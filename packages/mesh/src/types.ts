// Mesh types, as defined in section 15 of the mesh specification (v0.1).
// Field names and units match the packet definitions. Positions stay in site-frame decimeters
// (x east, y north, origin at the survey benchmark) until the twin's adapter converts them (12.4).
//
// Messages are object-level: a Packet is a header plus a typed payload object, not bytes.
// The rules that depend on the wire format (hop limits, class checks, payload limits, dedup by
// message ID) are enforced on these objects exactly as the spec states them.

export type NodeId = string // "02:00:00:00:03:01"
export type Dm = number // integer decimeters
export interface Pos {
  x: Dm
  y: Dm
}

export const BROADCAST: NodeId = 'FF:FF:FF:FF:FF:FF'

export enum NodeKind {
  HUB = 1,
  GATEWAY = 2,
  RELAY = 3,
  ROBOT = 4,
  SUPERVISOR = 5,
  ANCHOR = 6,
}
export enum MsgClass {
  SAFETY = 0,
  CONTROL = 1,
  STATUS = 2,
  BULK = 3,
}

export enum MsgType {
  RELAY_BEACON = 0x01,
  RELAY_STATUS = 0x02,
  ROBOT_BEACON = 0x03,
  ROBOT_STATE = 0x10,
  LIDAR_OBJECTS = 0x11,
  UWB_RANGES = 0x12,
  TRACKS = 0x13,
  SUPERVISOR_STATE = 0x14,
  SAFETY_STOP = 0x20,
  NEAR_MISS = 0x21,
  ZONE_BREACH = 0x22,
  ZONE_SET = 0x23,
  NODE_LOST = 0x24,
  NODE_LIST = 0x25,
  TASK = 0x30,
  AUCTION_STATE = 0x31,
  ITEM_STARTED = 0x32,
  ITEM_DONE = 0x33,
  ITEM_RELEASED = 0x34,
  TASK_CANCEL = 0x35,
  ALERT = 0x40,
  ALERT_ACK = 0x41,
  SUPERVISOR_CMD = 0x42,
  CMD_RESULT = 0x43,
  BULK_CHUNK = 0x50,
  BULK_NACK = 0x51,
}

/** Header flags (4.2). */
export const Flag = {
  CLOCK_UNSYNCED: 1 << 0,
  RETRY: 1 << 1,
  LOCAL_LINK: 1 << 2,
} as const

export interface Header {
  version: 1
  type: MsgType
  cls: MsgClass
  flags: number
  initialHops: number
  hopsLeft: number
  srcKind: NodeKind
  src: NodeId
  dst: NodeId // "FF:FF:FF:FF:FF:FF" = broadcast
  boot: number
  seq: number
  gpsTime: number // ms, UTC
}

export interface Packet<P = unknown> {
  h: Header
  p: P
}
export const msgId = (h: Header) => `${h.src}/${h.boot}/${h.seq}`

export enum RobotMode {
  IDLE,
  TO_ITEM,
  WORKING,
  STOPPED,
  CHARGING,
  OUT_OF_SERVICE,
  MANUAL_OVERRIDE,
  HOLD,
}

export enum StopReason {
  NONE = 0,
  LOST_MESH_CONTACT = 1,
  NEAR_MISS = 2,
  PERSON_DETECTED = 3,
  COLLISION = 4,
  FAULT = 5,
  ZONE_BREACH = 6,
  SUPERVISOR_STOP = 7,
  LOW_BATTERY = 8,
  OUT_OF_COVERAGE = 9,
  CREW_HOLD = 20,
  PROXIMITY_YIELD = 21,
}

/** ROBOT_STATE flags (7.1). */
export const RobotFlag = {
  LIGHTS: 1 << 0,
  HORN: 1 << 1,
  SLOW_BAND: 1 << 2,
  TRACKS_STALE: 1 << 3,
  IN_SERVICE: 1 << 4,
} as const

