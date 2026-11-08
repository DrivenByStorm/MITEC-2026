"""Turn an approved buildup plan into the mesh's site configuration (spec section 13), the
physical world the simulator runs, and the tasks the hub's planning software will publish.

Coordinates: the plan is in twin meters (x east, y south, origin at the terrain's NW corner).
The mesh uses the site frame (decimeters, x east, y north, origin at the survey benchmark).
The benchmark is the survey launch point; its position in twin coordinates goes in the config
as twin_benchmark_m, and the UI converts back in one place (spec 12.4).
"""

from __future__ import annotations

import base64

import numpy as np

HUB = "02:00:00:00:00:01"
WORK_SECONDS_PER_UNIT = 40  # demo pace for one unit's piles (real: ~16 min); the sim speed control scales time


def mac(kind: int, n: int) -> str:
    return f"02:00:00:{kind:02X}:{(n >> 8) & 255:02X}:{n & 255:02X}"


class Frame:
    """Twin meters <-> site-frame decimeters."""

    def __init__(self, bx: float, by: float):
        self.bx, self.by = bx, by

    def to_site(self, x: float, y: float) -> dict:
        return {"x": int(round((x - self.bx) * 10)), "y": int(round((self.by - y) * 10))}

    def to_twin(self, p: dict) -> tuple[float, float]:
        return self.bx + p["x"] / 10, self.by - p["y"] / 10


