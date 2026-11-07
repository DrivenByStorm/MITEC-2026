// Simulated drone survey that builds the site's terrain model from scratch.
//
// Flow: the build manager sets a distance and starts the survey. The scout drone flies
// out that far from the launch point and traces the site boundary, mapping a strip as
// it goes. The area inside is split into sections, the selection algorithm assigns
// sections to the survey drones, and each drone reveals elevation along its path.
// Afterwards the user can send drones to suggested gaps or lock the survey for buildup.
//
// Shown at accelerated speed so a full pass fits in a demo.

import type { Pt, SurveyDrone, SurveyEvent, SurveyPhase, SurveySection, SurveySnapshot } from './types'
import { loadTerrain } from './terrain'
import type { Terrain } from './terrain'
import { placeholderSelection } from './selection'
import type { SelectionAlgorithm } from './selection'

const TICK_MS = 250
const SPEEDUP = 16 // a 10 m/s drone covers 40 m per 250 ms tick
const SURVEY_SPEED = 40 // m per tick
const SCOUT_SPEED = 45
const SWATH_M = 80
const DRAIN_PER_M = { Scout: 0.006, Survey: 0.011 } // % battery per meter flown
const RESERVE_PCT = 8
const SWAP_TICKS = 8
const DONE_COVERAGE = 0.97
const SECTION_TARGET_M = 500

interface Mission {
  kind: 'perimeter' | 'section'
  sectionId?: string
  route: Pt[] // remaining waypoints of the mission itself
}

interface DroneState extends SurveyDrone {
  mission?: Mission
  /** Where to go right now (an outbound/return leg, or the next mission waypoint). */
  target?: Pt
  swapLeft: number
}

type Listener = () => void

export class SurveySession {
  private terrain: Terrain
  private selection: SelectionAlgorithm
  private listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null

  private phase: SurveyPhase = 'idle'
  private distanceM = 1000
  private readonly launch: Pt
  private readonly maxDistanceM: number
  private perimeter: Pt[] = []
  private perimeterFlown: Pt[] = []
  private drones: DroneState[] = []
  private sections: SurveySection[] = []
  private queue: string[] = []
  private events: SurveyEvent[] = []
  private eventSeq = 1

  // rasters
  readonly coverage: Uint8Array
  private insideMask: Uint8Array
  private insideCells = 0
  private insideMapped = 0
  private sum = 0
  private min = Infinity
  private max = -Infinity
  private coverageVersion = 0
  private colorRange = { min: 0, max: 1 }
  private snapshot: SurveySnapshot

  constructor(opts: { selection?: SelectionAlgorithm } = {}) {
    this.terrain = loadTerrain()
    this.selection = opts.selection ?? placeholderSelection
    const { cols, rows, cellM } = this.terrain
    this.coverage = new Uint8Array(cols * rows)
    this.insideMask = new Uint8Array(cols * rows)
    this.launch = { x: (cols * cellM) / 2, y: (rows * cellM) / 2 }
    this.maxDistanceM = Math.floor(((Math.min(cols, rows) * cellM) / 2 - 150) / 100) * 100
    this.resetDrones()
    this.log('info', `New site. ${this.terrain.real ? 'Real terrain loaded' : 'Synthetic terrain loaded'}; waiting to start the survey.`)
    this.snapshot = this.buildSnapshot()
  }

  get heights() {
    return this.terrain.heights
  }

  // ---------- public API ----------

  start() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  subscribe(l: Listener) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  getSnapshot() {
    return this.snapshot
  }

  setDistance(m: number) {
    if (this.phase !== 'idle') return
    this.distanceM = this.clampDistance(m)
    this.publish()
  }

  startSurvey(distanceM?: number): string {
    if (this.phase !== 'idle') return 'A survey is already under way. Use "map more" to extend it.'
    if (distanceM !== undefined) this.distanceM = this.clampDistance(distanceM)
    const d = this.distanceM
    const { x, y } = this.launch
    this.perimeter = [
      { x: x - d, y: y - d },
      { x: x + d, y: y - d },
      { x: x + d, y: y + d },
      { x: x - d, y: y + d },
    ]
    this.buildInsideMask()
    this.colorRange = this.rangeInside()

    const scout = this.drones.find((dr) => dr.role === 'Scout')!
    scout.mission = {
      kind: 'perimeter',
      route: [{ x, y: y - d }, { x: x + d, y: y - d }, { x: x + d, y: y + d }, { x: x - d, y: y + d }, { x: x - d, y: y - d }, { x, y: y - d }],
    }
    scout.status = 'outbound'
    scout.task = `Flying out ${d} m to the boundary`
    this.phase = 'scouting'
    this.log('info', `Survey started. Scout drone heading ${d} m out to trace the site boundary.`)
    this.publish()
    return `Survey started. The scout drone is flying ${d} m out to trace the boundary; the survey drones launch once it closes the loop.`
  }

