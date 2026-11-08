"""Terrain the survey drones "discover".

If data/site-dem.json exists (created by the terrain fetch tool), the survey reveals real
elevation data. Otherwise it falls back to generated terrain and says so in the UI, so
nobody mistakes it for a real site.

Site frame: meters, x east, y south, origin at the NW corner of the grid.
"""

from __future__ import annotations

import base64
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np

DEFAULT_DEM = Path(__file__).resolve().parents[2] / "data" / "site-dem.json"


@dataclass
class Terrain:
    cols: int
    rows: int
    cell_m: float
    lat0: float
    lon0: float
    real: bool
    source_label: str
    heights: np.ndarray  # float32, shape (rows*cols,), row 0 = north edge

    def heights_dm_b64(self) -> str:
        """Heights as little-endian int16 decimeters, base64 (same encoding as the DEM file)."""
        dm = np.round(self.heights * 10).astype("<i2")
        return base64.b64encode(dm.tobytes()).decode("ascii")

    def info(self) -> dict:
        return {
            "cols": self.cols,
            "rows": self.rows,
            "cellM": self.cell_m,
            "real": self.real,
            "sourceLabel": self.source_label,
            "lat0": self.lat0,
            "lon0": self.lon0,
        }


_cached: Terrain | None = None


def load_terrain(path: str | os.PathLike | None = None) -> Terrain:
    global _cached
    if _cached is not None and path is None:
        return _cached
    p = Path(path or os.environ.get("SITE_DEM", DEFAULT_DEM))
    t = decode(json.loads(p.read_text())) if p.exists() else synthetic()
    if path is None:
        _cached = t
    return t


def decode(dem: dict) -> Terrain:
    dm = np.frombuffer(base64.b64decode(dem["heightsDm"]), dtype="<i2")
    return Terrain(
        cols=dem["cols"],
        rows=dem["rows"],
        cell_m=dem["cellM"],
        lat0=dem["lat0"],
        lon0=dem["lon0"],
        real=True,
        source_label=f"Real terrain near {dem['lat0']:.3f}, {dem['lon0']:.3f}. {dem['attribution']}.",
        heights=(dm.astype(np.float32) / 10).astype(np.float32),
    )


def synthetic() -> Terrain:
    """Plausible West Texas terrain: gentle slope, rolling ground, a mesa and a dry wash."""
    cols = rows = 400
    noise = _value_noise(11)
    heights = np.empty(cols * rows, dtype=np.float32)
    for r in range(rows):
        y = r / rows
        for c in range(cols):
            x = c / cols
            h = 905 + (0.5 - x) * 28 + (y - 0.5) * 12
            h += _fbm(noise, x * 5, y * 5) * 22
            dm = math.hypot((x - 0.72) * 1.4, y - 0.28)
            h += 34 / (1 + math.exp((dm - 0.11) * 60))
            wash = abs(x - (0.32 + math.sin(y * 7) * 0.04))
            h -= 7 * math.exp(-((wash / 0.018) ** 2))
            heights[r * cols + c] = h
    return Terrain(
        cols=cols,
        rows=rows,
        cell_m=15,
        lat0=30.79,
        lon0=-103.03,
        real=False,
        source_label='Synthetic terrain for the demo. Run the terrain fetch tool (tools/terrain) to load real elevation data.',
        heights=heights,
    )


def _value_noise(seed: int):
    size = 256
    s = seed

    def rand():
        nonlocal s
        s = (s * 1664525 + 1013904223) % 4294967296
        return s / 4294967296

    perm = list(range(size))
    vals = [0.0] * size
    for i in range(size):
        vals[i] = rand() * 2 - 1
    for i in range(size - 1, 0, -1):
        j = math.floor(rand() * (i + 1))
        perm[i], perm[j] = perm[j], perm[i]
    perm = perm + perm

    def lattice(ix, iy):
        return vals[perm[(perm[ix & 255] + iy) & 255]]

    def noise(x, y):
        ix, iy = math.floor(x), math.floor(y)
        fx, fy = x - ix, y - iy
        sx = fx * fx * (3 - 2 * fx)
        sy = fy * fy * (3 - 2 * fy)
        a = lattice(ix, iy) + (lattice(ix + 1, iy) - lattice(ix, iy)) * sx
        b = lattice(ix, iy + 1) + (lattice(ix + 1, iy + 1) - lattice(ix, iy + 1)) * sx
        return a + (b - a) * sy

    return noise


def _fbm(noise, x, y):
    total, amp, freq = 0.0, 0.5, 1.0
    for _ in range(4):
        total += noise(x * freq, y * freq) * amp
        amp *= 0.5
        freq *= 2
    return total
