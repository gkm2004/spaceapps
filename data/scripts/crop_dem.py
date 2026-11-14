"""Crop a small square of a (huge) Mars DEM around a point and resample it.

Reads only the window it needs, never the whole file.

The output uses a local equirectangular projection whose standard parallel
is the site latitude, so the output cells are true ground metres in both
directions. (Global "Eqc latTs=0" products are only true-scale at the
equator: at Jezero, 18.4 N, their east-west metres are ~5% short, which
would skew slopes and route distances.)

Usage (from the repo root):
    python data/scripts/crop_dem.py --src PATH/TO/DEM.tif --site jezero \
        --lon 77.4509 --lat 18.4446

Writes data/processed/{site}_dem.tif.
"""

import argparse
import math
import warnings
from pathlib import Path

import numpy as np
import rasterio
from pyproj import CRS, Transformer
from pyproj.crs import ProjectedCRS
from pyproj.crs.coordinate_operation import EquidistantCylindricalConversion
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from rasterio.windows import Window, from_bounds

REPO = Path(__file__).resolve().parents[2]

# to_proj4() is only used for display; its 'may lose information' warning is noise here.
warnings.filterwarnings("ignore", message="You will likely lose important projection information")


def geographic_helpers(src_crs: CRS):
    """Return (geodetic_crs, to_pc_lat, from_pc_lat, lon_sign) for the DEM's body.

    The contract uses planetocentric latitude and east-positive longitude.
    On a sphere planetocentric == geodetic; on an ellipsoid we convert.
    """
    geo = src_crs.geodetic_crs
    ell = geo.ellipsoid
    a, b = ell.semi_major_metre, ell.semi_minor_metre
    k = (b * b) / (a * a)

    def to_pc(lat_g):  # geodetic -> planetocentric
        return np.degrees(np.arctan(k * np.tan(np.radians(lat_g))))

    def from_pc(lat_c):  # planetocentric -> geodetic
        return np.degrees(np.arctan(np.tan(np.radians(lat_c)) / k))

    lon_axis = next(ax for ax in geo.axis_info if ax.abbrev.lower().startswith("lon"))
    lon_sign = -1.0 if lon_axis.direction.lower() == "west" else 1.0
    return geo, to_pc, from_pc, lon_sign


