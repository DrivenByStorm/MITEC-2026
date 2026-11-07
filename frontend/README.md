# Build site digital twin: build manager console

Front end for the Exowatt off-grid construction site twin. A live 2D site plan sits at the top and a text box at the bottom. **Expand twin** opens the full real-time state panel beside the map.

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

## What's on screen

- **Site plan:** P3 units (orange = set, dotted = foundation ready, dashed = planned), robots and machines (teal), people (yellow), relay masts (diamonds), mesh links and relay coverage. Drag to pan, scroll to zoom, click anything to select it.
- **Freshness:** assets fade, then turn grey with a "last heard" age, when the twin stops hearing from them. The map shows the last *reported* position, never a guess.
- **Text box:** ask or instruct the site. Try `status`, `where is RPD-1`, `need a telehandler at B7`, `pause CR-1`, `who is in block C`, `network`, `requests`, `help`.
- **Expanded view:** selected-asset detail with pause/resume, plus Overview, Machines, People, Network, Requests and Activity tabs.

## How it's built

```
src/
  twin/
    types.ts       data model (units, assets, links, events, requests)
    simulator.ts   simulated site standing in for the edge server
    source.ts      TwinSource interface + useTwin() hook + freshness helpers
    commands.ts    offline parser for the text box
  components/
    SiteMap.tsx       SVG site plan with pan/zoom and layers
    StatePanel.tsx    expanded real-time state
    CommandConsole.tsx text box and conversation log
  App.tsx          layout and expand/collapse
electron/
  main.cjs         desktop window: loads dist/ (or the dev server in app:dev)
```

The simulator keeps two copies of the world: what is really happening and what the twin has *heard* over the radio. Reports only arrive while an asset has a path to the gateway, so you can watch store-and-forward work. About 12 s after load, relays M-4 and M-7 fail. RPD-1 drops out of coverage and goes stale but keeps driving piles. When it reconnects, its queued results sync into the twin with their original timestamps. Workers stay visible throughout over LoRa.

## Connecting real data

The components only use the `TwinSource` interface in `src/twin/source.ts`. To go live, implement it against the edge server, for example a WebSocket fed from the Zenoh router, and return it from `getTwinSource()`. The text box parser in `commands.ts` can likewise be swapped for, or backed by, a language model running on the edge server.
