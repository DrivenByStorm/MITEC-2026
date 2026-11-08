// The physical site the mesh runs on: where people, manual machines, robots and stray objects
// really are, and what the sensors would measure (UWB ranges, lidar detections). Nothing in
// the mesh reads this directly except through those sensors; the hub and the twin only ever
// see what the mesh reports. Manual work (cranes setting units) is tracked here because it is
// reported outside the mesh (spec 1.2: the hub's planning software).

import { RADIO, T } from '../constants.js'
import { dist, pointInPolygon } from '../geometry.js'
import type { LidarObject, NodeId, Pos, UwbRangesP } from '../types.js'

export type PersonKind = 'crew' | 'supervisor'

export interface Person {
  badge: number
  kind: PersonKind
  name: string
  role: string
  /** What the person stays near: a robot or machine id, 'office', 'electrical' or 'roam'. */
  group: string
  offset: Pos
  pos: Pos
  vel: { x: number; y: number } // cm/s
  target?: Pos
  speed: number // cm/s
  onShift: boolean
  supervisorNode?: NodeId
  /** A scripted walk that overrides the group behaviour until it ends. */
  errand?: { to: Pos; until: number; reason: string; then?: () => void }
  inHazardSince?: number
}

export interface Machine {
  badge: number
  id: string
  role: 'Crane' | 'Telehandler' | 'Trencher'
  radiusDm: number
  pos: Pos
  vel: { x: number; y: number }
  speed: number // cm/s
  heading: number
  task: string
  // behaviour state
  workUnit?: string
  dwellUntil?: number
  serves?: string
  leg?: 'laydown' | 'crane'
  waypoints?: Pos[]
  wp?: number
}

export interface StrayObject {
  id: number
  label: string
  pos: Pos
  vel: { x: number; y: number }
  radiusDm: number
  until: number
}

export interface WorldUnit {
  id: string
  block: string
  pos: Pos
  status: 'planned' | 'piled' | 'installed'
}

/** What the mesh can learn about a robot's body from the world (truth). */
export interface RobotBody {
  id: NodeId
  name: string
  pos(): Pos // true position
  vel: { x: number; y: number } // cm/s
  footprint: number // dm
}

export interface WorldSpec {
  units: { id: string; block: string; pos: Pos }[]
  office: Pos
  laydown: Pos
  charger: Pos
  people: Omit<Person, 'pos' | 'vel' | 'offset' | 'speed'>[]
  machines: { badge: number; id: string; role: Machine['role']; radiusDm: number; waypoints?: Pos[]; serves?: string }[]
  hazards: Pos[][]
  bounds: { min: Pos; max: Pos }
}

export class World {
  people = new Map<number, Person>()
  machines = new Map<number, Machine>()
  strays: StrayObject[] = []
  units: WorldUnit[]
  unitById = new Map<string, WorldUnit>()
  robots = new Map<NodeId, RobotBody>()
  lastInstalled?: Pos
  private straySeq = 1
  private readonly rand: () => number
  readonly spec: WorldSpec

  constructor(spec: WorldSpec, rand: () => number) {
    this.spec = spec
    this.rand = rand
    this.units = spec.units.map((u) => ({ ...u, status: 'planned' }))
    for (const u of this.units) this.unitById.set(u.id, u)
    let park = 0
    for (const m of spec.machines) {
      const pos = { x: spec.laydown.x - 150 + (park % 6) * 60, y: spec.laydown.y + 120 - Math.floor(park / 6) * 60 }
      park++
      const speed = m.role === 'Trencher' ? 40 : m.role === 'Crane' ? 140 : 300
      this.machines.set(m.badge, { ...m, pos, vel: { x: 0, y: 0 }, speed, heading: 0, task: 'Available', wp: 0, leg: 'crane' })
    }
    for (const p of spec.people) {
      const a = rand() * Math.PI * 2
      const r = 150 + rand() * 100 // crews work 15–25 m from their machine
      const offset = { x: Math.cos(a) * r, y: Math.sin(a) * r }
      const person: Person = { ...p, offset, pos: { ...spec.office }, vel: { x: 0, y: 0 }, speed: 110 + rand() * 30 }
      person.pos = this.anchorFor(person)
      this.people.set(p.badge, person)
    }
  }

  // ---------- sensing ----------

  /** UWB two-way ranges from an anchor at `at` to every badge in range (8.4). */
  uwbRanges(at: Pos): UwbRangesP['ranges'] {
    const out: UwbRangesP['ranges'] = []
    const max = RADIO.UWB_RANGE_M * 10
    const add = (badge: number, p: Pos) => {
      const d = dist(at, p)
      if (d > max) return
      const quality = Math.round(100 - 50 * (d / max) - this.rand() * 10)
      if (quality < T.UWB_MIN_QUALITY) return
      const noiseCm = (this.rand() - 0.5) * 20 * (1 + d / max)
      out.push({ badge, range: Math.max(0, Math.round(d * 10 + noiseCm)), quality })
    }
    for (const p of this.people.values()) if (p.onShift) add(p.badge, p.pos)
    for (const m of this.machines.values()) add(m.badge, m.pos)
    return out.slice(0, 32)
  }

