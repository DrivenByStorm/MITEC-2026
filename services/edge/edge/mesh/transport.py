"""Mesh transport for the digital twin.

Every robot, relay mast and the gateway is a node. Two nodes can exchange packets only while
there's a valid neighbor link between them (in range, both up, not cut by the manager). The
hub (the edge server) is wired to the gateway.

Packets are small dicts. A node that sends or forwards a packet broadcasts it to its current
neighbors; each copy arrives after a configurable delay, may be lost, and is dropped if the
link broke while it was in flight. Every node keeps a cache of message IDs it has seen, so a
new message is processed and forwarded once, with one less hop each time.

The simulator knows every position (it has to, to work out the links), but nothing here ever
writes into a robot's task records: robots only learn things through `handler(packet)`.
"""

from __future__ import annotations

import heapq
import itertools
import math
from dataclasses import dataclass, field
from typing import Callable

from ..twin.network import ASSET_RANGE_M, RELAY_RANGE_M, ROBOT_RANGE_M

WIRED_DELAY_S = 0.02
SEEN_TTL_S = 90.0
DEFAULT_HOPS = 8

PacketHandler = Callable[[dict], None]


@dataclass
class Node:
    id: str
    kind: str  # robot | relay | gateway | hub
    pos: Callable[[], tuple[float, float]]
    up: Callable[[], bool]
    handler: PacketHandler | None = None
    seen: dict[str, float] = field(default_factory=dict)


@dataclass(order=True)
class _Delivery:
    at: float
    seq: int
    to: str = field(compare=False)
    frm: str = field(compare=False)
    packet: dict = field(compare=False)
    trace: dict = field(compare=False)


