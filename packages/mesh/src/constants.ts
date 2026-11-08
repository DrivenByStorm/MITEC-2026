// Timers and constants (section 16), the message-type table (4.4) and simulator-only radio assumptions.

import { MsgClass, MsgType, NodeKind } from './types.js'

export const T = {
  HOP_LIMIT: 8,
  MAX_HOPS: 16,
  MAX_PAYLOAD: 985,
  DEDUP_TTL: 10_000,
  DEDUP_CAP: 4096,
  REPLAY_WINDOW: 128,
  REPAIR_WAIT: 300,
  CMD_RETRY_MS: 1000,
  CMD_RETRIES: 5,
  CMD_ID_MEMORY: 64,
  CMD_ID_MEMORY_MS: 60_000,
  BEACON_INTERVAL: 500,
  BEACON_JITTER: 50,
  ROBOT_BEACON_INTERVAL: 200,
  ROBOT_BEACON_JITTER: 20,
  ROBOT_BEACON_FRESH: 600,
  ROBOT_NEIGHBOR_DEPTH_FRESH: 1000,
  GATEWAY_HOPS_WINDOW: 1500,
  CONTACT_CHECK: 100,
  CONTACT_TIMEOUT: 1500,
  MAX_ROBOT_DEPTH: 2,
  COVERAGE_RADIUS_M: 300,
  COVERAGE_TOLERANCE_DM: 30,
  RELAY_ALIVE_FOR_COVERAGE: 15_000,
  ROBOT_STATE_INTERVAL: 1000,
  SUPERVISOR_STATE_INTERVAL: 5000,
  RELAY_STATUS_INTERVAL: 5000,
  ANCHOR_HEARTBEAT: 5000,
  ROBOT_LATE: 3000,
  ROBOT_LOST: 5000,
  SUPERVISOR_LATE: 12_000,
  SUPERVISOR_LOST: 20_000,
  ANCHOR_LATE: 12_000,
  ANCHOR_LOST: 20_000,
  RELAY_LATE: 12_000,
  RELAY_LOST: 15_000,
  ALERT_GROUP_WINDOW: 2000,
  LIDAR_INTERVAL: 500,
  LIDAR_RANGE_DM: 300,
  LIDAR_MIN_CONFIDENCE: 40,
  UWB_INTERVAL: 500,
  UWB_MIN_QUALITY: 50,
  TRACKS_INTERVAL: 1000,
  TRACKS_STALE: 5000,
  UWB_RANGE_WINDOW: 300,
  UWB_ANCHOR_MIN_SEPARATION_DM: 50,
  UWB_MAX_ANCHOR_ACC_CM: 100,
  UWB_STALE: 5000,
  UNKNOWN_TRACK_MIN_MS: 2000,
  UNKNOWN_TRACK_TIMEOUT: 3000,
  ZONE_SET_REBROADCAST: 10_000,
  ZONE_CHECK_INTERVAL: 100,
  CAUTIOUS_SPEED: 50, // cm/s
  DEGRADED_POS_ACC_CM: 50,
  CREW_STOP_RADIUS_DM: 30,
  CREW_SLOW_RADIUS_DM: 80,
  MACHINE_STOP_EXTRA_DM: 30,
  MACHINE_SLOW_EXTRA_DM: 100,
  UNKNOWN_STOP_EXTRA_DM: 20,
  UNKNOWN_SLOW_EXTRA_DM: 60,
  HOLD_CLEAR_MS: 3000,
  HOLD_HYSTERESIS_DM: 10,
  CREW_HOLD_LONG: 60_000,
  PROXIMITY_HORIZON_MS: 3000,
  PROXIMITY_MARGIN_DM: 20,
  CREW_ZONE_WARN_DM: 200,
  CREW_ZONE_WARN_MS: 5000,
  CREW_BREACH_MS: 2000,
  NEAR_MISS_CREW_DM: 15,
  NEAR_MISS_ROBOT_DM: 10,
  NEAR_MISS_SPEED: 30, // cm/s
  POS_MISMATCH_DM: 20,
  POS_MISMATCH_MS: 3000,
  CROSS_CHECK_EXTRA_DM: 20,
  UNKNOWN_MATCH_DM: 20,
  UNKNOWN_MERGE_DM: 15,
  CBAA_ROUND: 200,
  AUCTION_STATE_MIN_INTERVAL: 1000,
  HUB_AUCTION_STATE_INTERVAL: 5000,
  BID_WINDOW: 3000,
  STABLE_TIME: 2000,
  TASK_REBROADCAST: 30_000,
  OWNER_SILENT: 5000,
  OWNER_STOPPED: 60_000,
  OWNER_MISMATCH: 3000,
  SHORTFALL_CHECK: 5000,
  SHORTFALL_DELAY: 10_000,
  SHORTFALL_REPEAT: 300_000,
  ALERT_ACK_URGENT: 30_000,
  ALERT_ACK_OTHER: 120_000,
  RESUME_ON_SITE_DM: 100,
  NODE_LIST_REBROADCAST: 30_000,
  BULK_NACK_WAIT: 10_000,
  BULK_MAX_NACKS: 3,
  BULK_CHUNK_BYTES: 960,
  TRAVEL_CAP_S: 600,
  WORK_CAP_S: 3600,
} as const

