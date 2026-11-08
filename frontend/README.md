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

Enter **P3 units to build** and **Crew available**, then **Generate plan**, or ask the agent. The number of units is always yours. The planner decides the layout on flat mapped ground, the relays (every unit within 300 m of two), the two gateways, the UWB anchor posts, the fleet and crew, and the schedule. **Plan details** gives the reason for every quantity. **Approve and build** brings up the site mesh and starts construction of exactly that plan.

## Construction: the site mesh

Construction runs over the site mesh (`packages/mesh`, mesh spec v0.1). Everything on the map is what the hub mesh service reports.

- **Network:** relays (diamonds) and gateways (squares, wired to the hub) with their links. Shaded circles show each relay's coverage, and the dashed outline is the 3 m band robots may work in.
- **Robots:** pile drivers and the survey bot. A dotted line runs to the relay a robot is attached to; an orange dashed line means it reaches the mesh through another robot. A red octagon means stopped (needs a resume); an amber ring means holding (clears by itself).
- **People and machines:** crew and supervisors (yellow) and manual machines (outlined) are positioned from their UWB badges. Unknown objects seen by robot lidar show as red question marks. **Safety circles** shows where robots hold and slow for each of them.
- **Zones:** hazard zones from the survey and any zones you add.
- **Progress:** units turn piled when robots report them done over the mesh, and orange when cranes set them.
- **Packets:** animates traffic moving through the mesh, with a ring for each transmission and a dot for each hop. Click a dot to follow that message through the whole flood.
- **Sim controls:** run at 1×, 2×, 5× or 10×, and inject failures from spec section 17: relay, gateway or hub down; a robot's radio or RTK lost; a stray vehicle; crew walking into a hazard.
- **Expanded view:** details for the selected node (resume, stop, out of service), plus Overview, Robots, People, Mesh (relay counters), Tasks (release held items, sign off), Alerts (who was notified, acknowledge) and Activity (the hub's event log).

A remote resume works for lost contact, zone breach, supervisor stop and out of coverage. Near miss, person detected, collision and fault need a supervisor standing at the robot, so the twin explains instead of sending.

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
  mesh/
    types.ts         the mesh types (re-exported from packages/mesh, spec section 15)
    adapter.ts       site frame -> twin coordinates, in one place (spec 12.4)
  twin/
    types.ts         plan preview snapshot
    freshness.ts     live / lagging / stale
  components/
    SurveyView.tsx / SurveyMap.tsx / SurveyPanel.tsx   survey stage
    BuildupView.tsx / PlanPanel.tsx                    buildup planning
    ConstructionView.tsx / MeshMap.tsx / MeshPanel.tsx  construction over the mesh
    SiteMap.tsx       plan preview map
    CommandConsole.tsx  chat with the site agent, suggestion cards
    Topbar.tsx, usePanZoom.ts
  App.tsx            stage switching, connection screen
electron/main.cjs    desktop window; starts the edge service for local demos
```
