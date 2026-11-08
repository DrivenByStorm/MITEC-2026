"""Edge service: hosts the site twin and the site agent, and streams both to the UI.

One WebSocket (/ws) carries everything. Server -> client messages:
    hello    terrain (heights), network ranges, stage, plan, chat history, agent status, actions
    survey   survey snapshot (+ packed coverage bits when new ground was mapped)
    twin     construction snapshot (with `mesh`: nodes, links, tasks, rounds, robot views)
    traces   mesh packet hops since the last batch, for the packet animation
    plan     buildup plan + preview snapshot
    stage    furthest stage reached
    chat     one chat message (new or updated, keyed by id)
    agent    agent status / busy / current activity
    result   reply to a client action
Client -> server messages:
    action   {id, name, args}: the build manager acting directly (UI buttons)
    chat     {text}: a message to the site agent
    decide   {suggestionId, approve}: approve or dismiss an agent suggestion
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
import os
import time
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .agent import NO_UPDATE, SiteAgent
from .monitor import Monitor
from .site import ACTIONS, ActionError, Site
from .clock import PACKETS_MAX_SPEED
from .survey.session import TICK_S as SURVEY_TICK_S

log = logging.getLogger("edge")

AGENT_MIN_INTERVAL_S = float(os.environ.get("AGENT_MIN_INTERVAL_S", "20"))
AGENT_PROACTIVE = os.environ.get("AGENT_PROACTIVE", "1") != "0"
SITE_STEP_S = 0.1  # construction loop period (wall seconds); the clock's speed decides site time per step
TRACE_EVERY = 2  # steps per traces batch
TWIN_EVERY = 5  # steps per twin snapshot
SURVEY_EVENTS = 60
TWIN_EVENTS = 80
CHAT_LIMIT = 300


def now_ms() -> int:
    return int(time.time() * 1000)


class EdgeApp:
    def __init__(self, site: Site | None = None, agent_client=None):
        self.site = site or Site()
        self.monitor = Monitor(self.site)
        self.agent = SiteAgent(self.site, self._propose, client=agent_client)
        self.clients: set[WebSocket] = set()
        self.chat: list[dict] = []
        self._seq = itertools.count(1)
        self._agent_lock = asyncio.Lock()
        self._agent_busy = False
        self._agent_activity = ""
        self._last_proactive = 0.0
        self._last_agent_error: str | None = None
        self._pending_findings: list[str] = []
        self._coverage_sent = -1
        self._plan_sent = 0
        self._stage_sent = self.site.stage
        self._tasks: list[asyncio.Task] = []

    # ---------- lifecycle ----------

    async def start(self) -> None:
        self._tasks = [asyncio.create_task(self._survey_loop()), asyncio.create_task(self._site_loop()), asyncio.create_task(self._agent_loop())]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await t

    # ---------- loops ----------

    async def _survey_loop(self) -> None:
        n = 0
        while True:
            await asyncio.sleep(SURVEY_TICK_S)
            if self.site.stage == "survey":
                for _ in range(self.site.survey_ticks()):
                    self.site.tick_survey()
            self.monitor.check()
            active = self.site.survey.phase in ("scouting", "surveying")
            n += 1
            if self.site.stage == "survey" and (active or n % 4 == 0):
                await self._broadcast_survey()
            await self._broadcast_changes()

    async def _site_loop(self) -> None:
        """Construction: advance the site clock (twin + mesh) and stream what changed."""
        n = 0
        while True:
            await asyncio.sleep(SITE_STEP_S)
            site = self.site
            if not site.sim or not site.mesh:
                continue
            rolled = site.advance(SITE_STEP_S)
            self.monitor.check()
            n += 1
            mesh = site.mesh
            if n % TRACE_EVERY == 0:
                traces = mesh.take_traces()
                speed = site.clock.effective_speed()
                if traces and self.clients and 0 < speed <= PACKETS_MAX_SPEED:
                    await self._broadcast({"type": "traces", "meshNow": round(mesh.tx.now, 3), "speed": speed, "traces": traces})
            if rolled or n % TWIN_EVERY == 0:
                await self._broadcast({"type": "twin", "snapshot": self._twin_snapshot()})

    async def _agent_loop(self) -> None:
        while True:
            await asyncio.sleep(2)
            new = self.monitor.take()
            if self.site.clock.finishing:
                continue  # skipping to the end: stay quiet, one wrap-up comes when it stops
            self._pending_findings += new
            del self._pending_findings[:-15]
            if not (AGENT_PROACTIVE and self.agent.online and self._pending_findings):
                continue
            if self._agent_lock.locked() or time.time() - self._last_proactive < AGENT_MIN_INTERVAL_S:
                continue
            findings, self._pending_findings = self._pending_findings, []
            self._last_proactive = time.time()
            text = "[Site monitor]\n" + "\n".join(f"- {f}" for f in findings)
            asyncio.create_task(self._agent_turn(text, proactive=True))

    # ---------- snapshots ----------

    def _survey_snapshot(self) -> dict:
        snap = self.site.survey.snapshot()
        snap["events"] = snap["events"][:SURVEY_EVENTS]
        return snap

    def _twin_snapshot(self) -> dict | None:
        if not self.site.sim:
            return None
        snap = self.site.sim.snapshot()
        snap["events"] = snap["events"][:TWIN_EVENTS]
        if self.site.mesh:
            snap["mesh"] = self.site.mesh.snapshot()
        if self.site.days:
            snap["schedule"] = self.site.days.view()
        snap["clock"] = self.site.clock.view()
        snap["manualChanges"] = self.site.manual_changes() if self.site.sim else []
        return snap

    def _plan_msg(self) -> dict:
        return {"type": "plan", "plan": self.site.plan, "preview": self.site.preview, "version": self.site.plan_version}

    def _agent_msg(self) -> dict:
        return {"type": "agent", "online": self.agent.online, "status": self.agent.status, "busy": self._agent_busy, "activity": self._agent_activity, "model": self.agent.model}

    def hello(self) -> dict:
        s = self.site.survey
        return {
            "type": "hello",
            "terrain": {**s.terrain.info(), "heightsDm": s.terrain.heights_dm_b64()},
            "network": self.site.network_info(),
            "clock": self.site.clock.view(),
            "stage": self.site.stage,
            "survey": self._survey_snapshot(),
            "coverage": {"version": s.coverage_version, "bits": self.site.coverage_b64()},
            "plan": self.site.plan,
            "preview": self.site.preview,
            "planVersion": self.site.plan_version,
            "twin": self._twin_snapshot(),
            "chat": self.chat,
            "agent": self._agent_msg(),
        }

    async def _broadcast_survey(self) -> None:
        s = self.site.survey
        msg: dict = {"type": "survey", "snapshot": self._survey_snapshot(), "clock": self.site.clock.view()}
        if s.coverage_version != self._coverage_sent:
            self._coverage_sent = s.coverage_version
            msg["coverage"] = {"version": s.coverage_version, "bits": self.site.coverage_b64()}
        await self._broadcast(msg)

    async def _broadcast_changes(self) -> None:
        if self.site.plan_version != self._plan_sent:
            self._plan_sent = self.site.plan_version
            await self._broadcast(self._plan_msg())
        if self.site.stage != self._stage_sent:
            self._stage_sent = self.site.stage
            await self._broadcast({"type": "stage", "stage": self.site.stage})
            await self._expire_suggestions()
            if self.site.stage == "construction":
                await self._broadcast({"type": "twin", "snapshot": self._twin_snapshot()})

    async def _broadcast(self, msg: dict) -> None:
        if not self.clients:
            return
        data = json.dumps(msg, separators=(",", ":"), default=_json_default)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    # ---------- chat ----------

    async def _post(self, **fields) -> dict:
        msg = {"id": next(self._seq), "at": now_ms(), **fields}
        self.chat.append(msg)
        del self.chat[:-CHAT_LIMIT]
        await self._broadcast({"type": "chat", "message": msg})
        return msg

    async def _update(self, msg: dict) -> None:
        await self._broadcast({"type": "chat", "message": msg})

    def _propose(self, action: str, args: dict, reason: str) -> dict:
        """Called by the agent. Creates a suggestion card; it's attached to the agent's reply."""
        return {"id": f"S-{next(self._seq)}", "action": action, "args": args, "label": self.site.describe_action(action, args), "reason": reason, "status": "pending"}

    async def _agent_turn(self, text: str, proactive: bool = False) -> None:
        async with self._agent_lock:
            self._agent_busy = True
            self._agent_activity = "Checking the site" if proactive else "Thinking"
            await self._broadcast(self._agent_msg())

            async def on_tool(label: str) -> None:
                self._agent_activity = label
                await self._broadcast(self._agent_msg())

            try:
                res = await self.agent.respond(text, on_tool)
            finally:
                self._agent_busy = False
                self._agent_activity = ""
                await self._broadcast(self._agent_msg())
            reply = res["text"].strip()
            if proactive and not res["proposals"] and (not reply or reply.startswith(NO_UPDATE)):
                return
            if res.get("error"):
                # Unprompted checks retry every few seconds: say a given error once, not every time.
                if proactive and reply == self._last_agent_error:
                    return
                self._last_agent_error = reply
            else:
                self._last_agent_error = None
            if reply.startswith(NO_UPDATE):
                reply = reply[len(NO_UPDATE):].strip()
            await self._post(
                **{"from": "agent"},
                text=reply,
                proactive=proactive,
                tools=res["tools"],
                select=res["select"],
                suggestions=res["proposals"],
            )

    # ---------- client messages ----------

    async def handle(self, ws: WebSocket, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "action":
            await self._handle_action(ws, msg)
        elif kind == "chat":
            text = str(msg.get("text", "")).strip()
            if text:
                await self._post(**{"from": "you"}, text=text)
                asyncio.create_task(self._agent_turn(text))
        elif kind == "decide":
            await self._handle_decision(str(msg.get("suggestionId")), bool(msg.get("approve")))

    async def _handle_action(self, ws: WebSocket, msg: dict) -> None:
        name, args = str(msg.get("name")), msg.get("args") or {}
        quiet = name in ("survey.setDistance", "mesh.latency", "mesh.loss") or name.startswith("sim.")  # dials shouldn't flood the chat
        try:
            text = self.site.run_action(name, args)
            ok = True
        except ActionError as e:
            text, ok = str(e), False
        await ws.send_text(json.dumps({"type": "result", "id": msg.get("id"), "ok": ok, "text": text}))
        label = self.site.describe_action(name, args)
        if ok and name == "sim.finishBuild":
            await self._expire_suggestions(f"No longer applies: the site was fast-forwarded from day {self.site.clock.day}.", everything=True)
        if not quiet or name in ("sim.finishBuild", "sim.cancelFinish"):
            await self._post(**{"from": "site"}, text=text, action=label, ok=ok)
        if ok and name != "survey.setDistance" and not name.startswith("sim."):
            self.agent.note(f"{label}. Result: {text}")
        await self._after_change()

    async def _handle_decision(self, sid: str, approve: bool) -> None:
        msg, card = next(((m, c) for m in reversed(self.chat) for c in m.get("suggestions") or [] if c["id"] == sid), (None, None))
        if not card or card["status"] != "pending":
            return
        if not approve:
            card["status"] = "dismissed"
            await self._update(msg)
            self.agent.note(f"Dismissed your suggestion: {card['label']}.")
            return
        try:
            card["result"] = self.site.run_action(card["action"], card["args"])
            card["status"] = "approved"
            self.agent.note(f"Approved your suggestion: {card['label']}. Result: {card['result']}")
        except ActionError as e:
            card["result"] = str(e)
            card["status"] = "failed"
            self.agent.note(f"Your suggestion {card['label']} was approved but failed: {e}")
        await self._update(msg)
        await self._after_change()

    async def _expire_suggestions(self, reason: str | None = None, everything: bool = False) -> None:
        """Suggestions for an earlier stage (or before a fast-forward) can't run any more; close them."""
        for m in self.chat:
            changed = False
            for card in m.get("suggestions") or []:
                if card["status"] == "pending" and (everything or ACTIONS[card["action"]][0] not in (self.site.stage, "any")):
                    card["status"] = "expired"
                    card["result"] = reason or f"No longer applies: the site has moved on to {self.site.stage}."
                    changed = True
            if changed:
                await self._update(m)

    async def _after_change(self) -> None:
        await self._broadcast_survey()
        await self._broadcast_changes()
        if self.site.sim:
            await self._broadcast({"type": "twin", "snapshot": self._twin_snapshot()})


