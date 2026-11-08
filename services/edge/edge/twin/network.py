"""Radio ranges shared by the buildup planner, the construction simulator and the mesh, so the
network the planner designs is the same one the twin simulates."""

RELAY_RANGE_M = 460  # longest relay-to-relay mesh hop (relays and the gateway)
ASSET_RANGE_M = 270  # longest robot/machine-to-relay link (also the coverage circles on the map)
ROBOT_RANGE_M = 120  # longest robot-to-robot mesh hop (low masts on the robots themselves)
LORA_RANGE_M = 2000  # worker LoRa tag to any relay or gateway
