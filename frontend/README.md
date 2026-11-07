# Build site digital twin: build manager console

Front end for the Exowatt off-grid construction site twin. A live 2D map sits at the top and a text box at the bottom. **Expand twin** opens the full real-time state panel beside the map.

The twin moves through stages, shown in the header:

1. **Survey:** drones build the terrain model of a new site from scratch.
2. **Buildup plan:** placeholder for the layout algorithm (next to design).
3. **Construction (demo):** the live site with machines, crews and the mesh network.

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

## What's on screen (construction demo)

- **Site plan:** P3 units (orange = set, dotted = foundation ready, dashed = planned), robots and machines (teal), people (yellow), relay masts (diamonds), mesh links and relay coverage. Drag to pan, scroll to zoom, click anything to select it.
- **Freshness:** assets fade, then turn grey with a "last heard" age, when the twin stops hearing from them. The map shows the last *reported* position, never a guess.
- **Text box:** ask or instruct the site. In the survey try `start survey 1 km`, `status`, `map more`, `survey B1 C4`, `move to buildup`. In the construction demo try `status`, `where is RPD-1`, `need a telehandler at B7`, `pause CR-1`, `who is in block C`, `network`, `requests`, `help`.
- **Expanded view:** selected-asset detail with pause/resume, plus Overview, Machines, People, Network, Requests and Activity tabs.

## How it's built

```
scripts/
  fetch-terrain.mjs  downloads real elevation data into the app
src/
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
    simulator.ts   simulated site standing in for the edge server
    source.ts      TwinSource interface + useTwin() hook + freshness helpers
    commands.ts    offline parser for the text box
  components/
    SurveyView.tsx / SurveyMap.tsx / SurveyPanel.tsx   survey stage
    ConstructionView.tsx                               construction demo
    Topbar.tsx        title, stage steps, status
    usePanZoom.ts     shared map pan/zoom
    SiteMap.tsx       SVG site plan with pan/zoom and layers
    StatePanel.tsx    expanded real-time state
    CommandConsole.tsx text box and conversation log
  App.tsx          stage switching
electron/
  main.cjs         desktop window: loads dist/ (or the dev server in app:dev)
```

The simulator keeps two copies of the world: what is really happening and what the twin has *heard* over the radio. Reports only arrive while an asset has a path to the gateway, so you can watch store-and-forward work. About 12 s after load, relays M-4 and M-7 fail. RPD-1 drops out of coverage and goes stale but keeps driving piles. When it reconnects, its queued results sync into the twin with their original timestamps. Workers stay visible throughout over LoRa.

## Connecting real data

The components only use the `TwinSource` interface in `src/twin/source.ts`. To go live, implement it against the edge server, for example a WebSocket fed from the Zenoh router, and return it from `getTwinSource()`. The text box parser in `commands.ts` can likewise be swapped for, or backed by, a language model running on the edge server.
