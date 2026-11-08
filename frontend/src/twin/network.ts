// Radio ranges shared by the buildup planner and the construction simulator, so the
// network the planner designs is the same one the twin simulates.

/** Longest relay-to-relay mesh hop, meters. */
export const RELAY_RANGE_M = 460
/** Longest machine/robot-to-relay link, meters (also the coverage circles on the map). */
export const ASSET_RANGE_M = 270
/** Worker LoRa tag to any relay or gateway, meters. */
export const LORA_RANGE_M = 2000
