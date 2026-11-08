"""Site agent: Claude, connected to the twin, in suggest-only mode.

It answers the build manager in the chat, and it watches the site through the monitor.
It can read anything in the twin through its tools, but it cannot change anything:
every change is a `propose_action` that shows up in the chat as a suggestion card, and
only runs if the build manager approves it.

Needs ANTHROPIC_API_KEY (and an internet path, e.g. the site's satellite uplink).
ANTHROPIC_MODEL overrides the model.
"""

from __future__ import annotations

import json
import logging
import math
import os
import time
from typing import Any, Awaitable, Callable

from .site import ACTIONS, ActionError, Site
from .twin.network import COVERAGE_RADIUS_M, COVERAGE_TOLERANCE_M

log = logging.getLogger("edge.agent")

DEFAULT_MODEL = "claude-sonnet-5-5"
MAX_TOOL_ROUNDS = 8
HISTORY_LIMIT = 60
NO_UPDATE = "NO_UPDATE"

SYSTEM_PROMPT = f"""You are the site agent for an Exowatt P3 solar-thermal construction site in rural West Texas. \
You work for the build manager, who talks to you through a chat box under a live 2D digital twin of the site.

The site has no internet (an optional satellite uplink is how you are reached). The twin moves through three stages:
1. survey: a scout drone traces a square boundary at a distance the manager sets, then survey drones map sections \
   (A1, B3, ...) and reveal elevation. The manager can map more gaps or lock the survey.
2. buildup: the manager sets the number of P3 units and the crew available. The planner (rule-based, not you) \
   places units on flat mapped ground in blocks (A, B, ...) and decides relays, gateways, UWB anchors, robots, \
   machines, crew and schedule. Never choose the number of units yourself; that is always the manager's decision.
3. construction: the approved plan is built over the site mesh (mesh spec v0.1):
   - Relays (M-n) and two gateways (GW-1, GW-2, wired to the hub) flood every packet. Each relay covers {COVERAGE_RADIUS_M} m; \
     the plan gives every work area two relays, so one failing should not cut anything off.
   - Robots: pile drivers RPD-n and a survey bot SB-n. A robot hears relays directly (depth 0) or reaches the mesh through \
     up to two neighbor robots (depth 1-2), and may work up to {COVERAGE_TOLERANCE_M} m outside coverage. No mesh path for 1.5 s \
     means it stops (LOST_MESH_CONTACT). Robots split the work among themselves (CBAA auctions); the hub only publishes tasks.
   - Crew, supervisors and manual machines (cranes CR-n, telehandlers TH-n, trenchers TR-n) carry UWB badges; the hub \
     fuses UWB ranges into tracks. Robots hold for people and machines nearby (CREW_HOLD) and for each other \
     (PROXIMITY_YIELD); holds clear by themselves.
   - Stops need a RESUME: remotely (from you via the manager) for lost contact, zone breach, supervisor stop and out of \
     coverage, once the cause has cleared; near miss, person detected, collision and fault need a supervisor standing \
     at the robot. Suggest walking a supervisor over for those instead of a remote resume.
   - The hub raises alerts (node lost with cause, near miss, crew in zone, stop needs resume, shortfall, sign-off \
     needed, ...) to the nearest supervisor and escalates unacknowledged ones.
   Unit ids look like B-04-12 (block B, row 4, slot 12). Crew are named like "J. Ortiz".

How you work:
- You are SUGGEST-ONLY. You cannot change anything on site. To suggest a change, call propose_action; it appears in the \
  chat as a card the manager can approve or dismiss. Even when the manager tells you to do something, propose it; \
  their click is the approval. Don't claim an action happened until you're told it was approved.
- Look things up with your tools instead of guessing. Use names and numbers from the twin.
- Be brief and concrete: plain sentences, no headings, at most a few short lines. Lead with what matters. \
  Say what you'd do and why in one line, then propose it.
- When the message starts with [Site monitor], nobody asked: decide whether the manager needs to know. If it's routine or \
  already handled (traffic rerouted, a hold that cleared, a supervisor already handling it), reply with exactly {NO_UPDATE}. \
  Otherwise write a short heads-up, with a proposal if there's a clear next step.
- Messages starting with [Manager action] tell you what the manager did directly with the UI; take them into account.
"""


