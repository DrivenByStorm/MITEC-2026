# Build site digital twin: build manager console

The build manager's UI for the Exowatt off-grid construction site twin. A live 2D map sits at the top and the chat with the **site agent** at the bottom. **Expand twin** opens the full real-time state panel beside the map.

The UI has no site logic of its own. The survey, the buildup planner, the construction twin and the agent all run in the edge service (`../services/edge`). This app renders what that service streams and sends back the manager's clicks and messages.

The twin moves through stages, shown in the header:

1. **Survey:** drones build the terrain model of a new site from scratch.
2. **Buildup plan:** you set the number of P3 units and the crew available; the planner lays out the site and decides the relays, robots, machines and crew.
3. **Construction:** the approved plan is built live from bare ground, with machines, crews and the mesh network.

## Run it

```bash
cd frontend
npm install
cp ../services/edge/.env.example ../services/edge/.env   # add your ANTHROPIC_API_KEY
```

As a desktop app (Electron). These start the edge service too, unless it's already running:

```bash
npm run app        # build, then open the Site Twin window
npm run app:dev    # live-reloading desktop window while you edit code
npm run dist:mac   # package Site Twin.app into release/ (expects an edge server to connect to)
```

In a browser:

```bash
npm run edge       # start the edge service (in its own terminal)
npm run dev        # http://localhost:5173
```

The app connects to `ws://localhost:8765/ws`. To use another edge server, set `VITE_EDGE_URL` at build time or open the app with `?edge=10.0.0.5:8765`. If the connection drops, a banner shows and the app reconnects on its own.

## Talking to the site agent

Type to the agent in plain language: "Start a 1.5 km survey", "Is there enough flat ground yet?", "Plan 300 units with 40 people", "Why this many relays?", "Where is RPD-1?", "Anything I should worry about?".

- The agent looks things up in the twin. The chat shows what it checked, and anything it finds is highlighted on the map.
- It **never changes anything itself**. When it wants to act, it shows a **suggested action** card with **Approve** and **Dismiss** buttons. Nothing happens until you approve. When the panel is expanded, a pending suggestion appears in the slim bar at the bottom.
- It also watches the site. When something needs your attention (a survey pass finished, a relay went down, a machine keeps stopping for people nearby), it posts a **heads-up**, usually with a suggestion.
- Buttons on the map and in the panels act directly. Their results show in the chat as **Site** messages, and the agent is told about them.

The dot next to **Send** is green when the agent is online, pulses while it works, and is grey when it's offline (for example, no API key or no uplink). The map controls work either way.

## Survey stage

Set the boundary distance on the map and start the survey, or ask the agent. The scout (SC-1) traces the boundary, then the selection algorithm assigns sections to SV-1 to SV-4 and the elevation heat map fills in. After a pass, click a suggested gap to map it, or choose **Move forward with buildup**.

## Buildup stage

Enter **P3 units to build** and **Crew available**, then **Generate plan**, or ask the agent. The number of units is always yours. The planner decides the layout on flat mapped ground, the relays (every unit within reach of two), the fleet and crew, and the schedule. **Plan details** gives the reason for every quantity. **Approve and build** starts construction of exactly that plan. About 40 s in, a relay fails on purpose so you can watch traffic reroute.

## What's on screen (construction)

- **Site plan:** P3 units (orange = set, dotted = foundation ready, dashed = planned), robots and machines (teal), people (yellow), relay masts (diamonds), mesh links and relay coverage. Drag to pan, scroll to zoom, click anything to select it.
- **Freshness:** when the twin stops hearing from an asset, it fades and then turns grey with a "last heard" age. The map always shows the last *reported* position, never a guess.
- **Expanded view:** details for the selected asset with pause/resume, plus Overview, Machines, People, Network, Requests and Activity tabs.

## How it's built

```
src/
  edge/client.ts     WebSocket client + store: state, act(), chat(), decide()
  survey/
    types.ts         survey snapshot (as sent by the edge service)
    heatmap.ts       elevation coloring and hillshade
    labels.ts        phase labels
  buildup/
    types.ts         plan (as sent by the edge service)
    overlay.ts       unbuildable-ground image
  twin/
    types.ts         construction snapshot (as sent by the edge service)
    freshness.ts     live / lagging / stale
  components/
    SurveyView.tsx / SurveyMap.tsx / SurveyPanel.tsx   survey stage
    BuildupView.tsx / PlanPanel.tsx                    buildup planning
    ConstructionView.tsx / SiteMap.tsx / StatePanel.tsx construction
    CommandConsole.tsx  chat with the site agent, suggestion cards
    Topbar.tsx, usePanZoom.ts
  App.tsx            stage switching, connection screen
electron/main.cjs    desktop window; starts the edge service for local demos
```
