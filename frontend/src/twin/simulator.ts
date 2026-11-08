// Simulated construction of an approved buildup plan, from bare ground to installed units.
//
// It keeps two copies of the world:
//   - `truth`: where things really are and what they are really doing;
//   - `reported`: what the digital twin has actually heard over the radio.
// Reports only arrive while an asset has a network path to the gateway, so an asset
// that loses coverage freezes (goes stale) on the map, keeps working, and flushes its
// queued results when it reconnects (store-and-forward). The relays, fleet and crew
// are exactly the ones the buildup planner chose.

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
import type { SitePlan } from '../buildup/types'
import { ASSET_RANGE_M, LORA_RANGE_M, RELAY_RANGE_M } from './network'

const PROXIMITY_STOP_M = 12

type Role = 'Pile driver' | 'Crane' | 'Telehandler' | 'Trencher' | 'Survey drone' | 'Solar relay mast' | 'Gateway (wired to edge server)' | string

interface Truth {
  id: string
  name: string
  kind: AssetKind
  role: Role
  x: number
  y: number
  heading: number
  mode: AssetMode
  baseMode: AssetMode
  task: string
  energy: number
  speed: number
  dwell: number
  holdUntil: number
  target?: { x: number; y: number }
  waypoints?: { x: number; y: number }[]
  wpIndex: number
  // work
  block?: string
  workUnit?: string
  serves?: string // telehandler → crane id
  shuttleLeg?: 'laydown' | 'crane'
  requestId?: string
  // workers
  group?: string
  anchorOffset?: { x: number; y: number }
  inCab?: boolean
  // relays
  failedUntil?: number
  // store-and-forward
  outbox: { unitId: string; status: UnitStatus; at: number }[]
  outEvents: { level: EventLevel; text: string; at: number }[]
  lastLoraReport: number
  lastVia?: string
}

type Listener = () => void

