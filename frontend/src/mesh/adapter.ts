// The twin's data source adapter for the mesh (spec 12.4). This is the one place where
// site-frame decimeters (x east, y north, origin at the benchmark) become twin meters
// (x east, y south, origin at the NW corner), and mesh headings become screen headings.

import type { Alert, ItemEntry, MeshSnapshot, NodeId, Pos, RelayStatus, RobotState, Task, Zone } from './types'
import { ItemState, Liveness, NodeKind, RobotMode, StopReason, TrackKind, ZoneKind } from './types'

export interface MeshConfig {
  twinBenchmarkM: { x: number; y: number }
  coverageRadiusM: number
  hub: NodeId
  gateways: NodeId[]
  relays: { node: NodeId; name: string; pos: Pos; coverageRadiusM: number; gateway?: boolean }[]
  anchors: { node: NodeId; name: string; pos: Pos }[]
  robots: { node: NodeId; name: string; tag: number; footprintDm: number }[]
  supervisors: { node: NodeId; badge: number; name: string }[]
  badges: { badge: number; kind: 'crew' | 'machine' | 'supervisor'; name: string; radiusDm?: number }[]
  buildManager: NodeId
  units: { id: string; block: string; pos: Pos }[]
  tasks: { taskId: number; label: string; unitIds: Record<string, string> }[]
}

export interface PlanningView {
  units: { id: string; status: 'planned' | 'piled' | 'installed' }[]
  tasks: { taskId: number; label: string; tag: number; mode: 'autonomous' | 'manual'; status: 'queued' | 'open' | 'complete' }[]
}

export interface SimStatus {
  simTime: number
  speed: number
  running: boolean
  hubUp: boolean
  txPerSec: number
  lossPerSec: number
  scenario: string
}

export interface XY {
  x: number
  y: number
}

export interface ViewNode extends XY {
  id: NodeId
  kind: NodeKind
  name: string
  liveness: Liveness
  lastHeard: number
  hasPos: boolean
  robot?: RobotState & { headingDeg: number; viaName?: string; viaIsRobot: boolean; footprintM: number }
  relay?: RelayStatus
  supervisor?: { badgeId: number; onShift: boolean }
}

export interface ViewTrack extends XY {
  kind: TrackKind
  id: number
  name: string
  radiusM: number
  accM: number
  stale: boolean
  vx: number
  vy: number
  /** Stop and slow radii robots apply around this track (8.6), meters from its edge. */
  stopM: number
  slowM: number
}

export interface ViewZone {
  zone: Zone
  label: string
  circle?: XY & { r: number }
  polygon?: XY[]
  bufferM: number
  slowM: number
}

export interface ViewItem extends XY {
  taskId: number
  itemId: number
  unitId?: string
  entry: ItemEntry
  winnerName?: string
}

export interface MeshView {
  now: number
  nodes: ViewNode[]
  byId: Map<NodeId, ViewNode>
  links: { a: ViewNode; b: ViewNode; rssi: number }[]
  coverage: (XY & { r: number })[]
  zones: ViewZone[]
  tracks: ViewTrack[]
  tasks: { task: Task; label: string; items: ItemEntry[]; shortfall: number }[]
  items: ViewItem[]
  unitStatus: Map<string, 'planned' | 'piled' | 'installed'>
  itemByUnit: Map<string, ViewItem>
  alerts: Alert[]
  hubLinks: MeshSnapshot['hubLinks']
  toTwin: (p: Pos) => XY
}

export function makeConverter(cfg: Pick<MeshConfig, 'twinBenchmarkM'>) {
  const { x: bx, y: by } = cfg.twinBenchmarkM
  return {
    toTwin: (p: Pos): XY => ({ x: bx + p.x / 10, y: by - p.y / 10 }),
    /** Mesh heading: centidegrees counterclockwise from east. Screen: degrees clockwise from east. */
    heading: (cdeg: number) => (360 - cdeg / 100) % 360,
  }
}