ACTION_NAMES = [n for n, v in ACTIONS.items() if v[3]]

TOOLS: list[dict[str, Any]] = [
    {
        "name": "get_site_overview",
        "description": "Current stage and a short summary of the whole site: survey progress, plan, construction progress, network and alerts.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_survey_status",
        "description": "Survey details: phase, distance, coverage, elevation stats, sections (coverage/status), suggested gaps, drones (status, battery, task).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_plan",
        "description": "The current buildup plan: inputs, units placed, blocks, fleet with the reason for each quantity, crew, stage durations, bottleneck, relays, warnings and the planning assumptions.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "find_asset",
        "description": "Find one robot, relay, gateway, anchor, supervisor, crew member or machine by id or name (e.g. 'RPD-1', 'M-4', 'Ortiz', 'CR-1') and get what the twin knows: mode, stop reason, task, battery, mesh depth and attached node, liveness, last heard, block. Also highlights it on the manager's map.",
        "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
    {
        "name": "list_assets",
        "description": "List nodes and tracks during construction, optionally filtered.",
        "input_schema": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": ["robot", "relay", "anchor", "supervisor", "crew", "machine", "unknown"]},
                "block": {"type": "string", "description": "Block letter, e.g. 'B'"},
                "issue": {"type": "string", "enum": ["stopped", "hold", "lost", "late", "low_battery", "out_of_coverage_band", "via_robot", "stale_track"]},
            },
        },
    },
    {
        "name": "get_network_status",
        "description": "Mesh health: relays and gateways (liveness, load, drops, gateway hops), relay links, robots' mesh depth and attachment, hub links (gateways up, Starlink, HQ sync), packet rate.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_alerts",
        "description": "Hub alerts (newest first): kind, severity, subjects, which supervisors were notified and whether anyone acknowledged.",
        "input_schema": {"type": "object", "properties": {"open_only": {"type": "boolean"}}},
    },
    {
        "name": "get_tasks",
        "description": "Tasks the hub has published and their items: state counts, which robot holds what, held or awaiting sign-off items, shortfall; plus units set by cranes.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_recent_events",
        "description": "The hub's event log (stops, item changes, alerts, acks, commands, node losses) or the survey log, newest first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "contains": {"type": "string", "description": "Only entries containing this text (case-insensitive)."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 40},
            },
        },
    },
    {
        "name": "propose_action",
        "description": "Suggest a change to the site. It is shown to the build manager as a card with Approve / Dismiss and runs only if approved. "
        "Actions: " + " ".join(f"{n}: {d} args {json.dumps(a)}." for n, (_, d, a, agent) in ACTIONS.items() if agent),
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ACTION_NAMES},
                "args": {"type": "object", "description": "Arguments for the action (see the action list)."},
                "reason": {"type": "string", "description": "One short sentence the manager sees on the card."},
            },
            "required": ["action", "reason"],
        },
        "cache_control": {"type": "ephemeral"},
    },
]

ProposeFn = Callable[[str, dict, str], dict]


