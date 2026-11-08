# Edge service: site twin + site agent

Runs on the site's edge server (or the build manager's laptop for a demo). It owns everything about the site:

- **Survey:** simulated drones build the terrain model from scratch (`edge/survey/`).
- **Buildup planner:** layout, relays, fleet, crew and schedule from the units and crew the manager sets (`edge/buildup/`).
- **Construction over the site mesh:** when the plan is approved, this service builds the mesh's site configuration (spec section 13), the physical world and the task list from the plan (`edge/meshsite.py`). It then starts the mesh simulator in `packages/mesh`, which runs every relay, robot, anchor and tablet plus the hub mesh service, and talks to it (`edge/mesh_client.py`). Construction actions become supervisor commands that the hub sends on behalf of the build manager (spec 12.3).
- **Monitor:** cheap rules that turn the hub's alerts and loss groups, survey milestones and plan warnings into findings for the agent (`edge/monitor.py`).
- **Site agent:** Claude, connected to all of the above. It answers in the chat and speaks up when the monitor flags something. It is **suggest-only**: it can read anything, but every change is a suggestion card that the manager approves or dismisses (`edge/agent.py`).

The UI (`frontend/`) just renders what this service streams over one WebSocket.

Positions: the plan and the UI use twin meters (y south, origin at the NW corner). The mesh uses the site frame from the spec (decimeters, y north, origin at the survey benchmark, which here is the survey launch point). `meshsite.py` converts the plan into the site frame. The UI's adapter (`frontend/src/mesh/adapter.ts`) converts mesh data back, as spec 12.4 describes.

## Run it

Needs Python 3.9 or newer, and Node.js for the mesh simulator (`run.sh` builds it the first time).

```bash
cp .env.example .env      # then put your ANTHROPIC_API_KEY in .env
bash run.sh               # creates .venv on first run, then serves ws://localhost:8765/ws
```

`npm run app` and `npm run app:dev` in `frontend/` start this service for you if it isn't already running. Use `bash run.sh --host 0.0.0.0` to let tablets on the site network connect; the service also serves the built UI at `http://<edge-server>:8765/`.

With no API key the twin still runs and the map buttons still work; the chat just says the agent is offline. The agent needs a path to the Anthropic API (on site, the satellite uplink). If the uplink drops, the chat says so and the site keeps running.

Settings (in `.env`): `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`), `AGENT_PROACTIVE=0` to stop unprompted messages, `AGENT_MIN_INTERVAL_S` (default 20) between unprompted messages, `SELECTION_ALGORITHM` (below), `EDGE_HOST`, `EDGE_PORT`.

## How the agent works

- **Tools (read-only):** site overview, survey status, the plan, find a node or track, list assets with filters (stopped, holding, lost, low battery, reaching the mesh through a robot...), mesh status, alerts, tasks and items, and the hub's event log.
- **`propose_action`:** the only way it can change anything. The proposal becomes a card in the chat; approving it runs the same action a UI button would, and the result goes back to the agent. Proposals for an earlier stage expire when the site moves on.
- **Monitoring:** after every tick the monitor collects findings. At most every `AGENT_MIN_INTERVAL_S` it hands them to the agent as `[Site monitor] ...`. The agent either replies `NO_UPDATE` (nothing is shown) or posts a short heads-up, usually with a suggestion.
- **Context:** when the manager acts directly (clicks a button), the agent is told with its next message, so it never suggests something already done.

Every action, whether from a button or an approved suggestion, goes through `Site.run_action` in `edge/site.py`. That file is the list of everything that can change on site.

## Plugging in real data

| Piece | Where | How |
|---|---|---|
| Survey selection algorithm | `edge/survey/selection.py` | Write `select(input: dict) -> list[dict]` with the documented shape, then set `SELECTION_ALGORITHM=your_module:select` (no code changes), or pass it to `Site(selection=...)`. |
| Real terrain | `data/site-dem.json` | `tools/terrain` fetches it (USGS 3DEP via AWS Terrain Tiles). Without it, synthetic terrain is used and the UI says so. |
| Live drones | `edge/survey/session.py` | Replace the simulated `tick()` with real positions and mapped cells, keeping `snapshot()` the same. |
| Real mesh hardware | `edge/mesh_client.py` | The simulator speaks the twin interface from spec 12. A hub mesh service on real gateways would send the same snapshot and events, so only the client changes. |
| Planner rates | `edge/buildup/assumptions.py` | Estimates are marked; confirm with Exowatt. |

## WebSocket protocol (`/ws`)

Server → client: `hello` (terrain heights, network ranges, stage, plan, chat, agent), `survey` (snapshot plus packed coverage bits when new ground is mapped), `plan` (plan plus preview), `twin` (the mesh snapshot, planning progress, sim status), `meshEvents`, `traces`, `meshLog`, `meshConfig` (benchmark and names for the UI's coordinate adapter), `stage`, `chat` (one message, new or updated), `agent` (online/busy/activity), `result` (reply to an action).

Client → server: `action {id, name, args}`, `chat {text}`, `decide {suggestionId, approve}`.

## Layout

```
edge/
  server.py      FastAPI app: WebSocket, tick loops, chat, suggestions
  site.py        stages + every action (the one place site state changes)
  agent.py       Claude site agent: tools, propose_action, history
  monitor.py     rules that decide what's worth the agent's attention
  meshsite.py    plan -> site config, world and tasks for the mesh (site frame, spec 13)
  mesh_client.py starts and talks to the mesh simulator
  survey/        terrain, selection (placeholder), drone survey session
  buildup/       planner (relays, 2 gateways, UWB anchors), assumptions, plan preview
  twin/          radio ranges shared with the mesh
data/site-dem.json   real terrain for the site
tests/
  test_flow.py   end to end over the WebSocket with a scripted Claude stand-in
  run_fake.py    run the service with the stand-in, for UI work without an API key
```

Run the tests with `python tests/test_flow.py` (needs `httpx`).