  /** What a robot's lidar sees, converted to the site frame with the robot's reported pose (8.3). */
  lidar(self: NodeId, truePos: Pos, reportedPos: Pos): LidarObject[] {
    const dx = reportedPos.x - truePos.x
    const dy = reportedPos.y - truePos.y
    const objs: (LidarObject & { d: number })[] = []
    let localId = 1
    const see = (p: Pos, radius: number, vel: { x: number; y: number }, cls: LidarObject['cls']) => {
      const d = dist(truePos, p)
      if (d > T.LIDAR_RANGE_DM) return
      const confidence = Math.round(98 - 50 * (d / T.LIDAR_RANGE_DM) - this.rand() * 8)
      if (confidence < T.LIDAR_MIN_CONFIDENCE) return
      const n = () => (this.rand() - 0.5) * 3
      objs.push({ localId: localId++, pos: { x: Math.round(p.x + dx + n()), y: Math.round(p.y + dy + n()) }, radius: radius, vx: Math.round(vel.x), vy: Math.round(vel.y), cls, confidence, d })
    }
    for (const p of this.people.values()) if (p.onShift) see(p.pos, 4, p.vel, 1)
    for (const m of this.machines.values()) see(m.pos, m.radiusDm, m.vel, 2)
    for (const r of this.robots.values()) if (r.id !== self) see(r.pos(), r.footprint, r.vel, 2)
    for (const s of this.strays) see(s.pos, s.radiusDm, s.vel, 0)
    objs.sort((a, b) => a.d - b.d)
    return objs.slice(0, 32).map(({ d: _d, ...o }) => o) // eslint-disable-line @typescript-eslint/no-unused-vars
  }

  /** Closest person, machine or stray to a point (onboard safety uses this, not the mesh). */
  nearestObstacle(p: Pos, exceptRobot?: NodeId): { d: number; kind: 'person' | 'machine' | 'robot' | 'stray'; speed: number; id: string } | null {
    let best: { d: number; kind: 'person' | 'machine' | 'robot' | 'stray'; speed: number; id: string } | null = null
    const consider = (d: number, kind: 'person' | 'machine' | 'robot' | 'stray', speed: number, id: string) => {
      if (!best || d < best.d) best = { d, kind, speed, id }
    }
    for (const q of this.people.values()) if (q.onShift) consider(dist(p, q.pos), 'person', Math.hypot(q.vel.x, q.vel.y), String(q.badge))
    for (const m of this.machines.values()) consider(dist(p, m.pos) - m.radiusDm, 'machine', Math.hypot(m.vel.x, m.vel.y), String(m.badge))
    for (const r of this.robots.values()) if (r.id !== exceptRobot) consider(dist(p, r.pos()) - r.footprint, 'robot', Math.hypot(r.vel.x, r.vel.y), r.id)
    for (const s of this.strays) consider(dist(p, s.pos) - s.radiusDm, 'stray', Math.hypot(s.vel.x, s.vel.y), `stray-${s.id}`)
    return best
  }

  // ---------- work reported by robots ----------

  markPiled(unitId: string) {
    const u = this.unitById.get(unitId)
    if (u && u.status === 'planned') u.status = 'piled'
  }

  // ---------- movement ----------

  step(now: number, dtMs: number) {
    const dt = dtMs / 1000
    for (const p of this.people.values()) this.stepPerson(p, now, dt)
    for (const m of this.machines.values()) this.stepMachine(m, now, dt)
    for (const s of this.strays) {
      s.pos.x += (s.vel.x * dt) / 10
      s.pos.y += (s.vel.y * dt) / 10
    }
    this.strays = this.strays.filter((s) => s.until > now)
  }

  private moveToward(obj: { pos: Pos; vel: { x: number; y: number } }, to: Pos, speedCms: number, dt: number): boolean {
    const d = dist(obj.pos, to)
    const stepDm = (speedCms * dt) / 10
    if (d <= Math.max(stepDm, 1)) {
      obj.pos = { ...to }
      obj.vel = { x: 0, y: 0 }
      return true
    }
    obj.vel = { x: ((to.x - obj.pos.x) / d) * speedCms, y: ((to.y - obj.pos.y) / d) * speedCms }
    obj.pos = { x: obj.pos.x + ((to.x - obj.pos.x) / d) * stepDm, y: obj.pos.y + ((to.y - obj.pos.y) / d) * stepDm }
    return false
  }

  anchorFor(p: Person): Pos {
    const r = this.robots.get(p.group)
    if (r) {
      const rp = r.pos()
      return { x: rp.x + p.offset.x, y: rp.y + p.offset.y }
    }
    const m = [...this.machines.values()].find((x) => x.id === p.group)
    if (m) return { x: m.pos.x + p.offset.x * 0.8, y: m.pos.y + p.offset.y * 0.8 }
    const o = this.spec.office
    if (p.group === 'office') return { x: o.x + p.offset.x * 0.25, y: o.y + p.offset.y * 0.2 }
    if (p.group === 'electrical') {
      const q = this.lastInstalled ?? o
      return { x: q.x + p.offset.x * 0.5, y: q.y + p.offset.y * 0.5 }
    }
    // roamers: walk between units that are being worked on
    const b = this.spec.bounds
    return { x: b.min.x + (b.max.x - b.min.x) * (0.5 + 0.35 * Math.cos(p.badge + this.phase)), y: b.min.y + (b.max.y - b.min.y) * (0.5 + 0.35 * Math.sin(p.badge * 1.3 + this.phase)) }
  }