class SiteAgent:
    def __init__(self, site: Site, propose: ProposeFn, client: Any = None):
        self.site = site
        self.propose = propose
        self.model = os.environ.get("ANTHROPIC_MODEL", DEFAULT_MODEL)
        self.history: list[dict] = []
        self.pending_notes: list[str] = []
        self._client = client
        self._client_error: str | None = None
        if client is None:
            if not os.environ.get("ANTHROPIC_API_KEY"):
                self._client_error = "The site agent is offline: ANTHROPIC_API_KEY isn't set on the edge service (services/edge/.env). The map buttons still work."
            else:
                try:
                    from anthropic import AsyncAnthropic

                    self._client = AsyncAnthropic()
                except Exception as e:  # pragma: no cover
                    self._client_error = f"The site agent couldn't start: {e}"

    @property
    def online(self) -> bool:
        return self._client is not None

    @property
    def status(self) -> str:
        return "online" if self.online else (self._client_error or "offline")

    def note(self, text: str) -> None:
        """Something the manager did directly; the agent sees it with its next message."""
        self.pending_notes.append(text)
        del self.pending_notes[:-12]

    async def respond(self, text: str, on_tool: Callable[[str], Awaitable[None]] | None = None) -> dict:
        """Run one agent turn. Returns {"text", "tools", "select", "proposals"}."""
        result: dict = {"text": "", "tools": [], "select": None, "proposals": []}
        if not self._client:
            result["text"] = self._client_error or "The site agent is offline."
            return result
        prefix = "".join(f"[Manager action] {n}\n" for n in self.pending_notes)
        self.pending_notes = []
        self._trim()
        start = len(self.history)
        self.history.append({"role": "user", "content": prefix + text})
        said: list[str] = []
        try:
            for _ in range(MAX_TOOL_ROUNDS):
                resp = await self._client.messages.create(
                    model=self.model,
                    max_tokens=1024,
                    system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
                    tools=TOOLS,
                    messages=self.history,
                )
                # The API rejects empty text blocks, so drop them before keeping the reply in the history.
                content = [b for b in (_block_to_dict(x) for x in resp.content) if not (b["type"] == "text" and not b["text"].strip())]
                if not content:
                    content = [{"type": "text", "text": "(no reply)"}]
                self.history.append({"role": "assistant", "content": content})
                uses = [b for b in content if b["type"] == "tool_use"]
                said += [b["text"].strip() for b in content if b["type"] == "text" and b["text"].strip()]
                if not uses:
                    result["text"] = "\n\n".join(said).strip()
                    return result
                tool_results = []
                for u in uses:
                    label = _tool_label(u["name"], u.get("input") or {})
                    result["tools"].append(label)
                    if on_tool:
                        await on_tool(label)
                    out = self._run_tool(u["name"], u.get("input") or {}, result)
                    tool_results.append({"type": "tool_result", "tool_use_id": u["id"], "content": json.dumps(out, default=_json_default)[:12000]})
                self.history.append({"role": "user", "content": tool_results})
            result["text"] = "I ran out of steps working on that. Could you narrow it down?"
            return result
        except Exception as e:
            log.warning("agent call failed: %s", e)
            del self.history[start:]  # drop the unfinished turn so the history stays valid
            result["text"] = _friendly_error(e)
            return result

    # ---------- tools ----------

    def _run_tool(self, name: str, args: dict, result: dict) -> Any:
        try:
            if name == "propose_action":
                action, a, reason = args.get("action", ""), args.get("args") or {}, args.get("reason", "")
                try:
                    self.site.validate(action, a)
                except ActionError as e:
                    return {"error": str(e)}
                card = self.propose(action, a, reason)
                result["proposals"].append(card)
                return {"proposed": card["label"], "status": "Waiting for the build manager to approve or dismiss."}
            fn = getattr(self, f"_tool_{name}", None)
            if not fn:
                return {"error": f"Unknown tool {name}"}
            return fn(args, result)
        except Exception as e:  # tool bugs shouldn't kill the turn
            log.exception("tool %s failed", name)
            return {"error": f"{type(e).__name__}: {e}"}

    def _tool_get_site_overview(self, args, result):
        site = self.site
        s = site.survey
        st = s.stats()
        out: dict[str, Any] = {
            "stage": site.stage,
            "survey": {"phase": s.phase, "distanceM": s.distance_m, "coveragePct": round(st["coverage"] * 100), "areaKm2": round(st["perimeterAreaKm2"], 2), "terrain": "real" if s.terrain.real else "synthetic"},
            "availableActions": site.available_actions(for_agent=True),
        }
        if site.plan:
            p = site.plan
            out["plan"] = {"unitsRequested": p["input"]["unitCount"], "unitsPlaced": len(p["units"]), "crewAvailable": p["input"]["crewSize"], "crewUsed": p["crewUsed"], "relays": len(p["relays"]), "anchors": len(p.get("anchors", [])), "totalDays": p["totalDays"], "bottleneck": p["bottleneck"], "warnings": p["warnings"]}
        snap, planning = site.mesh.snapshot, site.mesh.planning
        if site.construction and snap:
            robots = [n for n in snap["nodes"] if n["kind"] == 4]
            relays = [n for n in snap["nodes"] if n["kind"] in (2, 3)]
            units = planning["units"] if planning else []
            open_alerts = [a for a in snap["alerts"] if not a.get("ack") and a["kind"] != 10]
            out["construction"] = {
                "unitsPiled": sum(u["status"] in ("piled", "installed") for u in units),
                "unitsSet": sum(u["status"] == "installed" for u in units),
                "unitsTotal": len(units),
                "robots": {n["name"]: _robot_brief(n) for n in robots},
                "relaysUp": f"{sum(1 for r in relays if r['liveness'] != 2)} of {len(relays)}",
                "relaysLost": [r["name"] for r in relays if r["liveness"] == 2],
                "tracks": _count(t["kind"] for t in snap["tracks"]["list"]),
                "openAlerts": [f"{a['alertId']}: {_ALERT.get(a['kind'], a['kind'])}" for a in open_alerts[:8]],
                "gatewaysUp": len(snap["hubLinks"]["gatewaysUp"]),
                "starlink": "up" if snap["hubLinks"]["starlinkUp"] else "down",
                "sim": site.mesh.status,
            }
        return out

    def _tool_get_survey_status(self, args, result):
        s = self.site.survey
        snap = s.snapshot()
        return {
            "phase": snap["phase"],
            "distanceM": snap["distanceM"],
            "maxDistanceM": snap["maxDistanceM"],
            "stats": {k: (round(v, 3) if isinstance(v, float) else v) for k, v in snap["stats"].items()},
            "sections": [{"id": x["id"], "coveragePct": round(x["coverage"] * 100), "status": x["status"], "drones": x["assignedTo"]} for x in snap["sections"]],
            "suggestedGaps": s.suggestions()[:6] if s.sections else [],
            "drones": [{"id": d["id"], "role": d["role"], "status": d["status"], "battery": d["battery"], "task": d["task"]} for d in snap["drones"]],
            "terrain": snap["terrain"]["sourceLabel"],
            "recentEvents": [e["text"] for e in snap["events"][:8]],
        }

    def _tool_get_plan(self, args, result):
        p = self.site.plan
        if not p:
            return {"plan": None, "note": "No plan yet. The manager sets units and crew, then the planner generates it."}
        return {
            "input": p["input"],
            "unitsPlaced": len(p["units"]),
            "buildableSlots": p["buildableSlots"],
            "blocks": [{"id": b["id"], "units": b["unitCount"], "rows": b["rows"]} for b in p["blocks"]],
            "fleet": [{"name": f["name"], "count": f["count"], "why": f["why"]} for f in p["fleet"]],
            "crew": p["crew"],
            "crewUsed": p["crewUsed"],
            "stages": [{"stage": s["stage"], "days": round(s["days"], 1), "detail": s["detail"]} for s in p["stages"]],
            "totalDays": p["totalDays"],
            "bottleneck": p["bottleneck"],
            "trenchKm": round(p["trenchM"] / 1000, 2),
            "meanHaulM": round(p["meanHaulM"]),
            "relays": [{"id": r["id"], "covers": r["covers"], "linkOnly": r["linkOnly"]} for r in p["relays"]],
            "anchors": len(p.get("anchors", [])),
            "warnings": p["warnings"],
            "assumptions": p["assumptions"],
            "approved": self.site.construction,
        }

    # ---------- construction views ----------

    def _block_at(self, pos: dict | None) -> str | None:
        p = self.site.plan
        if not p or not pos:
            return None
        x, y = self.site.frame.to_twin(pos)
        b = next((b for b in p["blocks"] if b["x"] - 10 <= x <= b["x"] + b["w"] + 10 and b["y"] - 10 <= y <= b["y"] + b["h"] + 30), None)
        return b["id"] if b else None

    def _entities(self) -> list[dict]:
        """Every node and track the twin knows about, in one shape."""
        site = self.site
        snap = site.mesh.snapshot
        if not site.construction or not snap:
            s = site.survey.snapshot()
            return [{"id": d["id"], "name": d["id"], "kind": "drone", "status": d["status"], "battery": d["battery"], "task": d["task"]} for d in s["drones"]]
        now = snap["now"]
        kinds = {1: "hub", 2: "relay", 3: "relay", 4: "robot", 5: "supervisor", 6: "anchor"}
        out = []
        for n in snap["nodes"]:
            e = {"id": n["id"], "name": n["name"], "kind": kinds.get(n["kind"], "node"), "liveness": ["fresh", "late", "lost"][n["liveness"]], "lastHeardSecondsAgo": max(0, round((now - n["lastHeard"]) / 1000)), "block": self._block_at(n.get("pos"))}
            if n["kind"] == 2:
                e["gateway"] = True
            if n.get("robot"):
                e.update(_robot_brief(n))
                via = n["robot"].get("via")
                e["via"] = site.name_of(via) if via else None
                e["viaRobot"] = bool(via) and any(r["node"] == via for r in site.sim_input["config"]["robots"])
            if n.get("relay"):
                r = n["relay"]
                e.update({"gatewayHops": r["gatewayHops"], "neighbors": len(r["neighbors"]), "queueDrops": sum(r["qDrop"]), "forwarded": sum(r["fwd"])})
            out.append(e)
        tk = {1: "crew", 2: "supervisor", 3: "machine", 4: "unknown"}
        for t in snap["tracks"]["list"]:
            out.append({"id": str(t["id"]), "name": site.name_of(str(t["id"])) if t["kind"] != 4 else f"Unknown object {t['id']}", "kind": tk.get(t["kind"], "track"), "accuracyM": round(t["acc"] / 100, 1), "stale": t["stale"], "block": self._block_at(t["pos"]), "speedMs": round(math.hypot(t["vx"], t["vy"]) / 100, 1)})
        return out

    def _tool_find_asset(self, args, result):
        q = str(args.get("query", "")).strip().lower().rstrip(".?!")
        ents = self._entities()
        hit = next((e for e in ents if e["id"].lower() == q or e["name"].lower() == q), None) or next((e for e in ents if q and q in e["name"].lower()), None)
        if not hit:
            return {"error": f"Nothing matching '{args.get('query')}'."}
        result["select"] = hit["id"]
        return hit

    def _tool_list_assets(self, args, result):
        items = self._entities()
        if args.get("kind"):
            items = [e for e in items if e["kind"] == args["kind"]]
        if args.get("block"):
            items = [e for e in items if e.get("block") == str(args["block"]).upper()]
        issue = args.get("issue")
        tests = {
            "stopped": lambda e: e.get("mode") == "STOPPED",
            "hold": lambda e: e.get("mode") == "HOLD",
            "lost": lambda e: e.get("liveness") == "lost",
            "late": lambda e: e.get("liveness") == "late",
            "low_battery": lambda e: e.get("battery", 100) < 25,
            "out_of_coverage_band": lambda e: e.get("inCoverageBand"),
            "via_robot": lambda e: e.get("viaRobot"),
            "stale_track": lambda e: e.get("stale"),
        }
        if issue in tests:
            items = [e for e in items if tests[issue](e)]
        return {"count": len(items), "items": items[:40], "truncated": len(items) > 40}

    def _tool_get_network_status(self, args, result):
        snap = self.site.mesh.snapshot
        if not self.site.construction or not snap:
            p = self.site.plan
            return {"note": "Construction hasn't started.", "plannedRelays": len(p["relays"]) if p else None}
        name = self.site.name_of
        relays = [n for n in snap["nodes"] if n["kind"] in (2, 3)]
        robots = [n for n in snap["nodes"] if n["kind"] == 4 and n.get("robot")]
        return {
            "relays": [{"name": r["name"], "gateway": r["kind"] == 2, "liveness": ["fresh", "late", "lost"][r["liveness"]], "gatewayHops": (r.get("relay") or {}).get("gatewayHops"), "queueDrops": sum((r.get("relay") or {}).get("qDrop", [0])), "neighbors": len((r.get("relay") or {}).get("neighbors", []))} for r in relays],
            "links": len(snap["links"]),
            "robots": [{"name": r["name"], "via": name(r["robot"]["via"]) if r["robot"].get("via") else None, "liveness": ["fresh", "late", "lost"][r["liveness"]]} for r in robots],
            "hub": {"gatewaysUp": [name(g) for g in snap["hubLinks"]["gatewaysUp"]], "starlink": snap["hubLinks"]["starlinkUp"]},
            "sim": self.site.mesh.status,
        }

    def _tool_list_alerts(self, args, result):
        snap = self.site.mesh.snapshot
        if not snap:
            return {"note": "Construction hasn't started."}
        name = self.site.name_of
        out = []
        for a in snap["alerts"]:
            if args.get("open_only") and a.get("ack"):
                continue
            out.append({"alertId": a["alertId"], "kind": _ALERT.get(a["kind"], a["kind"]), "severity": ["info", "warning", "urgent"][a["severity"]], "subjects": [name(s) for s in a["subjects"]], "taskId": a["taskId"] or None, "itemId": a["itemId"] or None, "ref": a["ref"], "notified": [name(n) for n in a["notified"]], "ack": {"by": name(a["ack"]["by"]), "action": ["seen", "handling", "needs help"][a["ack"]["action"]]} if a.get("ack") else None})
        return out[:25]

    def _tool_get_tasks(self, args, result):
        snap, planning = self.site.mesh.snapshot, self.site.mesh.planning
        if not snap:
            return {"note": "Construction hasn't started."}
        name = self.site.name_of
        labels = {t["taskId"]: t["label"] for t in (planning or {}).get("tasks", [])}
        states = ["OPEN", "ASSIGNED", "STARTED", "DONE", "CANCELLED", "HELD", "AWAITING_SIGNOFF"]
        tasks = []
        for t in snap["tasks"]:
            counts = _count(states[i["state"]] for i in t["items"])
            working = [f"{name(i['winNode'])}: item {i['itemId']} ({states[i['state']].lower()})" for i in t["items"] if i["state"] in (1, 2) and i.get("winNode")]
            special = [{"itemId": i["itemId"], "state": states[i["state"]]} for i in t["items"] if i["state"] in (5, 6)]
            tasks.append({"taskId": t["task"]["taskId"], "label": labels.get(t["task"]["taskId"], ""), "mode": t["task"]["mode"], "robotCount": t["task"]["robotCount"], "counts": counts, "working": working, "heldOrSignoff": special[:10], "shortfall": t["shortfall"]})
        queued = [t for t in (planning or {}).get("tasks", []) if t["status"] == "queued"]
        units = (planning or {}).get("units", [])
        return {"tasks": tasks, "queued": [t["label"] for t in queued][:10], "units": _count(u["status"] for u in units)}

    def _tool_get_recent_events(self, args, result):
        site = self.site
        contains = str(args.get("contains") or "").lower()
        limit = int(args.get("limit") or 15)
        if site.construction:
            entries = list(reversed(site.mesh.hub_log))
            now = (site.mesh.snapshot or {}).get("now", 0)
            out = [{"secondsAgo": round((now - e["at"]) / 1000), "kind": e["kind"], "text": e["text"]} for e in entries if not contains or contains in e["text"].lower()]
            return out[:limit]
        now = time.time() * 1000
        return [{"secondsAgo": round((now - e["at"]) / 1000), "level": e["level"], "text": e["text"]} for e in site.survey.events if not contains or contains in e["text"].lower()][:limit]

    # ---------- history ----------

    def _trim(self) -> None:
        """Keep the conversation bounded, cutting only at the start of a plain user turn."""
        while len(self.history) > HISTORY_LIMIT:
            del self.history[0]
            while self.history and not (self.history[0]["role"] == "user" and isinstance(self.history[0]["content"], str)):
                del self.history[0]


