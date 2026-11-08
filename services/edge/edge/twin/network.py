"""Radio ranges shared by the buildup planner and the mesh, so the network the planner designs is
the one the mesh simulator runs (packages/mesh/src/constants.ts, RADIO; spec 6.4 and 18)."""

RELAY_RANGE_M = 460  # longest relay-to-relay mesh hop (simulator value, spec 18)
COVERAGE_RADIUS_M = 300  # robot/endpoint to relay: each relay's coverage radius (spec 6.4, site config default)
ASSET_RANGE_M = COVERAGE_RADIUS_M  # name used by the UI's coverage circles
ROBOT_RANGE_M = 120  # robot to robot, for reaching the mesh through a neighbor (spec 6.3)
UWB_RANGE_M = 150  # UWB anchor to badge (assumption until hardware tests)
COVERAGE_TOLERANCE_M = 3  # robots may work this far outside coverage (spec 6.4)
