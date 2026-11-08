# Edge service: site twin + site agent

Runs on the site's edge server (or the build manager's laptop for a demo). It owns everything about the site:

- **Survey:** simulated drones build the terrain model from scratch (`edge/survey/`).
- **Buildup planner:** layout, relays, fleet, crew and schedule from the units and crew the manager sets (`edge/buildup/`).
- **Construction twin:** the approved plan built live, with store-and-forward over a simulated mesh (`edge/twin/`).
- **Site mesh:** the robots, relays, gateway and hub as mesh nodes, with packet forwarding and emulated bidding and consensus for row tasks (`edge/mesh/`, below).
- **Monitor:** cheap rules that flag what matters, such as a relay going down, an asset going stale, repeated proximity stops, a survey pass finishing or a plan with warnings (`edge/monitor.py`).
- **Site agent:** Claude, connected to all of the above. It answers in the chat and speaks up when the monitor flags something. It is **suggest-only**: it can read anything, but every change is a suggestion card that the manager approves or dismisses (`edge/agent.py`).

The UI (`frontend/`) just renders what this service streams over one WebSocket.

## Run it

Needs Python 3.9 or newer.

```bash
cp .env.example .env      # then put your ANTHROPIC_API_KEY in .env
bash run.sh               # creates .venv on first run, then serves ws://localhost:8765/ws
```

`npm run app` and `npm run app:dev` in `frontend/` start this service for you if it isn't already running. Use `bash run.sh --host 0.0.0.0` to let tablets on the site network connect; the service also serves the built UI at `http://<edge-server>:8765/`.

With no API key the twin still runs and the map buttons still work; the chat just says the agent is offline. The agent needs a path to the Anthropic API (on site, the satellite uplink). If the uplink drops, the chat says so and the site keeps running.

Settings (in `.env`): `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`), `AGENT_PROACTIVE=0` to stop unprompted messages, `AGENT_MIN_INTERVAL_S` (default 20) between unprompted messages, `SELECTION_ALGORITHM` (below), `EDGE_HOST`, `EDGE_PORT`.

## Site time and the speed dial (`edge/clock.py`, `edge/schedule.py`)

Construction runs at the plan's **real rates**, from `buildup/assumptions.py`:
- a pile-driving robot takes 8 piles ÷ 300 piles a day = 16 minutes per unit
- a crane sets a unit in 37.5 minutes
- a rover stakes 120 units and checks 200 units a shift
- telehandler loads and handoffs, trencher metres per day and travel speeds follow the plan too

Work happens inside a shift (07:00 to 17:00 with the default 600-minute shift). When a shift ends, the day is summarized, the clock jumps to 07:00 the next day, and robots and machines start recharged. Day 1 starts at 07:00 the morning the plan is approved. Site times go to the UI as UTC epoch ms on a fixed calendar (Day 1 = 9 Nov 2026), and the UI formats them in UTC.

The dial (`sim.speed`) runs construction at 1×, 10×, 60×, 300× or 900× real time; the survey runs at up to 20×. `sim.pause` pauses. `sim.skipShift` fast-forwards through the rest of the shift as fast as the machine allows; the work still happens. `sim.pauseAtDayEnd` stops at each shift end. At high speed the simulator takes steps of up to 10 site seconds and the mesh up to 20 steps per call; a 10-hour shift simulates in about 15 s of CPU. Packets are only recorded and streamed at 2× or slower.

The **day tracker** (`schedule.py`) counts units staked, piled and set each shift from the twin's *reported* statuses, against the plan's pace: staking at the rovers' rate, piling over the planner's piling days, and setting a day behind piling. It also counts tasks done, rounds, stalled rounds, relay outages and pile refusals, and writes a one-line summary when the shift ends, which the agent can pass on.

## Site mesh (`edge/mesh/`)