  private phase = 0

  private stepPerson(p: Person, now: number, dt: number) {
    this.phase += dt / 600 / Math.max(1, this.people.size)
    if (p.errand) {
      const arrived = this.moveToward(p, p.errand.to, p.speed * 1.2, dt)
      if (arrived || now >= p.errand.until) {
        const then = p.errand.then
        p.errand = undefined
        then?.()
      }
    } else {
      const anchor = this.anchorFor(p)
      if (!p.target || dist(p.pos, p.target) < 5 || this.rand() < dt * 0.08) {
        const a = this.rand() * Math.PI * 2
        const r = 20 + this.rand() * 60
        p.target = { x: anchor.x + Math.cos(a) * r, y: anchor.y + Math.sin(a) * r }
      }
      const far = dist(p.pos, p.target) > 300
      this.moveToward(p, p.target, far ? p.speed * 1.4 : p.speed * 0.6, dt)
    }
    const inHazard = this.spec.hazards.some((h) => pointInPolygon(p.pos, h))
    p.inHazardSince = inHazard ? (p.inHazardSince ?? now) : undefined
  }

  private stepMachine(m: Machine, now: number, dt: number) {
    if (m.dwellUntil && now < m.dwellUntil) {
      m.vel = { x: 0, y: 0 }
      return
    }
    if (m.role === 'Crane') {
      let unit = m.workUnit ? this.unitById.get(m.workUnit) : undefined
      if (unit && m.dwellUntil && now >= m.dwellUntil) {
        unit.status = 'installed'
        this.lastInstalled = unit.pos
        m.workUnit = undefined
        m.dwellUntil = undefined
        unit = undefined
      }
      if (!unit || unit.status !== 'piled') {
        const taken = new Set([...this.machines.values()].filter((x) => x !== m && x.workUnit).map((x) => x.workUnit))
        let best: WorldUnit | undefined
        for (const u of this.units) {
          if (u.status !== 'piled' || taken.has(u.id)) continue
          if (!best || dist(m.pos, u.pos) < dist(m.pos, best.pos)) best = u
        }
        unit = best
        m.workUnit = unit?.id
      }
      if (!unit) {
        m.task = this.units.every((u) => u.status === 'installed') ? 'All units set' : 'Waiting for foundations'
        m.vel = { x: 0, y: 0 }
        return
      }
      const spot = { x: unit.pos.x, y: unit.pos.y - 140 }
      if (this.moveToward(m, spot, m.speed, dt)) {
        m.task = `Setting P3 unit ${unit.id}`
        m.dwellUntil = now + 25_000
      } else {
        m.task = `Moving to ${unit.id}`
      }
      return
    }
    if (m.role === 'Telehandler') {
      const crane = [...this.machines.values()].find((x) => x.id === m.serves)
      if (!crane || !crane.workUnit) {
        m.task = 'Available'
        this.moveToward(m, { x: this.spec.laydown.x + 300, y: this.spec.laydown.y }, m.speed, dt)
        return
      }
      const dest = m.leg === 'crane' ? { x: crane.pos.x + 200, y: crane.pos.y + 100 } : this.spec.laydown
      if (this.moveToward(m, dest, m.speed, dt)) {
        m.task = m.leg === 'crane' ? `Handing unit to ${crane.id}` : 'Loading unit at laydown yard'
        m.dwellUntil = now + 8000
        m.leg = m.leg === 'crane' ? 'laydown' : 'crane'
      } else {
        m.task = m.leg === 'crane' ? `Delivering P3 unit to ${crane.id}` : 'Returning to laydown yard'
      }
      return
    }
    // Trencher: run its waypoints.
    const wps = m.waypoints?.length ? m.waypoints : [this.spec.laydown]
    const wp = wps[(m.wp ?? 0) % wps.length]
    m.task = 'Trenching'
    if (this.moveToward(m, wp, m.speed, dt)) m.wp = ((m.wp ?? 0) + 1) % wps.length
  }

  // ---------- scripted events ----------

  spawnStray(now: number, from: Pos, to: Pos, label = 'Vehicle without a badge') {
    const d = dist(from, to)
    const speed = 200 // cm/s
    const id = this.straySeq++
    this.strays.push({ id, label, pos: { ...from }, vel: { x: ((to.x - from.x) / d) * speed, y: ((to.y - from.y) / d) * speed }, radiusDm: 12, until: now + ((d * 10) / speed) * 1000 })
    return id
  }

  sendOnErrand(badge: number, to: Pos, ms: number, reason: string, then?: () => void) {
    const p = this.people.get(badge)
    if (p) p.errand = { to, until: ms, reason, then }
  }
}
