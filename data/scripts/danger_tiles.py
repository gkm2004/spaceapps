"""Cut the slope grid into coloured "danger" PNG tiles for CesiumJS.

Input:  data/processed/{site}_slope.npy + {site}_grid.json   (from slope.py)
Output: data/tiles/{site}/danger/{z}/{x}/{y}.png
        data/tiles/{site}/danger/tiles.json   (zoom range, bounds, scheme)

Colours (semi-transparent RGBA): green < 10 deg, yellow 10-20 deg, red > 20 deg.
Cells without data are fully transparent.

Tiling scheme: Cesium's GeographicTilingScheme (EPSG:4326-style)
    level z has 2^(z+1) x 2^z tiles of 256 px, each 180/2^z degrees square,
    x counted east from -180, y counted SOUTH FROM +90 (north-origin, i.e.
    exactly what UrlTemplateImageryProvider puts in {y}).
Why: planetary DEMs are equirectangular already, Web Mercator would distort
them and is an Earth convention; this is Cesium's native non-Earth scheme, so
the frontend needs no custom tiling code. Lat/lon are the contract's
planetocentric degrees, which is also how Cesium's Mars tileset is placed
(see README in this folder).

Frontend usage:
    new Cesium.UrlTemplateImageryProvider({
      url: `${API_BASE}/tiles/jezero/danger/{z}/{x}/{y}.png`,
      tilingScheme: new Cesium.GeographicTilingScheme({ ellipsoid: Cesium.Ellipsoid.MARS }),
      rectangle: Cesium.Rectangle.fromDegrees(...tiles.json bounds),
      minimumLevel, maximumLevel,          // from tiles.json
    })

Usage (from the repo root):
    python data/scripts/danger_tiles.py --site jezero
"""

import argparse
import json
import math
import shutil
from pathlib import Path

import numpy as np
from affine import Affine
from pyproj import CRS, Transformer
from skimage import io

from crop_dem import geographic_helpers, wrap180

REPO = Path(__file__).resolve().parents[2]
PROCESSED = REPO / "data" / "processed"
TILE = 256

# RGBA. More opaque as it gets more dangerous, so red reads even over bright terrain.
GREEN = (46, 204, 64, 90)
YELLOW = (255, 210, 0, 150)
RED = (230, 30, 30, 190)


def tile_deg(z):
    return 180.0 / (2 ** z)


def tile_range(bounds, z):
    """Tiles at level z intersecting (west, south, east, north)."""
    w, s, e, n = bounds
    d = tile_deg(z)
    x0, x1 = math.floor((w + 180) / d), math.floor((e + 180) / d - 1e-12)
    y0, y1 = math.floor((90 - n) / d), math.floor((90 - s) / d - 1e-12)
    return x0, x1, y0, y1


def colorize(slope):
    rgba = np.zeros(slope.shape + (4,), np.uint8)
    rgba[slope < 10] = GREEN
    rgba[(slope >= 10) & (slope <= 20)] = YELLOW
    rgba[slope > 20] = RED  # NaN matches none of these -> stays transparent
    return rgba


def render_tile(z, x, y, slope, inv_transform, geo_to_grid, lon_sign, from_pc):
    """Sample the slope grid (nearest cell) at each pixel centre of one tile."""
    d = tile_deg(z)
    px = (np.arange(TILE) + 0.5) / TILE * d
    lon = -180 + x * d + px
    lat = 90 - y * d - px
    lon2, lat2 = np.meshgrid(lon, lat)
    gx, gy = geo_to_grid.transform(lon_sign * lon2, from_pc(lat2))
    col, row = inv_transform * (gx, gy)
    col, row = np.floor(col).astype(np.int64), np.floor(row).astype(np.int64)
    inside = (row >= 0) & (row < slope.shape[0]) & (col >= 0) & (col < slope.shape[1])
    s = np.full((TILE, TILE), np.nan, np.float32)
    s[inside] = slope[row[inside], col[inside]]
    return colorize(s)


