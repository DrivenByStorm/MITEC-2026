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
import os
import time
from typing import Any, Awaitable, Callable

from .site import ACTIONS, ActionError, Site
from .twin.network import ASSET_RANGE_M, RELAY_RANGE_M, ROBOT_RANGE_M

log = logging.getLogger("edge.agent")

DEFAULT_MODEL = "claude-sonnet-5-5"
MAX_TOOL_ROUNDS = 8
HISTORY_LIMIT = 60
NO_UPDATE = "NO_UPDATE"

SYSTEM_PROMPT = f"""You are the site agent for an Exowatt P3 solar-thermal construction site in rural West Texas. \
You work for the build manager, who talks to you through a chat box under a live 2D digital twin of the site.

The site has no internet. Robots, machines and relays talk over a local mesh; workers wear LoRa + UWB tags. \
The digital twin runs on the site's edge server. Positions are site meters (x east, y south).

The twin moves through three stages:
1. survey: a scout drone traces a square boundary at a distance the manager sets, then survey drones map sections \
   (A1, B3, ...) and reveal elevation. The manager can map more gaps or lock the survey.
2. buildup: the manager sets the number of P3 units and the crew available. The planner (rule-based, not you) \
   places units on flat mapped ground in blocks (A, B, ...) and decides relays, robots, machines, crew and schedule. \
   Never choose the number of units yourself; that is always the manager's decision.
3. construction: the approved plan is built live. Pile-driving robots (RPD-n), cranes (CR-n), telehandlers (TH-n), \
   trenchers (TR-n), a drone (DR-1), relay masts (M-n) and the gateway (GW). Each machine reaches the network through \
   a relay within {ASSET_RANGE_M} m; relays mesh within {RELAY_RANGE_M} m. The plan gives every work area two relays, \
   so one relay failing should not cut anything off. Assets out of coverage go stale on the map but keep working and \
   sync when they reconnect. Workers are W-nn with names like "J. Ortiz". Unit ids look like B-04-12 (block B, row 4, slot 12).

The site mesh (construction): the autonomous robots (pile drivers RPD-n, layout rovers LR-n, drone DR-1), the relay masts, \
the gateway GW and the hub (HUB, the edge server, wired to GW) are mesh nodes. Robots link to each other within {ROBOT_RANGE_M} m \
and to relays within {ASSET_RANGE_M} m; packets are forwarded hop by hop. The hub introduces row tasks: "Stake row A-03" (rovers), \
then "Pile row A-03" (pile drivers), then "Check row A-03" (rovers), and "Survey block A" (drone) once a block is piled. \
Allocation is EMULATED bidding and consensus: the hub announces one task per round with a fixed set of participants (every robot). \
It only opens a round when it believes a robot with the needed tool is free (from heartbeats, completed/released status, commits \
and "busy" declines); other ready tasks show "Waiting for a free robot". \
Each robot sends one frozen bid (or a decline), waits for a bid or decline from every participant (silence isn't a decline), picks \
the highest score (ties to the lowest robot ID) and sends AGREE with a fingerprint of the bid set. The tentative winner commits only \
after matching AGREEs from every participant, then starts work. Neither the hub nor you pick winners. A missing response leaves the \
round pending ("stalled" after a while); the hub never shrinks the participant set. After commitment, a robot that goes quiet is \
shown as "owner uncertain" but keeps the task until it reports it stopped or released. Manual machines (cranes, telehandlers, \
trenchers) are not mesh robots and don't bid. You are a hub-side helper: you can suggest hub actions (cancel, release or reprioritise \
a task; cut or restore a link; take a relay down or up; switch the hub off or on; change delay or loss), never a winner.

How you work:
- You are SUGGEST-ONLY. You cannot change anything on site. To suggest a change, call propose_action; it appears in the \
  chat as a card the manager can approve or dismiss. Even when the manager tells you to do something ("start the survey \
  at 2 km"), propose it; their click is the approval. Don't claim an action happened until you're told it was approved.
- Look things up with your tools instead of guessing. Use names and numbers from the twin.
- Be brief and concrete: plain sentences, no headings, at most a few short lines. Lead with what matters. \
  Say what you'd do and why in one line, then propose it.
- When the message starts with [Site monitor], nobody asked: decide whether the manager needs to know. If it's routine or \
  already handled (e.g. traffic rerouted with no loss of contact), reply with exactly {NO_UPDATE}. Otherwise write a short \
  heads-up, with a proposal if there's a clear next step.
- Messages starting with [Manager action] tell you what the manager did directly with the UI; take them into account.
"""

