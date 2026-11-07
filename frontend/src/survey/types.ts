// Data model for the survey stage of the digital twin.
// Coordinates are site meters: x east, y south, origin at the NW corner of the terrain grid.

export interface Pt {
  x: number
  y: number
}

/**
 * idle      nothing flown yet; waiting for "start survey"
 * scouting  scout drone is flying out and tracing the perimeter
 * surveying survey drones are mapping assigned sections
 * review    a pass is done; the user can map more or move to buildup
 * locked    survey accepted; terrain handed to buildup planning
 */
export type SurveyPhase = 'idle' | 'scouting' | 'surveying' | 'review' | 'locked'

export type DroneStatus = 'docked' | 'outbound' | 'perimeter' | 'mapping' | 'returning' | 'swapping'

export interface SurveyDrone {
  id: string
  role: 'Scout' | 'Survey'
  x: number
  y: number
  heading: number
  battery: number // 0–100
  status: DroneStatus
  task: string
  sectionId?: string
}

export type SectionStatus = 'unassigned' | 'queued' | 'mapping' | 'done'

export interface SurveySection {
  id: string // "B3" = row B, column 3
  x: number
  y: number
  w: number
  h: number
  coverage: number // 0–1 of cells mapped
  status: SectionStatus
  assignedTo: string[]
}

export interface SurveyEvent {
  id: number
  at: number
  level: 'info' | 'warn' | 'alert'
  text: string
}

export interface SurveyStats {
  perimeterAreaKm2: number
  mappedAreaKm2: number
  coverage: number // 0–1 of the area inside the perimeter
  minM?: number
  maxM?: number
  meanM?: number
}

export interface SurveySnapshot {
  now: number
  phase: SurveyPhase
  distanceM: number
  maxDistanceM: number
  launch: Pt
  /** Planned boundary (closed loop). Empty until the survey starts. */
  perimeter: Pt[]
  /** Part of the boundary the scout has actually flown so far. */
  perimeterFlown: Pt[]
  drones: SurveyDrone[]
  sections: SurveySection[]
  /** Sections worth mapping next, best first. Only meaningful in review. */
  suggestions: string[]
  stats: SurveyStats
  /** Elevation range inside the planned perimeter, used for a stable color scale. */
  colorRange: { min: number; max: number }
  events: SurveyEvent[]
  /** Increments whenever new ground is mapped (lets the heat map redraw only when needed). */
  coverageVersion: number
  speedup: number
  terrain: {
    cols: number
    rows: number
    cellM: number
    real: boolean
    sourceLabel: string
    lat0: number
    lon0: number
  }
}