def downsample(children):
    """2x2 child tiles (None = empty) -> parent tile, premultiplied-alpha average."""
    big = np.zeros((2 * TILE, 2 * TILE, 4), np.float64)
    for (dx, dy), img in children.items():
        if img is not None:
            big[dy * TILE:(dy + 1) * TILE, dx * TILE:(dx + 1) * TILE] = img
    a = big[..., 3:4] / 255.0
    pre = np.concatenate([big[..., :3] * a, a], axis=-1)
    pre = pre.reshape(TILE, 2, TILE, 2, 4).mean(axis=(1, 3))
    alpha = pre[..., 3:4]
    rgb = np.divide(pre[..., :3], alpha, out=np.zeros_like(pre[..., :3]), where=alpha > 0)
    return np.concatenate([rgb, alpha * 255.0], axis=-1).round().astype(np.uint8)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--site", default="jezero")
    p.add_argument("--min-zoom", type=int, default=10)
    p.add_argument("--max-zoom", type=int, default=None,
                   help="default: first level whose pixels are finer than the grid cells")
    p.add_argument("--out", default=None, help="default: data/tiles/{site}/danger")
    args = p.parse_args()

    meta = json.loads((PROCESSED / f"{args.site}_grid.json").read_text())
    slope = np.load(PROCESSED / f"{args.site}_slope.npy")
    transform = Affine(*meta["transform"])
    grid_crs = CRS.from_wkt(meta["crs_wkt"])
    geo, to_pc, from_pc, lon_sign = geographic_helpers(grid_crs)
    geo_to_grid = Transformer.from_crs(geo, grid_crs, always_xy=True)
    grid_to_geo = Transformer.from_crs(grid_crs, geo, always_xy=True)

    rows, cols = slope.shape
    gb = (transform.c, transform.f + rows * transform.e, transform.c + cols * transform.a, transform.f)
    w, s, e, n = grid_to_geo.transform_bounds(*gb, densify_pts=21)
    west, east = sorted(float(v) for v in wrap180([lon_sign * w, lon_sign * e]))
    bounds = (west, float(to_pc(s)), east, float(to_pc(n)))

    # Max zoom: pixel height (in metres along a meridian) <= grid cell size.
    radius = geo.ellipsoid.semi_major_metre
    cell = min(meta["cell_size_m"])
    max_zoom = args.max_zoom
    if max_zoom is None:
        max_zoom = next(z for z in range(30)
                        if math.radians(tile_deg(z) / TILE) * radius <= cell)

    out = Path(args.out) if args.out else REPO / "data" / "tiles" / args.site / "danger"
    if out.exists():
        shutil.rmtree(out)  # regenerate cleanly; nothing here is hand-made
    inv = ~transform

    def save(z, x, y, img):
        path = out / str(z) / str(x) / f"{y}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        io.imsave(path, img, check_contrast=False)

    # Highest zoom straight from the grid, then each parent from its 4 children.
    level = {}
    x0, x1, y0, y1 = tile_range(bounds, max_zoom)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            img = render_tile(max_zoom, x, y, slope, inv, geo_to_grid, lon_sign, from_pc)
            if img[..., 3].any():
                level[(x, y)] = img
    counts = {max_zoom: len(level)}
    for (x, y), img in level.items():
        save(max_zoom, x, y, img)

    for z in range(max_zoom - 1, args.min_zoom - 1, -1):
        parents = {}
        for (cx, cy) in level:
            parents.setdefault((cx // 2, cy // 2), None)
        nxt = {}
        for (x, y) in parents:
            kids = {(dx, dy): level.get((2 * x + dx, 2 * y + dy)) for dx in (0, 1) for dy in (0, 1)}
            img = downsample(kids)
            if img[..., 3].any():
                nxt[(x, y)] = img
                save(z, x, y, img)
        level = nxt
        counts[z] = len(level)

    px_m = math.radians(tile_deg(max_zoom) / TILE) * radius
    info = {
        "site": args.site,
        "scheme": "Cesium GeographicTilingScheme: level z = 2^(z+1) x 2^z tiles, "
                  "y counted from the north, 256 px",
        "url_template": f"/tiles/{args.site}/danger/{{z}}/{{x}}/{{y}}.png",
        "bounds": [round(v, 6) for v in bounds],
        "minzoom": args.min_zoom,
        "maxzoom": max_zoom,
        "colors": {"green_lt_10": GREEN, "yellow_10_20": YELLOW, "red_gt_20": RED},
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "tiles.json").write_text(json.dumps(info, indent=2))

    total = sum(counts.values())
    size = sum(f.stat().st_size for f in out.rglob("*.png"))
    print(f"bounds:  {info['bounds']}  (west, south, east, north; planetocentric, east-positive)")
    print(f"zoom:    {args.min_zoom}..{max_zoom}  (z{max_zoom} pixel = {px_m:.2f} m N-S, "
          f"{px_m * math.cos(math.radians(bounds[1])):.2f} m E-W; grid cell = {cell:g} m)")
    print("tiles:   " + ", ".join(f"z{z}: {counts[z]}" for z in sorted(counts)) +
          f"  -> {total} PNGs, {size / 1024:.0f} KB")
    print(f"wrote:   {out}")


if __name__ == "__main__":
    main()