const ZONE_LABEL: Record<ZoneKind, string> = {
  [ZoneKind.NO_GO]: 'No-go',
  [ZoneKind.CRANE]: 'Crane',
  [ZoneKind.WORK_AREA]: 'Crew working',
  [ZoneKind.ROBOT_WORK]: 'Robots working',
  [ZoneKind.HAZARD]: 'Hazard',
  [ZoneKind.COVERAGE]: 'Measured coverage',
}

export function buildView(mesh: MeshSnapshot, planning: PlanningView | null, cfg: MeshConfig): MeshView {
  const { toTwin, heading } = makeConverter(cfg)
  const cfgPos = new Map<NodeId, Pos>()
  for (const r of cfg.relays) cfgPos.set(r.node, r.pos)
  for (const a of cfg.anchors) cfgPos.set(a.node, a.pos)
  const robotIds = new Set(cfg.robots.map((r) => r.node))
  const names = new Map(mesh.nodes.map((n) => [n.id, n.name]))

  const nodes: ViewNode[] = mesh.nodes
    .filter((n) => n.kind !== NodeKind.HUB)
    .map((n) => {
      const p = n.pos ?? cfgPos.get(n.id) ?? null
      const xy = p ? toTwin(p) : { x: 0, y: 0 }
      const v: ViewNode = { id: n.id, kind: n.kind, name: n.name, liveness: n.liveness, lastHeard: n.lastHeard, hasPos: !!p, ...xy, relay: n.relay, supervisor: n.supervisor }
      if (n.robot) {
        const via = n.robot.via
        v.robot = { ...n.robot, headingDeg: heading(n.robot.heading), viaName: via ? names.get(via) : undefined, viaIsRobot: !!via && robotIds.has(via), footprintM: n.robot.footprint / 10 }
      }
      return v
    })
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const links = mesh.links.flatMap((l) => {
    const a = byId.get(l.a)
    const b = byId.get(l.b)
    return a && b ? [{ a, b, rssi: l.rssi }] : []
  })

  // Coverage: circles of relays and gateways that aren't lost (6.4).
  const coverage = cfg.relays
    .filter((r) => byId.get(r.node)?.liveness !== Liveness.LOST)
    .map((r) => ({ ...toTwin(r.pos), r: r.coverageRadiusM ?? cfg.coverageRadiusM }))

  const zones: ViewZone[] = mesh.zones.list.map((z) => {
    const v: ViewZone = { zone: z, label: ZONE_LABEL[z.kind] ?? 'Zone', bufferM: z.buffer / 10, slowM: z.slowBand / 10 }
    if ('circle' in z.shape) v.circle = { ...toTwin(z.shape.circle.center), r: z.shape.circle.radius / 10 }
    else v.polygon = z.shape.polygon.map(toTwin)
    return v
  })

  const badgeName = new Map(cfg.badges.map((b) => [b.badge, b.name]))
  const tracks: ViewTrack[] = mesh.tracks.list.map((t) => {
    const radiusM = t.radius / 10
    const accM = t.acc / 100
    let stopM: number
    let slowM: number
    if (t.kind === TrackKind.CREW || t.kind === TrackKind.SUPERVISOR) {
      stopM = 3 + accM
      slowM = 8
    } else if (t.kind === TrackKind.MACHINE) {
      stopM = radiusM + 3
      slowM = radiusM + 10
    } else {
      stopM = radiusM + 2
      slowM = radiusM + 6
    }
    return { kind: t.kind, id: t.id, name: badgeName.get(t.id) ?? (t.kind === TrackKind.UNKNOWN ? 'Unknown object' : `Badge ${t.id}`), ...toTwin(t.pos), radiusM, accM, stale: t.stale, vx: t.vx / 100, vy: -t.vy / 100, stopM, slowM }
  })

  const labelOf = new Map(cfg.tasks.map((t) => [t.taskId, t.label]))
  const unitOf = new Map<string, string>()
  for (const t of cfg.tasks) for (const [item, unit] of Object.entries(t.unitIds ?? {})) unitOf.set(`${t.taskId}/${item}`, unit)
  const items: ViewItem[] = []
  const itemByUnit = new Map<string, ViewItem>()
  for (const t of mesh.tasks) {
    if (t.task.mode !== 'autonomous') continue
    for (const def of t.task.items) {
      const entry = t.items.find((e) => e.itemId === def.itemId)
      if (!entry) continue
      const unitId = unitOf.get(`${t.task.taskId}/${def.itemId}`)
      const it: ViewItem = { taskId: t.task.taskId, itemId: def.itemId, unitId, entry, winnerName: entry.winNode ? names.get(entry.winNode) : undefined, ...toTwin(def.pos) }
      items.push(it)
      if (unitId && t.task.tag === 1) itemByUnit.set(unitId, it)
    }
  }

  return {
    now: mesh.now,
    nodes,
    byId,
    links,
    coverage,
    zones,
    tracks,
    tasks: mesh.tasks.map((t) => ({ task: t.task, label: labelOf.get(t.task.taskId) ?? `Task ${t.task.taskId}`, items: t.items, shortfall: t.shortfall })),
    items,
    unitStatus: new Map((planning?.units ?? []).map((u) => [u.id, u.status])),
    itemByUnit,
    alerts: mesh.alerts,
    hubLinks: mesh.hubLinks,
    toTwin,
  }
}

