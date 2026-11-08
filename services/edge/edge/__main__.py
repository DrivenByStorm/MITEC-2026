"""Run the edge service:  python -m edge [--host 0.0.0.0] [--port 8765]"""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path


def load_dotenv(path: Path) -> None:
    """Minimal .env reader (KEY=value lines) so the API key can live in services/edge/.env."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def main() -> None:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    ap = argparse.ArgumentParser(description="Site twin edge service")
    ap.add_argument("--host", default=os.environ.get("EDGE_HOST", "127.0.0.1"), help="0.0.0.0 to serve the site network")
    ap.add_argument("--port", type=int, default=int(os.environ.get("EDGE_PORT", "8765")))
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    import uvicorn

    from .server import create_app

    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