Follows "Exowatt Mesh Network and Digital Twin" (8 Nov 2026): the twin shows robots passing task information to each other over the mesh and converging on one owner. The bidding is an **emulation**, not the CBAA firmware.

**Transport** (`transport.py`). Nodes are the autonomous robots (pile drivers `RPD-n`, layout rovers `LR-n`, drone `DR-1`), the relay masts, the gateway `GW` and the hub `HUB` (the edge server, wired to `GW`). A link exists while two nodes are in range (robot–robot 120 m, robot–relay 270 m, relay–relay 460 m), both are up and the manager hasn't cut it. Packets are small dicts with `message_id`, `origin_id`, `type`, `destination`, `task_id`, `revision`, `round_id`, `hops_left` and `payload`. A broadcast goes to immediate neighbors; each copy arrives after the per-hop delay (default 250 ms ± 30%), can be lost (default 2%), and is dropped if the link broke in flight. Every node keeps a seen-ID cache, so a message is processed and forwarded once, with one less hop. Retries get a fresh message ID but carry the same task/round record. Manual machines (cranes, telehandlers, trenchers) are not mesh robots.

**Tasks** (`site_mesh.py`). The hub introduces one task per row of the approved plan: *Stake row* (rovers), then *Pile row* (pile drivers), then *Check row* (rovers), plus *Survey block* (the drone) once every row in a block is piled. The hub unlocks a task only after it hears the earlier one is complete. Queue order: priority, then task ID.

**Allocation** (`robot.py`, `hub.py`, `rules.py`). One round at a time, one active task per robot:
1. The hub picks the highest-priority ready task that a robot it **believes is free** could do, and sends `TASK_ANNOUNCE` with the fixed participants (every robot). It re-announces every 4 s while the round is open. The belief comes only from what the hub hears: heartbeats (availability and tools), completed/released status, commits and "busy" declines. If it's wrong, the round ends *No eligible robot* (and the declines correct it), or the task waits for the next heartbeat. Other ready tasks show *Waiting for a free robot*.
2. Each participant sends one frozen `BID`: 100 − 4 per 100 m of travel − 0.3 per % of battery used, or an explicit decline (busy, paused, no tool, low battery). Silence is not a decline.
3. With a response from every participant, each robot picks the highest score (ties to the lowest robot ID) and sends `AGREE` with the winner and a fingerprint of the ordered bid set, task revision and round.
4. The tentative winner commits only with matching `AGREE`s from every participant (its own included), and only if it's still available. The emulated consensus component records one commit and an idempotent assignment ID; it never picks a winner. The winner broadcasts `COMMIT` and only then starts work.
5. `STATUS` reports progress, completion or a confirmed release. `HEARTBEAT` (every ~3 s) carries availability, tools and the current assignment, so the hub catches up on anything it missed.

Failures: BID/AGREE are retried every 3 s; robots that already concluded repeat their bid and agreement when a participant is still asking. Old revisions and rounds are ignored, and duplicates can't create a second owner or restart completed work. A round open 20 s+ shows as *stalled*; the participant set never shrinks. A winner that became unavailable sends `attempt_cancelled` and the hub opens a new round. After commitment, an owner not heard for 7 s is shown as *uncertain* but keeps the task; reassignment needs an explicit release. **Release** and **Cancel** bump the task revision and wait for the owner to confirm it stopped before a new round opens. If everyone declines anyway (a stale belief), the round closes as *No eligible robot* and similar tasks wait until a robot reports it's free.

Manager controls (UI or approved agent suggestion): `task.cancel`, `task.release`, `task.priority`, `mesh.cutLink`, `mesh.restoreLink`, `mesh.relay`, `mesh.hub`, `mesh.latency`, `mesh.loss`. Mesh robots' position reports reach the twin over this mesh too, so a robot with no path to the hub goes stale on the map.

Scores and timers are in `rules.py` (`ALLOC`); ranges in `twin/network.py`; the number of layout rovers in `buildup/assumptions.py`. `python tests/test_mesh.py` runs the acceptance checks from the doc.

