"""Radio ranges shared by the buildup planner and the construction simulator, so the network
the planner designs is the same one the twin simulates."""

RELAY_RANGE_M = 460  # longest relay-to-relay mesh hop
ASSET_RANGE_M = 270  # longest machine/robot-to-relay link (also the coverage circles on the map)
LORA_RANGE_M = 2000  # worker LoRa tag to any relay or gateway
