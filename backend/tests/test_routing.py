"""Tests for the least-cost routing in routing.py.

Synthetic grids keep these fast and independent of the DEM; the last tests
run on the real site grids and are skipped when data/processed/ is empty.

Run from backend/:  python -m pytest
"""

import math
from pathlib import Path

import numpy as np
import pytest

from routing import (FLAT_SPEED_M_S, MIN_WINDOW_MARGIN_CELLS, PROFILE_STEP_M, RouteError, Site,
                     compute_route, compute_route_windowed, cost_for_slope)

CELL = (2.0, 2.0)
PROCESSED = Path(__file__).resolve().parents[2] / "data" / "processed"

# An 8-direction grid path can't follow an arbitrary bearing: at worst (22.5 deg
# off an axis) it is cos(22.5) + (sqrt(2) - 1) * sin(22.5) = 1.0824x the straight line.
MAX_GRID_DETOUR = 1.0824


def flat(shape=(120, 200), height=-2500.0):
    return np.ones(shape, np.float32), np.zeros(shape, np.float32), np.full(shape, height, np.float32)


def straight_m(start, end):
    return math.hypot((end[0] - start[0]) * CELL[1], (end[1] - start[1]) * CELL[0])


def assert_connected(cells, start, end):
    assert tuple(cells[0]) == start and tuple(cells[-1]) == end
    steps = np.abs(np.diff(cells, axis=0))
    assert steps.max() <= 1, "path jumps over cells"
    assert (steps.sum(axis=1) > 0).all(), "path repeats a cell"


# -- flat ground: close to the straight line ----------------------------------

@pytest.mark.parametrize("start,end", [
    ((10, 10), (10, 190)),   # due east
    ((5, 50), (115, 50)),    # due south
    ((10, 10), (110, 110)),  # exact diagonal
])
def test_flat_route_on_grid_direction_is_exactly_straight(start, end):
    cost, slope, dem = flat()
    r = compute_route(cost, slope, dem, CELL, start, end)
    assert r.distance_m == pytest.approx(straight_m(start, end), rel=1e-9)


@pytest.mark.parametrize("start,end", [
    ((10, 10), (80, 150)),
    ((100, 20), (15, 190)),
    ((60, 5), (40, 195)),
    ((3, 100), (117, 60)),
])
def test_flat_route_is_close_to_straight_line(start, end):
    cost, slope, dem = flat()
    r = compute_route(cost, slope, dem, CELL, start, end)
    line = straight_m(start, end)
    assert_connected(r.cells, start, end)
    assert line <= r.distance_m + 1e-6
    assert r.distance_m <= line * MAX_GRID_DETOUR + 1e-6


def test_flat_route_stats():
    cost, slope, dem = flat()
    r = compute_route(cost, slope, dem, CELL, (10, 10), (80, 150))
    assert r.ascent_m == 0
    assert r.max_slope_deg == 0
    # flat ground: 0.8 m/s exactly
    assert r.est_minutes == pytest.approx(r.distance_m / FLAT_SPEED_M_S / 60)


def test_profile_sampled_every_10_m_and_ends_at_distance():
    cost, slope, dem = flat()
    dem += np.linspace(0, 30, dem.shape[1], dtype=np.float32)  # gentle ramp to the east
    r = compute_route(cost, slope, dem, CELL, (10, 10), (80, 150))
    d = np.array([p[0] for p in r.profile])
    assert d[0] == 0
    assert np.allclose(np.diff(d)[:-1], PROFILE_STEP_M)
    assert 0 < d[-1] - d[-2] <= PROFILE_STEP_M
    assert d[-1] == pytest.approx(r.distance_m, abs=0.05)
    h = [p[1] for p in r.profile]
    assert h[0] == pytest.approx(float(dem[10, 10]), abs=0.01)
    assert h[-1] == pytest.approx(float(dem[80, 150]), abs=0.01)
    assert r.ascent_m == pytest.approx(h[-1] - h[0], abs=0.05)  # monotonic climb


# -- impassable cells are never crossed ---------------------------------------

def test_route_goes_through_the_gap_in_a_wall():
    cost, slope, dem = flat()
    cost[:, 100] = np.inf
    cost[90:93, 100] = 1.0  # the only gap, far from the direct line
    start, end = (20, 20), (20, 180)
    r = compute_route(cost, slope, dem, CELL, start, end)
    assert_connected(r.cells, start, end)
    assert np.isfinite(cost[r.cells[:, 0], r.cells[:, 1]]).all()
    crossing = r.cells[r.cells[:, 1] == 100]
    assert len(crossing) and ((crossing[:, 0] >= 90) & (crossing[:, 0] < 93)).all()
    assert r.distance_m > straight_m(start, end) * 1.2  # had to detour


