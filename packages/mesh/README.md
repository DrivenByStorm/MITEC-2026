# Site mesh: simulator and hub mesh service

A TypeScript implementation of the mesh specification (v0.1, 7 Nov 2026). It covers the program that runs on relays, gateways, robots, UWB anchors and supervisor tablets, and the hub mesh service that sits between the gateways and the twin. It runs as a simulation: each node is a separate object exchanging packets over a simulated radio, in a simulated physical site.

The edge service (`services/edge`) starts it when the build manager approves a plan, sends it the site configuration (spec section 13) and the tasks, and talks to it over a WebSocket. What comes back is exactly the twin interface in section 12: a `MeshSnapshot` every second, a `MeshEvent` stream and, when the UI asks, `MeshTrace` entries for every transmission and drop.

```bash
npm install
npm run build
npm test                         # behaviour tests against the spec
node dist/src/server.js          # ws://127.0.0.1:8766 (the edge service starts this for you)
```

## What's implemented, by spec section

| Spec | Where | Notes |
|---|---|---|
| 2–4 identifiers, header, message types, classes | `src/types.ts`, `src/constants.ts` | Section 15 types, plus object-level payloads for every message type. |
| 5.1–5.5 flooding, dedup, replay window, queues, gateways | `src/nodes/base.ts`, `src/nodes/relay.ts`, `src/hub/hub.ts` | Per-class queues with jitter, status coalescing, drop policies, class checks; the hub sends to both gateways and drops the second copy. |
| 5.7 command retries and idempotency | `src/nodes/endpoints.ts`, `src/nodes/robot.ts`, `src/hub/hub.ts` | 1 s, 5 retries, new seq, RETRY flag; robots remember 64 cmd_ids. |
| 5.8 bulk evidence and NACK | `robot.ts`, `hub.ts` | Robots send at depth 0 only; the hub NACKs missing chunks up to 3 times. |
| 5.9 robot forwarding F1–F4 | `robot.ts` | Robots carry neighbors that are outside relay range. |
| 5.10 repair re-send | `base.ts` | One re-send if no other node is heard forwarding within 300 ms. |
| 6 beacons, watchdog, depth, coverage band | `relay.ts`, `robot.ts` | Depth 0/1/2/255, LOST after 1.5 s with no path, the 3 m band, OUT_OF_COVERAGE. |
| 7 state messages, liveness, NODE_LOST grouping | `robot.ts`, `relay.ts`, `hub.ts` | RELAY_DOWN / HUB_ISOLATED / UNKNOWN groups. |
| 8 lidar, UWB, fusion, TRACKS, zones, checks, stops, near misses | `world/world.ts`, `robot.ts`, `hub.ts`, `geometry.ts` | Least-squares UWB fixes; lidar cross-checks; robots fall back to their own fix when TRACKS stops. |
| 9 tasks, CBAA, slot rule, release rule, shortfall | `cbaa.ts`, `robot.ts`, `hub.ts` | Integer utility; all robots converge on the same winners. |
| 10 alerts, escalation, commands, resume rules, NODE_LIST | `hub.ts`, `endpoints.ts`, `robot.ts` | On-site resumes need LOCAL_LINK or a supervisor's badge within 10 m. |
| 11 hub mesh service | `hub.ts` | Including the event log and the HQ sync over Starlink. |
| 12 twin interface | `hub.ts` (`snapshot()`), `server.ts` | Twin commands are sent by the hub on behalf of the logged-in supervisor. |
| 17 failure cases | `index.ts` (`inject`), tests | Relay, gateway or hub down; robot radio or RTK lost; strays; crew in a hazard zone. |

Messages are object-level: a packet is a header plus a typed payload object, not bytes. Every rule that depends on the format is still enforced: hop limits, class checks, message IDs, part splitting for ZONE_SET, TRACKS, NODE_LIST, TASK and AUCTION_STATE.

## Simulator assumptions (not in the spec)

- Radio: relay to relay 460 m, endpoint to relay 300 m (the coverage radius), robot to robot 120 m, 2 ms per packet on air. Reception loss is 1%, rising toward the edge of range.
- UWB: 150 m anchor-to-badge range, about ±10 cm noise.
- Pace: robots drive at their configured speed; one unit's piles take 40 s (the edge service sets this) so a block fits in a demo. The sim speed control runs everything faster.
- The `demo` scenario script: a relay fails at 45 s, a stray vehicle crosses at 130 s, a robot loses RTK at 210 s, a crew member walks into a hazard at 300 s, and a robot's radio dies at 380 s. Crew also walk up to working robots every minute or so.

## Clarifications made while implementing

These are places where the spec was silent or ambiguous. Each choice is marked in the code.

1. **Ordering (9.3):** within one generation, HELD and AWAITING_SIGNOFF rank above STARTED, so an older STARTED copy can't undo them.
2. **Release rule (9.9):** for an item that is ASSIGNED but not started, mode IDLE is expected, so only a different task or item counts as a mismatch.
3. **Loss grouping (7.3):** a robot goes LOST after 5 s but its relay only after 15 s. When the relay is lost, every lost endpoint whose last via was that relay is regrouped under RELAY_DOWN. Anchors and tablets have no via field, so the hub takes theirs from the relays' neighbor tables.
4. **Coverage (6.4):** the coverage check waits until a robot has heard at least one relay. Before that, the contact watchdog decides.
5. **Resume (10.3):** after a resume the robot releases the item it held and bids again, instead of carrying on with it.
6. **Near miss (8.9):** the robot that reports a near miss names itself in `involved` and stops too.
7. **Item command results (10.2):** the hub answers CANCEL_ITEM, RELEASE_ITEM and SIGN_OFF; the robot answers REDIRECT.
8. **Manual work:** progress on crane-set units is reported outside the mesh (spec 1.2, the planning software), so the twin shows installed units from planning and piled units from the mesh.
9. **Planning:** the hub's planning software opens one autonomous task per fleet type at a time; a second one would only ever show as a shortfall.
10. **ITEM_RELEASED reason codes:** 1 owner silent, 2 owner stopped, 3 owner mismatch, 4 supervisor, 5 item failed, 6 redirect, 7 sign-off rejected.
