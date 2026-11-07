// A simulated build site that stands in for the real edge-server feed.
//
// It keeps two copies of the world:
//   - `truth`: where things really are and what they are really doing;
//   - `reported`: what the digital twin has actually heard over the radio.
// Reports only arrive while an asset has a network path, so an asset that
// drives out of coverage freezes (goes stale) on the map, keeps working, and
// flushes its queued results when it reconnects (store-and-forward).

import type {
  Asset,
  AssetKind,
  AssetMode,
  AssetRequest,
  Block,
  EventLevel,
  LinkLayer,
  P3Unit,
  RelayLink,
  TwinEvent,
  TwinSnapshot,
  UnitStatus,
} from './types'

const SITE = { w: 1400, h: 920 }
const ROW_GAP = 32
const SLOT_GAP = 18
const RELAY_RANGE = 460 // relay-to-relay mesh hop, m
const ASSET_RANGE = 270 // machine/robot to nearest relay, m
const LORA_RANGE = 2000 // worker LoRa tag to any relay, m
const PROXIMITY_STOP_M = 12
const LAYDOWN = { x: 1150, y: 240 }

interface Truth {
  id: string
  name: string
  kind: AssetKind
  role: string
  x: number
  y: number
  heading: number
  mode: AssetMode
  task: string
  energy: number
  speed: number
  // behaviour state
  block?: string
  target?: { x: number; y: number }
  dwell: number
  holdUntil: number // proximity stop / paused-by-safety tick
  waypoints?: { x: number; y: number }[]
  wpIndex: number
  group?: string // workers: id of the machine their crew works around
  anchorOffset?: { x: number; y: number }
  requestId?: string
  workUnit?: string
  shuttleLeg?: 'laydown' | 'crane'
  baseMode: AssetMode
  // relays
  failedUntil?: number
  // store-and-forward outbox
  outbox: { unitId: string; status: UnitStatus; at: number }[]
  outEvents: { level: EventLevel; text: string; at: number }[]
  lastLoraReport: number
}

type Listener = () => void

function dist(ax: number, ay: number, bx: number, by: number) {
  return Math.hypot(ax - bx, ay - by)
}

