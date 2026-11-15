"""Least-cost walking routes on the grids produced by data/scripts/.

`compute_route` is pure numpy/skimage (no files, no georeferencing) so it can
be tested on synthetic grids. `Site` adds loading and lon/lat <-> cell maths.
"""

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
import rasterio
from affine import Affine
from pyproj import CRS, Transformer
from scipy.ndimage import distance_transform_edt
from skimage.graph import route_through_array

FLAT_SPEED_M_S = 0.8  # walking speed on flat ground; cost grid scales it down with slope
PROFILE_STEP_M = 10.0
SNAP_RADIUS_M = 30.0  # clicks on impassable cells snap to the nearest walkable one


class RouteError(ValueError):
    """A route request that cannot be satisfied (bad point, no path)."""


@dataclass
class RouteResult:
    cells: np.ndarray  # (n, 2) int rows, cols
    heights: np.ndarray  # (n,) metres
    distance_m: float
    ascent_m: float
    est_minutes: float
    max_slope_deg: float
    profile: list  # [[dist_m, height_m], ...] every PROFILE_STEP_M


def compute_route(cost, slope, dem, cell_size, start, end) -> RouteResult:
    """Least-cost path between two (row, col) cells.

    cost:  time multiplier per metre (1 = flat), np.inf = impassable
    slope: degrees;  dem: metres;  cell_size: (dx, dy) metres
    """
    start, end = tuple(map(int, start)), tuple(map(int, end))
    if start == end:
        raise RouteError("Start and end are the same grid cell.")
    for name, cell in (("Start", start), ("End", end)):
        if not np.isfinite(cost[cell]):
            raise RouteError(f"{name} point is on impassable terrain.")
    try:
        # geometric=True weights diagonal steps by sqrt(2); inf cells are never entered.
        path, _ = route_through_array(cost, start, end, fully_connected=True, geometric=True)
    except ValueError as exc:
        raise RouteError("No walkable route between these points.") from exc

    cells = np.asarray(path, dtype=np.int64)
    rows, cols = cells[:, 0], cells[:, 1]
    z = dem[rows, cols].astype(np.float64)
    dx, dy = cell_size
    horiz = np.hypot(np.diff(cols) * dx, np.diff(rows) * dy)
    seg = np.hypot(horiz, np.diff(z))  # 3D length of each step
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    distance = float(cum[-1])

    # Time: each step at the mean cost of its two cells.
    c = cost[rows, cols].astype(np.float64)
    seconds = float(np.sum(seg * (c[:-1] + c[1:]) / 2.0) / FLAT_SPEED_M_S)

    # Profile every 10 m (plus the exact end). Ascent is summed on this profile,
    # not per 2 m cell, so DEM noise doesn't inflate it.
    d = np.arange(0.0, distance, PROFILE_STEP_M)
    if distance - d[-1] > 1e-6:
        d = np.append(d, distance)
    h = np.interp(d, cum, z)
    ascent = float(np.clip(np.diff(h), 0, None).sum())

    return RouteResult(
        cells=cells,
        heights=z,
        distance_m=distance,
        ascent_m=ascent,
        est_minutes=seconds / 60.0,
        max_slope_deg=float(np.nanmax(slope[rows, cols])),
        profile=[[round(float(a), 1), round(float(b), 2)] for a, b in zip(d, h)],
    )


MIN_WINDOW_MARGIN_CELLS = 150  # 300 m at 2 m cells