  /** Send drones to specific sections (e.g. suggested gaps). */
  requestSections(ids: string[]): string {
    if (this.phase === 'idle') return 'Start the survey first.'
    if (this.phase === 'locked') return 'The survey is locked for buildup.'
    if (this.phase === 'scouting') return 'Wait for the scout to finish the boundary first.'
    const valid = ids.map((i) => i.toUpperCase()).filter((id) => this.sections.some((s) => s.id === id))
    if (!valid.length) return `No section called ${ids.join(', ')}. Sections run ${this.sections[0]?.id} to ${this.sections.at(-1)?.id}.`
    const fresh = valid.filter((id) => {
      const s = this.sections.find((x) => x.id === id)!
      return s.coverage < DONE_COVERAGE && s.status !== 'mapping' && !this.queue.includes(id)
    })
    if (!fresh.length) return `${valid.join(', ')} ${valid.length > 1 ? 'are' : 'is'} already mapped or in progress.`
    this.queue.push(...fresh)
    fresh.forEach((id) => (this.sections.find((s) => s.id === id)!.status = 'queued'))
    this.phase = 'surveying'
    this.log('info', `Mapping requested for ${fresh.join(', ')}.`)
    this.dispatch()
    this.publish()
    const busy = this.queue.filter((id) => fresh.includes(id))
    return busy.length
      ? `Queued ${fresh.join(', ')}. ${busy.join(', ')} will start as soon as drones are free.`
      : `Sending drones to ${fresh.join(', ')}.`
  }

  /** Map the best suggested gaps, up to one per free drone. */
  mapMore(): string {
    const ids = this.suggestions().slice(0, Math.max(1, this.drones.length - 1))
    if (!ids.length) return 'Everything inside the boundary is already mapped.'
    return this.requestSections(ids)
  }

  recallAll(): string {
    if (this.phase === 'idle') return 'No drones are flying.'
    this.queue = []
    for (const d of this.drones) {
      if (d.status === 'docked' || d.status === 'swapping') continue
      d.mission = undefined
      this.sendHome(d, 'Recalled to launch point')
    }
    this.sections.forEach((s) => s.status === 'queued' && (s.status = 'unassigned'))
    this.log('warn', 'All drones recalled to the launch point.')
    this.publish()
    return 'Recalling all drones to the launch point.'
  }

  lock(): string {
    if (this.phase === 'idle' || this.phase === 'scouting') return 'Finish at least the boundary and one mapping pass before moving to buildup.'
    if (this.phase === 'locked') return 'The survey is already locked for buildup.'
    if (this.phase === 'surveying') this.recallAll()
    this.phase = 'locked'
    this.log('info', `Survey locked at ${Math.round(this.stats().coverage * 100)}% coverage. Terrain model handed to buildup planning.`)
    this.publish()
    return `Survey locked with ${Math.round(this.stats().coverage * 100)}% of the site mapped. The terrain model is ready for buildup planning.`
  }

  /** Elevation at a site point, or undefined if not mapped yet. */
  elevationAt(p: Pt): number | undefined {
    const { cols, rows, cellM } = this.terrain
    const c = Math.floor(p.x / cellM)
    const r = Math.floor(p.y / cellM)
    if (c < 0 || r < 0 || c >= cols || r >= rows) return undefined
    const i = r * cols + c
    return this.coverage[i] ? this.terrain.heights[i] : undefined
  }

  // ---------- simulation ----------

  private tick() {
    for (const d of this.drones) this.stepDrone(d)
    this.updateSections()
    this.dispatch()
    if (this.phase === 'surveying' && !this.queue.length && !this.drones.some((d) => d.mission?.kind === 'section')) {
      this.phase = 'review'
      const pct = Math.round(this.stats().coverage * 100)
      this.log('info', `Mapping pass complete: ${pct}% of the site mapped. Map more or move forward with buildup.`)
    }
    this.publish()
  }