/** ROBOT_BEACON flags (6.2). */
export const BeaconFlag = {
  STOPPED: 1 << 0,
  HOLDING: 1 << 1,
  LIGHTS: 1 << 2,
  COVERAGE_BAND: 1 << 3,
} as const

export interface RobotState {
  tag: number
  mode: RobotMode
  stopId: number
  stopReason: StopReason
  pos: Pos
  heading: number
  speed: number
  posSource: 0 | 1 | 2 | 3
  posAcc: number
  batteryPct: number
  health: 0 | 1 | 2
  taskId: number
  itemId: number
  itemGen: number
  via: NodeId | null
  footprint: Dm
  maxSpeed: number
  flags: number
}

export interface RelayStatus {
  uptimeS: number
  gatewayHops: number
  gpsLocked: boolean
  rx: number[]
  fwd: number[]
  dup: number[]
  hopDrop: number[]
  qDrop: number[] // per class
  neighbors: { node: NodeId; kind: NodeKind; rssi: number; ageMs: number }[]
}

export enum ZoneKind {
  NO_GO = 1,
  CRANE = 2,
  WORK_AREA = 3,
  ROBOT_WORK = 4,
  HAZARD = 5,
  COVERAGE = 6,
}
export interface Zone {
  zoneId: number
  kind: ZoneKind
  appliesTo: { robots: boolean; crew: boolean }
  shape: { circle: { center: Pos; radius: Dm } } | { polygon: Pos[] }
  buffer: Dm
  slowBand: Dm
  until: number
  setBy: NodeId
}

export enum TrackKind {
  CREW = 1,
  SUPERVISOR = 2,
  MACHINE = 3,
  UNKNOWN = 4,
}
export interface Track {
  kind: TrackKind
  id: number
  pos: Pos
  radius: Dm
  vx: number
  vy: number
  acc: number
  stale: boolean
}

export enum ItemState {
  OPEN,
  ASSIGNED,
  STARTED,
  DONE,
  CANCELLED,
  HELD,
  AWAITING_SIGNOFF,
}
export interface TaskItem {
  itemId: number
  pos: Pos
  estDurationS: number
  exclusive: boolean
}
export interface Task {
  taskId: number
  revision: number
  mode: 'autonomous' | 'manual'
  tag: number
  robotCount: number
  priority: number
  minBattery: number
  areaCenter: Pos
  localRadiusM: number
  zoneId: number
  requiresSignoff: boolean
  items: TaskItem[]
}
export interface ItemEntry {
  taskId: number
  itemId: number
  gen: number
  winBid: number
  winNode: NodeId | null
  state: ItemState
}

export enum AlertKind {
  NODE_LOST = 1,
  NEAR_MISS,
  CREW_IN_ZONE,
  STOP_NEEDS_RESUME,
  CREW_HOLD_LONG,
  POSITION_MISMATCH,
  SHORTFALL,
  ITEM_FAILED,
  DUPLICATE_START,
  MANUAL_TASK,
  SIGNOFF_NEEDED,
}
export interface Alert {
  alertId: number
  kind: AlertKind
  severity: 0 | 1 | 2
  pos: Pos
  subjects: string[]
  taskId: number
  itemId: number
  ref: number
  notified: NodeId[] // hub-side: supervisors tried, in order
  ack?: { by: NodeId; action: 0 | 1 | 2; at: number }
}

export interface RobotBeacon {
  pos: Pos
  heading: number
  vx: number
  vy: number
  footprint: Dm
  mode: RobotMode
  meshDepth: number // 0 direct, 1–2 via robots, 255 none
  taskPriority: number
  flags: number
}

export enum Liveness {
  FRESH,
  LATE,
  LOST,
}