def build_sim_input(plan: dict, survey, scenario: str = "demo", seed: int = 7) -> dict:
    t = survey.terrain
    launch = survey.launch
    f = Frame(launch["x"], launch["y"])
    count = {x["key"]: x["count"] for x in plan["fleet"]}

    # ---------- network ----------
    relays = []
    gateways = []
    for i, g in enumerate(plan["gateways"]):
        node = mac(0, 0x10 + i)
        gateways.append(node)
        relays.append({"node": node, "name": f"GW-{i + 1}", "pos": f.to_site(g["x"], g["y"]), "uwbAnchor": True, "coverageRadiusM": 300, "gateway": True})
    for i, r in enumerate(plan["relays"]):
        relays.append({"node": mac(1, i + 1), "name": r["id"], "pos": f.to_site(r["x"], r["y"]), "uwbAnchor": True, "coverageRadiusM": 300})
    anchors = [{"node": mac(2, i + 1), "name": a["id"], "pos": f.to_site(a["x"], a["y"])} for i, a in enumerate(plan["anchors"])]

    # ---------- robots ----------
    robots = []
    for i in range(count.get("pile", 0)):
        robots.append({"node": mac(3, i + 1), "name": f"RPD-{i + 1}", "tag": 1, "footprintDm": 15, "maxSpeedCms": 150, "drainPctPerHour": 20, "workRatePct": 100})
    for i in range(count.get("surveyBot", 0)):
        robots.append({"node": mac(3, 0x100 + i + 1), "name": f"SB-{i + 1}", "tag": 2, "footprintDm": 8, "maxSpeedCms": 200, "drainPctPerHour": 15, "workRatePct": 100})

    # ---------- people, supervisors, machines ----------
    office_t = (plan["office"]["x"] + plan["office"]["w"] / 2, plan["office"]["y"] + plan["office"]["h"] / 2)
    office = f.to_site(*office_t)
    laydown_t = (plan["laydown"]["x"] + plan["laydown"]["w"] / 2, plan["laydown"]["y"] + plan["laydown"]["h"] / 2)
    laydown = f.to_site(*laydown_t)
    charger = f.to_site(laydown_t[0] - 60, laydown_t[1] - 50)

    supervisors, people, badges = [], [], []
    sup_n = 1
    build_manager = mac(4, sup_n)
    supervisors.append({"node": build_manager, "badge": 5001, "name": "Build manager"})
    people.append({"badge": 5001, "kind": "supervisor", "name": "Build manager", "role": "Build manager", "group": "office", "onShift": True, "supervisorNode": build_manager})
    badges.append({"badge": 5001, "kind": "supervisor", "name": "Build manager"})

    names = _names()
    crew_badge = 6001
    n_crane, n_th, n_tr = count.get("crane", 0), count.get("telehandler", 0), count.get("trencher", 0)
    pile_nodes = [r["node"] for r in robots if r["tag"] == 1]
    survey_nodes = [r["node"] for r in robots if r["tag"] == 2]
    for role in plan["crew"]:
        for k in range(role["count"]):
            name = next(names)
            r = role["role"]
            if r in ("Foreman", "Safety lead"):
                sup_n += 1
                node = mac(4, sup_n)
                badge = 5000 + sup_n
                full = f"{r} {name}"
                supervisors.append({"node": node, "badge": badge, "name": full})
                people.append({"badge": badge, "kind": "supervisor", "name": full, "role": r, "group": "roam", "onShift": True, "supervisorNode": node})
                badges.append({"badge": badge, "kind": "supervisor", "name": full})
                continue
            if r in ("Crane operator", "Telehandler operator", "Trencher operator"):
                continue  # in the cab: the machine's own badge stands for them
            if r in ("Robot operator", "Pile loader"):
                group = pile_nodes[k % len(pile_nodes)] if pile_nodes else "office"
            elif r in ("Rigger", "Signal person"):
                group = f"CR-{k % max(1, n_crane) + 1}"
            elif r == "Trench laborer":
                group = f"TR-{k % max(1, n_tr) + 1}"
            elif r == "Electrician":
                group = "electrical"
            elif r == "Drone pilot":
                group = survey_nodes[0] if survey_nodes else "office"
            else:
                group = "roam"
            people.append({"badge": crew_badge, "kind": "crew", "name": name, "role": r, "group": group, "onShift": True})
            badges.append({"badge": crew_badge, "kind": "crew", "name": f"{name} ({r.lower()})"})
            crew_badge += 1

    machines = []
    badge = 7001
    for i in range(n_crane):
        machines.append({"badge": badge, "id": f"CR-{i + 1}", "role": "Crane", "radiusDm": 60})
        badges.append({"badge": badge, "kind": "machine", "name": f"Crane CR-{i + 1}", "radiusDm": 60})
        badge += 1
    for i in range(n_th):
        machines.append({"badge": badge, "id": f"TH-{i + 1}", "role": "Telehandler", "radiusDm": 30, "serves": f"CR-{i % max(1, n_crane) + 1}"})
        badges.append({"badge": badge, "kind": "machine", "name": f"Telehandler TH-{i + 1}", "radiusDm": 30})
        badge += 1
    blocks = plan["blocks"]
    for i in range(n_tr):
        mine = [b for k, b in enumerate(blocks) if k % n_tr == i]
        wps = [f.to_site(b["x"] - 5, y) for b in mine for y in (b["y"], b["y"] + b["h"])]
        machines.append({"badge": badge, "id": f"TR-{i + 1}", "role": "Trencher", "radiusDm": 30, "waypoints": wps})
        badges.append({"badge": badge, "kind": "machine", "name": f"Trencher TR-{i + 1}", "radiusDm": 30})
        badge += 1

    # ---------- units, hazards, tasks ----------
    units = [{"id": u["id"], "block": u["block"], "pos": f.to_site(u["x"], u["y"])} for u in plan["units"]]
    hazards = _hazards(plan, f)
    tasks = _tasks(plan, units, len(pile_nodes), bool(survey_nodes))

    xs = [u["pos"]["x"] for u in units] or [office["x"]]
    ys = [u["pos"]["y"] for u in units] or [office["y"]]
    pr = plan["bounds"]
    boundary = [f.to_site(pr["x"], pr["y"]), f.to_site(pr["x"] + pr["w"], pr["y"]), f.to_site(pr["x"] + pr["w"], pr["y"] + pr["h"]), f.to_site(pr["x"], pr["y"] + pr["h"])]

    config = {
        "siteId": "SITE-01",
        "benchmark": {"lat": t.lat0, "lon": t.lon0, "altM": 0.0, "gridRotationDeg": 0.0},
        "twinBenchmarkM": {"x": launch["x"], "y": launch["y"]},
        "boundary": boundary,
        "hub": HUB,
        "gateways": gateways,
        "coverageRadiusM": 300,
        "hazards": [{"kind": "steep", "polygon": h} for h in hazards],
        "relays": relays,
        "anchors": anchors,
        "robots": robots,
        "bid": {"weights": {"travel": 45, "work": 30, "energy": 15, "risk": 10}, "travelCapS": 600, "workCapS": 3600},
        "supervisors": supervisors,
        "badges": badges,
        "tags": [{"tag": 1, "name": "Pile driver bot"}, {"tag": 2, "name": "Survey bot"}],
        "timers": {},
    }
    world = {
        "units": units,
        "office": office,
        "laydown": laydown,
        "charger": charger,
        "people": people,
        "machines": machines,
        "hazards": hazards,
        "bounds": {"min": {"x": min(xs), "y": min(ys)}, "max": {"x": max(xs), "y": max(ys)}},
    }
    return {"config": config, "world": world, "tasks": tasks, "buildManager": build_manager, "options": {"seed": seed, "speed": 1, "scenario": scenario}}