  private stepDrone(d: DroneState) {
    if (d.status === 'swapping') {
      if (--d.swapLeft <= 0) {
        d.battery = 100
        d.status = 'docked'
        d.task = d.mission ? 'Battery swapped' : 'Ready'
        if (d.mission) this.resumeMission(d)
      }
      return
    }
    if (d.status === 'docked') {
      if (d.battery < 95 && !d.mission) this.beginSwap(d)
      return
    }
    // Head home early if the battery can't cover the trip back plus a reserve.
    const home = Math.hypot(d.x - this.launch.x, d.y - this.launch.y)
    if (d.status !== 'returning' && d.battery - home * DRAIN_PER_M[d.role] < RESERVE_PCT) {
      this.log('info', `${d.id} low on battery (${Math.round(d.battery)}%); returning to swap and resume.`)
      this.sendHome(d, 'Returning to swap battery')
      return
    }
    const target = d.target ?? d.mission?.route[0]
    if (!target) return
    const speed = d.role === 'Scout' ? SCOUT_SPEED : SURVEY_SPEED
    const from = { x: d.x, y: d.y }
    const arrived = this.moveToward(d, target, speed)
    const flown = Math.hypot(d.x - from.x, d.y - from.y)
    d.battery = Math.max(0, d.battery - flown * DRAIN_PER_M[d.role])
    if (d.status === 'perimeter' || d.status === 'mapping') this.markSwath(from, { x: d.x, y: d.y })
    if (d.status === 'perimeter') this.perimeterFlown.push({ x: d.x, y: d.y })
    if (!arrived) return
    this.arrive(d)
  }

  private arrive(d: DroneState) {
    if (d.status === 'returning') {
      d.target = undefined
      Object.assign(d, this.dockPoint(d))
      if (d.mission) this.beginSwap(d)
      else if (d.battery < 95) this.beginSwap(d)
      else {
        d.status = 'docked'
        d.task = 'Ready'
      }
      return
    }
    if (d.status === 'outbound') {
      // reached the first mission waypoint (or the resume point)
      d.target = undefined
      d.status = d.mission!.kind === 'perimeter' ? 'perimeter' : 'mapping'
      if (d.mission!.kind === 'perimeter') {
        this.perimeterFlown.push({ x: d.x, y: d.y })
        d.task = 'Tracing the site boundary'
      } else {
        d.task = `Mapping section ${d.mission!.sectionId}`
      }
      if (this.near(d, d.mission!.route[0])) d.mission!.route.shift()
      return
    }
    // mission waypoint reached
    d.mission!.route.shift()
    if (d.mission!.route.length) return
    const done = d.mission!
    d.mission = undefined
    d.sectionId = undefined
    if (done.kind === 'perimeter') {
      this.log('info', `${d.id} closed the boundary loop (${((this.distanceM * 8) / 1000).toFixed(1)} km). Splitting the site into sections.`)
      this.sendHome(d, 'Boundary done; returning')
      this.createSections()
      this.phase = 'surveying'
      this.assign('initial', [])
    } else {
      this.log('info', `${d.id} finished section ${done.sectionId}.`)
      this.sendHome(d, `Finished ${done.sectionId}; returning`)
    }
  }

  private resumeMission(d: DroneState) {
    const next = d.mission!.route[0]
    if (!next) {
      d.mission = undefined
      return
    }
    d.status = 'outbound'
    d.target = next
    d.task = d.mission!.kind === 'perimeter' ? 'Resuming the boundary' : `Resuming section ${d.mission!.sectionId}`
  }

  private beginSwap(d: DroneState) {
    d.status = 'swapping'
    d.swapLeft = SWAP_TICKS
    d.task = 'Swapping battery'
  }

  private sendHome(d: DroneState, task: string) {
    // Keep the mission so the drone resumes where it left off; insert its current position as the resume point.
    if (d.mission && d.status !== 'outbound') d.mission.route.unshift({ x: d.x, y: d.y })
    d.status = 'returning'
    d.target = this.dockPoint(d)
    d.task = task
  }

  private dockPoint(d: DroneState): Pt {
    const i = this.drones.indexOf(d)
    return { x: this.launch.x - 40 + i * 20, y: this.launch.y + 25 }
  }

  private moveToward(d: DroneState, t: Pt, speed: number): boolean {
    const dist = Math.hypot(t.x - d.x, t.y - d.y)
    if (dist > 0.01) d.heading = (Math.atan2(t.y - d.y, t.x - d.x) * 180) / Math.PI
    if (dist <= speed) {
      d.x = t.x
      d.y = t.y
      return true
    }
    d.x += ((t.x - d.x) / dist) * speed
    d.y += ((t.y - d.y) / dist) * speed
    return false
  }

  private near(a: Pt, b?: Pt) {
    return !!b && Math.hypot(a.x - b.x, a.y - b.y) < 1
  }