@pytest.mark.parametrize("seed", range(8))
def test_route_never_crosses_impassable_cells_in_random_terrain(seed):
    rng = np.random.default_rng(seed)
    shape = (120, 200)
    slope = rng.uniform(0, 24, shape).astype(np.float32)
    cost = np.exp(3.5 * np.tan(np.radians(slope))).astype(np.float32)
    blocked = rng.random(shape) < 0.3  # 30% impassable: plenty of obstacles, still connected
    cost[blocked] = np.inf
    slope[blocked] = 40.0
    dem = rng.normal(-2500, 5, shape).astype(np.float32)
    free = np.argwhere(~blocked)
    start = tuple(int(v) for v in free[rng.integers(len(free))])
    end = tuple(int(v) for v in free[rng.integers(len(free))])
    if start == end:
        pytest.skip("random start == end")
    try:
        r = compute_route(cost, slope, dem, CELL, start, end)
    except RouteError:
        pytest.skip("random start/end not connected")
    assert_connected(r.cells, start, end)
    rows, cols = r.cells[:, 0], r.cells[:, 1]
    assert np.isfinite(cost[rows, cols]).all()
    assert not blocked[rows, cols].any()
    assert r.max_slope_deg <= 24.0


def test_route_avoids_a_steep_band_when_the_detour_is_cheaper():
    cost, slope, dem = flat()
    cost[30:90, 95:105] = 5.0  # steep but passable ridge across the direct line
    r = compute_route(cost, slope, dem, CELL, (60, 20), (60, 180))
    assert (cost[r.cells[:, 0], r.cells[:, 1]] == 1.0).all()


# -- vehicles: speed and slope limit ---------------------------------------------

def test_speed_only_changes_the_time():
    cost, slope, dem = flat()
    walk = compute_route(cost, slope, dem, CELL, (10, 10), (80, 150))
    fast = compute_route(cost, slope, dem, CELL, (10, 10), (80, 150), speed_m_s=FLAT_SPEED_M_S * 4)
    assert (fast.cells == walk.cells).all()
    assert fast.est_minutes == pytest.approx(walk.est_minutes / 4)


def test_cost_for_slope_matches_the_walking_limit():
    slope = np.array([0.0, 10.0, 24.9, 25.0, 25.1, 40.0, np.nan], np.float32)
    cost = cost_for_slope(slope, 25.0)
    assert cost[0] == pytest.approx(1.0)
    assert np.isfinite(cost[:4]).all() and np.isinf(cost[4:]).all()
    assert np.isinf(cost_for_slope(slope, 20.0)[2])
    assert np.isfinite(cost_for_slope(slope, 45.0)[5])


def ridge():
    """Flat ground with a 28 degree ridge right across it: too steep to walk, fine for a rover."""
    _, slope, dem = big_flat((200, 400))
    slope[:, 195:205] = 28.0
    return cost_for_slope(slope, 25.0), slope, dem


def test_slope_limit_opens_and_closes_a_ridge():
    cost, slope, dem = ridge()
    with pytest.raises(RouteError, match="No walkable route"):
        compute_route_windowed(cost, slope, dem, CELL, (100, 20), (100, 380))
    r = compute_route_windowed(cost, slope, dem, CELL, (100, 20), (100, 380), max_slope_deg=30.0)
    assert r.max_slope_deg == pytest.approx(28.0)


def test_lower_slope_limit_takes_the_detour():
    cost, slope, dem = flat((120, 200))
    slope[20:120, 95:105] = 15.0  # a 15 degree band with a flat gap at the top
    cost = cost_for_slope(slope, 25.0)
    walk = compute_route_windowed(cost, slope, dem, CELL, (100, 20), (100, 180))
    assert walk.max_slope_deg == pytest.approx(15.0)  # walkers climb straight over
    rover = compute_route_windowed(cost, slope, dem, CELL, (100, 20), (100, 180), max_slope_deg=10.0)
    assert rover.max_slope_deg == 0.0  # the vehicle goes round through the gap
    assert rover.distance_m > walk.distance_m


# -- windowed search (large sites) ----------------------------------------------

def big_flat(shape=(900, 1200)):
    return np.ones(shape, np.float32), np.zeros(shape, np.float32), np.full(shape, -2500.0, np.float32)


def test_windowed_route_matches_whole_grid_route():
    rng = np.random.default_rng(3)
    cost, slope, dem = big_flat()
    cost *= rng.uniform(1.0, 3.0, cost.shape).astype(np.float32)  # varied terrain, no walls
    start, end = (400, 300), (520, 700)
    full = compute_route(cost, slope, dem, CELL, start, end)
    win = compute_route_windowed(cost, slope, dem, CELL, start, end)
    assert_connected(win.cells, start, end)
    # same optimum unless the best path leaves the box; allow a hair of slack for that
    assert win.est_minutes == pytest.approx(full.est_minutes, rel=0.01)
    assert win.distance_m == pytest.approx(full.distance_m, rel=0.02)


