// The site mesh as the edge service reports it (services/edge/edge/mesh).
// Positions are site meters like the rest of the twin (x east, y south).

export type MeshNodeKind = 'robot' | 'relay' | 'gateway' | 'hub'

export interface MeshNode {
  id: string
  kind: MeshNodeKind
  x: number
  y: number
  up: boolean
  /** Has a path to the hub over current links. */
  reachesHub: boolean
}

export interface MeshLink {
  a: string
  b: string
  kind: 'radio' | 'wired'
}

export type TaskState =
  | 'waiting'
  | 'queued'
  | 'announced'
  | 'bidding'
  | 'awaiting'
  | 'assigned'
  | 'in_progress'
  | 'completed'
  | 'no_eligible'
  | 'release_requested'
  | 'cancel_requested'
  | 'cancelled'

export type TaskKind = 'stake' | 'pile' | 'check' | 'survey'

export interface MeshTask {
  id: string
  label: string
  kind: TaskKind
  requires: string
  priority: number
  revision: number
  state: TaskState
  stateLabel: string
  owner?: string
  assignmentId?: string
  roundId?: number
  rounds: number[]
  done: number
  total: number
  x: number
  y: number
  /** Assigned, but the owner hasn't been heard for a while. The task stays assigned. */
  uncertain: boolean
  deferred: boolean
}

export interface Agreement {
  winner?: string
  fp: string
}

export interface MeshRound {
  id: number
  taskId: string
  revision: number
  status: 'open' | 'committed' | 'no_eligible' | 'cancelled'
  outcome?: string
  participants: string[]
  /** Bids the hub has received (score). */
  bids: Record<string, number>
  /** Participants the hub has heard decline. Anyone in neither list hasn't been heard yet. */
  declined: string[]
  reasons: Record<string, string>
  agrees: Record<string, Agreement>
  commit?: { owner: string; assignmentId: string }
  openedAt: number
  closedAt?: number
  stalled: boolean
  ageS: number
  /** Each robot's own proposed winner (from its local copy of the round). */
  proposedByRobot: Record<string, string | undefined>
  /** The tentative winner's own count of matching agreements. */
  tentative?: { robot: string; matching: number; of: number }
}

export interface RobotRoundView {
  id: number
  taskId: string
  status: string
  myBid?: { score?: number; reason: string }
  bidsReceived: number
  participants: number
  proposed?: string
  matching: number
}

export interface RobotView {
  id: string
  tools: string[]
  available: boolean
  assignment?: { id: string; taskId: string; label: string; state: string; done: number; total: number; roundId: number }
  knownTasks: number
  inbox: number
  openRounds: RobotRoundView[]
}

export interface MeshSnapshot {
  now: number
  mode: string
  config: {
    latencyMs: number
    lossPct: number
    robotRangeM: number
    assetRangeM: number
    relayRangeM: number
    retryS: number
    stallS: number
    uncertainS: number
  }
  hub: { online: boolean; currentRound?: number; inbox: number }
  nodes: MeshNode[]
  links: MeshLink[]
  /** Removed links that would otherwise be up. */
  cut: [string, string][]
  /** Every removed link, including ones currently out of range anyway. */
  cutTotal: number
  robots: RobotView[]
  heard: Record<string, { ago: number; available?: boolean; battery?: number }>
  tasks: MeshTask[]
  rounds: MeshRound[]
  counts: Partial<Record<TaskState, number>>
  stateLabels: Record<string, string>
  stats: { sent: number; hops: number; delivered: number; lost: number; broken: number; duplicates: number }
}

export type PacketType = 'TASK_ANNOUNCE' | 'BID' | 'AGREE' | 'COMMIT' | 'STATUS' | 'HEARTBEAT'

/** One packet copy crossing one link. t0/t1 are local ms (performance-free Date.now() time). */
export interface PacketHop {
  id: number
  from: string
  to: string
  t0: number
  t1: number
  type: PacketType
  mid: string
  origin: string
  taskId?: string
  result: 'ok' | 'lost' | 'broken'
}

export const PACKET_TYPES: PacketType[] = ['TASK_ANNOUNCE', 'BID', 'AGREE', 'COMMIT', 'STATUS', 'HEARTBEAT']

export const PACKET_LABEL: Record<PacketType, string> = {
  TASK_ANNOUNCE: 'Announce',
  BID: 'Bid',
  AGREE: 'Agree',
  COMMIT: 'Commit',
  STATUS: 'Status',
  HEARTBEAT: 'Heartbeat',
}

export const PACKET_COLORS: Record<PacketType, string> = {
  TASK_ANNOUNCE: '#2b6cb0',
  BID: '#d08a00',
  AGREE: '#7b4bb3',
  COMMIT: '#2f7d4f',
  STATUS: '#0e7c86',
  HEARTBEAT: '#8b979b',
}
