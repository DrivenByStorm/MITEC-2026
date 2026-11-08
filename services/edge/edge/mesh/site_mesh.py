"""The site mesh: the robots, relays, gateway and hub of a construction simulation, the tasks the
hub introduces, and the controls the build manager has over the network.

Tasks come from the approved plan, one row at a time:
    Stake row   layout rover marks the pile positions          (needs nothing)
    Pile row    pile-driving robot drives the row's piles       (needs the row staked)
    Check row   layout rover checks the driven piles            (needs the row piled)
    Survey block  drone flies the block for an as-built survey  (needs every row in the block piled)
The hub only unlocks a task once it has *heard* that the work it depends on is complete.
"""

from __future__ import annotations

from collections import defaultdict
from typing import TYPE_CHECKING

from .hub import HUB, STATE_LABEL, HubAgent
from .robot import RobotAgent
from .rules import ALLOC, EmulatedConsensus, robot_key
from .transport import MeshTransport, Node

if TYPE_CHECKING:
    from ..twin.simulator import SimulatedSite

SUBSTEP_S = 0.05
TRACE_KEEP_S = 6

TOOLS = {"Pile driver": {"pile"}, "Layout rover": {"layout"}, "Survey drone": {"aerial"}}
PRIORITY = {"pile": 3, "survey": 3, "stake": 2, "check": 1}
REQUIRES = {"stake": "layout", "pile": "pile", "check": "layout", "survey": "aerial"}