## How the agent works

- **Tools (read-only):** site overview, survey status, the plan, find an asset, list assets with filters (stale, offline, paused...), network status, recent events, equipment requests, mesh tasks, one allocation round in detail, mesh status, and day-by-day progress against the plan.
- **Role on the mesh:** a hub-side helper. It can suggest cancelling, releasing or reprioritising a task, cutting or restoring links, relays and the hub, or changing delay and loss. It never picks a winner.
- **`propose_action`:** the only way it can change anything. The proposal becomes a card in the chat; approving it runs the same action a UI button would, and the result goes back to the agent. Proposals for an earlier stage expire when the site moves on.
- **Monitoring:** after every tick the monitor collects findings (including stalled agreement, uncertain owners and cancelled attempts on the mesh). At most every `AGENT_MIN_INTERVAL_S` it hands them to the agent as `[Site monitor] ...`. The agent either replies `NO_UPDATE` (nothing is shown) or posts a short heads-up, usually with a suggestion.
- **Context:** when the manager acts directly (clicks a button), the agent is told with its next message, so it never suggests something already done.

Every action, whether from a button or an approved suggestion, goes through `Site.run_action` in `edge/site.py`. That file is the list of everything that can change on site.

## Plugging in real data

| Piece | Where | How |
|---|---|---|
| Survey selection algorithm | `edge/survey/selection.py` | Write `select(input: dict) -> list[dict]` with the documented shape, then set `SELECTION_ALGORITHM=your_module:select` (no code changes), or pass it to `Site(selection=...)`. |
| Real terrain | `data/site-dem.json` | `tools/terrain` fetches it (USGS 3DEP via AWS Terrain Tiles). Without it, synthetic terrain is used and the UI says so. |
| Live drones | `edge/survey/session.py` | Replace the simulated `tick()` with real positions and mapped cells, keeping `snapshot()` the same. |
| Live robots, machines, workers | `edge/twin/simulator.py` | Replace `SimulatedSite` with a class that fills the same `snapshot()` from Meshtastic / ChirpStack / Zenoh reports and implements the same actions. |
| Planner rates | `edge/buildup/assumptions.py` | Estimates are marked; confirm with Exowatt. |

## WebSocket protocol (`/ws`)

Server → client: `hello` (terrain heights, network ranges, stage, plan, chat, agent), `survey` (snapshot plus packed coverage bits when new ground is mapped), `twin` (with `mesh`: nodes, links, tasks, rounds, robot views; `clock`; `schedule`: days against the plan), `traces` (packet hops for the animation, 5 times a second), `plan` (plan plus preview), `stage`, `chat` (one message, new or updated), `agent` (online/busy/activity), `result` (reply to an action).

Client → server: `action {id, name, args}`, `chat {text}`, `decide {suggestionId, approve}`.

## Layout

```
edge/
  server.py      FastAPI app: WebSocket, survey + construction loops, chat, suggestions
  clock.py       site time, shifts and the speed dial
  schedule.py    day-by-day tracker against the plan
  site.py        stages + every action (the one place site state changes)
  agent.py       Claude site agent: tools, propose_action, history
  monitor.py     rules that decide what's worth the agent's attention
  survey/        terrain, selection (placeholder), drone survey session
  buildup/       planner + assumptions
  twin/          construction simulator (robot bodies + manual machines), radio ranges
  mesh/          transport, robot agents, hub, allocation rules, site wiring
data/site-dem.json   real terrain for the site
tests/
  test_flow.py   end to end over the WebSocket with a scripted Claude stand-in
  test_mesh.py   the mesh acceptance checks (two hops, convergence, stalls, duplicates, hub off, release) and pacing
  run_fake.py    run the service with the stand-in, for UI work without an API key
```

Run the tests with `python tests/test_mesh.py` and `python tests/test_flow.py` (needs `httpx`).