/** Allowed class per message type (4.4). ALERT and SUPERVISOR_CMD may be SAFETY or CONTROL. */
export const ALLOWED_CLASSES: Record<MsgType, MsgClass[]> = {
  [MsgType.RELAY_BEACON]: [MsgClass.SAFETY],
  [MsgType.RELAY_STATUS]: [MsgClass.STATUS],
  [MsgType.ROBOT_BEACON]: [MsgClass.SAFETY],
  [MsgType.ROBOT_STATE]: [MsgClass.STATUS],
  [MsgType.LIDAR_OBJECTS]: [MsgClass.STATUS],
  [MsgType.UWB_RANGES]: [MsgClass.STATUS],
  [MsgType.TRACKS]: [MsgClass.SAFETY],
  [MsgType.SUPERVISOR_STATE]: [MsgClass.STATUS],
  [MsgType.SAFETY_STOP]: [MsgClass.SAFETY],
  [MsgType.NEAR_MISS]: [MsgClass.SAFETY],
  [MsgType.ZONE_BREACH]: [MsgClass.SAFETY],
  [MsgType.ZONE_SET]: [MsgClass.SAFETY],
  [MsgType.NODE_LOST]: [MsgClass.SAFETY],
  [MsgType.NODE_LIST]: [MsgClass.CONTROL],
  [MsgType.TASK]: [MsgClass.CONTROL],
  [MsgType.AUCTION_STATE]: [MsgClass.CONTROL],
  [MsgType.ITEM_STARTED]: [MsgClass.CONTROL],
  [MsgType.ITEM_DONE]: [MsgClass.CONTROL],
  [MsgType.ITEM_RELEASED]: [MsgClass.CONTROL],
  [MsgType.TASK_CANCEL]: [MsgClass.CONTROL],
  [MsgType.ALERT]: [MsgClass.SAFETY, MsgClass.CONTROL],
  [MsgType.ALERT_ACK]: [MsgClass.CONTROL],
  [MsgType.SUPERVISOR_CMD]: [MsgClass.SAFETY, MsgClass.CONTROL],
  [MsgType.CMD_RESULT]: [MsgClass.CONTROL],
  [MsgType.BULK_CHUNK]: [MsgClass.BULK],
  [MsgType.BULK_NACK]: [MsgClass.BULK],
}

/** Queue limits and jitter per class (5.4). */
export const RELAY_QUEUE = {
  limit: [64, 128, 64, 32],
  jitterMax: [5, 10, 20, 50],
  dropNewest: [false, false, false, true],
}
export const ROBOT_QUEUE = { limit: [32, 64, 32, 0] }

/** Node kinds that forward every packet (3). */
export const FORWARDER_KINDS = new Set([NodeKind.GATEWAY, NodeKind.RELAY])

// ---------------------------------------------------------------------------
// Simulator-only radio assumptions (not part of the spec; see open items in section 18).
// ---------------------------------------------------------------------------

export const RADIO = {
  /** Relay-to-relay mesh hop, meters (current simulator value, 18). */
  RELAY_RANGE_M: 460,
  /** Robot/endpoint to relay, meters: the coverage radius (6.4). */
  ENDPOINT_RANGE_M: 300,
  /** Robot to robot (HaLow, both on the ground), meters. */
  ROBOT_RANGE_M: 120,
  /** UWB two-way ranging between an anchor and a badge, meters. */
  UWB_RANGE_M: 150,
  /** Time on air per packet, ms (HaLow at a few Mbit/s, 1 kB packets). */
  AIRTIME_MS: 2,
  /** Base packet loss and how loss grows toward the edge of range. */
  BASE_LOSS: 0.01,
  EDGE_LOSS: 0.25,
}

export const BULK_CONTENT = { JPEG: 1, LIDAR: 2, LOG: 3 } as const