def _block_to_dict(b: Any) -> dict:
    if isinstance(b, dict):
        return b
    if b.type == "text":
        return {"type": "text", "text": b.text}
    if b.type == "tool_use":
        return {"type": "tool_use", "id": b.id, "name": b.name, "input": b.input}
    return b.model_dump()


def _tool_label(name: str, args: dict) -> str:
    return {
        "get_site_overview": "Checked the site overview",
        "get_survey_status": "Checked the survey",
        "get_plan": "Read the buildup plan",
        "find_asset": f"Looked up {args.get('query', '')}",
        "list_assets": "Listed assets" + (f" ({', '.join(str(v) for v in args.values())})" if args else ""),
        "get_network_status": "Checked the mesh",
        "get_recent_events": "Read the site log",
        "list_alerts": "Checked alerts",
        "get_tasks": "Checked tasks",
        "propose_action": f"Suggested: {args.get('action', '')}",
    }.get(name, name)


def _friendly_error(e: Exception) -> str:
    name = type(e).__name__
    if "Connection" in name or "Timeout" in name:
        return "I can't reach Claude right now (is the satellite uplink down?). The site keeps running; the map buttons still work."
    if "Authentication" in name:
        return "The Anthropic API key on the edge service was rejected. Check ANTHROPIC_API_KEY in services/edge/.env."
    if "RateLimit" in name:
        return "Claude is rate-limiting requests right now. Try again in a minute."
    return f"The site agent hit an error ({name}). Try again."


