# MITEC-2026
Two twos

## Exowatt challenge: off-grid build-site digital twin

```
frontend/        build manager console (React + Electron): map, state panel, chat with the site agent
services/edge/   edge service (Python): survey, buildup planner, monitor, Claude site agent, hub planning software
packages/mesh/   the site mesh (TypeScript, mesh spec v0.1): relays, robots, anchors, tablets and the hub mesh service, simulated
tools/terrain/   fetches real elevation data for the site
```

Quick start: put an `ANTHROPIC_API_KEY` in `services/edge/.env` (see `.env.example`), then `cd frontend && npm install && npm run app`. That builds the console and starts the edge service, which starts the mesh simulator when construction begins. Node.js and Python 3.9+ are needed. See each folder's README for details.