def _tasks(plan: dict, units: list[dict], pile_robots: int, survey_bot: bool) -> list[dict]:
    tasks = []
    by_block: dict[str, list[dict]] = {}
    for u in units:
        by_block.setdefault(u["block"], []).append(u)
    prev_pile = None
    for k, b in enumerate(plan["blocks"]):
        items = by_block.get(b["id"], [])
        if not items:
            continue
        cx = sum(u["pos"]["x"] for u in items) / len(items)
        cy = sum(u["pos"]["y"] for u in items) / len(items)
        center = {"x": int(cx), "y": int(cy)}
        pile_id = 1000 + k
        unit_ids = {j + 1: u["id"] for j, u in enumerate(items)}
        tasks.append({
            "taskId": pile_id, "revision": 1, "mode": "autonomous", "tag": 1, "robotCount": max(1, pile_robots), "priority": 5,
            "minBattery": 15, "areaCenter": center, "localRadiusM": 0, "zoneId": 0, "requiresSignoff": False,
            "items": [{"itemId": j + 1, "pos": u["pos"], "estDurationS": WORK_SECONDS_PER_UNIT, "exclusive": True} for j, u in enumerate(items)],
            "unitIds": unit_ids, "label": f"Drive piles, block {b['id']}",
        })
        # Cranes and crews set the units: a manual task sent to a supervisor (9.2).
        tasks.append({
            "taskId": 2000 + k, "revision": 1, "mode": "manual", "tag": 0, "robotCount": 0, "priority": 4,
            "minBattery": 0, "areaCenter": center, "localRadiusM": 0, "zoneId": 0, "requiresSignoff": False,
            "items": [{"itemId": j + 1, "pos": u["pos"], "estDurationS": 1800, "exclusive": False} for j, u in enumerate(items)],
            "unitIds": unit_ids, "label": f"Set units, block {b['id']}", "after": [prev_pile] if prev_pile else [],
        })
        if survey_bot:
            rows: dict[int, list[dict]] = {}
            for u in items:
                rows.setdefault(u["pos"]["y"], []).append(u)
            pts = [{"x": int(sum(u["pos"]["x"] for u in r) / len(r)), "y": y - 60} for y, r in sorted(rows.items(), reverse=True)][:12]
            tasks.append({
                "taskId": 3000 + k, "revision": 1, "mode": "autonomous", "tag": 2, "robotCount": 1, "priority": 3,
                "minBattery": 15, "areaCenter": center, "localRadiusM": 0, "zoneId": 0, "requiresSignoff": True,
                "items": [{"itemId": j + 1, "pos": p, "estDurationS": 20, "exclusive": False} for j, p in enumerate(pts)],
                "label": f"As-built check, block {b['id']}", "after": [pile_id],
            })
        prev_pile = pile_id
    return tasks


def _hazards(plan: dict, f: Frame, tile_m: float = 60.0, max_zones: int = 80) -> list[list[dict]]:
    """Steep ground from the survey as HAZARD squares (spec 6.4, 8.6), kept clear of the work."""
    ground = np.frombuffer(base64.b64decode(plan["ground"]), dtype=np.uint8)
    cols, rows, cell = plan["terrain"]["cols"], plan["terrain"]["rows"], plan["terrain"]["cellM"]
    g = ground.reshape(rows, cols)
    b = plan["bounds"]
    keep_out = [(u["x"], u["y"]) for u in plan["units"]] + [(plan["office"]["x"] + plan["office"]["w"] / 2, plan["office"]["y"] + plan["office"]["h"] / 2), (plan["laydown"]["x"] + plan["laydown"]["w"] / 2, plan["laydown"]["y"] + plan["laydown"]["h"] / 2)]
    kx = np.array([p[0] for p in keep_out])
    ky = np.array([p[1] for p in keep_out])
    tiles = []
    y = b["y"]
    while y < b["y"] + b["h"]:
        x = b["x"]
        while x < b["x"] + b["w"]:
            c0, c1 = int(x // cell), int((x + tile_m) // cell)
            r0, r1 = int(y // cell), int((y + tile_m) // cell)
            block = g[max(0, r0):min(rows, r1), max(0, c0):min(cols, c1)]
            if block.size and (block == 2).mean() > 0.5:
                cx, cy = x + tile_m / 2, y + tile_m / 2
                clear = np.min(np.hypot(kx - cx, ky - cy)) > tile_m * 0.71 + 25
                if clear:
                    tiles.append((x, y, (block == 2).mean()))
            x += tile_m
        y += tile_m
    tiles.sort(key=lambda t: -t[2])
    polys = []
    for x, y, _ in tiles[:max_zones]:
        polys.append([f.to_site(x, y), f.to_site(x + tile_m, y), f.to_site(x + tile_m, y + tile_m), f.to_site(x, y + tile_m)])
    return polys


def _names():
    surnames = ["Reyes", "Okafor", "Lindqvist", "Ortiz", "Patel", "Begay", "Nguyen", "Castillo", "Hale", "Andrade", "Whitehorse", "Kowalski", "Mensah", "Duarte", "Ibarra", "Sato", "Haddad", "Morales", "Becker", "Yazzie", "Ferreira", "Ochoa", "Brennan", "Vargas", "Chen", "Silva", "Tran", "Navarro", "Abbott", "Romero", "Kaur", "Delgado", "Murphy", "Salazar", "Novak", "Aguilar", "Jensen", "Fuentes", "Rossi", "Garza"]
    initials = "ABCDEFGHJKLMNPRSTW"
    i = 0
    while True:
        yield f"{initials[(i * 7) % len(initials)]}. {surnames[i % len(surnames)]}"
        i += 1


def frame_for(survey) -> Frame:
    return Frame(survey.launch["x"], survey.launch["y"])


__all__ = ["build_sim_input", "Frame", "frame_for", "mac", "HUB"]