const SURNAMES = ['Reyes', 'Okafor', 'Lindqvist', 'Ortiz', 'Patel', 'Begay', 'Nguyen', 'Castillo', 'Hale', 'Andrade', 'Whitehorse', 'Kowalski', 'Mensah', 'Duarte', 'Ibarra', 'Sato', 'Haddad', 'Morales', 'Becker', 'Yazzie', 'Ferreira', 'Ochoa', 'Brennan', 'Vargas', 'Chen', 'Silva', 'Tran', 'Navarro', 'Abbott', 'Romero', 'Kaur', 'Delgado', 'Murphy', 'Salazar', 'Novak', 'Aguilar', 'Jensen', 'Fuentes', 'Rossi', 'Garza']
const INITIALS = 'ABCDEFGHJKLMNPRSTW'

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
  private blockOrder: string[] = []
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
  private lastInstalled?: { x: number; y: number }
  private snapshot: TwinSnapshot

  readonly edgeServer: { x: number; y: number; online: boolean }
  readonly rtkBase: { x: number; y: number; online: boolean }
  private readonly laydownPt: { x: number; y: number }
  private readonly plan: SitePlan

  constructor(plan: SitePlan) {
    this.plan = plan
    const o = plan.office
    this.edgeServer = { x: o.x + o.w - 30, y: o.y + 45, online: true }
    this.rtkBase = { x: o.x + o.w - 30, y: o.y + o.h - 30, online: true }
    this.laydownPt = { x: plan.laydown.x + plan.laydown.w / 2, y: plan.laydown.y + plan.laydown.h / 2 }
    this.buildSite()
    this.buildAssets()
    this.computeNetwork()
    const now = Date.now()
    for (const t of this.truth.values()) this.report(t, now, t.kind === 'worker' ? 'lora' : 'mesh')
    this.log('info', `Construction started: ${plan.units.length} P3 units in ${plan.blocks.length} block${plan.blocks.length === 1 ? '' : 's'}, ${plan.relays.length} relays, crew of ${plan.crewUsed}.`)
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
      t.mode = 'paused'
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
      if (t) this.releaseFromRequest(t)
    }
    this.log('info', `${req.id} cancelled.`)
    this.publish()
    return `Cancelled ${req.id}.`
  }

  /** Resolve "B7" / "block B row 7" / "C-03-07" / "laydown" / an asset name into map coordinates. */
  resolveTarget(text: string): { label: string; x: number; y: number } | undefined {
    const s = text.trim().toUpperCase()
    const unit = this.truthUnits.find((u) => u.id === s)
    if (unit) return { label: unit.id, x: unit.x, y: unit.y + 10 }
    if (s.includes('LAYDOWN')) return { label: 'laydown yard', ...this.laydownPt }
    if (s.includes('OFFICE')) return { label: 'site office', x: this.plan.office.x + this.plan.office.w / 2, y: this.plan.office.y + this.plan.office.h / 2 }
    const m = s.match(/^(?:BLOCK\s*)?([A-Z]{1,2})\s*-?\s*(?:ROW\s*)?(\d{1,2})$/) ?? s.match(/^ROW\s*(\d{1,2})\s*(?:OF\s*)?(?:BLOCK\s*)?([A-Z]{1,2})$/)
    if (m) {
      const [blockId, rowStr] = /\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]]
      const row = this.truthUnits.filter((u) => u.block === blockId && u.row === Number(rowStr))
      if (row.length) {
        return { label: `block ${blockId}, row ${Number(rowStr)}`, x: row.reduce((t, u) => t + u.x, 0) / row.length, y: row[0].y + 12 }
      }
    }
    const blockOnly = s.match(/^BLOCK\s*([A-Z]{1,2})$/)
    if (blockOnly) {
      const b = this.blocks.find((x) => x.id === blockOnly[1])
      if (b) return { label: `block ${b.id}`, x: b.x + b.w / 2, y: b.y + b.h + 6 }
    }
    const asset = [...this.truth.values()].find((t) => t.name.toUpperCase() === s || t.id === s)
    if (asset) return { label: asset.name, x: asset.x + 15, y: asset.y + 15 }
    return undefined
  }

  // ---------- site construction ----------

  private buildSite() {
    this.blocks = this.plan.blocks.map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, rows: b.rows, slots: b.slots }))
    this.blockOrder = this.plan.blocks.map((b) => b.id)
    this.truthUnits = this.plan.units.map((u) => ({ ...u, status: 'planned' as UnitStatus }))
    this.reportedUnits = this.truthUnits.map((u) => ({ ...u }))
  }

  private addTruth(p: Partial<Truth> & Pick<Truth, 'id' | 'name' | 'kind' | 'role' | 'x' | 'y'>) {
    this.truth.set(p.id, {
      heading: 0,
      mode: 'idle',
      baseMode: p.mode ?? 'idle',
      task: 'Available',
      energy: 65 + this.rand() * 30,
      speed: 5,
      dwell: 0,
      holdUntil: 0,
      wpIndex: 0,
      outbox: [],
      outEvents: [],
      lastLoraReport: 0,
      ...p,
    })
  }

  private count(key: string) {
    return this.plan.fleet.find((f) => f.key === key)?.count ?? 0
  }

  private parking(i: number) {
    const L = this.plan.laydown
    const perRow = Math.max(1, Math.floor((L.w - 30) / 32))
    return { x: L.x + 20 + (i % perRow) * 32, y: L.y + 30 + Math.floor(i / perRow) * 28 }
  }

  private buildAssets() {
    for (const r of this.plan.relays) {
      this.addTruth({ id: r.id, name: r.id, kind: 'relay', role: 'Solar relay mast', x: r.x, y: r.y, mode: 'autonomous', task: 'Relaying', energy: 70 + this.rand() * 30 })
    }
    const g = this.plan.gateway
    this.addTruth({ id: 'GW', name: 'Gateway', kind: 'relay', role: 'Gateway (wired to edge server)', x: g.x, y: g.y, mode: 'autonomous', task: 'Relaying', energy: 100 })

    let park = 0
    const nPile = this.count('pile')
    const nCrane = this.count('crane')
    const nTH = this.count('telehandler')
    const nTR = this.count('trencher')
    for (let i = 1; i <= nPile; i++) {
      this.addTruth({ id: `RPD-${i}`, name: `RPD-${i}`, kind: 'robot', role: 'Pile driver', ...this.parking(park++), mode: 'autonomous', speed: 9, task: 'Heading to first block' })
    }
    for (let i = 1; i <= nCrane; i++) {
      this.addTruth({ id: `CR-${i}`, name: `CR-${i}`, kind: 'machine', role: 'Crane', ...this.parking(park++), mode: 'manual', speed: 7, task: 'Waiting for foundations' })
    }
    for (let i = 1; i <= nTH; i++) {
      this.addTruth({ id: `TH-${i}`, name: `TH-${i}`, kind: 'machine', role: 'Telehandler', ...this.parking(park++), mode: 'manual', speed: 10, serves: `CR-${((i - 1) % Math.max(1, nCrane)) + 1}`, shuttleLeg: 'crane', task: 'Loading first unit' })
    }
    // Trenchers: split blocks between them; each runs a spine trench down the west edge of its blocks.
    for (let i = 1; i <= nTR; i++) {
      const mine = this.plan.blocks.filter((_, k) => k % nTR === i - 1)
      const wps = mine.flatMap((b) => [{ x: b.x - 5, y: b.y }, { x: b.x - 5, y: b.y + b.h }])
      this.addTruth({
        id: `TR-${i}`, name: `TR-${i}`, kind: 'machine', role: 'Trencher', ...this.parking(park++), mode: 'manual', speed: 1.5,
        waypoints: wps.length ? wps : [this.laydownPt], task: `Trenching block${mine.length > 1 ? 's' : ''} ${mine.map((b) => b.id).join(', ')}`,
      })
    }
    // Drone: back-and-forth progress survey over the planned area.
    const xs = this.plan.units.map((u) => u.x)
    const ys = this.plan.units.map((u) => u.y)
    if (this.count('drone') && xs.length) {
      const x0 = Math.min(...xs) - 20, x1 = Math.max(...xs) + 20, y0 = Math.min(...ys) - 20, y1 = Math.max(...ys) + 20
      const lanes = Math.max(2, Math.round((y1 - y0) / 70))
      const wps: { x: number; y: number }[] = []
      for (let k = 0; k <= lanes; k++) {
        const y = y0 + ((y1 - y0) * k) / lanes
        wps.push(k % 2 ? { x: x1, y } : { x: x0, y }, k % 2 ? { x: x0, y } : { x: x1, y })
      }
      this.addTruth({ id: 'DR-1', name: 'DR-1', kind: 'drone', role: 'Survey drone', x: this.plan.office.x + 20, y: this.plan.office.y + 20, mode: 'autonomous', speed: 14, waypoints: wps, task: 'Daily progress survey' })
    }

    // Crew: every person the plan calls for, attached to the machine or job they work on.
    let w = 0
    const nextName = () => {
      const n = `${INITIALS[(w * 7) % INITIALS.length]}. ${SURNAMES[w % SURNAMES.length]}`
      w++
      return n
    }
    const addWorker = (role: string, group: string, inCab = false) => {
      const id = `W-${String(w + 1).padStart(2, '0')}`
      // Crews work at a set distance from their machine (outside its swing/stop zone).
      const a = this.rand() * Math.PI * 2
      const r = 32 + this.rand() * 20
      const ox = Math.cos(a) * r
      const oy = Math.sin(a) * r
      const start = this.anchorFor(group, { x: ox, y: oy })
      this.addTruth({ id, name: nextName(), kind: 'worker', role, x: start.x, y: start.y, mode: 'manual', speed: 4, group, anchorOffset: inCab ? { x: 0, y: 0 } : { x: ox, y: oy }, inCab, task: role, energy: 55 + this.rand() * 45 })
    }
    for (const r of this.plan.crew) {
      for (let k = 0; k < r.count; k++) {
        switch (r.role) {
          case 'Robot operator':
          case 'Pile loader':
            addWorker(r.role, `RPD-${(k % Math.max(1, nPile)) + 1}`)
            break
          case 'Crane operator':
            addWorker(r.role, `CR-${(k % Math.max(1, nCrane)) + 1}`, true)
            break
          case 'Rigger':
          case 'Signal person':
            addWorker(r.role, `CR-${(k % Math.max(1, nCrane)) + 1}`)
            break
          case 'Telehandler operator':
            addWorker(r.role, `TH-${(k % Math.max(1, nTH)) + 1}`, true)
            break
          case 'Trencher operator':
            addWorker(r.role, `TR-${(k % Math.max(1, nTR)) + 1}`, true)
            break
          case 'Trench laborer':
            addWorker(r.role, `TR-${(k % Math.max(1, nTR)) + 1}`)
            break
          case 'Electrician':
            addWorker(r.role, 'electrical')
            break
          case 'Drone pilot':
            addWorker(r.role, 'office')
            break
          default:
            addWorker(r.role, 'roam')
        }
      }
    }
  }

  private anchorFor(group: string, offset: { x: number; y: number }) {
    const m = this.truth.get(group)
    if (m) return { x: m.x + offset.x, y: m.y + offset.y }
    const o = this.plan.office
    if (group === 'office') return { x: o.x + o.w / 2 + offset.x * 0.6, y: o.y + o.h / 2 + offset.y * 0.4 }
    if (group === 'electrical') {
      const p = this.lastInstalled ?? { x: o.x + o.w / 2, y: o.y + o.h / 2 }
      return { x: p.x + offset.x * 1.5, y: p.y + offset.y }
    }
    // roamers drift around the active area
    const b = this.plan.bounds
    const phase = this.tickCount / 60
    return { x: b.x + b.w / 2 + Math.cos(phase) * b.w * 0.3 + offset.x, y: b.y + b.h / 2 + Math.sin(phase * 1.3) * b.h * 0.3 + offset.y }
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
    this.checkComplete()
    this.publish()
  }

  private completeLogged = false
  private checkComplete() {
    if (this.completeLogged || !this.truthUnits.length) return
    if (this.reportedUnits.every((u) => u.status === 'installed')) {
      this.completeLogged = true
      this.log('info', `All ${this.reportedUnits.length} P3 units set. Construction complete; electrical commissioning continues.`)
    }
  }

  private updateRelays(now: number) {
    // Scripted demo: 40 s in, the relay RPD-1 is using fails. Redundant coverage should carry it.
    if (this.tickCount === 40) {
      const rpd = this.truth.get('RPD-1')
      const via = rpd && this.reported.get('RPD-1')?.via
      const relay = via && via !== 'GW' ? this.truth.get(via) : [...this.truth.values()].find((t) => t.kind === 'relay' && t.id !== 'GW')
      if (relay) this.failRelay(relay, now, 50)
    }
    for (const t of this.truth.values()) {
      if (t.kind !== 'relay' || t.id === 'GW') continue
      if (!t.failedUntil && this.tickCount > 120 && this.rand() < 0.0006) this.failRelay(t, now, 40 + this.rand() * 40)
      if (t.failedUntil && now >= t.failedUntil) {
        t.failedUntil = undefined
        t.mode = 'autonomous'
        t.task = 'Relaying'
        this.log('info', `${t.name} is back online. Mesh routes restored.`, t.id)
      }
      t.energy = Math.max(5, Math.min(100, t.energy + (this.rand() - 0.52) * 0.4))
    }
  }

  private failRelay(t: Truth, now: number, seconds: number) {
    if (t.failedUntil) return
    t.failedUntil = now + seconds * 1000
    t.mode = 'offline'
    t.task = 'No heartbeat'
    this.log('alert', `${t.name} stopped sending heartbeats. Traffic is rerouting around it.`, t.id)
  }

  private stepAsset(t: Truth, now: number) {
    if (t.inCab) {
      const m = this.truth.get(t.group!)
      if (m) { t.x = m.x; t.y = m.y }
      return
    }
    if (t.mode === 'paused') return
    if (this.tickCount < t.holdUntil) return
    t.energy = Math.max(8, t.energy - (t.kind === 'worker' ? 0.01 : 0.03))
    // A crane or trencher answering a request drives there (in updateRequests) instead of its usual work.
    if (t.requestId && t.role !== 'Telehandler') return
    switch (t.role) {
      case 'Pile driver':
        return this.stepPileDriver(t, now)
      case 'Crane':
        return this.stepCrane(t, now)
      case 'Telehandler':
        return this.stepTelehandler(t)
      case 'Trencher':
      case 'Survey drone':
        return this.stepWaypoints(t)
    }
    if (t.kind === 'worker') this.stepWorker(t)
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

  private claimed(role: Role, self: Truth) {
    return new Set([...this.truth.values()].filter((o) => o !== self && o.role === role && o.workUnit).map((o) => o.workUnit!))
  }

  private stepPileDriver(t: Truth, now: number) {
    const taken = this.claimed('Pile driver', t)
    let unit = t.workUnit ? this.truthUnits.find((u) => u.id === t.workUnit) : undefined
    if (!unit || unit.status !== 'planned') {
      t.workUnit = undefined
      t.dwell = 0
      // Stay in our block while it has work; otherwise take the next block nobody else is on.
      const otherBlocks = new Set([...this.truth.values()].filter((o) => o !== t && o.role === 'Pile driver' && o.block).map((o) => o.block))
      const hasWork = (b?: string) => !!b && this.truthUnits.some((u) => u.block === b && u.status === 'planned' && !taken.has(u.id))
      if (!hasWork(t.block)) {
        t.block = this.blockOrder.find((b) => !otherBlocks.has(b) && hasWork(b)) ?? this.blockOrder.find((b) => hasWork(b))
      }
      unit = this.truthUnits.find((u) => u.block === t.block && u.status === 'planned' && !taken.has(u.id))
      t.workUnit = unit?.id
    }
    if (!unit) {
      t.mode = 'idle'
      t.task = 'All foundations driven'
      return
    }
    t.mode = 'autonomous'
    if (this.moveToward(t, unit.x, unit.y + 7)) {
      t.task = `Driving piles at ${unit.id}`
      if (++t.dwell >= 3) {
        unit.status = 'piled'
        t.outbox.push({ unitId: unit.id, status: 'piled', at: now })
        if (this.rand() < 0.05) t.outEvents.push({ level: 'warn', text: `${t.name} hit refusal at ${unit.id}; pile flagged for engineer review.`, at: now })
        t.workUnit = undefined
        t.dwell = 0
      }
    } else {
      t.task = `Moving to ${unit.id}`
    }
  }

  private stepCrane(t: Truth, now: number) {
    const taken = this.claimed('Crane', t)
    let unit = t.workUnit ? this.truthUnits.find((u) => u.id === t.workUnit) : undefined
    if (!unit || unit.status !== 'piled') {
      t.dwell = 0
      unit = this.truthUnits
        .filter((u) => u.status === 'piled' && !taken.has(u.id))
        .reduce<P3Unit | undefined>((best, u) => (!best || dist(t.x, t.y, u.x, u.y) < dist(t.x, t.y, best.x, best.y) ? u : best), undefined)
      t.workUnit = unit?.id
    }
    if (!unit) {
      t.mode = 'idle'
      t.task = this.truthUnits.every((u) => u.status === 'installed') ? 'All units set' : 'Waiting for foundations'
      return
    }
    t.mode = 'manual'
    if (this.moveToward(t, unit.x, unit.y + 14)) {
      t.task = `Setting P3 unit ${unit.id}`
      if (++t.dwell >= 5) {
        unit.status = 'installed'
        this.lastInstalled = { x: unit.x, y: unit.y }
        t.outbox.push({ unitId: unit.id, status: 'installed', at: now })
        t.workUnit = undefined
        t.dwell = 0
      }
    } else {
      t.task = `Moving to ${unit.id}`
    }
  }

  private stepTelehandler(t: Truth) {
    if (t.requestId) {
      t.mode = 'manual'
      if (t.target) this.moveToward(t, t.target.x, t.target.y)
      return
    }
    const crane = t.serves ? this.truth.get(t.serves) : undefined
    if (!crane || crane.mode === 'idle') {
      // Nothing to feed: park at the laydown yard.
      t.mode = 'idle'
      t.task = 'Available'
      this.moveToward(t, this.laydownPt.x + 30, this.laydownPt.y)
      return
    }
    const dest = t.shuttleLeg === 'crane' ? { x: crane.x + 20, y: crane.y - 10 } : this.laydownPt
    t.mode = 'manual'
    if (this.moveToward(t, dest.x, dest.y)) {
      t.task = t.shuttleLeg === 'crane' ? `Handing unit to ${crane.name}` : 'Loading unit at laydown yard'
      if (++t.dwell >= 3) {
        t.shuttleLeg = t.shuttleLeg === 'crane' ? 'laydown' : 'crane'
        t.dwell = 0
      }
    } else {
      t.task = t.shuttleLeg === 'crane' ? `Delivering P3 unit to ${crane.name}` : 'Returning to laydown yard'
    }
  }

  private stepWaypoints(t: Truth) {
    const wps = t.waypoints!
    const wp = wps[t.wpIndex % wps.length]
    if (this.moveToward(t, wp.x, wp.y)) t.wpIndex = (t.wpIndex + 1) % wps.length
  }

  private stepWorker(t: Truth) {
    const anchor = this.anchorFor(t.group!, t.anchorOffset!)
    if (!t.target || dist(t.x, t.y, t.target.x, t.target.y) < 2 || this.rand() < 0.05) {
      const r = 3 + this.rand() * 10
      const a = this.rand() * Math.PI * 2
      t.target = { x: anchor.x + Math.cos(a) * r, y: anchor.y + Math.sin(a) * r }
    }
    this.moveToward(t, t.target.x, t.target.y)
  }

  /** UWB proximity: acts locally on the machine, no network needed. */
  private checkProximity(now: number) {
    const workers = [...this.truth.values()].filter((t) => t.kind === 'worker' && !t.inCab)
    const movers = [...this.truth.values()].filter((t) => t.kind === 'robot' || t.kind === 'machine')
    for (const m of movers) {
      for (const w of workers) {
        if (dist(m.x, m.y, w.x, w.y) > PROXIMITY_STOP_M) continue
        const key = `${m.id}:${w.id}`
        if ((this.proximityCooldown.get(key) ?? 0) > this.tickCount) continue
        this.proximityCooldown.set(key, this.tickCount + 120)
        m.holdUntil = this.tickCount + 3
        m.outEvents.push({ level: 'warn', text: `Proximity stop: ${m.name} held for ${w.name} (${w.role}).`, at: now })
      }
    }
  }

  // ---------- requests ----------

  private matchRole(need: string): Role {
    const n = need.toLowerCase()
    if (n.includes('crane')) return 'Crane'
    if (n.includes('trench')) return 'Trencher'
    return 'Telehandler'
  }

  private assignRequest(req: AssetRequest) {
    const role = this.matchRole(req.need)
    const pick = [...this.truth.values()]
      .filter((t) => t.role === role && !t.requestId && t.mode !== 'paused' && t.mode !== 'fault')
      .sort((a, b) => Number(b.mode === 'idle') - Number(a.mode === 'idle') || dist(a.x, a.y, req.target.x, req.target.y) - dist(b.x, b.y, req.target.x, req.target.y))[0]
    if (!pick) {
      this.log('warn', `${req.id}: no ${role.toLowerCase()} available. Request is waiting in the queue.`)
      return
    }
    pick.requestId = req.id
    pick.target = { x: req.target.x, y: req.target.y }
    pick.workUnit = undefined
    pick.task = `${req.id}: heading to ${req.target.label}`
    req.assignedTo = pick.id
    req.status = 'assigned'
    req.eta = Math.round(dist(pick.x, pick.y, req.target.x, req.target.y) / pick.speed)
    this.log('info', `${req.id} assigned to ${pick.name} (ETA ${req.eta} s).`, pick.id)
  }

  private releaseFromRequest(t: Truth) {
    t.requestId = undefined
    t.target = undefined
    t.dwell = 0
    t.mode = t.baseMode
    t.task = 'Available'
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
      // Cranes and trenchers on a request just drive there; telehandlers move in stepTelehandler.
      if (t.role !== 'Telehandler' && t.target && t.mode !== 'paused') this.moveToward(t, t.target.x, t.target.y)
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
      } else if (req.status === 'arrived' && ++t.dwell >= 15) {
        req.status = 'done'
        this.releaseFromRequest(t)
        this.log('info', `${req.id} done. ${t.name} is available again.`, t.id)
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
        const d = dist(relays[i].x, relays[i].y, relays[j].x, relays[j].y)
        if (d <= RELAY_RANGE_M) links.push({ a: relays[i].id, b: relays[j].id, quality: Math.max(0.2, 1 - (d / RELAY_RANGE_M) * 0.7) })
      }
    }
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
    const rerouted: string[] = []
    for (const t of this.truth.values()) {
      if (t.kind === 'relay') {
        if (this.relayOnline(t) && this.reachableRelays.has(t.id)) this.report(t, now, 'mesh')
        else this.markLink(t.id, 'none')
        continue
      }
      if (t.kind === 'worker') {
        const moving = t.target ? dist(t.x, t.y, t.target.x, t.target.y) > 2 : false
        const relay = this.bestRelay(t, LORA_RANGE_M)
        if (relay && now - t.lastLoraReport >= (moving ? 3000 : 8000) && this.rand() < 0.9) {
          t.lastLoraReport = now
          this.report(t, now, 'lora', relay.id)
        }
        continue
      }
      const relay = this.bestRelay(t, ASSET_RANGE_M)
      if (!relay) {
        this.markLink(t.id, 'none')
        continue
      }
      if (t.lastVia && t.lastVia !== relay.id && this.truth.get(t.lastVia)?.mode === 'offline') rerouted.push(`${t.name} via ${relay.name}`)
      t.lastVia = relay.id
      if (this.rand() < 0.94) this.report(t, now, 'mesh', relay.id)
    }
    if (rerouted.length) {
      this.log('info', `Rerouted around the failed relay with no loss of contact: ${rerouted.join(', ')}. The plan's two-relay coverage at work.`)
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
      inCab: t.inCab || undefined,
    })
    if (t.outbox.length) {
      const delayed = now - t.outbox[0].at > 5000
      for (const item of t.outbox) {
        const u = this.reportedUnits.find((x) => x.id === item.unitId)
        if (u) u.status = item.status
        this.log('info', `${t.name} ${item.status === 'piled' ? 'drove piles' : 'set P3 unit'} at ${item.unitId}.`, t.id, item.at)
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
    const { cols, rows, cellM } = this.plan.terrain
    return {
      now: Date.now(),
      siteName: 'New site, Pecos County TX',
      site: { w: cols * cellM, h: rows * cellM },
      view: { ...this.plan.bounds },
      office: { ...this.plan.office },
      laydown: { ...this.plan.laydown },
      terrainImage: this.plan.terrainImage,
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
}