class SiteMesh:
    def __init__(self, sim: "SimulatedSite"):
        self.sim = sim
        self.tx = MeshTransport(sim.rand)
        self.consensus = EmulatedConsensus()
        self.robots: dict[str, RobotAgent] = {}
        self.hub_online = True

        for t in sim.truth.values():
            if t["kind"] == "relay":
                kind = "gateway" if t["id"] == "GW" else "relay"
                self.tx.add(Node(t["id"], kind, pos=_pos(t), up=_relay_up(t)))
            elif t["role"] in TOOLS:
                agent = RobotAgent(t["id"], TOOLS[t["role"]], t, self.tx, self.consensus, sim.log)
                self.robots[t["id"]] = agent
                self.tx.add(Node(t["id"], "robot", pos=_pos(t), up=lambda: True, handler=agent.receive))
        es = sim.edge_server
        self.hub = HubAgent(self.tx, list(self.robots), sim.log, self._on_complete)
        self.tx.add(Node(HUB, "hub", pos=lambda: (es["x"], es["y"]), up=lambda: self.hub_online, handler=self.hub.receive))
        self._make_tasks()
        # The twin's own position reports from mesh robots travel over this mesh too.
        sim.mesh_routes = lambda: self.tx.next_hops(HUB)

    # ---------- tasks ----------

    def _make_tasks(self) -> None:
        sim = self.sim
        rows: dict[tuple[str, int], list[dict]] = defaultdict(list)
        for u in sim.truth_units:
            rows[(u["block"], u["row"])].append(u)
        self.deps: dict[str, list[str]] = defaultdict(list)  # task -> tasks that wait on it
        self.waits: dict[str, set[str]] = {}
        seq = 0

        def add(kind: str, label: str, units: list[dict], ready: bool, rect: dict | None = None) -> str:
            nonlocal seq
            seq += 1
            tid = f"T-{seq:03d}"
            if rect:
                x, y = rect["x"] + rect["w"] / 2, rect["y"] + rect["h"] / 2
            else:
                x, y = sum(u["x"] for u in units) / len(units), units[0]["y"]
            self.hub.add_task({"id": tid, "seq": seq, "kind": kind, "label": label, "requires": REQUIRES[kind], "priority": PRIORITY[kind],
                               "x": round(x, 1), "y": round(y, 1), "units": [u["id"] for u in units], "rect": rect}, ready)
            return tid

        for b in sim.blocks:
            pile_ids = []
            for r in sorted({row for (blk, row) in rows if blk == b["id"]}):
                us = sorted(rows[(b["id"], r)], key=lambda u: u["slot"])
                name = f"{b['id']}-{r:02d}"
                stake = add("stake", f"Stake row {name}", us, True)
                pile = add("pile", f"Pile row {name}", us, False)
                check = add("check", f"Check row {name}", us, False)
                self._dep(stake, pile)
                self._dep(pile, check)
                pile_ids.append(pile)
            if any(rt["role"] == "Survey drone" for rt in sim.truth.values()):
                survey = add("survey", f"Survey block {b['id']}", [], False, rect={k: b[k] for k in ("x", "y", "w", "h")})
                for p in pile_ids:
                    self._dep(p, survey)

    def _dep(self, first: str, then: str) -> None:
        self.deps[first].append(then)
        self.waits.setdefault(then, set()).add(first)

    def _on_complete(self, t: dict) -> None:
        for nxt in self.deps.get(t["id"], []):
            w = self.waits[nxt]
            w.discard(t["id"])
            if not w:
                self.hub.make_ready(nxt)

    # ---------- time ----------

    def step(self, dt: float) -> None:
        # Fine steps at normal speed; at high speed at most 20 steps per call (rounds still finish
        # inside a step, because robots answer from their packet handlers).
        n = max(1, min(round(dt / SUBSTEP_S), 20))
        self.tx.invalidate()  # robots moved since the last call; nothing moves within it
        for _ in range(n):
            self.tx.advance(dt / n)
            for r in self.robots.values():
                r.step()
            self.hub.step()

    def take_traces(self) -> list[dict]:
        return self.tx.take_traces()

    # ---------- manager controls ----------

    def node_id(self, text: str) -> str | None:
        s = str(text).strip().upper()
        if s in ("HUB", "EDGE SERVER", "EDGE"):
            return HUB
        if s in ("GATEWAY",):
            return "GW"
        return s if s in self.tx.nodes else None

    def task_id(self, text: str) -> str | None:
        """'T-005', '5', 'pile row A-02', 'A-02 pile' -> task id."""
        s = str(text).strip()
        up = s.upper()
        if up in self.hub.tasks:
            return up
        if up.isdigit() and f"T-{int(up):03d}" in self.hub.tasks:
            return f"T-{int(up):03d}"
        low = s.lower().replace("row", " ").replace("block", " ")
        words = set(low.replace("-", " - ").split())
        matches = []
        for t in self.hub.tasks.values():
            lab = t["label"].lower().replace("row", " ").replace("block", " ")
            lw = set(lab.replace("-", " - ").split())
            if t["label"].lower() == s.lower() or (words and words <= lw):
                matches.append(t)
        if matches:
            rank = {"completed": 3, "cancelled": 3, "waiting": 2}
            return min(matches, key=lambda t: (rank.get(t["state"], 1), t["seq"]))["id"]
        # "A-02" alone or "A2": prefer the row's active task
        import re

        m = re.match(r"^([A-Z]{1,2})\s*-?\s*(\d{1,2})$", up)
        if m:
            name = f"{m.group(1)}-{int(m.group(2)):02d}"
            cands = [t for t in self.hub.tasks.values() if t["label"].endswith(name)]
            active = [t for t in cands if t["state"] not in ("completed", "cancelled", "waiting")]
            if active or cands:
                return (active or cands)[0]["id"]
        return None

    def set_latency(self, ms: float) -> str:
        self.tx.latency_ms = max(10.0, min(3000.0, float(ms)))
        return f"Mesh delay set to about {round(self.tx.latency_ms)} ms per hop."

    def set_loss(self, pct: float) -> str:
        self.tx.loss_pct = max(0.0, min(90.0, float(pct)))
        return f"Packet loss set to {self.tx.loss_pct:g}% per hop."

    def cut_link(self, a: str, b: str) -> str:
        na, nb = self.node_id(a), self.node_id(b)
        if not na or not nb or na == nb:
            return f"I need two different mesh nodes; got {a} and {b}."
        self.tx.cut_link(na, nb)
        self.sim.log("warn", f"Mesh link {na}–{nb} removed by the build manager.")
        return f"Removed the link between {na} and {nb}. Packets have to find another path."

    def restore_link(self, a: str | None = None, b: str | None = None) -> str:
        if a is None:
            n = len(self.tx.cut)
            self.tx.cut.clear()
            self.tx.invalidate()
            if n:
                self.sim.log("info", f"All {n} removed mesh links restored.")
            return f"Restored {n} removed link{'s' if n != 1 else ''}." if n else "No links were removed."
        na, nb = self.node_id(a), self.node_id(b or "")
        if not na or not nb:
            return f"I need two mesh nodes; got {a} and {b}."
        if self.tx.restore_link(na, nb):
            self.sim.log("info", f"Mesh link {na}–{nb} restored.")
            return f"Restored the link between {na} and {nb}."
        return f"The link between {na} and {nb} wasn't removed."

    def set_hub(self, online: bool) -> str:
        if online == self.hub_online:
            return f"The hub is already {'on' if online else 'off'}."
        self.hub_online = online
        self.hub.online = online
        self.tx.invalidate()
        if online:
            self.sim.log("info", "Hub back on the mesh. It catches up from robot status and heartbeats.")
            return "Hub is back on. It will catch up on anything it missed from the robots' status and heartbeats."
        self.sim.log("warn", "Hub switched off. Robots keep agreeing on tasks they already received; no new tasks are announced.")
        return "Hub is off. Robots that already received a task can still agree among themselves; new tasks wait for the hub."

    # ---------- view ----------

    def snapshot(self) -> dict:
        tx = self.tx
        hub = self.hub
        reach = tx.reachable(HUB)
        nodes = []
        for n in tx.nodes.values():
            x, y = n.pos()
            nodes.append({"id": n.id, "kind": n.kind, "x": round(x, 1), "y": round(y, 1), "up": n.up(), "reachesHub": n.id in reach})
        tasks = [hub.task_view(hub.tasks[i]) for i in hub.order]
        live = [self._with_winner_view(hub.round_view(r)) for r in sorted(hub.rounds.values(), key=lambda r: -r["id"])[:16]]
        counts: dict[str, int] = defaultdict(int)
        for t in tasks:
            counts[t["state"]] += 1
        return {
            "now": round(tx.now, 2),
            "mode": "Emulated bidding and consensus",
            "config": {"latencyMs": round(tx.latency_ms), "lossPct": tx.loss_pct, "robotRangeM": _ranges()[0], "assetRangeM": _ranges()[1], "relayRangeM": _ranges()[2],
                       "retryS": ALLOC["retryS"], "stallS": ALLOC["stallS"], "uncertainS": ALLOC["uncertainS"]},
            "hub": {"online": self.hub_online, "currentRound": hub.current, "inbox": hub.inbox_count},
            "nodes": nodes,
            "links": tx.links(),
            # Removed links that would otherwise be up (drawn on the map); cutTotal counts them all.
            "cut": [list(p) for p in sorted(tx.cut) if p[0] in tx.nodes and p[1] in tx.nodes and tx.link_kind(tx.nodes[p[0]], tx.nodes[p[1]], ignore_cut=True)],
            "cutTotal": len(tx.cut),
            "robots": [self.robots[k].view() for k in sorted(self.robots, key=robot_key)],
            "heard": {rid: {"ago": round(tx.now - h["at"], 1), "available": h.get("available"), "battery": h.get("battery")} for rid, h in hub.heard.items()},
            "tasks": tasks,
            "rounds": live,
            "counts": dict(counts),
            "stateLabels": STATE_LABEL,
            "stats": dict(tx.stats),
        }

    def _with_winner_view(self, rv: dict) -> dict:
        """Add the tentative winner's own count of matching agreements (from its local copy)."""
        props = {}
        for rid, agent in self.robots.items():
            r = agent.rounds.get(rv["id"])
            if r and r["myAgree"]:
                props[rid] = r["myAgree"]["winner"]
        w = next((v for v in props.values() if v), None)
        rv["proposedByRobot"] = props
        if w and w in self.robots:
            r = self.robots[w].rounds.get(rv["id"])
            rv["tentative"] = {"robot": w, "matching": self.robots[w].matching_agrees(r) if r else 0, "of": len(rv["participants"])}
        else:
            rv["tentative"] = None
        return rv

    def round_detail(self, round_id: int) -> dict | None:
        """Hub's view of a round plus each robot's own copy (matching agreements at the tentative winner)."""
        rnd = self.hub.rounds.get(round_id)
        if not rnd:
            return None
        out = self.hub.round_view(rnd)
        out["robots"] = {}
        for rid, agent in self.robots.items():
            r = agent.rounds.get(round_id)
            if r:
                out["robots"][rid] = agent.round_view(r)
        rec = next((v for k, v in self.consensus.records.items() if k[2] == round_id), None)
        out["consensus"] = rec
        return out


def _pos(t: dict):
    return lambda: (t["x"], t["y"])


def _relay_up(t: dict):
    return lambda: t["mode"] != "offline"


def _ranges():
    from ..twin.network import ASSET_RANGE_M, RELAY_RANGE_M, ROBOT_RANGE_M

    return ROBOT_RANGE_M, ASSET_RANGE_M, RELAY_RANGE_M