def wrap180(lon):
    return (np.asarray(lon) + 180.0) % 360.0 - 180.0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--src", required=True, help="source DEM GeoTIFF")
    p.add_argument("--site", default="jezero")
    p.add_argument("--lon", type=float, default=77.4509, help="centre, east-positive degrees")
    p.add_argument("--lat", type=float, default=18.4446, help="centre, planetocentric degrees")
    p.add_argument("--size", type=float, default=3000.0, help="side of the square, metres")
    p.add_argument("--res", type=float, default=2.0, help="output cell size, metres")
    p.add_argument("--out", default=None, help="default: data/processed/{site}_dem.tif")
    args = p.parse_args()

    out_path = Path(args.out) if args.out else REPO / "data" / "processed" / f"{args.site}_dem.tif"

    with rasterio.open(args.src) as src:
        src_crs = CRS.from_wkt(src.crs.to_wkt())
        print("== Source")
        print(f"file:       {args.src}")
        print(f"size:       {src.width} x {src.height} px, {src.dtypes[0]}, nodata={src.nodata}")
        print(f"CRS:        {src_crs.name}")
        print(f"            {src_crs.to_proj4()}")
        print(f"resolution: {src.res[0]} x {src.res[1]} {src_crs.axis_info[0].unit_name}")
        print(f"bounds:     {tuple(src.bounds)}")

        geo, to_pc, from_pc, lon_sign = geographic_helpers(src_crs)
        print(f"body:       {geo.ellipsoid.name}, a={geo.ellipsoid.semi_major_metre} "
              f"b={geo.ellipsoid.semi_minor_metre}")

        # Local equirectangular grid, true scale at the site latitude.
        lat_g = float(from_pc(args.lat))
        lon_crs = lon_sign * args.lon
        dst_crs = ProjectedCRS(
            name=f"{args.site} local equirectangular",
            conversion=EquidistantCylindricalConversion(
                latitude_first_parallel=lat_g, longitude_natural_origin=lon_crs
            ),
            geodetic_crs=geo,
        )
        geo_to_dst = Transformer.from_crs(geo, dst_crs, always_xy=True)
        cx, cy = geo_to_dst.transform(lon_crs, lat_g)
        half = args.size / 2.0
        n = int(round(args.size / args.res))
        # Snap the grid origin to the cell size so reruns are reproducible.
        x0 = math.floor((cx - half) / args.res) * args.res
        y1 = math.floor((cy + half) / args.res) * args.res
        dst_transform = from_origin(x0, y1, args.res, args.res)
        dst_bounds = (x0, y1 - n * args.res, x0 + n * args.res, y1)

        # Source window covering the destination (+ a few pixels for resampling).
        dst_to_src = Transformer.from_crs(dst_crs, src_crs, always_xy=True)
        sb = dst_to_src.transform_bounds(*dst_bounds, densify_pts=21)
        pad = 4 * max(src.res)
        win = from_bounds(sb[0] - pad, sb[1] - pad, sb[2] + pad, sb[3] + pad, src.transform)
        win = win.round_offsets(op="floor").round_lengths(op="ceil")
        full = Window(0, 0, src.width, src.height)
        if (win.col_off < 0 or win.row_off < 0 or win.col_off + win.width > full.width
                or win.row_off + win.height > full.height):
            raise SystemExit(f"Requested crop falls outside the DEM (window {win}). "
                             "Pick a centre further inside the file's bounds.")

        print("\n== Reading window")
        print(f"window:     cols {win.col_off}..{win.col_off + win.width}, "
              f"rows {win.row_off}..{win.row_off + win.height} "
              f"({win.width * win.height * 4 / 1e6:.0f} MB)")
        block = src.read(1, window=win)
        block_transform = src.window_transform(win)
        src_nodata = src.nodata

    out_nodata = -32768.0
    dst = np.full((n, n), out_nodata, dtype=np.float32)
    reproject(
        source=block,
        destination=dst,
        src_transform=block_transform,
        src_crs=src_crs.to_wkt(),
        src_nodata=src_nodata,
        dst_transform=dst_transform,
        dst_crs=dst_crs.to_wkt(),
        dst_nodata=out_nodata,
        resampling=Resampling.average,  # downsampling ~1 m -> 2 m
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    profile = dict(
        driver="GTiff", width=n, height=n, count=1, dtype="float32",
        crs=dst_crs.to_wkt(), transform=dst_transform, nodata=out_nodata,
        compress="deflate", predictor=3, tiled=True, blockxsize=256, blockysize=256,
    )
    with rasterio.open(out_path, "w", **profile) as out:
        out.write(dst, 1)
        out.update_tags(site=args.site, center_lon=args.lon, center_lat=args.lat,
                        source=Path(args.src).name)

    valid = dst != out_nodata
    print("\n== Output")
    print(f"file:       {out_path}")
    print(f"grid:       {n} x {n} cells at {args.res} m ({args.size:.0f} m square)")
    print(f"CRS:        {dst_crs.to_proj4()}")
    if valid.any():
        print(f"elevation:  min {dst[valid].min():.1f} m, max {dst[valid].max():.1f} m, "
              f"mean {dst[valid].mean():.1f} m")
    print(f"nodata:     {100 * (1 - valid.mean()):.2f}% of cells")

    # bbox in degrees (planetocentric lat, east-positive lon), from the grid's own CRS
    dst_to_geo = Transformer.from_crs(dst_crs, geo, always_xy=True)
    w, s, e, nn = dst_to_geo.transform_bounds(*dst_bounds, densify_pts=21)
    west, east = sorted(wrap180([lon_sign * w, lon_sign * e]))
    south, north = float(to_pc(s)), float(to_pc(nn))
    print("\n== Crop bbox (planetocentric lat, east-positive lon)")
    print(f"west {west:.6f}  south {south:.6f}  east {east:.6f}  north {north:.6f}")
    print(f"contract bbox: [{west:.6f}, {south:.6f}, {east:.6f}, {north:.6f}]")


if __name__ == "__main__":
    main()
