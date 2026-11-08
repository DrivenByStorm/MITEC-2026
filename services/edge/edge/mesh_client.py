"""Connection to the mesh simulator (packages/mesh), which runs the site mesh and the hub mesh
service. The edge service starts it when construction begins, sends it the site config and
tasks, forwards the build manager's commands, and receives the twin interface (spec 12.1):
a snapshot every second, an event stream and, on request, packet traces.

On real hardware the same messages would come from the hub mesh service talking to the
gateways; only this client would change.

MESH_URL points at an already-running simulator; otherwise one is started with node.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
import os
import shutil
from pathlib import Path
from typing import Awaitable, Callable

import websockets

log = logging.getLogger("edge.mesh")

REPO = Path(__file__).resolve().parents[3]
MESH_DIR = REPO / "packages" / "mesh"
DEFAULT_PORT = int(os.environ.get("MESH_PORT", "8766"))

Handler = Callable[[dict], Awaitable[None]]


class MeshClient:
    def __init__(self, on_message: Handler):
        self.on_message = on_message
        self.url = os.environ.get("MESH_URL") or f"ws://127.0.0.1:{DEFAULT_PORT}"
        self.proc: asyncio.subprocess.Process | None = None
        self.ws = None
        self._seq = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}
        self._reader: asyncio.Task | None = None
        self.snapshot: dict | None = None
        self.planning: dict | None = None
        self.status: dict | None = None
        self.hub_log: list[dict] = []
        self.error: str | None = None

    @property
    def connected(self) -> bool:
        return self.ws is not None

    async def ensure(self) -> None:
        """Connect, starting the simulator first if needed."""
        if self.ws is not None:
            return
        if not os.environ.get("MESH_URL"):
            await self._spawn()
        for _ in range(60):
            try:
                self.ws = await websockets.connect(self.url, max_size=32 * 1024 * 1024)
                break
            except OSError:
                await asyncio.sleep(0.25)
        if self.ws is None:
            raise RuntimeError(f"Couldn't reach the mesh simulator at {self.url}.")
        self._reader = asyncio.create_task(self._read())

    async def _spawn(self) -> None:
        if self.proc and self.proc.returncode is None:
            return
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js is needed to run the mesh simulator (packages/mesh).")
        server = MESH_DIR / "dist" / "src" / "server.js"
        if not server.exists():
            raise RuntimeError("The mesh simulator isn't built. Run: cd packages/mesh && npm install && npm run build")
        port = self.url.rsplit(":", 1)[-1]
        self.proc = await asyncio.create_subprocess_exec(node, str(server), "--port", port, cwd=str(MESH_DIR))
        log.info("Started mesh simulator (pid %s) on %s", self.proc.pid, self.url)

    async def _read(self) -> None:
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                kind = msg.get("type")
                if kind == "result":
                    fut = self._pending.pop(msg.get("id"), None)
                    if fut and not fut.done():
                        fut.set_result(msg)
                    continue
                if kind == "snapshot":
                    self.snapshot, self.planning, self.status = msg["mesh"], msg["planning"], msg["status"]
                    self.hub_log = msg.get("hubLog", self.hub_log)
                await self.on_message(msg)
        except websockets.ConnectionClosed:
            pass
        finally:
            self.ws = None
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_result({"ok": False, "text": "Lost the connection to the mesh simulator."})
            self._pending.clear()

    async def request(self, msg: dict, timeout: float = 15.0) -> dict:
        await self.ensure()
        rid = next(self._seq)
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        await self.ws.send(json.dumps({**msg, "id": rid}))
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self._pending.pop(rid, None)
            return {"ok": False, "text": "The mesh simulator didn't answer."}

    async def close(self) -> None:
        if self.ws is not None:
            with contextlib.suppress(Exception):
                await self.ws.close()
        if self._reader:
            self._reader.cancel()
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.proc.wait(), 3)
