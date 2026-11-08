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
exec .venv/bin/python -m edge "$@"