/** One entry per transmission or drop. Simulator only. */
export interface MeshTrace {
  t: number // sim time, ms
  msgId: string
  type: MsgType
  cls: MsgClass
  from: NodeId // node transmitting (or dropping)
  to: NodeId | null // receiving node; null for a drop
  result: 'tx' | 'repair_tx' | 'delivered' | 'dup_dropped' | 'hop_dropped' | 'queue_dropped' | 'stale_dropped' | 'lost'
  hopsLeft: number
}

/** What the hub mesh service gives the twin. */
export interface MeshSnapshot {
  now: number
  nodes: {
    id: NodeId
    kind: NodeKind
    name: string
    liveness: Liveness
    lastHeard: number
    pos: Pos | null
    robot?: RobotState
    relay?: RelayStatus
    supervisor?: { badgeId: number; onShift: boolean }
  }[]
  links: { a: NodeId; b: NodeId; rssi: number }[] // from relay neighbor tables
  zones: { version: number; list: Zone[] }
  tracks: { version: number; list: Track[] }
  tasks: { task: Task; items: ItemEntry[]; shortfall: number }[]
  alerts: Alert[]
  hubLinks: { gatewaysUp: NodeId[]; starlinkUp: boolean; lastHqSync: number }
}

export type MeshEvent =
  | { kind: 'packet'; at: number; h: Header; summary: string }
  | { kind: 'trace'; trace: MeshTrace }
  | { kind: 'stop'; at: number; node: NodeId; stopId: number; reason: StopReason; pos: Pos }
  | { kind: 'resume'; at: number; node: NodeId; stopId: number; by: NodeId }
  | { kind: 'node_lost'; at: number; groupId: number; cause: 0 | 1 | 2; causeNode: NodeId | null; nodes: NodeId[] }
  | { kind: 'zone_breach'; at: number; subject: string; zoneId: number; pos: Pos }
  | { kind: 'near_miss'; at: number; eventId: number; pos: Pos; involved: string[] }
  | { kind: 'item'; at: number; entry: ItemEntry }
  | { kind: 'alert'; at: number; alert: Alert }

// ---------------------------------------------------------------------------
// Payloads (section 4.4 onwards). Object-level versions of the packet payloads.
// ---------------------------------------------------------------------------

export interface RelayBeaconP {
  gatewayHops: number
  relayFlags: number // bit 0 GPS_LOCKED, bit 1 WIRED, bit 2 UWB_ANCHOR
  loadPct: number
}

export interface LidarObject {
  localId: number
  pos: Pos
  radius: Dm
  vx: number
  vy: number
  cls: 0 | 1 | 2 | 3 // 0 unknown, 1 person, 2 robot/vehicle, 3 static
  confidence: number
}
export interface LidarObjectsP {
  observerPos: Pos
  observerHeading: number
  posAcc: number
  objects: LidarObject[]
}

export interface UwbRangesP {
  anchorPos: Pos
  anchorAcc: number
  ranges: { badge: number; range: number; quality: number }[] // range in cm
}

export interface TracksP {
  tracksVersion: number
  part: number
  parts: number
  tracks: Track[]
}

export interface SupervisorStateP {
  badgeId: number
  onShift: boolean
  pos: Pos
}

export interface SafetyStopP {
  stopId: number
  stopReason: StopReason
  pos: Pos
  stoppedAt: number
  taskId: number
  itemId: number
  itemGen: number
  detail: number
}

export interface NearMissP {
  eventId: number
  pos: Pos
  involved: { kind: number; id: string; pos: Pos; speed: number }[]
  minDistance: number // cm
}

export interface ZoneBreachP {
  subjectKind: 1 | 2 | 3
  subjectId: string
  zoneId: number
  pos: Pos
  stopId: number
}

export interface ZoneSetP {
  zoneSetVersion: number
  part: number
  parts: number
  zones: Zone[]
}

export interface NodeLostP {
  groupId: number
  cause: 0 | 1 | 2
  causeNode: NodeId | null
  nodes: { node: NodeId; kind: NodeKind; lastPos: Pos | null; lastTask: number; lastItem: number; lastHeardMs: number }[]
}

