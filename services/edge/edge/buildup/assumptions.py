"""Planning assumptions for the buildup planner.

These drive how many robots, machines and people the planner asks for. Values marked
ESTIMATE are reasonable placeholders that should be checked against Exowatt's actual P3
foundation design and crew productivity; change them here and every plan updates.
Keys are camelCase because the dict is sent as-is to the UI's Assumptions tab.
"""

ASSUMPTIONS: dict[str, float] = {
    # ---- layout ----
    "slotSpacingM": 18,  # spacing between P3 unit centers along a row (east-west), m. ESTIMATE
    "rowSpacingM": 32,  # spacing between rows (north-south), m. ESTIMATE
    "blockRows": 10,  # units per block: rows x slots; blocks group work and name areas (A, B, C...)
    "blockSlots": 18,
    "maxSlopePct": 5,  # steepest ground a P3 unit can sit on without major grading. ESTIMATE
    "maxFootprintReliefM": 1.2,  # most elevation change under one unit's footprint, m. ESTIMATE
    "boundarySetbackM": 60,  # keep units this far inside the surveyed boundary, m. ESTIMATE
    # ---- foundations ----
    "pilesPerUnit": 8,  # ESTIMATE: depends on Exowatt's foundation design
    "pileRobotPilesPerDay": 300,  # per 10 h shift; Built Robotics quotes 300+ for the RPD 35
    "pileRobotCrew": 2,  # robot operator + pile loader (Built Robotics' two-person crew)
    # ---- setting units ----
    "craneUnitsPerDay": 16,  # ESTIMATE (~1 every 35-40 min)
    "craneCrew": 4,  # crane operator, two riggers, signal person
    # ---- delivery ----
    "telehandlerSpeedKmh": 12,  # ESTIMATE
    "telehandlerLoadMin": 8,  # pick up at the laydown yard. ESTIMATE
    "telehandlerHandoffMin": 5,  # hand to the crane. ESTIMATE
    "telehandlerCrew": 1,
    # ---- trenching & electrical ----
    "trencherMPerDay": 500,  # ESTIMATE
    "trencherCrew": 2,
    "electricalUnitsPerDay": 8,  # per two-person crew per shift. ESTIMATE
    "electricalCrew": 2,
    # ---- supervision ----
    "workersPerForeman": 15,
    "workersPerSafetyLead": 40,  # at least one on site
    # ---- schedule ----
    "shiftMinutes": 600,
}
