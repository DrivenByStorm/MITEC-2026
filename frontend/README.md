# Build site digital twin: build manager console

Front end for the Exowatt off-grid construction site twin. A live 2D map sits at the top and a text box at the bottom. **Expand twin** opens the full real-time state panel beside the map.

The twin moves through stages, shown in the header:

1. **Survey:** drones build the terrain model of a new site from scratch.
2. **Buildup plan:** you set the number of P3 units and the crew available; the planner lays out the site and decides the relays, robots, machines and crew.
3. **Construction:** the approved plan is built live from bare ground, with machines, crews and the mesh network.

## Run it

```bash
cd frontend
npm install
```

As a desktop app (Electron):

```bash
npm run app        # build, then open the Site Twin window
npm run app:dev    # live-reloading desktop window while you edit code
npm run dist:mac   # package Site Twin.app (.dmg and .zip) into release/
```

The packaged app isn't code-signed, so the first time you open it on a Mac, right-click it, choose **Open**, then confirm. `npm run dist` packages for whatever OS you run it on (Windows installer, Linux AppImage).

In a browser:

```bash
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
```

Everything works offline: fonts are bundled and no external services are called.

## Survey stage

1. Set the boundary distance on the map (or type `start survey 1200 m`) and start the survey.
2. The scout drone (SC-1) flies out that far from the launch point and traces the site boundary, mapping a strip as it goes.
3. When the loop closes, the site is split into sections (A1, B2, ...). The **selection algorithm** assigns sections to the survey drones (SV-1 to SV-4).
4. The elevation heat map fills in wherever a drone has flown. Hover to read elevation; unmapped ground is hatched.
5. After the pass, suggested gaps are highlighted. Click one (or say `map more` / `survey B1`) to send drones, or choose **Move forward with buildup** to lock the survey.

Drones fly at 16× real speed so a pass fits in a demo. They swap batteries at the launch point and resume where they left off.

After a pass, **Move forward with buildup** locks the survey and opens the buildup planner on the mapped terrain.

## Buildup stage

Enter **P3 units to build** and **Crew available** (or type `plan 240 units with 30 people`). The number of units is always yours; the planner never changes it. It decides:

- **Layout:** units go on mapped ground flatter than 5% slope, inside a boundary setback and clear of the site office and laydown yard, in rows grouped into blocks (A, B, C...), filled nearest the office first. Ground it can't use is shaded on the map (red too steep, grey reserved). If the mapped ground can't fit every unit, it says so and suggests mapping more.
- **Relays:** enough solar relay masts that every unit is within reach of at least two (so one failing never cuts a work area off), plus link-only masts to chain distant relays back to the gateway. LoRa gateways go on every other mast.
- **Fleet and crew:** starts with one crew of each kind (piling, setting, trenching, electrical), then repeatedly adds to whichever stage is slowest until the crew runs out or another crew would save less than a quarter day. Telehandlers per crane come from the haul distance.
- **Schedule:** working days per stage and overall, and which stage limits it.

Every quantity comes with its reason (**Plan details**). The rates behind it are in `src/buildup/assumptions.ts`: Built Robotics' published pile rate is used; the rest are marked estimates to confirm with Exowatt. Ask `why this many relays?`, `what limits the schedule?` or `approve plan`.

**Approve and build** starts construction of exactly that plan: those units, relays, machines and people, from zero. About 40 s in, a relay fails on purpose so you can watch the two-relay coverage reroute everything with no loss of contact.

### Real elevation data

Out of the box the survey reveals synthetic terrain, and the map says so. To use real terrain, run this once on a computer with internet:

```bash
npm run terrain:fetch                                   # default site in Pecos County, TX
npm run terrain:fetch -- --lat 30.79 --lon -103.03 --size-km 6 --cell 15
```

This downloads AWS Terrain Tiles (USGS 3DEP, about 10 m resolution in the US) and writes `src/survey/data/site-dem.json`, which is bundled into the app, so the site itself still needs no connection. Commit that file to share it with the team.

### Plugging in the real selection algorithm

`src/survey/selection.ts` defines the interface (`SelectionInput` → `Assignment[]`) and a placeholder that gives each drone the nearest section and flies a back-and-forth pattern. Write your algorithm with the same signature and pass it in `src/survey/source.ts`:

```ts
instance = new SurveySession({ selection: yourAlgorithm })
```

## What's on screen (construction)

- **Site plan:** P3 units (orange = set, dotted = foundation ready, dashed = planned), robots and machines (teal), people (yellow), relay masts (diamonds), mesh links and relay coverage. Drag to pan, scroll to zoom, click anything to select it.
- **Freshness:** assets fade, then turn grey with a "last heard" age, when the twin stops hearing from them. The map shows the last *reported* position, never a guess.
- **Text box:** ask or instruct the site. In the survey try `start survey 1 km`, `status`, `map more`, `survey B1 C4`, `move to buildup`. In buildup try `plan 240 units with 30 people`, `why this fleet?`, `approve plan`. In construction try `status`, `where is RPD-1`, `need a telehandler at A2`, `pause CR-1`, `who is in block A`, `network`, `requests`, `help`.
- **Expanded view:** selected-asset detail with pause/resume, plus Overview, Machines, People, Network, Requests and Activity tabs.

## How it's built

```
scripts/
  fetch-terrain.mjs  downloads real elevation data into the app
src/
  buildup/
    planner.ts     BUILDUP PLANNER: layout, relays, fleet & crew sizing, schedule
    assumptions.ts rates and limits the planner uses (edit these)
    types.ts       plan data model
    preview.ts     plan → map preview
    overlay.ts     unbuildable-ground image
    commands.ts    text box commands for planning
  survey/
    types.ts       survey data model
    terrain.ts     loads site-dem.json, or synthetic terrain if absent
    session.ts     simulated drone survey (scout, sections, coverage, batteries)
    selection.ts   SELECTION ALGORITHM interface + placeholder
    heatmap.ts     elevation coloring and hillshade
    commands.ts    text box commands for the survey
    source.ts      SurveySource interface + useSurvey() hook
  twin/
    types.ts       data model (units, assets, links, events, requests)
    simulator.ts   builds an approved plan live (stands in for the edge server)
    network.ts     radio ranges shared by the planner and the simulator
    source.ts      TwinSource interface + useTwin() hook + freshness helpers
    commands.ts    offline parser for the text box
  components/
    SurveyView.tsx / SurveyMap.tsx / SurveyPanel.tsx   survey stage
    BuildupView.tsx / PlanPanel.tsx                    buildup planning
    ConstructionView.tsx                               construction
    Topbar.tsx        title, stage steps, status
    usePanZoom.ts     shared map pan/zoom
    SiteMap.tsx       SVG site plan with pan/zoom and layers
    StatePanel.tsx    expanded real-time state
    CommandConsole.tsx text box and conversation log
  App.tsx          stage switching
electron/
  main.cjs         desktop window: loads dist/ (or the dev server in app:dev)
```

The simulator keeps two copies of the world: what is really happening and what the twin has *heard* over the radio. Reports only arrive while an asset has a path to the gateway. An asset that loses coverage goes stale on the map but keeps working, and its queued results sync with their original timestamps when it reconnects (store-and-forward). Because the planner gives every unit two relays, a single relay failure normally just reroutes traffic; workers stay visible throughout over LoRa.

## Connecting real data

The components only use the `TwinSource` interface in `src/twin/source.ts`. To go live, implement it against the edge server, for example a WebSocket fed from the Zenoh router, and return it from `getTwinSource()`. The text box parser in `commands.ts` can likewise be swapped for, or backed by, a language model running on the edge server.