function seededRandom(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

export class SimulatedSite {
  private rand = seededRandom(7)
  private tickCount = 0
  private listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null

  private blocks: Block[] = []
  private truthUnits: P3Unit[] = []
  private reportedUnits: P3Unit[] = []
  private truth = new Map<string, Truth>()
  private reported = new Map<string, Asset>()
  private links: RelayLink[] = []
  private events: TwinEvent[] = []
  private requests: AssetRequest[] = []
  private eventSeq = 1
  private requestSeq = 1
  private proximityCooldown = new Map<string, number>()
  private uplink = { online: true, lastSync: Date.now() }
  private snapshot: TwinSnapshot

  readonly edgeServer = { x: 1170, y: 475, online: true }
  readonly rtkBase = { x: 1170, y: 520, online: true }

  constructor() {
    this.buildSite()
    this.buildAssets()
    this.computeNetwork()
    const now = Date.now()
    for (const t of this.truth.values()) this.report(t, now, t.kind === 'worker' ? 'lora' : 'mesh')
    this.log('info', 'Digital twin started. Edge server is collecting reports from the site.')
    this.snapshot = this.buildSnapshot()
  }

  // ---------- public API ----------

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 1000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): TwinSnapshot {
    return this.snapshot
  }

  /** Pause a robot or machine. Anyone may stop; this is always allowed. */
  pause(id: string): string {
    const t = this.truth.get(id)
    if (!t) return `No asset called ${id}.`
    if (t.kind === 'worker' || t.kind === 'relay') return `${t.name} is not a machine and can't be paused.`
    if (t.mode === 'paused') return `${t.name} is already paused.`
    t.mode = 'paused'
    this.log('warn', `${t.name} paused by build manager.`, id)
    this.forceReport(t)
    return `Paused ${t.name}. It will hold position until you resume it.`
  }

  /** Resume a paused machine. Starting motion needs a supervisor, which the build manager is. */
  resume(id: string): string {
    const t = this.truth.get(id)
    if (!t) return `No asset called ${id}.`
    if (t.mode !== 'paused') return `${t.name} isn't paused (it is ${t.mode}).`
    t.mode = t.requestId ? 'manual' : t.baseMode
    this.log('info', `${t.name} resumed by build manager.`, id)
    this.forceReport(t)
    return `Resumed ${t.name}.`
  }

  pauseAllRobots(): string {
    const robots = [...this.truth.values()].filter((t) => t.kind === 'robot' || t.kind === 'drone')
    robots.forEach((t) => {
      if (t.mode !== 'paused') t.mode = 'paused'
      this.forceReport(t)
    })
    this.log('alert', `All robots paused by build manager (${robots.length}).`)
    return `Paused all ${robots.length} robots and drones.`
  }

  createRequest(need: string, target: { label: string; x: number; y: number }, requestedBy: string): AssetRequest {
    const req: AssetRequest = {
      id: `REQ-${String(this.requestSeq++).padStart(3, '0')}`,
      createdAt: Date.now(),
      requestedBy,
      need,
      target,
      status: 'pending',
    }
    this.requests.unshift(req)
    this.log('info', `${req.id}: ${need} requested at ${target.label} by ${requestedBy}.`)
    this.assignRequest(req)
    this.publish()
    return req
  }

  cancelRequest(id: string): string {
    const req = this.requests.find((r) => r.id === id.toUpperCase())
    if (!req) return `No request called ${id}.`
    if (req.status === 'done' || req.status === 'cancelled') return `${req.id} is already ${req.status}.`
    req.status = 'cancelled'
    if (req.assignedTo) {
      const t = this.truth.get(req.assignedTo)
      if (t) {
        t.requestId = undefined
        t.target = undefined
        t.mode = 'idle'
        t.task = 'Available'
      }
    }
    this.log('info', `${req.id} cancelled.`)
    this.publish()
    return `Cancelled ${req.id}.`
  }

  // ---------- site construction ----------

  private buildSite() {
    const defs = [
      { id: 'A', x: 120, y: 90 },
      { id: 'B', x: 520, y: 90 },
      { id: 'C', x: 120, y: 500 },
      { id: 'D', x: 520, y: 500 },
    ]
    const rows = 10
    const slots = 18
    for (const d of defs) {
      this.blocks.push({ id: d.id, x: d.x, y: d.y, w: slots * SLOT_GAP + 12, h: rows * ROW_GAP + 8, rows, slots })
      for (let r = 0; r < rows; r++) {
        for (let s = 0; s < slots; s++) {
          let status: UnitStatus = 'planned'
          if (d.id === 'A') status = 'installed'
          if (d.id === 'B') status = r < 6 ? 'installed' : 'piled'
          if (d.id === 'C') status = r < 3 ? 'piled' : 'planned'
          this.truthUnits.push({
            id: `${d.id}-${String(r + 1).padStart(2, '0')}-${String(s + 1).padStart(2, '0')}`,
            block: d.id,
            row: r + 1,
            slot: s + 1,
            x: d.x + 12 + s * SLOT_GAP,
            y: d.y + 16 + r * ROW_GAP,
            status,
          })
        }
      }
    }
    this.reportedUnits = this.truthUnits.map((u) => ({ ...u }))
  }

  private addTruth(p: Partial<Truth> & Pick<Truth, 'id' | 'name' | 'kind' | 'role' | 'x' | 'y'>) {
    this.truth.set(p.id, {
      heading: 0,
      mode: 'idle',
      task: 'Available',
      energy: 60 + this.rand() * 35,
      speed: 5,
      dwell: 0,
      holdUntil: 0,
      wpIndex: 0,
      outbox: [],
      outEvents: [],
      lastLoraReport: 0,
      baseMode: p.mode ?? 'idle',
      ...p,
    })
  }

  private buildAssets() {
    // Relays: solar masts on a grid, plus the gateway wired to the edge server.
    const masts: [string, number, number][] = [
      ['M-1', 80, 60], ['M-2', 480, 60], ['M-3', 880, 60],
      ['M-4', 80, 470], ['M-5', 480, 470], ['M-6', 880, 470],
      ['M-7', 80, 870], ['M-8', 480, 870], ['M-9', 880, 870],
    ]
    for (const [id, x, y] of masts) {
      this.addTruth({ id, name: id, kind: 'relay', role: 'Solar relay mast', x, y, mode: 'autonomous', task: 'Relaying', energy: 70 + this.rand() * 30 })
    }
    this.addTruth({ id: 'GW', name: 'Gateway', kind: 'relay', role: 'Gateway (wired to edge server)', x: 1080, y: 435, mode: 'autonomous', task: 'Relaying', energy: 100 })

    // Robots
    this.addTruth({ id: 'RPD-1', name: 'RPD-1', kind: 'robot', role: 'Pile driver', x: 140, y: 600, mode: 'autonomous', speed: 6, block: 'C', task: 'Driving piles, block C' })
    this.addTruth({ id: 'RPD-2', name: 'RPD-2', kind: 'robot', role: 'Pile driver', x: 540, y: 520, mode: 'autonomous', speed: 6, block: 'D', task: 'Driving piles, block D' })

    // Machines
    this.addTruth({ id: 'CR-1', name: 'CR-1', kind: 'machine', role: 'Crane', x: 560, y: 300, mode: 'manual', speed: 4, block: 'B', task: 'Setting P3 units, block B' })
    this.addTruth({ id: 'TH-1', name: 'TH-1', kind: 'machine', role: 'Telehandler', x: LAYDOWN.x, y: LAYDOWN.y, mode: 'manual', speed: 7, task: 'Shuttling units to CR-1', shuttleLeg: 'crane' })
    this.addTruth({ id: 'TH-2', name: 'TH-2', kind: 'machine', role: 'Telehandler', x: LAYDOWN.x + 40, y: LAYDOWN.y + 30, mode: 'idle', speed: 7, task: 'Available' })
    this.addTruth({
      id: 'TR-1', name: 'TR-1', kind: 'machine', role: 'Trencher', x: 470, y: 120, mode: 'manual', speed: 1.5,
      task: 'Trenching collection line', waypoints: [{ x: 470, y: 110 }, { x: 470, y: 840 }],
    })

    // Drone: lawnmower survey over block D
    const d = { x: 520, y: 500, w: 340, h: 330 }
    const wps: { x: number; y: number }[] = []
    for (let i = 0; i <= 6; i++) {
      const y = d.y + (i * d.h) / 6
      wps.push(i % 2 ? { x: d.x + d.w, y } : { x: d.x, y })
      wps.push(i % 2 ? { x: d.x, y } : { x: d.x + d.w, y })
    }
    this.addTruth({ id: 'DR-1', name: 'DR-1', kind: 'drone', role: 'Survey drone', x: d.x, y: d.y, mode: 'autonomous', speed: 14, waypoints: wps, task: 'Progress survey, block D' })

    // Workers, each crew anchored to the machine they work around.
    const crew: [string, string, string, string][] = [
      ['W-01', 'M. Reyes', 'Robot operator', 'RPD-1'],
      ['W-02', 'D. Okafor', 'Spotter', 'RPD-1'],
      ['W-03', 'S. Lindqvist', 'Robot operator', 'RPD-2'],
      ['W-04', 'J. Ortiz', 'Rigger', 'CR-1'],
      ['W-05', 'A. Patel', 'Rigger', 'CR-1'],
      ['W-06', 'K. Begay', 'Signal person', 'CR-1'],
      ['W-07', 'L. Nguyen', 'Electrician', 'A'],
      ['W-08', 'R. Castillo', 'Electrician', 'A'],
      ['W-09', 'T. Hale', 'Surveyor', 'DR-1'],
      ['W-10', 'P. Andrade', 'Safety lead', 'roam'],
      ['W-11', 'C. Whitehorse', 'Foreman', 'roam'],
    ]
    for (const [id, name, role, group] of crew) {
      const ox = (this.rand() - 0.5) * 60
      const oy = 18 + this.rand() * 30
      const start = this.anchorFor(group, { x: ox, y: oy })
      this.addTruth({ id, name, kind: 'worker', role, x: start.x, y: start.y, mode: 'manual', speed: 2.5, group, anchorOffset: { x: ox, y: oy }, task: role, energy: 50 + this.rand() * 50 })
    }
  }

  private anchorFor(group: string, offset: { x: number; y: number }) {
    const m = this.truth.get(group)
    if (m) return { x: m.x + offset.x, y: m.y + offset.y }
    if (group === 'A') return { x: 280 + offset.x * 2, y: 250 + offset.y * 2 }
    // roamers drift around the active blocks
    const phase = this.tickCount / 60
    return { x: 500 + Math.cos(phase) * 320 + offset.x, y: 470 + Math.sin(phase * 1.3) * 260 + offset.y }
  }

  // ---------- simulation ----------

  private tick() {
    this.tickCount++
    const now = Date.now()

    this.updateRelays(now)
    this.computeNetwork()

    for (const t of this.truth.values()) {
      if (t.kind === 'relay') continue
      this.stepAsset(t, now)
    }

    this.checkProximity(now)
    this.updateRequests()
    this.deliverReports(now)
    this.updateUplink(now)
    this.publish()
  }

  private updateRelays(now: number) {
    for (const t of this.truth.values()) {
      if (t.kind !== 'relay' || t.id === 'GW') continue
      // Scripted demo: the two west-side masts drop out 12 s in and come back a minute
      // later, leaving the west edge of block C out of coverage for a while.
      if (this.tickCount === 12 && (t.id === 'M-4' || t.id === 'M-7')) this.failRelay(t, now, t.id === 'M-4' ? 60 : 75)
      else if (!t.failedUntil && this.tickCount > 120 && this.rand() < 0.0008) this.failRelay(t, now, 40 + this.rand() * 40)

      if (t.failedUntil && now >= t.failedUntil) {
        t.failedUntil = undefined
        t.mode = 'autonomous'
        t.task = 'Relaying'
        this.log('info', `${t.name} is back online. Mesh routes restored.`, t.id)
      }
      // solar trickle and drain
      t.energy = Math.max(5, Math.min(100, t.energy + (this.rand() - 0.52) * 0.4))
    }
  }

  private failRelay(t: Truth, now: number, seconds: number) {
    t.failedUntil = now + seconds * 1000
    t.mode = 'offline'
    t.task = 'No heartbeat'
    this.log('alert', `${t.name} stopped sending heartbeats. Traffic is rerouting around it.`, t.id)
  }

  private stepAsset(t: Truth, now: number) {
    if (t.mode === 'paused') return
    if (this.tickCount < t.holdUntil) return
    t.energy = Math.max(8, t.energy - (t.kind === 'worker' ? 0.01 : 0.03))

    switch (t.id) {
      case 'RPD-1':
      case 'RPD-2':
        return this.stepPileDriver(t, now)
      case 'CR-1':
        return this.stepCrane(t, now)
      case 'TH-1':
        return this.stepShuttle(t)
      case 'DR-1':
      case 'TR-1':
        return this.stepWaypoints(t)
    }
    if (t.kind === 'machine') return this.stepRequestMachine(t)
    if (t.kind === 'worker') return this.stepWorker(t)
  }

  private moveToward(t: Truth, tx: number, ty: number): boolean {
    const d = dist(t.x, t.y, tx, ty)
    if (d < 0.5) return true
    t.heading = (Math.atan2(ty - t.y, tx - t.x) * 180) / Math.PI
    const step = Math.min(d, t.speed)
    t.x += ((tx - t.x) / d) * step
    t.y += ((ty - t.y) / d) * step
    return d <= t.speed
  }

  private nextUnit(block: string, status: UnitStatus) {
    return this.truthUnits.find((u) => u.block === block && u.status === status)
  }

  private stepPileDriver(t: Truth, now: number) {
    let unit = t.workUnit ? this.truthUnits.find((u) => u.id === t.workUnit) : undefined
    if (!unit || unit.status !== 'planned') {
      unit = this.nextUnit(t.block!, 'planned')
      t.workUnit = unit?.id
      t.dwell = 0
    }
    if (!unit) {
      t.mode = 'idle'
      t.task = `Block ${t.block} piling complete`
      return
    }
    t.mode = 'autonomous'
    if (this.moveToward(t, unit.x, unit.y + 7)) {
      t.task = `Driving pile at ${unit.id}`
      t.dwell++
      if (t.dwell >= 4) {
        unit.status = 'piled'
        t.outbox.push({ unitId: unit.id, status: 'piled', at: now })
        if (this.rand() < 0.06) {
          t.outEvents.push({ level: 'warn', text: `${t.name} hit refusal at ${unit.id}; pile flagged for engineer review.`, at: now })
        }
        t.workUnit = undefined
        t.dwell = 0
      }
    } else {
      t.task = `Moving to ${unit.id}`
    }
  }

  private stepCrane(t: Truth, now: number) {
    let unit = t.workUnit ? this.truthUnits.find((u) => u.id === t.workUnit) : undefined
    if (!unit || unit.status !== 'piled') {
      unit = this.nextUnit('B', 'piled') ?? this.nextUnit('C', 'piled')
      t.workUnit = unit?.id
      t.dwell = 0
    }
    if (!unit) {
      t.mode = 'idle'
      t.task = 'Waiting for piled foundations'
      return
    }
    t.mode = 'manual'
    if (this.moveToward(t, unit.x, unit.y + 14)) {
      t.task = `Setting P3 unit ${unit.id}`
      t.dwell++
      if (t.dwell >= 7) {
        unit.status = 'installed'
        t.outbox.push({ unitId: unit.id, status: 'installed', at: now })
        t.workUnit = undefined
        t.dwell = 0
      }
    } else {
      t.task = `Moving to ${unit.id}`
    }
  }

  private stepShuttle(t: Truth) {
    if (t.requestId) return this.stepRequestMachine(t)
    const crane = this.truth.get('CR-1')!
    const dest = t.shuttleLeg === 'crane' ? { x: crane.x + 20, y: crane.y - 10 } : LAYDOWN
    t.mode = 'manual'
    if (this.moveToward(t, dest.x, dest.y)) {
      t.dwell++
      t.task = t.shuttleLeg === 'crane' ? 'Handing unit to CR-1' : 'Loading unit at laydown yard'
      if (t.dwell >= 3) {
        t.shuttleLeg = t.shuttleLeg === 'crane' ? 'laydown' : 'crane'
        t.dwell = 0
      }
    } else {
      t.task = t.shuttleLeg === 'crane' ? 'Delivering P3 unit to CR-1' : 'Returning to laydown yard'
    }
  }

  private stepWaypoints(t: Truth) {
    const wps = t.waypoints!
    const wp = wps[t.wpIndex % wps.length]
    if (this.moveToward(t, wp.x, wp.y)) t.wpIndex = (t.wpIndex + 1) % wps.length
  }

  private stepRequestMachine(t: Truth) {
    if (!t.requestId || !t.target) return
    t.mode = 'manual'
    this.moveToward(t, t.target.x, t.target.y)
  }

  private stepWorker(t: Truth) {
    const anchor = this.anchorFor(t.group!, t.anchorOffset!)
    if (!t.target || dist(t.x, t.y, t.target.x, t.target.y) < 2 || this.rand() < 0.05) {
      const r = 6 + this.rand() * 22
      const a = this.rand() * Math.PI * 2
      t.target = { x: anchor.x + Math.cos(a) * r, y: anchor.y + Math.sin(a) * r }
    }
    this.moveToward(t, t.target.x, t.target.y)
  }

  /** UWB proximity: acts locally on the machine, no network needed. */
  private checkProximity(now: number) {
    const workers = [...this.truth.values()].filter((t) => t.kind === 'worker')
    const movers = [...this.truth.values()].filter((t) => t.kind === 'robot' || t.kind === 'machine')
    for (const m of movers) {
      for (const w of workers) {
        if (dist(m.x, m.y, w.x, w.y) > PROXIMITY_STOP_M) continue
        const key = `${m.id}:${w.id}`
        if ((this.proximityCooldown.get(key) ?? 0) > this.tickCount) continue
        this.proximityCooldown.set(key, this.tickCount + 40)
        m.holdUntil = this.tickCount + 3
        // The stop happens instantly on site; the twin hears about it on the next report.
        m.outEvents.push({ level: 'warn', text: `Proximity stop: ${m.name} held for ${w.name} (${w.role}).`, at: now })
      }
    }
  }

  // ---------- requests ----------

  private matchKind(need: string) {
    const n = need.toLowerCase()
    if (n.includes('tele') || n.includes('forklift') || n.includes('reload') || n.includes('material')) return 'Telehandler'
    if (n.includes('crane')) return 'Crane'
    if (n.includes('trench')) return 'Trencher'
    return 'Telehandler'
  }

  private assignRequest(req: AssetRequest) {
    const role = this.matchKind(req.need)
    const candidates = [...this.truth.values()]
      .filter((t) => t.role === role && !t.requestId && t.mode !== 'paused' && t.mode !== 'fault')
      .sort((a, b) => {
        // prefer idle machines, then the closest
        const idle = Number(b.mode === 'idle') - Number(a.mode === 'idle')
        return idle || dist(a.x, a.y, req.target.x, req.target.y) - dist(b.x, b.y, req.target.x, req.target.y)
      })
    const pick = candidates[0]
    if (!pick) {
      this.log('warn', `${req.id}: no ${role.toLowerCase()} available. Request is waiting in the queue.`)
      return
    }
    pick.requestId = req.id
    pick.target = { x: req.target.x, y: req.target.y }
    pick.task = `${req.id}: heading to ${req.target.label}`
    req.assignedTo = pick.id
    req.status = 'assigned'
    req.eta = Math.round(dist(pick.x, pick.y, req.target.x, req.target.y) / pick.speed)
    this.log('info', `${req.id} assigned to ${pick.name} (ETA ${req.eta} s).`, pick.id)
  }

  private updateRequests() {
    for (const req of this.requests) {
      if (req.status === 'pending') {
        this.assignRequest(req)
        continue
      }
      if (!req.assignedTo || req.status === 'done' || req.status === 'cancelled') continue
      const t = this.truth.get(req.assignedTo)
      if (!t) continue
      const d = dist(t.x, t.y, req.target.x, req.target.y)
      if (req.status === 'assigned') req.status = 'en-route'
      if (req.status === 'en-route') {
        req.eta = Math.round(d / t.speed)
        if (d < 2) {
          req.status = 'arrived'
          t.task = `${req.id}: on station at ${req.target.label}`
          t.dwell = 0
          this.log('info', `${t.name} arrived at ${req.target.label} for ${req.id}.`, t.id)
        }
      } else if (req.status === 'arrived') {
        t.dwell++
        if (t.dwell >= 15) {
          req.status = 'done'
          t.requestId = undefined
          t.target = undefined
          t.dwell = 0
          t.mode = 'idle'
          t.task = 'Available'
          this.log('info', `${req.id} done. ${t.name} is available again.`, t.id)
        }
      }
    }
  }

  // ---------- network ----------

  private relayOnline(t: Truth) {
    return t.kind === 'relay' && t.mode !== 'offline'
  }

  private reachableRelays = new Set<string>()

  private computeNetwork() {
    const relays = [...this.truth.values()].filter((t) => this.relayOnline(t))
    const links: RelayLink[] = []
    for (let i = 0; i < relays.length; i++) {
      for (let j = i + 1; j < relays.length; j++) {
        const a = relays[i]
        const b = relays[j]
        const d = dist(a.x, a.y, b.x, b.y)
        if (d <= RELAY_RANGE) links.push({ a: a.id, b: b.id, quality: Math.max(0.2, 1 - (d / RELAY_RANGE) * 0.7) })
      }
    }
    // Which relays have a multi-hop path to the gateway?
    const reach = new Set<string>(['GW'])
    let grew = true
    while (grew) {
      grew = false
      for (const l of links) {
        if (reach.has(l.a) && !reach.has(l.b)) { reach.add(l.b); grew = true }
        if (reach.has(l.b) && !reach.has(l.a)) { reach.add(l.a); grew = true }
      }
    }
    this.reachableRelays = reach
    this.links = links
  }

  private bestRelay(t: Truth, range: number): Truth | undefined {
    let best: Truth | undefined
    let bestD = Infinity
    for (const r of this.truth.values()) {
      if (!this.relayOnline(r) || !this.reachableRelays.has(r.id)) continue
      const d = dist(t.x, t.y, r.x, r.y)
      if (d <= range && d < bestD) { best = r; bestD = d }
    }
    return best
  }

  private deliverReports(now: number) {
    for (const t of this.truth.values()) {
      if (t.kind === 'relay') {
        if (this.relayOnline(t) && this.reachableRelays.has(t.id)) this.report(t, now, 'mesh')
        else this.markLink(t.id, 'none')
        continue
      }
      if (t.kind === 'worker') {
        // LoRa tags report every few seconds; faster while moving.
        const moving = t.target ? dist(t.x, t.y, t.target.x, t.target.y) > 2 : false
        const interval = moving ? 3000 : 8000
        const relay = this.bestRelay(t, LORA_RANGE)
        if (relay && now - t.lastLoraReport >= interval && this.rand() < 0.9) {
          t.lastLoraReport = now
          this.report(t, now, 'lora', relay.id)
        }
        continue
      }
      const relay = this.bestRelay(t, ASSET_RANGE)
      if (!relay) {
        this.markLink(t.id, 'none')
        continue
      }
      if (this.rand() < 0.94) this.report(t, now, 'mesh', relay.id)
    }
  }

  private markLink(id: string, link: LinkLayer) {
    const r = this.reported.get(id)
    if (r && r.link !== link) this.reported.set(id, { ...r, link, via: undefined })
  }

  private forceReport(t: Truth) {
    this.report(t, Date.now(), t.kind === 'worker' ? 'lora' : 'mesh', this.reported.get(t.id)?.via)
    this.publish()
  }

  private report(t: Truth, now: number, link: LinkLayer, via?: string) {
    this.reported.set(t.id, {
      id: t.id,
      name: t.name,
      kind: t.kind,
      role: t.role,
      x: t.x,
      y: t.y,
      heading: t.heading,
      mode: t.mode,
      task: t.task,
      energy: Math.round(t.energy),
      lastHeard: now,
      link,
      via,
      onSite: t.kind === 'worker' ? true : undefined,
    })
    // Store-and-forward: flush anything queued while out of coverage.
    if (t.outbox.length) {
      const delayed = now - t.outbox[0].at > 5000
      for (const item of t.outbox) {
        const u = this.reportedUnits.find((x) => x.id === item.unitId)
        if (u) u.status = item.status
        const verb = item.status === 'piled' ? 'drove pile' : 'set P3 unit'
        this.log('info', `${t.name} ${verb} at ${item.unitId}.`, t.id, item.at)
      }
      if (delayed) this.log('info', `${t.name} reconnected and synced ${t.outbox.length} queued update(s).`, t.id)
      t.outbox = []
    }
    for (const e of t.outEvents) this.log(e.level, e.text, t.id, e.at)
    t.outEvents = []
  }

  private updateUplink(now: number) {
    if (this.tickCount % 50 === 0) {
      this.uplink.online = this.rand() > 0.35
      if (!this.uplink.online) this.log('info', 'Satellite uplink is down. Site keeps running; HQ sync will resume when it returns.')
    }
    if (this.uplink.online && this.tickCount % 30 === 0) this.uplink.lastSync = now
  }

  // ---------- events & snapshot ----------

  private log(level: EventLevel, text: string, assetId?: string, at = Date.now()) {
    this.events.unshift({ id: this.eventSeq++, at, level, text, assetId })
    if (this.events.length > 250) this.events.length = 250
  }

  private publish() {
    this.snapshot = this.buildSnapshot()
    for (const l of this.listeners) l()
  }

  private buildSnapshot(): TwinSnapshot {
    return {
      now: Date.now(),
      siteName: 'Frontier Site 3, Pecos County TX',
      site: SITE,
      blocks: this.blocks,
      units: this.reportedUnits.map((u) => ({ ...u })),
      assets: [...this.reported.values()],
      links: this.links.map((l) => ({ ...l })),
      edgeServer: { ...this.edgeServer },
      rtkBase: { ...this.rtkBase },
      uplink: { ...this.uplink },
      events: this.events.slice(),
      requests: this.requests.map((r) => ({ ...r, target: { ...r.target } })),
    }
  }

  /** Resolve a target like "B4", "row 4 of block B", "C-03-07" or an asset name into map coordinates. */
  resolveTarget(text: string): { label: string; x: number; y: number } | undefined {
    const s = text.trim().toUpperCase()
    const unit = this.truthUnits.find((u) => u.id === s)
    if (unit) return { label: unit.id, x: unit.x, y: unit.y + 10 }
    const m = s.match(/(?:BLOCK\s*)?([A-D])\s*[- ]?\s*(?:ROW\s*)?(\d{1,2})\b/) ?? s.match(/ROW\s*(\d{1,2})\s*(?:OF\s*)?(?:BLOCK\s*)?([A-D])/)
    if (m) {
      const [blockId, rowStr] = /\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]]
      const block = this.blocks.find((b) => b.id === blockId)
      const row = Number(rowStr)
      if (block && row >= 1 && row <= block.rows) {
        return { label: `block ${blockId}, row ${row}`, x: block.x + block.w / 2, y: block.y + 16 + (row - 1) * ROW_GAP + 10 }
      }
    }
    const blockOnly = s.match(/BLOCK\s*([A-D])\b/)
    if (blockOnly) {
      const b = this.blocks.find((x) => x.id === blockOnly[1])!
      return { label: `block ${b.id}`, x: b.x + b.w / 2, y: b.y + b.h + 6 }
    }
    if (s.includes('LAYDOWN')) return { label: 'laydown yard', ...LAYDOWN }
    const asset = [...this.truth.values()].find((t) => t.name.toUpperCase() === s || t.id === s)
    if (asset) return { label: `${asset.name}`, x: asset.x + 15, y: asset.y + 15 }
    return undefined
  }
}

let instance: SimulatedSite | null = null
export function getSimulatedSite() {
  if (!instance) instance = new SimulatedSite()
  return instance
}
