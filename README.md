# MITEC-2026
Two twos

## Exowatt challenge: off-grid build-site digital twin

```
frontend/        build manager console (React + Electron): map, state panel, chat with the site agent
services/edge/   edge service (Python): survey, buildup planner, construction twin, site mesh, monitor, Claude site agent
tools/terrain/   fetches real elevation data for the site
```

Quick start: put an `ANTHROPIC_API_KEY` in `services/edge/.env` (see `.env.example`), then `cd frontend && npm install && npm run app`. That builds the console and starts the edge service. See each folder's README for details.