// ---------- labels ----------

export const MODE_LABEL: Record<RobotMode, string> = {
  [RobotMode.IDLE]: 'Idle',
  [RobotMode.TO_ITEM]: 'Travelling',
  [RobotMode.WORKING]: 'Working',
  [RobotMode.STOPPED]: 'Stopped',
  [RobotMode.CHARGING]: 'Charging',
  [RobotMode.OUT_OF_SERVICE]: 'Out of service',
  [RobotMode.MANUAL_OVERRIDE]: 'Manual override',
  [RobotMode.HOLD]: 'Holding',
}

export const STOP_LABEL: Record<number, string> = {
  [StopReason.NONE]: '',
  [StopReason.LOST_MESH_CONTACT]: 'lost mesh contact',
  [StopReason.NEAR_MISS]: 'near miss',
  [StopReason.PERSON_DETECTED]: 'person detected',
  [StopReason.COLLISION]: 'collision',
  [StopReason.FAULT]: 'fault',
  [StopReason.ZONE_BREACH]: 'zone breach',
  [StopReason.SUPERVISOR_STOP]: 'supervisor stop',
  [StopReason.LOW_BATTERY]: 'low battery',
  [StopReason.OUT_OF_COVERAGE]: 'out of coverage',
  [StopReason.CREW_HOLD]: 'person or machine nearby',
  [StopReason.PROXIMITY_YIELD]: 'yielding to a robot',
}

/** Stops a supervisor must clear standing at the robot (10.3). */
export const ON_SITE_RESUME = new Set([StopReason.NEAR_MISS, StopReason.PERSON_DETECTED, StopReason.COLLISION, StopReason.FAULT])

export const ALERT_LABEL: Record<number, string> = {
  1: 'Node lost',
  2: 'Near miss',
  3: 'Crew in zone',
  4: 'Stop needs resume',
  5: 'Long crew hold',
  6: 'Position mismatch',
  7: 'Shortfall',
  8: 'Item failed',
  9: 'Duplicate start',
  10: 'Manual task',
  11: 'Sign-off needed',
}

export const ITEM_LABEL: Record<ItemState, string> = {
  [ItemState.OPEN]: 'Open',
  [ItemState.ASSIGNED]: 'Assigned',
  [ItemState.STARTED]: 'Started',
  [ItemState.DONE]: 'Done',
  [ItemState.CANCELLED]: 'Cancelled',
  [ItemState.HELD]: 'Held',
  [ItemState.AWAITING_SIGNOFF]: 'Awaiting sign-off',
}

export const LIVENESS_LABEL: Record<Liveness, string> = { [Liveness.FRESH]: 'live', [Liveness.LATE]: 'late', [Liveness.LOST]: 'lost' }