  /** Reveal every cell within half a swath of the segment the drone just flew. */
  private markSwath(a: Pt, b: Pt) {
    const { cols, rows, cellM, heights } = this.terrain
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const steps = Math.max(1, Math.ceil(len / (cellM / 2)))
    const r = SWATH_M / 2
    const rc = Math.ceil(r / cellM)
    let changed = false
    for (let s = 0; s <= steps; s++) {
      const px = a.x + ((b.x - a.x) * s) / steps
      const py = a.y + ((b.y - a.y) * s) / steps
      const c0 = Math.floor(px / cellM)
      const r0 = Math.floor(py / cellM)
      for (let dr = -rc; dr <= rc; dr++) {
        for (let dc = -rc; dc <= rc; dc++) {
          const c = c0 + dc
          const rr = r0 + dr
          if (c < 0 || rr < 0 || c >= cols || rr >= rows) continue
          const cx = (c + 0.5) * cellM
          const cy = (rr + 0.5) * cellM
          if ((cx - px) ** 2 + (cy - py) ** 2 > r * r) continue
          const i = rr * cols + c
          if (this.coverage[i]) continue
          this.coverage[i] = 1
          changed = true
          if (this.insideMask[i]) {
            const h = heights[i]
            this.insideMapped++
            this.sum += h
            if (h < this.min) this.min = h
            if (h > this.max) this.max = h
          }
        }
      }
    }
    if (changed) this.coverageVersion++
  }

  // ---------- sections & selection ----------

  private createSections() {
    const k = Math.min(6, Math.max(2, Math.round((this.distanceM * 2) / SECTION_TARGET_M)))
    const [nw] = this.perimeter
    const size = (this.distanceM * 2) / k
    this.sections = []
    for (let r = 0; r < k; r++) {
      for (let c = 0; c < k; c++) {
        this.sections.push({
          id: `${String.fromCharCode(65 + r)}${c + 1}`,
          x: nw.x + c * size,
          y: nw.y + r * size,
          w: size,
          h: size,
          coverage: 0,
          status: 'unassigned',
          assignedTo: [],
        })
      }
    }
    this.updateSections()
  }