def _json_default(o):
    try:
        return float(o)
    except Exception:
        return str(o)


_ALERT = {1: "NODE_LOST", 2: "NEAR_MISS", 3: "CREW_IN_ZONE", 4: "STOP_NEEDS_RESUME", 5: "CREW_HOLD_LONG", 6: "POSITION_MISMATCH", 7: "SHORTFALL", 8: "ITEM_FAILED", 9: "DUPLICATE_START", 10: "MANUAL_TASK", 11: "SIGNOFF_NEEDED"}
_MODES = ["IDLE", "TO_ITEM", "WORKING", "STOPPED", "CHARGING", "OUT_OF_SERVICE", "MANUAL_OVERRIDE", "HOLD"]
_STOPS = {0: None, 1: "LOST_MESH_CONTACT", 2: "NEAR_MISS", 3: "PERSON_DETECTED", 4: "COLLISION", 5: "FAULT", 6: "ZONE_BREACH", 7: "SUPERVISOR_STOP", 8: "LOW_BATTERY", 9: "OUT_OF_COVERAGE", 20: "CREW_HOLD", 21: "PROXIMITY_YIELD"}


def _robot_brief(n: dict) -> dict:
    r = n.get("robot") or {}
    return {
        "mode": _MODES[r.get("mode", 0)] if r else None,
        "stopReason": _STOPS.get(r.get("stopReason", 0)),
        "stopId": r.get("stopId") or None,
        "battery": r.get("batteryPct"),
        "taskId": r.get("taskId") or None,
        "itemId": r.get("itemId") or None,
        "positionSource": ["RTK fixed", "RTK float", "GPS", "dead reckoning"][r.get("posSource", 0)] if r else None,
        "positionAccuracyCm": r.get("posAcc"),
        "inCoverageBand": bool(r.get("flags", 0) & 4),
        "tracksStale": bool(r.get("flags", 0) & 8),
        "liveness": ["fresh", "late", "lost"][n.get("liveness", 0)],
    }


def _count(it) -> dict:
    out: dict = {}
    for k in it:
        out[k] = out.get(k, 0) + 1
    return out