def _pair(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


class MeshTransport:
    def __init__(self, rand: Callable[[], float], latency_ms: float = 250, loss_pct: float = 2):
        self.rand = rand
        self.now = 0.0
        self.latency_ms = latency_ms
        self.loss_pct = loss_pct
        self.nodes: dict[str, Node] = {}
        self.cut: set[tuple[str, str]] = set()
        self._queue: list[_Delivery] = []
        self._seq = itertools.count()
        self._trace_seq = itertools.count(1)
        self._msg_seq: dict[str, itertools.count] = {}
        self.new_traces: list[dict] = []
        self.record_traces = True  # off at high speed: nobody can watch packets then
        self._adj: dict[str, list[tuple[Node, str]]] | None = None  # link table, rebuilt each step
        self.stats = {"sent": 0, "hops": 0, "delivered": 0, "lost": 0, "broken": 0, "duplicates": 0}

    # ---------- nodes and links ----------

    def add(self, node: Node) -> None:
        self.nodes[node.id] = node

    def link_kind(self, a: Node, b: Node, ignore_cut: bool = False) -> str | None:
        """'radio' or 'wired' if a and b can exchange packets right now, else None."""
        if a.id == b.id or not (a.up() and b.up()):
            return None
        if not ignore_cut and _pair(a.id, b.id) in self.cut:
            return None
        kinds = {a.kind, b.kind}
        if "hub" in kinds:
            return "wired" if kinds == {"hub", "gateway"} else None
        ax, ay = a.pos()
        bx, by = b.pos()
        d = math.hypot(ax - bx, ay - by)
        if kinds == {"robot"}:
            return "radio" if d <= ROBOT_RANGE_M else None
        if "robot" in kinds:
            return "radio" if d <= ASSET_RANGE_M else None
        return "radio" if d <= RELAY_RANGE_M else None

    def invalidate(self) -> None:
        """Positions, node states or cuts changed: rebuild the link table on next use."""
        self._adj = None

    def _table(self) -> dict[str, list[tuple[Node, str]]]:
        if self._adj is None:
            adj: dict[str, list[tuple[Node, str]]] = {i: [] for i in self.nodes}
            ns = list(self.nodes.values())
            for i, a in enumerate(ns):
                for b in ns[i + 1:]:
                    k = self.link_kind(a, b)
                    if k:
                        adj[a.id].append((b, k))
                        adj[b.id].append((a, k))
            self._adj = adj
        return self._adj

    def neighbors(self, node_id: str) -> list[tuple[Node, str]]:
        return self._table().get(node_id, [])

    def linked(self, a: str, b: str) -> bool:
        return any(n.id == b for n, _ in self.neighbors(a))

    def links(self) -> list[dict]:
        out = []
        for a, lst in self._table().items():
            for n, k in lst:
                if a < n.id:
                    out.append({"a": a, "b": n.id, "kind": k})
        return sorted(out, key=lambda l: (l["a"], l["b"]))

    def reachable(self, start: str) -> set[str]:
        """Nodes with a path to `start` over current links (for display and tests only)."""
        return set(self.next_hops(start))

    def next_hops(self, start: str) -> dict[str, str | None]:
        """For every node with a path to `start`: its neighbor on a shortest path toward it."""
        if start not in self.nodes or not self.nodes[start].up():
            return {}
        parent: dict[str, str | None] = {start: None}
        queue = [start]
        while queue:
            cur = queue.pop(0)
            for n, _ in self.neighbors(cur):
                if n.id not in parent:
                    parent[n.id] = cur
                    queue.append(n.id)
        return parent

    # ---------- sending ----------

    def new_message_id(self, origin: str) -> str:
        c = self._msg_seq.setdefault(origin, itertools.count(1))
        return f"{origin}#{next(c)}"

    def send(self, origin: str, ptype: str, *, destination: str = "all", task_id: str | None = None, revision: int | None = None,
             round_id: int | None = None, payload: dict | None = None, hops: int = DEFAULT_HOPS) -> dict:
        """Originate a packet at `origin`. Retries call this again, so they get a fresh message ID."""
        pkt = {
            "message_id": self.new_message_id(origin),
            "origin_id": origin,
            "type": ptype,
            "destination": destination,
            "task_id": task_id,
            "revision": revision,
            "round_id": round_id,
            "hops_left": hops,
            "payload": payload or {},
            "sent_at": self.now,
        }
        node = self.nodes.get(origin)
        if not node or not node.up():
            return pkt
        node.seen[pkt["message_id"]] = self.now
        self.stats["sent"] += 1
        self._broadcast(node, pkt, exclude=None)
        return pkt

    def _broadcast(self, node: Node, pkt: dict, exclude: str | None) -> None:
        delay = self.latency_ms / 1000
        loss = self.loss_pct / 100
        for n, kind in self.neighbors(node.id):
            if n.id == exclude:
                continue
            wired = kind == "wired"
            d = WIRED_DELAY_S if wired else delay * (0.7 + 0.6 * self.rand())
            lost = (not wired) and self.rand() < loss
            tr = {
                "id": next(self._trace_seq),
                "from": node.id,
                "to": n.id,
                "t0": self.now,
                "t1": self.now + d,
                "type": pkt["type"],
                "mid": pkt["message_id"],
                "origin": pkt["origin_id"],
                "taskId": pkt["task_id"],
                "result": "lost" if lost else "ok",
            }
            self.stats["hops"] += 1
            if self.record_traces:
                self.new_traces.append(tr)
            if lost:
                self.stats["lost"] += 1
                continue
            heapq.heappush(self._queue, _Delivery(self.now + d, next(self._seq), n.id, node.id, dict(pkt), tr))

    # ---------- time ----------

    def advance(self, dt: float) -> None:
        self._adj = None  # things may have moved since the last step
        end = self.now + dt
        while self._queue and self._queue[0].at <= end:
            dv = heapq.heappop(self._queue)
            self.now = max(self.now, dv.at)
            self._deliver(dv)
        self.now = end
        if int(end) != int(end - dt):
            self._prune()

    def _deliver(self, dv: _Delivery) -> None:
        to, frm = self.nodes.get(dv.to), self.nodes.get(dv.frm)
        if not to or not frm or not self.linked(frm.id, to.id):
            dv.trace["result"] = "broken"
            self.stats["broken"] += 1
            if self.record_traces:
                self.new_traces.append({**dv.trace, "update": True})  # same id: the UI turns that dot red
            return
        pkt = dv.packet
        mid = pkt["message_id"]
        if mid in to.seen:
            self.stats["duplicates"] += 1
            return
        to.seen[mid] = self.now
        self.stats["delivered"] += 1
        if to.handler:
            to.handler(dict(pkt))
        if pkt["hops_left"] > 0 and to.up():
            self._broadcast(to, {**pkt, "hops_left": pkt["hops_left"] - 1}, exclude=frm.id)

    def _prune(self) -> None:
        cutoff = self.now - SEEN_TTL_S
        for n in self.nodes.values():
            if len(n.seen) > 200:
                n.seen = {k: t for k, t in n.seen.items() if t >= cutoff}

    def take_traces(self) -> list[dict]:
        out, self.new_traces = self.new_traces, []
        return out

    # ---------- manager controls ----------

    def cut_link(self, a: str, b: str) -> None:
        self.cut.add(_pair(a, b))
        self._adj = None

    def restore_link(self, a: str, b: str) -> bool:
        p = _pair(a, b)
        if p in self.cut:
            self.cut.discard(p)
            self._adj = None
            return True
        return False