export interface NodeListEntry {
  node: NodeId
  kind: NodeKind
  tag: number
  inService: boolean
  badge: number
}
export interface NodeListP {
  listVersion: number
  part: number
  parts: number
  hub: NodeId
  nodes: NodeListEntry[]
}

export interface TaskP extends Task {
  slice: number
  slices: number
}

export interface AuctionStateP {
  taskId: number
  revision: number
  firstIndex: number
  entries: ItemEntry[]
}

export interface ItemStartedP {
  taskId: number
  itemId: number
  gen: number
  winBid: number
}
export interface ItemDoneP {
  taskId: number
  itemId: number
  gen: number
  result: 0 | 1
  evidenceTransfer: number
}
export interface ItemReleasedP {
  taskId: number
  itemId: number
  newGen: number
  reason: number
}
export interface TaskCancelP {
  taskId: number
}

export interface AlertP {
  alertId: number
  kind: AlertKind
  severity: 0 | 1 | 2
  pos: Pos
  subjects: string[]
  taskId: number
  itemId: number
  ref: number
}
export interface AlertAckP {
  alertId: number
  action: 0 | 1 | 2
}

export enum Cmd {
  RESUME = 1,
  STOP = 2,
  CANCEL_ITEM = 3,
  REDIRECT = 4,
  RELEASE_ITEM = 5,
  SIGN_OFF = 6,
  ZONE_ADD = 7,
  ZONE_REMOVE = 8,
  OUT_OF_SERVICE = 9,
  RETURN_TO_SERVICE = 10,
  ADMIT_NODE = 11,
  REQUEST_ROBOTS = 12,
}
export interface SupervisorCmdP {
  cmdId: number
  cmd: Cmd
  target: NodeId | null
  args: Record<string, unknown>
  /** Set when the hub sends a command for a supervisor logged in to the twin (12.3). */
  onBehalfOf?: NodeId
}
export interface CmdResultP {
  cmdId: number
  result: 0 | 1 | 2 // ok, rejected, not applicable
  reason: number // 1 not a supervisor, 2 unknown stop, 3 not on site, 4 condition not met, 5 unknown item, 6 bad arguments
}

export interface BulkChunkP {
  transferId: number
  content: 1 | 2 | 3
  chunkIndex: number
  chunkCount: number
  itemRef: { taskId: number; itemId: number }
  bytes: number // size of the data carried (object-level: no actual data)
}
export interface BulkNackP {
  transferId: number
  missing: number[]
}

// ---------------------------------------------------------------------------
// Site configuration (section 13)
// ---------------------------------------------------------------------------

export interface SiteConfig {
  siteId: string
  benchmark: { lat: number; lon: number; altM: number; gridRotationDeg: number }
  /** Benchmark position in twin coordinates (meters from the NW corner, y south). */
  twinBenchmarkM: { x: number; y: number }
  boundary: Pos[]
  hub: NodeId
  gateways: NodeId[]
  coverageRadiusM: number
  hazards: { kind: string; polygon: Pos[] }[]
  relays: { node: NodeId; name: string; pos: Pos; uwbAnchor: boolean; coverageRadiusM: number; gateway?: boolean }[]
  anchors: { node: NodeId; name: string; pos: Pos }[]
  robots: { node: NodeId; name: string; tag: number; footprintDm: number; maxSpeedCms: number; drainPctPerHour: number; workRatePct: number }[]
  bid: { weights: { travel: number; work: number; energy: number; risk: number }; travelCapS: number; workCapS: number }
  supervisors: { node: NodeId; badge: number; name: string }[]
  badges: { badge: number; kind: 'crew' | 'machine' | 'supervisor'; name: string; radiusDm?: number }[]
  tags: { tag: number; name: string }[]
  timers: Record<string, number>
}