def test_windowed_route_widens_the_box_when_blocked():
    cost, slope, dem = big_flat()
    cost[:, 600] = np.inf
    gap_row = 860  # far outside the first box around the two points
    cost[gap_row:gap_row + 3, 600] = 1.0
    start, end = (100, 550), (100, 650)
    assert gap_row > max(start[0], end[0]) + MIN_WINDOW_MARGIN_CELLS
    r = compute_route_windowed(cost, slope, dem, CELL, start, end)
    assert_connected(r.cells, start, end)
    rows, cols = r.cells[:, 0], r.cells[:, 1]
    assert np.isfinite(cost[rows, cols]).all()
    assert rows.max() >= gap_row  # it found the gap


def test_windowed_route_reports_no_route_only_after_the_whole_grid():
    cost, slope, dem = big_flat()
    cost[:, 600] = np.inf
    with pytest.raises(RouteError, match="No walkable route"):
        compute_route_windowed(cost, slope, dem, CELL, (100, 550), (100, 650))


def test_windowed_route_near_the_grid_edge():
    cost, slope, dem = big_flat()
    start, end = (2, 3), (40, 1195)
    r = compute_route_windowed(cost, slope, dem, CELL, start, end)
    assert_connected(r.cells, start, end)
    assert r.distance_m <= straight_m(start, end) * MAX_GRID_DETOUR + 1e-6


# -- errors ---------------------------------------------------------------------

def test_no_route_through_a_complete_wall():
    cost, slope, dem = flat()
    cost[:, 100] = np.inf
    with pytest.raises(RouteError, match="No walkable route"):
        compute_route(cost, slope, dem, CELL, (20, 20), (20, 180))


def test_start_or_end_on_impassable_cell_is_rejected():
    cost, slope, dem = flat()
    cost[20, 20] = np.inf
    with pytest.raises(RouteError, match="Start"):
        compute_route(cost, slope, dem, CELL, (20, 20), (20, 180))
    with pytest.raises(RouteError, match="End"):
        compute_route(cost, slope, dem, CELL, (20, 180), (20, 20))


def test_same_start_and_end_is_rejected():
    cost, slope, dem = flat()
    with pytest.raises(RouteError, match="same grid cell"):
        compute_route(cost, slope, dem, CELL, (20, 20), (20, 20))


# -- real site data (skipped without data/processed/) ---------------------------

@pytest.fixture(scope="module")
def jezero():
    if not (PROCESSED / "jezero_grid.json").exists():
        pytest.skip("data/processed/jezero_* not built (see data/scripts/README.md)")
    return Site("jezero", "Jezero Crater", PROCESSED)


def test_real_lonlat_cell_round_trip(jezero):
    row, col = jezero.lonlat_to_cell(77.4509, 18.4446)
    lon, lat = jezero.cells_to_lonlat([row], [col])
    assert abs(lon[0] - 77.4509) < 5e-5 and abs(lat[0] - 18.4446) < 5e-5  # within one 2 m cell
    with pytest.raises(RouteError, match="outside"):
        jezero.lonlat_to_cell(77.60, 18.44)


def test_real_route_matches_contract_and_avoids_impassable(jezero):
    start, end = (77.4509, 18.4446), (77.4350, 18.4600)
    f = jezero.route(start, end)
    assert f["type"] == "Feature" and f["geometry"]["type"] == "LineString"
    p = f["properties"]
    assert set(p) == {"distance_m", "ascent_m", "est_minutes", "max_slope_deg", "profile"}
    coords = np.array(f["geometry"]["coordinates"])
    assert coords.shape[1] == 3
    w, s, e, n = jezero.bbox
    assert ((coords[:, 0] >= w) & (coords[:, 0] <= e) & (coords[:, 1] >= s) & (coords[:, 1] <= n)).all()

    cells = [jezero.lonlat_to_cell(lon, lat) for lon, lat, _ in coords]
    assert all(np.isfinite(jezero.cost[c]) for c in cells)
    assert p["max_slope_deg"] <= 25.0
    assert p["est_minutes"] >= p["distance_m"] / FLAT_SPEED_M_S / 60 - 0.1  # never faster than flat
    assert p["profile"][-1][0] == pytest.approx(p["distance_m"], abs=0.1)


def test_real_vehicle_route_respects_its_slope_limit_and_speed(jezero):
    start, end = (77.4509, 18.4446), (77.4350, 18.4600)
    walk = jezero.route(start, end)["properties"]
    rover = jezero.route(start, end, speed_m_s=2.8, max_slope_deg=15.0)["properties"]
    assert rover["max_slope_deg"] <= 15.0
    assert rover["est_minutes"] < walk["est_minutes"]