def compute_route_windowed(cost, slope, dem, cell_size, start, end) -> RouteResult:
    """compute_route, but searching only a box around the two points.

    The search cost grows with the number of cells, so on a large site a
    whole-grid search takes seconds. The box is the start/end bounding box
    plus a margin of half its longer side (at least 300 m). If no route fits
    inside it, the margin is widened, ending with the whole grid, so a route
    that needs a long detour is still found.
    """
    rows, cols = cost.shape
    span = max(abs(start[0] - end[0]), abs(start[1] - end[1]))
    margin = max(MIN_WINDOW_MARGIN_CELLS, span // 2)
    while True:
        r0, r1 = max(0, min(start[0], end[0]) - margin), min(rows, max(start[0], end[0]) + margin + 1)
        c0, c1 = max(0, min(start[1], end[1]) - margin), min(cols, max(start[1], end[1]) + margin + 1)
        whole = (r0, c0, r1, c1) == (0, 0, rows, cols)
        try:
            result = compute_route(
                cost[r0:r1, c0:c1], slope[r0:r1, c0:c1], dem[r0:r1, c0:c1], cell_size,
                (start[0] - r0, start[1] - c0), (end[0] - r0, end[1] - c0))
        except RouteError as exc:
            if whole or "No walkable route" not in str(exc):
                raise
            margin *= 4  # blocked inside the box: look further afield
            continue
        result.cells = result.cells + np.array([r0, c0])
        return result


class Site:
    """One site's grids plus its georeferencing."""

    def __init__(self, site_id: str, name: str, processed_dir: Path):
        meta = json.loads((processed_dir / f"{site_id}_grid.json").read_text())
        self.id, self.name = site_id, name
        self.cost = np.load(processed_dir / f"{site_id}_cost.npy")
        self.slope = np.load(processed_dir / f"{site_id}_slope.npy")
        with rasterio.open(processed_dir / meta["dem"]) as src:
            self.dem = src.read(1)
        self.transform = Affine(*meta["transform"])
        self.cell_size = tuple(meta["cell_size_m"])

        crs = CRS.from_wkt(meta["crs_wkt"])
        geo = crs.geodetic_crs
        # Contract latitudes are planetocentric; convert if the body isn't a sphere.
        ell = geo.ellipsoid
        self._k = (ell.semi_minor_metre / ell.semi_major_metre) ** 2
        self._to_grid = Transformer.from_crs(geo, crs, always_xy=True)
        self._to_geo = Transformer.from_crs(crs, geo, always_xy=True)

        rows, cols = self.cost.shape
        t = self.transform
        w, s, e, n = self._to_geo.transform_bounds(
            t.c, t.f + rows * t.e, t.c + cols * t.a, t.f, densify_pts=21)
        self.bbox = [round(v, 6) for v in (self._wrap(w), self._pc(s), self._wrap(e), self._pc(n))]
        self.center = meta.get("center") or [
            round((self.bbox[0] + self.bbox[2]) / 2, 6), round((self.bbox[1] + self.bbox[3]) / 2, 6)]

        # For snapping: index of the nearest passable cell, for every cell.
        dist, idx = distance_transform_edt(
            ~np.isfinite(self.cost), sampling=(self.cell_size[1], self.cell_size[0]),
            return_indices=True)
        # compact types: with two 6 km sites loaded, the defaults (float64 + int32) cost ~290 MB
        self._snap_dist = dist.astype(np.float32)
        self._snap_idx = idx.astype(np.int16 if max(self.cost.shape) < 32768 else np.int32)
        del dist, idx
        self.route_cells = lru_cache(maxsize=512)(self._route_cells)

    # -- coordinates ---------------------------------------------------------
    @staticmethod
    def _wrap(lon):
        return float((lon + 180.0) % 360.0 - 180.0)

    def _pc(self, lat_geodetic):
        return float(np.degrees(np.arctan(self._k * np.tan(np.radians(lat_geodetic)))))

    def lonlat_to_cell(self, lon: float, lat: float):
        lat_g = np.degrees(np.arctan(np.tan(np.radians(lat)) / self._k))
        x, y = self._to_grid.transform(lon, lat_g)
        t = self.transform  # north-up grid: no rotation terms
        col, row = (x - t.c) / t.a, (y - t.f) / t.e
        row, col = int(np.floor(row)), int(np.floor(col))
        if not (0 <= row < self.cost.shape[0] and 0 <= col < self.cost.shape[1]):
            raise RouteError(f"Point {lon},{lat} is outside the site bbox {self.bbox}.")
        return row, col

    def cells_to_lonlat(self, rows, cols):
        t = self.transform  # north-up grid: no rotation terms
        x = t.c + (np.asarray(cols) + 0.5) * t.a
        y = t.f + (np.asarray(rows) + 0.5) * t.e
        lon, lat_g = self._to_geo.transform(x, y)
        lat = np.degrees(np.arctan(self._k * np.tan(np.radians(lat_g))))
        return (np.asarray(lon) + 180.0) % 360.0 - 180.0, lat

    def snap(self, cell):
        """Nearest passable cell, if within SNAP_RADIUS_M."""
        if np.isfinite(self.cost[cell]):
            return cell
        if self._snap_dist[cell] > SNAP_RADIUS_M:
            raise RouteError("Point is on impassable terrain (too steep) with no walkable ground nearby.")
        return int(self._snap_idx[0][cell]), int(self._snap_idx[1][cell])

    # -- routing -------------------------------------------------------------
    def _route_cells(self, start, end) -> RouteResult:
        return compute_route_windowed(self.cost, self.slope, self.dem, self.cell_size, start, end)

    def route(self, start_lonlat, end_lonlat) -> dict:
        """GeoJSON Feature per CONTRACT.md. Cached per (start cell, end cell)."""
        start = self.snap(self.lonlat_to_cell(*start_lonlat))
        end = self.snap(self.lonlat_to_cell(*end_lonlat))
        r = self.route_cells(start, end)
        lon, lat = self.cells_to_lonlat(r.cells[:, 0], r.cells[:, 1])
        coords = [[round(float(a), 7), round(float(b), 7), round(float(c), 2)]
                  for a, b, c in zip(lon, lat, r.heights)]
        return {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {
                "distance_m": round(r.distance_m, 1),
                "ascent_m": round(r.ascent_m, 1),
                "est_minutes": round(r.est_minutes, 1),
                "max_slope_deg": round(r.max_slope_deg, 1),
                "profile": r.profile,
            },
        }

    def as_contract(self) -> dict:
        return {"id": self.id, "name": self.name, "center": self.center, "bbox": self.bbox}
