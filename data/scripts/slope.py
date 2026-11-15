"""Slope and walking-cost grids from a cropped DEM (output of crop_dem.py).

Writes to data/processed/:
    {site}_slope.npy   float32 slope in degrees, NaN where the DEM has no data
    {site}_cost.npy    float32 walking cost per metre, np.inf = impassable
    {site}_grid.json   affine transform, CRS, shape and cost parameters
                       (the .npy files hold only the arrays)

Cost model
    cost = how many times longer a metre takes to walk than on flat ground,
    so flat = 1.0 and total route cost x cell size = time at flat speed.
    It follows Tobler's hiking function, speed ~ exp(-3.5 * tan(slope)),
    made direction-free (the grid stores slope magnitude, not up/down):
        cost = exp(3.5 * tan(slope))      10 deg -> 1.9, 20 deg -> 3.6, 25 deg -> 5.1
    Cells steeper than 25 degrees, or without DEM data, are impassable (inf).
    skimage.graph.route_through_array never crosses inf cells and raises
    ValueError when the end is unreachable.

Usage (from the repo root):
    python data/scripts/slope.py --site jezero
"""

import argparse
import json
from pathlib import Path

import numpy as np
import rasterio
from skimage.measure import label

REPO = Path(__file__).resolve().parents[2]
PROCESSED = REPO / "data" / "processed"

MAX_SLOPE_DEG = 25.0
TOBLER_K = 3.5


def horn_slope(z: np.ndarray, dx: float, dy: float) -> np.ndarray:
    """Slope in degrees using Horn's 3x3 method (the GDAL/ArcGIS standard).

    Less noise-sensitive than a 2-point gradient, which matters on 1-2 m DTMs.
    Edges are handled by repeating the border cells. NaN in -> NaN out for
    every cell whose 3x3 neighbourhood touches a NaN.
    """
    p = np.pad(z, 1, mode="edge")
    a, b, c = p[:-2, :-2], p[:-2, 1:-1], p[:-2, 2:]
    d, f = p[1:-1, :-2], p[1:-1, 2:]
    g, h, i = p[2:, :-2], p[2:, 1:-1], p[2:, 2:]
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx)
    dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * dy)
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy)))


def cost_from_slope(slope_deg: np.ndarray) -> np.ndarray:
    cost = np.exp(TOBLER_K * np.tan(np.radians(np.nan_to_num(slope_deg, nan=90.0))))
    cost[~(slope_deg <= MAX_SLOPE_DEG)] = np.inf  # also catches NaN
    return cost.astype(np.float32)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--site", default="jezero")
    p.add_argument("--dem", default=None, help="default: data/processed/{site}_dem.tif")
    args = p.parse_args()

    dem_path = Path(args.dem) if args.dem else PROCESSED / f"{args.site}_dem.tif"
    with rasterio.open(dem_path) as src:
        z = src.read(1, masked=True).astype(np.float64).filled(np.nan)
        transform, crs = src.transform, src.crs
        if transform.b != 0 or transform.d != 0:
            raise SystemExit("Rotated grids are not supported.")
        dx, dy = transform.a, -transform.e
        tags = src.tags()

    slope = horn_slope(z, dx, dy).astype(np.float32)
    cost = cost_from_slope(slope)

    PROCESSED.mkdir(parents=True, exist_ok=True)
    slope_path = PROCESSED / f"{args.site}_slope.npy"
    cost_path = PROCESSED / f"{args.site}_cost.npy"
    meta_path = PROCESSED / f"{args.site}_grid.json"
    np.save(slope_path, slope)
    np.save(cost_path, cost)
    meta = {
        "site": args.site,
        "shape": list(slope.shape),  # rows, cols
        "transform": list(transform)[:6],  # affine a, b, c, d, e, f (rasterio order)
        "cell_size_m": [dx, dy],
        "crs_wkt": crs.to_wkt(),
        "dem": dem_path.name,
        "center": [float(tags["center_lon"]), float(tags["center_lat"])] if "center_lon" in tags else None,
        "slope_unit": "degrees",
        "cost_model": {
            "formula": "exp(k * tan(slope)), inf above max_slope_deg or without data",
            "k": TOBLER_K,
            "max_slope_deg": MAX_SLOPE_DEG,
            "meaning": "multiplier on flat-ground time per metre",
        },
    }
    meta_path.write_text(json.dumps(meta, indent=2))

    # ---- report -------------------------------------------------------------
    valid = ~np.isnan(slope)
    s = slope[valid]
    n = slope.size
    passable = np.isfinite(cost)
    comps = label(passable, connectivity=2)
    sizes = np.bincount(comps.ravel())[1:]
    largest = sizes.max() if sizes.size else 0
    centre_comp = comps[slope.shape[0] // 2, slope.shape[1] // 2]

    print(f"DEM:      {dem_path}  ({slope.shape[1]} x {slope.shape[0]} cells, {dx} x {dy} m)")
    print(f"slope:    min {s.min():.1f}  median {np.median(s):.1f}  p95 {np.percentile(s, 95):.1f}  "
          f"max {s.max():.1f} deg   (no data: {100 * (1 - valid.mean()):.2f}%)")
    print("classes:  "
          f"green <10: {100 * np.sum(slope < 10) / n:.1f}%   "
          f"yellow 10-20: {100 * np.sum((slope >= 10) & (slope <= 20)) / n:.1f}%   "
          f"red >20: {100 * np.sum(slope > 20) / n:.1f}%")
    print(f"cost:     impassable (>{MAX_SLOPE_DEG:g} deg or no data): {100 * (~passable).mean():.2f}% of cells; "
          f"passable cost range {cost[passable].min():.2f} .. {cost[passable].max():.2f}")
    print(f"connectivity: {sizes.size} passable regions; largest holds "
          f"{100 * largest / passable.sum():.1f}% of passable cells; "
          f"centre cell is {'in the largest region' if centre_comp and sizes[centre_comp - 1] == largest else 'NOT in the largest region'}")
    print(f"wrote:    {slope_path.name}, {cost_path.name}, {meta_path.name}  in {PROCESSED}")


if __name__ == "__main__":
    main()