def _json_default(o):
    try:
        return float(o)
    except Exception:
        return str(o)


def create_app(edge: EdgeApp | None = None) -> FastAPI:
    holder: dict = {}

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        holder["edge"] = edge or EdgeApp()
        await holder["edge"].start()
        log.info("Edge service ready. Agent: %s", holder["edge"].agent.status)
        yield
        await holder["edge"].stop()

    app = FastAPI(title="Site twin edge service", lifespan=lifespan)

    @app.get("/health")
    async def health():
        e: EdgeApp = holder["edge"]
        return JSONResponse({"ok": True, "stage": e.site.stage, "agent": e.agent.status, "clients": len(e.clients)})

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        e: EdgeApp = holder["edge"]
        await ws.accept()
        await ws.send_text(json.dumps(e.hello(), separators=(",", ":"), default=_json_default))
        e.clients.add(ws)
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                await e.handle(ws, msg)
        except WebSocketDisconnect:
            pass
        finally:
            e.clients.discard(ws)

    # Serve the built UI too, so tablets on the site network can open http://<edge-server>:8765/
    dist = Path(os.environ.get("FRONTEND_DIST", Path(__file__).resolve().parents[3] / "frontend" / "dist"))
    if dist.is_dir():
        from fastapi.staticfiles import StaticFiles

        app.mount("/", StaticFiles(directory=dist, html=True), name="ui")
    return app
