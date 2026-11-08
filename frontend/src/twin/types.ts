import type { MeshSnapshot } from '../mesh/types'

// Data model for the build-site digital twin.
// Coordinates are site-local meters: x grows east, y grows south, origin at the NW corner.

export type UnitStatus = 'planned' | 'staked' | 'piled' | 'installed'

export interface P3Unit {
  id: string // e.g. "B-04-12" = block B, row 4, slot 12
  block: string
  row: number
  slot: number
  x: number
  y: number
  status: UnitStatus
}

export type AssetKind = 'robot' | 'machine' | 'drone' | 'worker' | 'relay'

export type AssetMode =
  | 'autonomous'
  | 'manual'
  | 'idle'
  | 'paused'
  | 'fault'
  | 'offline'

export type LinkLayer = 'mesh' | 'lora' | 'none'

export interface Asset {
  id: string
  name: string
  kind: AssetKind
  /** What kind of machine or job, in plain words ("Pile driver", "Electrician"). */
  role: string
  x: number
  y: number
  heading: number // degrees, 0 = east
  mode: AssetMode
  task: string
  /** Fuel or battery, 0–100. */
  energy: number
  /** ms epoch of the last report the edge server received. */
  lastHeard: number
  link: LinkLayer
  /** Relay this asset is currently reaching the network through, if any. */
  via?: string
  /** For workers: on shift and on site. */
  onSite?: boolean
  /** For workers: riding inside a machine cab (hidden on the map, never triggers proximity stops). */
  inCab?: boolean
}

export interface RelayLink {
  a: string
  b: string
  quality: number // 0–1
}

export type EventLevel = 'info' | 'warn' | 'alert'

export interface TwinEvent {
  id: number
  at: number
  level: EventLevel
  text: string
  assetId?: string
}

export type RequestStatus = 'pending' | 'assigned' | 'en-route' | 'arrived' | 'done' | 'cancelled'

export interface AssetRequest {
  id: string
  createdAt: number
  requestedBy: string
  need: string // "telehandler", "pile reload", ...
  target: { label: string; x: number; y: number }
  status: RequestStatus
  assignedTo?: string
  eta?: number // seconds
}

export interface Block {
  id: string
  x: number
  y: number
  w: number
  h: number
  rows: number
  slots: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface TwinSnapshot {
  now: number
  siteName: string
  site: { w: number; h: number }
  /** Area to frame on the map. */
  view: Rect
  office: Rect
  laydown: Rect
  /** Optional shaded terrain image drawn under the site. */
  terrainImage?: { href: string; x: number; y: number; w: number; h: number }
  blocks: Block[]
  units: P3Unit[]
  assets: Asset[]
  links: RelayLink[]
  edgeServer: { x: number; y: number; online: boolean }
  rtkBase: { x: number; y: number; online: boolean }
  uplink: { online: boolean; lastSync: number }
  events: TwinEvent[]
  requests: AssetRequest[]
  /** The site mesh during construction: nodes, links, tasks, allocation rounds, robot views. */
  mesh?: MeshSnapshot
  /** Site clock and speed dial. */
  clock?: SiteClock
  /** Day-by-day progress against the plan. */
  schedule?: Schedule
}

/** Site time. `ms` is UTC epoch ms on the site's own calendar: format it in UTC. */
export interface SiteClock {
  day: number
  time: string
  ms: number
  speed: number
  /** 0 when paused; the skip speed while skipping to the end of the shift. */
  effectiveSpeed: number
  paused: boolean
  onShift: boolean
  shiftStart: string
  shiftEnd: string
  shiftLeftMin: number
  pauseAtDayEnd: boolean
  skipping: boolean
  speeds: number[]
  surveySpeeds: number[]
  /** Above this speed, packets move too fast to animate. */
  packetsMaxSpeed: number
}

export interface DayCounts {
  staked: number
  piled: number
  set: number
}

export interface ScheduleDay {
  day: number
  /** Today, still running. */
  live: boolean
  /** Units that moved into each stage this day. */
  did: DayCounts
  /** Cumulative at the end of the day (or now, for today). */
  total: DayCounts
  /** Cumulative the plan expects by the end of this day. */
  expected: DayCounts
  tasksDone: number
  rounds: number
  roundsNoEligible: number
  roundsStalled: number
  relayOutages: number
  refusals: number
  proximityStops: number
  summary?: string
}

export interface Schedule {
  units: number
  planDays: number
  /** Expected cumulative units at the end of each planned day. */
  curve: (DayCounts & { day: number })[]
  days: ScheduleDay[]
  complete: boolean
}
