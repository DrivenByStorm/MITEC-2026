"""The buildup plan drawn as a site snapshot, so the UI can preview it on the same map the
construction stage uses: units as planned footprints, gateways and relay masts with their links."""

from __future__ import annotations

import math

from ..twin.network import RELAY_RANGE_M

SITE_NAME = "New site, Pecos County TX"


def plan_preview(plan: dict) -> dict:
    now = plan["createdAt"]

    def relay(rid, x, y, role, name=None):
        return {"id": rid, "name": name or rid, "kind": "relay", "role": role, "x": x, "y": y, "heading": 0, "mode": "autonomous", "task": "Planned", "energy": 100, "lastHeard": now, "link": "mesh"}

    relays = [relay(r["id"], r["x"], r["y"], "Relay mast (link only)" if r["linkOnly"] else "Solar relay mast") for r in plan["relays"]]
    for i, g in enumerate(plan["gateways"]):
        relays.append(relay(f"GW-{i + 1}", g["x"], g["y"], "Gateway (wired to the hub)", f"GW-{i + 1}"))
    links = []
    for i in range(len(relays)):
        for j in range(i + 1, len(relays)):
            d = math.hypot(relays[i]["x"] - relays[j]["x"], relays[i]["y"] - relays[j]["y"])
            if d <= RELAY_RANGE_M:
                links.append({"a": relays[i]["id"], "b": relays[j]["id"], "quality": max(0.2, 1 - d / RELAY_RANGE_M * 0.7)})
    o = plan["office"]
    t = plan["terrain"]
    return {
        "now": now,
        "siteName": SITE_NAME,
        "site": {"w": t["cols"] * t["cellM"], "h": t["rows"] * t["cellM"]},
        "view": plan["bounds"],
        "office": plan["office"],
        "laydown": plan["laydown"],
        "blocks": [{k: b[k] for k in ("id", "x", "y", "w", "h", "rows", "slots")} for b in plan["blocks"]],
        "units": [{**u, "status": "planned"} for u in plan["units"]],
        "assets": relays,
        "anchors": [{"id": a["id"], "x": a["x"], "y": a["y"]} for a in plan.get("anchors", [])],
        "links": links,
        "edgeServer": {"x": o["x"] + o["w"] - 30, "y": o["y"] + 45, "online": True},
        "rtkBase": {"x": o["x"] + o["w"] - 30, "y": o["y"] + o["h"] - 30, "online": True},
        "uplink": {"online": True, "lastSync": now},
        "events": [],
        "requests": [],
    }
