// Buildup plan as sent by the edge service (services/edge/edge/buildup/planner.py).

import type { Pt } from '../survey/types'

export interface PlanInput {
  /** Number of P3 units to build (set by the build manager, never by the planner). */
  unitCount: number
  /** People available for the site crew. */
  crewSize: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface PlannedUnit {
  id: string // "B-04-12" = block B, row 4, slot 12
  block: string
  row: number
  slot: number
  x: number
  y: number
}

export interface PlannedBlock extends Rect {
  id: string
  rows: number
  slots: number
  unitCount: number
}

export interface PlannedRelay {
  id: string
  x: number
  y: number
  /** Planned units within machine-link range of this relay. */
  covers: number
  /** Added only to link other relays back to the gateway. */
  linkOnly: boolean
}

export type FleetKind = 'robot' | 'machine' | 'drone' | 'network' | 'wearable'

export interface FleetItem {
  key: 'pile' | 'crane' | 'telehandler' | 'trencher' | 'drone' | 'relay' | 'loraGateway' | 'tag'
  name: string
  kind: FleetKind
  count: number
  /** Plain-language reason for the quantity. */
  why: string
}

export interface CrewRole {
  role: string
  count: number
  /** Which machine or job they work on. */
  with: string
}

export interface StageEstimate {
  stage: 'Piling' | 'Setting units' | 'Trenching' | 'Electrical'
  days: number
  detail: string
}

export interface SitePlan {
  input: PlanInput
  createdAt: number
  units: PlannedUnit[]
  blocks: PlannedBlock[]
  relays: PlannedRelay[]
  gateway: Pt
  office: Rect
  laydown: Rect
  trenchM: number
  meanHaulM: number
  fleet: FleetItem[]
  crew: CrewRole[]
  crewUsed: number
  stages: StageEstimate[]
  totalDays: number
  bottleneck: StageEstimate['stage']
  warnings: string[]
  buildableSlots: number
  /** Area to frame on the map. */
  bounds: Rect
  /** Per-cell ground class for the overlay, base64 bytes: 0 unmapped, 1 buildable, 2 too steep, 3 reserved (setback/office). */
  ground: string
  /** Planning rates and limits the plan was made with (services/edge/edge/buildup/assumptions.py). */
  assumptions: Assumptions
  terrain: { cols: number; rows: number; cellM: number }
}

export interface Assumptions {
  slotSpacingM: number
  rowSpacingM: number
  blockRows: number
  blockSlots: number
  maxSlopePct: number
  maxFootprintReliefM: number
  boundarySetbackM: number
  pilesPerUnit: number
  pileRobotPilesPerDay: number
  pileRobotCrew: number
  craneUnitsPerDay: number
  craneCrew: number
  telehandlerSpeedKmh: number
  telehandlerLoadMin: number
  telehandlerHandoffMin: number
  telehandlerCrew: number
  trencherMPerDay: number
  trencherCrew: number
  electricalUnitsPerDay: number
  electricalCrew: number
  workersPerForeman: number
  workersPerSafetyLead: number
  shiftMinutes: number
}
