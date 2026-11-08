#!/usr/bin/env bash
# Starts the edge service, creating a virtualenv and installing dependencies the first time.
#   bash services/edge/run.sh [--host 0.0.0.0] [--port 8765]
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
if [ ! -x .venv/bin/python ]; then
  echo "edge: creating virtualenv (first run)"
  "$PY" -m venv .venv
fi
if [ ! -f .venv/.deps-ok ] || [ requirements.txt -nt .venv/.deps-ok ]; then
  echo "edge: installing dependencies"
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q -r requirements.txt
  touch .venv/.deps-ok
fi
# The mesh simulator (packages/mesh) runs the site mesh during construction; build it if needed.
MESH="$(cd ../../packages/mesh && pwd)"
if command -v node >/dev/null 2>&1; then
  if [ ! -d "$MESH/node_modules" ]; then
    echo "edge: installing the mesh simulator"
    (cd "$MESH" && npm install --silent --no-audit --no-fund)
  fi
  if [ ! -f "$MESH/dist/src/server.js" ] || [ -n "$(find "$MESH/src" -newer "$MESH/dist/src/server.js" -name '*.ts' | head -1)" ]; then
    echo "edge: building the mesh simulator"
    (cd "$MESH" && npm run build --silent)
  fi
else
  echo "edge: Node.js not found; construction (the mesh simulator) won't start until it's installed" >&2
fi
exec .venv/bin/python -m edge "$@"