ACTION_NAMES = list(ACTIONS)

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
        "description": "Find one robot, machine, drone, relay or worker by id or name (e.g. 'RPD-1', 'M-4', 'Ortiz') and get its last reported state, block, link and how long ago it reported. Also highlights it on the manager's map.",
        "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
    {
        "name": "list_assets",
        "description": "List assets during construction, optionally filtered.",
        "input_schema": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": ["robot", "machine", "drone", "worker", "relay"]},
                "block": {"type": "string", "description": "Block letter, e.g. 'B'"},
                "issue": {"type": "string", "enum": ["stale", "offline", "paused", "idle", "low_energy", "out_of_coverage"]},
            },
        },
    },
    {
        "name": "get_network_status",
        "description": "Relay mesh health during construction: relays up/down, which assets are out of coverage, satellite uplink.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_recent_events",
        "description": "Recent site log entries for the current stage, newest first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "level": {"type": "string", "enum": ["info", "warn", "alert"]},
                "contains": {"type": "string", "description": "Only entries containing this text (case-insensitive)."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 40},
            },
        },
    },
    {
        "name": "get_tasks",
        "description": "Mesh tasks as the hub sees them (state, owner, progress, rounds). Filter by state or text.",
        "input_schema": {
            "type": "object",
            "properties": {
                "state": {"type": "string", "enum": ["waiting", "queued", "announced", "bidding", "awaiting", "assigned", "in_progress", "completed", "no_eligible", "release_requested", "cancel_requested", "cancelled", "active"]},
                "contains": {"type": "string", "description": "Only tasks whose label contains this, e.g. 'A-03' or 'pile'."},
            },
        },
    },
    {
        "name": "get_round",
        "description": "One allocation round in detail: participants, each bid or decline the hub received, each robot's proposed winner, the tentative winner's count of matching agreements, the commit and whether it's stalled. Omit roundId for the current or latest round.",
        "input_schema": {"type": "object", "properties": {"roundId": {"type": "integer"}}},
    },
    {
        "name": "get_mesh_status",
        "description": "Mesh health: nodes up/down and whether they reach the hub, removed links, delay and loss settings, hub on/off, each robot's availability, assignment, last heartbeat, and packet counters.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_requests",
        "description": "Equipment requests during construction (pending, en-route, arrived, done, cancelled).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "propose_action",
        "description": "Suggest a change to the site. It is shown to the build manager as a card with Approve / Dismiss and runs only if approved. "
        "Actions: " + " ".join(f"{n}: {d} args {json.dumps(a)}." for n, (_, d, a) in ACTIONS.items()),
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
        key = text.split(" to ")[0]
        self.pending_notes = [n for n in self.pending_notes if n.split(" to ")[0] != key or not key.startswith("Set ")]
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
            "availableActions": site.available_actions(),
        }
        if site.plan:
            p = site.plan
            out["plan"] = {"unitsRequested": p["input"]["unitCount"], "unitsPlaced": len(p["units"]), "crewAvailable": p["input"]["crewSize"], "crewUsed": p["crewUsed"], "relays": len(p["relays"]), "totalDays": p["totalDays"], "bottleneck": p["bottleneck"], "warnings": p["warnings"]}
        if site.sim:
            snap = site.sim.snapshot()
            units = snap["units"]
            now = snap["now"]
            assets = snap["assets"]
            stale = [a["name"] for a in assets if a["kind"] != "relay" and now - a["lastHeard"] > 30000]
            relays = [a for a in assets if a["kind"] == "relay"]
            down = [a["name"] for a in relays if a["mode"] == "offline" or a["link"] == "none"]
            out["construction"] = {
                "unitsInstalled": sum(u["status"] == "installed" for u in units),
                "unitsPiled": sum(u["status"] == "piled" for u in units),
                "unitsTotal": len(units),
                "people": sum(a["kind"] == "worker" for a in assets),
                "machines": sum(a["kind"] in ("robot", "machine", "drone") for a in assets),
                "relaysUp": f"{len(relays) - len(down)} of {len(relays)}",
                "relaysDown": down,
                "stale": stale,
                "paused": [a["name"] for a in assets if a["mode"] == "paused"],
                "openRequests": [r["id"] for r in snap["requests"] if r["status"] not in ("done", "cancelled")],
                "uplink": "up" if snap["uplink"]["online"] else "down",
                "minutesElapsed": round(site.sim.tick_count / 60, 1),
            }
        if site.mesh:
            m = site.mesh.snapshot()
            cur = next((r for r in m["rounds"] if r["status"] == "open"), None)
            out["mesh"] = {
                "allocation": m["mode"],
                "hub": "on" if m["hub"]["online"] else "off",
                "tasks": m["counts"],
                "currentRound": {"id": cur["id"], "task": cur["taskId"], "stalled": cur["stalled"], "ageS": cur["ageS"]} if cur else None,
                "uncertainOwners": [t["owner"] + " on " + t["label"] for t in m["tasks"] if t["uncertain"]],
                "removedLinks": ["–".join(c) for c in m["cut"]],
                "nodesNotReachingHub": [n["id"] for n in m["nodes"] if not n["reachesHub"] and n["kind"] != "hub"],
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
            "warnings": p["warnings"],
            "assumptions": p["assumptions"],
            "approved": self.site.sim is not None,
        }

    def _assets(self) -> list[dict]:
        site = self.site
        if site.sim:
            return list(site.sim.snapshot()["assets"])
        snap = site.survey.snapshot()
        return [{**d, "kind": "drone", "name": d["id"], "mode": d["status"], "energy": d["battery"], "lastHeard": snap["now"], "link": "mesh"} for d in snap["drones"]]

    def _describe(self, a: dict, now: int) -> dict:
        out = {k: a.get(k) for k in ("id", "name", "kind", "role", "mode", "task", "energy", "link", "via")}
        out["x"], out["y"] = round(a["x"]), round(a["y"])
        out["lastHeardSecondsAgo"] = max(0, round((now - a.get("lastHeard", now)) / 1000))
        sim = self.site.sim
        if sim:
            b = next((b for b in sim.blocks if b["x"] - 10 <= a["x"] <= b["x"] + b["w"] + 10 and b["y"] - 10 <= a["y"] <= b["y"] + b["h"] + 30), None)
            out["block"] = b["id"] if b else None
        return {k: v for k, v in out.items() if v is not None}

    def _tool_find_asset(self, args, result):
        q = str(args.get("query", "")).strip().lower().rstrip(".?!")
        assets = self._assets()
        hit = (
            next((a for a in assets if a["id"].lower() == q or a["name"].lower() == q), None)
            or next((a for a in assets if q and (q in a["name"].lower() or q in a["id"].lower())), None)
            or next((a for a in assets if a.get("role", "").lower() == q), None)
        )
        if not hit:
            return {"error": f"No asset matching '{args.get('query')}'."}
        result["select"] = hit["id"]
        return self._describe(hit, int(time.time() * 1000))

    def _tool_list_assets(self, args, result):
        if not self.site.sim:
            return {"assets": [self._describe(a, int(time.time() * 1000)) for a in self._assets()], "note": "Construction hasn't started; these are the survey drones."}
        now = int(time.time() * 1000)
        items = [self._describe(a, now) for a in self._assets()]
        if args.get("kind"):
            items = [a for a in items if a["kind"] == args["kind"]]
        if args.get("block"):
            items = [a for a in items if a.get("block") == str(args["block"]).upper()]
        issue = args.get("issue")
        if issue == "stale":
            items = [a for a in items if a["lastHeardSecondsAgo"] > 30 and a["kind"] != "relay"]
        elif issue == "offline":
            items = [a for a in items if a["mode"] == "offline"]
        elif issue == "paused":
            items = [a for a in items if a["mode"] == "paused"]
        elif issue == "idle":
            items = [a for a in items if a["mode"] == "idle"]
        elif issue == "low_energy":
            items = [a for a in items if a.get("energy", 100) < 25]
        elif issue == "out_of_coverage":
            items = [a for a in items if a.get("link") == "none"]
        return {"count": len(items), "assets": items[:40], "truncated": len(items) > 40}

    def _tool_get_network_status(self, args, result):
        sim = self.site.sim
        if not sim:
            p = self.site.plan
            return {"note": "Construction hasn't started.", "plannedRelays": len(p["relays"]) if p else None}
        snap = sim.snapshot()
        relays = [a for a in snap["assets"] if a["kind"] == "relay"]
        return {
            "relays": [{"id": r["id"], "mode": r["mode"], "link": r["link"], "energy": r["energy"]} for r in relays],
            "meshLinks": len(snap["links"]),
            "outOfCoverage": [a["name"] for a in snap["assets"] if a["kind"] != "relay" and a["link"] == "none"],
            "uplink": snap["uplink"],
        }

    def _tool_get_recent_events(self, args, result):
        site = self.site
        events = site.sim.events if site.sim else site.survey.events
        lvl, contains = args.get("level"), str(args.get("contains") or "").lower()
        out = [e for e in events if (not lvl or e["level"] == lvl) and (not contains or contains in e["text"].lower())]
        now = time.time() * 1000
        return [{"secondsAgo": round((now - e["at"]) / 1000), "level": e["level"], "text": e["text"]} for e in out[: int(args.get("limit") or 15)]]

    def _tool_get_tasks(self, args, result):
        m = self.site.mesh
        if not m:
            return {"note": "Construction hasn't started; no mesh tasks yet."}
        snap = m.snapshot()
        st, txt = args.get("state"), str(args.get("contains") or "").lower()
        active = ("announced", "bidding", "awaiting", "assigned", "in_progress", "release_requested", "cancel_requested", "no_eligible")
        items = [t for t in snap["tasks"] if (not st or t["state"] == st or (st == "active" and t["state"] in active)) and (not txt or txt in t["label"].lower())]
        keep = ("id", "label", "stateLabel", "owner", "done", "total", "priority", "revision", "rounds", "uncertain")
        return {"counts": snap["counts"], "count": len(items), "tasks": [{k: t[k] for k in keep} for t in items[:40]], "truncated": len(items) > 40}

    def _tool_get_round(self, args, result):
        m = self.site.mesh
        if not m or not m.hub.rounds:
            return {"note": "No allocation rounds yet."}
        rid = args.get("roundId") or m.hub.current or max(m.hub.rounds)
        d = m.round_detail(int(rid))
        if not d:
            return {"error": f"No round {rid}."}
        t = m.hub.tasks[d["taskId"]]
        d["task"] = t["label"]
        wv = m._with_winner_view(m.hub.round_view(m.hub.rounds[int(rid)]))
        d["tentative"] = wv["tentative"]
        d["proposedByRobot"] = wv["proposedByRobot"]
        if d.get("consensus"):
            d["consensus"] = {k: d["consensus"][k] for k in ("assignmentId", "owner", "at")} | {"fingerprint": d["consensus"]["evidence"]["fingerprint"]}
        return d

    def _tool_get_mesh_status(self, args, result):
        m = self.site.mesh
        if not m:
            return {"note": "Construction hasn't started; the mesh comes up with the robots."}
        snap = m.snapshot()
        return {
            "hub": snap["hub"],
            "config": snap["config"],
            "nodes": [{k: n[k] for k in ("id", "kind", "up", "reachesHub")} for n in snap["nodes"]],
            "removedLinks": snap["cut"],
            "links": len(snap["links"]),
            "robots": [{"id": r["id"], "available": r["available"], "assignment": r["assignment"], "openRounds": len(r["openRounds"]),
                        "lastHeartbeatSecondsAgo": snap["heard"].get(r["id"], {}).get("ago")} for r in snap["robots"]],
            "packets": snap["stats"],
        }

    def _tool_list_requests(self, args, result):
        sim = self.site.sim
        if not sim:
            return {"note": "Construction hasn't started."}
        return [{k: r[k] for k in ("id", "need", "status", "assignedTo", "eta")} | {"target": r["target"]["label"]} for r in sim.requests[:20]]

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
        "get_network_status": "Checked the relay network",
        "get_recent_events": "Read the site log",
        "list_requests": "Checked equipment requests",
        "get_tasks": "Checked mesh tasks" + (f" ({', '.join(str(v) for v in args.values())})" if args else ""),
        "get_round": f"Looked at round {args['roundId']}" if args.get("roundId") else "Looked at the current round",
        "get_mesh_status": "Checked the mesh",
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
