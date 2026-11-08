"""Run the edge service with a scripted stand-in for Claude (no API key needed).
For UI development and tests only:  python tests/run_fake.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import uvicorn  # noqa: E402

from edge.server import EdgeApp, create_app  # noqa: E402
from tests.fake_claude import FakeClaude  # noqa: E402

if __name__ == "__main__":
    uvicorn.run(create_app(EdgeApp(agent_client=FakeClaude())), host="127.0.0.1", port=int(os.environ.get("EDGE_PORT", "8765")), log_level="warning")