  private updateSections() {
    const { cols, cellM } = this.terrain
    for (const s of this.sections) {
      const c0 = Math.max(0, Math.floor(s.x / cellM))
      const c1 = Math.floor((s.x + s.w) / cellM)
      const r0 = Math.max(0, Math.floor(s.y / cellM))
      const r1 = Math.floor((s.y + s.h) / cellM)
      let total = 0
      let mapped = 0
      for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
          total++
          mapped += this.coverage[r * cols + c]
        }
      }
      s.coverage = total ? mapped / total : 0
      const crew = this.drones.filter((d) => d.mission?.kind === 'section' && d.mission.sectionId === s.id).map((d) => d.id)
      s.assignedTo = crew
      s.status = crew.length ? 'mapping' : s.coverage >= DONE_COVERAGE ? 'done' : this.queue.includes(s.id) ? 'queued' : 'unassigned'
    }
  }

  private freeDrones() {
    return this.drones.filter((d) => d.status === 'docked' && !d.mission && d.battery >= 95)
  }

  private dispatch() {
    if (!this.queue.length || this.phase !== 'surveying') return
    if (!this.freeDrones().length) return
    this.assign('requested', [...this.queue])
  }

  private assign(mode: 'initial' | 'requested', requested: string[]) {
    const free = this.freeDrones()
    if (!free.length) return
    const assignments = this.selection({
      mode,
      launch: { ...this.launch },
      perimeter: this.perimeter.map((p) => ({ ...p })),
      sections: this.sections.map((s) => ({ id: s.id, x: s.x, y: s.y, w: s.w, h: s.h, coverage: s.coverage })),
      drones: free.map((d) => ({ id: d.id, x: d.x, y: d.y, battery: d.battery })),
      swathM: SWATH_M,
      requestedSectionIds: requested,
    })
    for (const a of assignments) {
      const d = this.drones.find((x) => x.id === a.droneId)
      if (!d || !a.waypoints.length) continue
      d.mission = { kind: 'section', sectionId: a.sectionId, route: a.waypoints.map((p) => ({ ...p })) }
      d.sectionId = a.sectionId
      d.status = 'outbound'
      d.target = a.waypoints[0]
      d.task = `Flying to section ${a.sectionId}`
      this.queue = this.queue.filter((id) => id !== a.sectionId)
    }
    const ids = [...new Set(assignments.map((a) => a.sectionId))]
    if (ids.length) this.log('info', `Selection assigned ${ids.join(', ')} to ${assignments.map((a) => a.droneId).join(', ')}.`)
    this.updateSections()
  }

  private suggestions(): string[] {
    return this.sections
      .filter((s) => s.coverage < DONE_COVERAGE && s.status !== 'mapping' && s.status !== 'queued')
      .sort((a, b) => {
        // Prefer sections touching mapped ground, then the closest to the launch point.
        const adj = this.touchesMapped(b) - this.touchesMapped(a)
        return adj || this.distLaunch(a) - this.distLaunch(b)
      })
      .map((s) => s.id)
  }

  private touchesMapped(s: SurveySection) {
    return this.sections.some((o) => o !== s && o.coverage >= DONE_COVERAGE && Math.abs(o.x - s.x) <= s.w + 1 && Math.abs(o.y - s.y) <= s.h + 1 && (o.x === s.x || o.y === s.y)) ? 1 : 0
  }

  private distLaunch(s: SurveySection) {
    return Math.hypot(s.x + s.w / 2 - this.launch.x, s.y + s.h / 2 - this.launch.y)
  }

  // ---------- helpers ----------

  private resetDrones() {
    const ids: [string, 'Scout' | 'Survey'][] = [['SC-1', 'Scout'], ['SV-1', 'Survey'], ['SV-2', 'Survey'], ['SV-3', 'Survey'], ['SV-4', 'Survey']]
    this.drones = ids.map(([id, role]) => ({ id, role, x: 0, y: 0, heading: -90, battery: 100, status: 'docked', task: 'Ready', swapLeft: 0 }))
    for (const d of this.drones) Object.assign(d, this.dockPoint(d))
  }

  private clampDistance(m: number) {
    return Math.max(300, Math.min(this.maxDistanceM, Math.round(m / 50) * 50))
  }

  private buildInsideMask() {
    const { cols, rows, cellM } = this.terrain
    const [nw, , se] = this.perimeter
    this.insideMask.fill(0)
    this.insideCells = 0
    for (let r = 0; r < rows; r++) {
      const cy = (r + 0.5) * cellM
      if (cy < nw.y || cy > se.y) continue
      for (let c = 0; c < cols; c++) {
        const cx = (c + 0.5) * cellM
        if (cx < nw.x || cx > se.x) continue
        this.insideMask[r * cols + c] = 1
        this.insideCells++
      }
    }
  }

  private rangeInside() {
    let min = Infinity
    let max = -Infinity
    const h = this.terrain.heights
    for (let i = 0; i < h.length; i++) {
      if (!this.insideMask[i]) continue
      if (h[i] < min) min = h[i]
      if (h[i] > max) max = h[i]
    }
    return { min, max: max > min ? max : min + 1 }
  }

  private stats() {
    const cell2 = this.terrain.cellM ** 2
    return {
      perimeterAreaKm2: (this.insideCells * cell2) / 1e6,
      mappedAreaKm2: (this.insideMapped * cell2) / 1e6,
      coverage: this.insideCells ? this.insideMapped / this.insideCells : 0,
      minM: this.insideMapped ? this.min : undefined,
      maxM: this.insideMapped ? this.max : undefined,
      meanM: this.insideMapped ? this.sum / this.insideMapped : undefined,
    }
  }

  private log(level: SurveyEvent['level'], text: string) {
    this.events.unshift({ id: this.eventSeq++, at: Date.now(), level, text })
    if (this.events.length > 200) this.events.length = 200
  }

  private publish() {
    this.snapshot = this.buildSnapshot()
    for (const l of this.listeners) l()
  }

  private buildSnapshot(): SurveySnapshot {
    const t = this.terrain
    return {
      now: Date.now(),
      phase: this.phase,
      distanceM: this.distanceM,
      maxDistanceM: this.maxDistanceM,
      launch: { ...this.launch },
      perimeter: this.perimeter.map((p) => ({ ...p })),
      perimeterFlown: this.perimeterFlown.slice(),
      drones: this.drones.map(({ id, role, x, y, heading, battery, status, task, sectionId }) => ({ id, role, x, y, heading, battery: Math.round(battery), status, task, sectionId })),
      sections: this.sections.map((s) => ({ ...s, assignedTo: [...s.assignedTo] })),
      suggestions: this.phase === 'review' ? this.suggestions() : [],
      stats: this.stats(),
      colorRange: { ...this.colorRange },
      events: this.events.slice(),
      coverageVersion: this.coverageVersion,
      speedup: SPEEDUP,
      terrain: { cols: t.cols, rows: t.rows, cellM: t.cellM, real: t.real, sourceLabel: t.sourceLabel, lat0: t.lat0, lon0: t.lon0 },
    }
  }
}
