// Planning assumptions for the buildup planner.
//
// These drive how many robots, machines and people the planner asks for. Values marked
// ESTIMATE are reasonable placeholders that should be checked against Exowatt's actual
// P3 foundation design and crew productivity; change them here and every plan updates.

export const ASSUMPTIONS = {
  // ---- layout ----
  /** Spacing between P3 unit centers along a row (east-west), meters. ESTIMATE */
  slotSpacingM: 18,
  /** Spacing between rows (north-south), meters. ESTIMATE */
  rowSpacingM: 32,
  /** Units per block: rows × slots. Blocks group work and name areas (A, B, C...). */
  blockRows: 10,
  blockSlots: 18,
  /** Steepest ground a P3 unit can sit on without major grading. ESTIMATE */
  maxSlopePct: 5,
  /** Most elevation change allowed under one unit's footprint, meters. ESTIMATE */
  maxFootprintReliefM: 1.2,
  /** Keep units this far inside the surveyed boundary, meters. ESTIMATE */
  boundarySetbackM: 60,

  // ---- foundations ----
  /** Piles per P3 unit. ESTIMATE: depends on Exowatt's foundation design. */
  pilesPerUnit: 8,
  /** Piles one pile-driving robot installs per 10 h shift. Built Robotics quotes 300+ for the RPD 35. */
  pileRobotPilesPerDay: 300,
  /** People per pile-driving robot (robot operator + pile loader), per Built Robotics' two-person crew. */
  pileRobotCrew: 2,

  // ---- setting units ----
  /** P3 units one crane sets per shift. ESTIMATE (~1 every 35–40 min). */
  craneUnitsPerDay: 16,
  /** Crane operator, two riggers, signal person. */
  craneCrew: 4,

  // ---- delivery ----
  /** Telehandler travel speed loaded/unloaded on site roads, km/h. ESTIMATE */
  telehandlerSpeedKmh: 12,
  /** Minutes to pick up a unit at the laydown yard and to hand it to the crane. ESTIMATE */
  telehandlerLoadMin: 8,
  telehandlerHandoffMin: 5,
  telehandlerCrew: 1,

  // ---- trenching & electrical ----
  /** Meters of cable trench one trencher cuts per shift. ESTIMATE */
  trencherMPerDay: 500,
  trencherCrew: 2,
  /** Units one two-person electrical crew connects and commissions per shift. ESTIMATE */
  electricalUnitsPerDay: 8,
  electricalCrew: 2,

  // ---- supervision ----
  /** One foreman per this many field workers. */
  workersPerForeman: 15,
  /** One safety lead per this many field workers (at least one on site). */
  workersPerSafetyLead: 40,

  // ---- schedule ----
  shiftMinutes: 600,
}

export type Assumptions = typeof ASSUMPTIONS
