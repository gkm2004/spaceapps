"""Build a high-resolution 3D terrain model of a site from its DEM crop.

Cesium's global Mars tileset has a terrain point every ~73 m at Jezero; the
HiRISE DEM has one every 1-2 m. This script turns the DEM crop into a small
3D Tiles tileset that the frontend shows instead of Cesium's ground when the
camera is near the site (ground mode).

Input:   data/processed/{site}_dem.tif      geometry (2 m)
         data/processed/{site}_dem_1m.tif   surface shading (1 m); optional,
                                            falls back to the 2 m DEM
Output:  data/terrain/{site}/tileset.json + *.glb   (large: ignored by git)

Levels of detail (3D Tiles, REPLACE refinement):
    L0  the whole site      16 m mesh
    L1  3 x 3 tiles          8 m mesh
    L2  6 x 6 tiles          2 m mesh    (only loaded near the camera)
Tiles get a "skirt" (edge vertices repeated lower down) so no gaps show where
tiles of different detail meet.

Colour is shaded relief computed from the DEM and tinted Mars colours, baked
into each tile's texture (unlit material). The shapes are real; the colour is
synthetic. A real orthoimage could replace `surface_image()` later.

Coordinates: grid cell -> lon/lat -> ECEF on Cesium's Mars ellipsoid, using
the lon/lat values unchanged (see README: that is how Cesium's Mars tileset
is laid out). Heights are DEM heights; the frontend shifts the whole model
vertically to meet Cesium's surrounding terrain.

Usage (from the repo root):
    python data/scripts/crop_dem.py --src DEM.tif --site jezero --res 1 \
        --out data/processed/jezero_dem_1m.tif          # once, for shading
    python data/scripts/terrain_mesh.py --site jezero
"""

import argparse
import io
import json
import shutil
import struct
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from pyproj import CRS, Transformer
from scipy import ndimage

REPO = Path(__file__).resolve().parents[2]
PROCESSED = REPO / "data" / "processed"

# Cesium.Ellipsoid.MARS
MARS_A = 3396190.0
MARS_B = 3376200.0

TEXTURE_PX = 1024       # per tile, every level
SURFACE_M_PER_PX = 0.5  # resolution of the baked surface image
SKIRT_M = 12.0
LEVELS = [              # (tiles per side, cells per mesh step, geometric error in metres)
    (1, 8, 6.0),
    (3, 4, 2.5),
    (6, 1, 0.0),
]


def to_ecef(lon_deg, lat_deg, h):
    """Geodetic lon/lat/height on Cesium's Mars ellipsoid -> ECEF metres."""
    lon, lat = np.radians(lon_deg), np.radians(lat_deg)
    e2 = 1.0 - (MARS_B * MARS_B) / (MARS_A * MARS_A)
    n = MARS_A / np.sqrt(1.0 - e2 * np.sin(lat) ** 2)
    return np.stack([
        (n + h) * np.cos(lat) * np.cos(lon),
        (n + h) * np.cos(lat) * np.sin(lon),
        (n * (1.0 - e2) + h) * np.sin(lat),
    ], axis=-1)


def hillshade(z, cell, azimuth, altitude):
    gy, gx = np.gradient(z, cell)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    az, alt = np.radians(azimuth), np.radians(altitude)
    return np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)


def surface_image(dem, cell, out_px, seed=0):
    """Mars-tinted shaded relief, uint8 RGB, out_px x out_px, north at the top."""
    z = dem.astype(np.float64)
    # Sun from the north-west plus a weak fill light, so slopes facing away aren't black.
    # Relief is exaggerated 2x for the shading only (not the geometry): Jezero's floor is
    # nearly level, and true-scale shading leaves it one flat colour at eye level.
    shade = 0.75 * hillshade(z * 2.0, cell, 315, 38) + 0.25 * hillshade(z * 2.0, cell, 60, 55)
    # Local relief: bumps a little brighter, hollows darker (cheap ambient occlusion).
    relief = z - ndimage.gaussian_filter(z, 12.0 / cell)
    relief = np.clip(relief / 1.5, -1, 1)
    # Broad albedo variation with elevation, like dust settling in low ground.
    broad = ndimage.gaussian_filter(z, 60.0 / cell)
    broad = (broad - broad.min()) / max(np.ptp(broad), 1e-6)

    v = np.clip((shade - 0.25) / 0.6, 0, 1)
    v = np.clip(v + 0.20 * relief + 0.08 * (broad - 0.5), 0, 1)

    v = v.astype(np.float32)  # the upsampled image is large; float32 halves the memory
    zoom = out_px / v.shape[0]
    if abs(zoom - 1) > 1e-6:
        v = np.clip(ndimage.zoom(v, zoom, order=3), 0, 1)
    v = v[:out_px, :out_px]

    # Surface texture below the DEM's resolution, so the ground isn't a smooth blur at
    # your feet: pebble-scale grain plus patchy dust at a few metres and tens of metres.
    # (Synthetic. Only the relief shading above comes from data.)
    rng = np.random.default_rng(seed)
    px = 1.0 / (2976.0 / out_px)  # pixels per metre, roughly
    grain = np.zeros(v.shape, np.float32)
    for metres, weight in ((0.6, 0.30), (2.5, 0.30), (9.0, 0.25), (35.0, 0.15)):
        layer = ndimage.gaussian_filter(rng.standard_normal(v.shape, dtype=np.float32), max(metres * px / 2, 0.6))
        grain += weight * layer / max(float(layer.std()), 1e-6)
    v = np.clip(v + 0.085 * grain, 0, 1)

    # dark basalt -> dusty rose-brown -> pale dust. Tones picked to sit close to the
    # orbital imagery in Cesium's Mars tileset, so the edge of the site is less stark.
    stops = np.array([0.0, 0.45, 0.8, 1.0])
    colors = np.array([[50, 36, 32], [133, 100, 88], [181, 144, 126], [216, 188, 170]], np.float64)
    rgb = np.stack([np.interp(v, stops, colors[:, k]) for k in range(3)], axis=-1)
    return rgb.round().astype(np.uint8)


def write_glb(path, positions, uvs, indices, jpeg, center):
    """Minimal binary glTF: one unlit textured mesh, positions relative to `center` (ECEF).

    Node layout copies Cesium's own Mars tiles: an outer node that turns ECEF
    (z-up) into glTF's y-up, and an inner node translated to the tile centre.
    """
    def pad(b, fill=b"\x00"):
        return b + fill * (-len(b) % 4)

    chunks = [pad(positions.astype("<f4").tobytes()), pad(uvs.astype("<f4").tobytes()),
              pad(indices.astype("<u2").tobytes()), pad(jpeg)]
    offsets = np.concatenate([[0], np.cumsum([len(c) for c in chunks])])
    lengths = [positions.size * 4, uvs.size * 4, indices.size * 2, len(jpeg)]
    gltf = {
        "asset": {"version": "2.0", "generator": "mars-map terrain_mesh.py"},
        "extensionsUsed": ["KHR_materials_unlit"],
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [
            {"children": [1], "matrix": [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]},
            {"mesh": 0, "translation": [float(v) for v in center]},
        ],
        "meshes": [{"primitives": [{
            "attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "indices": 2, "material": 0, "mode": 4}]}],
        "materials": [{
            "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0, "roughnessFactor": 1},
            "doubleSided": True,
            "extensions": {"KHR_materials_unlit": {}},
        }],
        "textures": [{"source": 0, "sampler": 0}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "images": [{"bufferView": 3, "mimeType": "image/jpeg"}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(positions), "type": "VEC3",
             "min": positions.min(axis=0).astype(float).tolist(), "max": positions.max(axis=0).astype(float).tolist()},
            {"bufferView": 1, "componentType": 5126, "count": len(uvs), "type": "VEC2"},
            {"bufferView": 2, "componentType": 5123, "count": int(indices.size), "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": int(offsets[0]), "byteLength": lengths[0], "target": 34962},
            {"buffer": 0, "byteOffset": int(offsets[1]), "byteLength": lengths[1], "target": 34962},
            {"buffer": 0, "byteOffset": int(offsets[2]), "byteLength": lengths[2], "target": 34963},
            {"buffer": 0, "byteOffset": int(offsets[3]), "byteLength": lengths[3]},
        ],
        "buffers": [{"byteLength": int(offsets[-1])}],
    }
    js = pad(json.dumps(gltf, separators=(",", ":")).encode(), b" ")
    binary = b"".join(chunks)
    total = 12 + 8 + len(js) + 8 + len(binary)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(js), b"JSON") + js)
        f.write(struct.pack("<I4s", len(binary), b"BIN\x00") + binary)
    return total


def grid_indices(rows, cols):
    """Two counter-clockwise (seen from above) triangles per grid quad."""
    r, c = np.meshgrid(np.arange(rows - 1), np.arange(cols - 1), indexing="ij")
    nw = (r * cols + c).ravel()
    ne, sw, se = nw + 1, nw + cols, nw + cols + 1
    return np.stack([nw, sw, se, nw, se, ne], axis=1).ravel()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--site", default="jezero")
    p.add_argument("--out", default=None, help="default: data/terrain/{site}")
    args = p.parse_args()

    with rasterio.open(PROCESSED / f"{args.site}_dem.tif") as src:
        dem = src.read(1).astype(np.float64)
        transform, crs = src.transform, CRS.from_wkt(src.crs.to_wkt())
    rows, cols = dem.shape
    cell = transform.a
    cells = rows - 1  # mesh spans cell centres 0..rows-1
    finest_tiles = LEVELS[-1][0]
    if rows != cols or cells % (finest_tiles * LEVELS[0][1]) not in (0,):
        # 1500 cells -> use 1496 so every level's step divides the tile size; trim the last rows/cols
        usable = (cells // (finest_tiles * LEVELS[0][1])) * finest_tiles * LEVELS[0][1]
        dem = dem[: usable + 1, : usable + 1]
        rows = cols = usable + 1
        cells = usable

    # lon/lat of every cell centre (these values are used as-is in Cesium)
    to_geo = Transformer.from_crs(crs, crs.geodetic_crs, always_xy=True)
    xs = transform.c + (np.arange(cols) + 0.5) * transform.a
    ys = transform.f + (np.arange(rows) + 0.5) * transform.e
    lon, _ = to_geo.transform(xs, np.full(cols, ys[rows // 2]))
    _, lat = to_geo.transform(np.full(rows, xs[cols // 2]), ys)

    # surface image for the whole (trimmed) site
    shade_path = PROCESSED / f"{args.site}_dem_1m.tif"
    if shade_path.exists():
        with rasterio.open(shade_path) as src:
            fine = src.read(1).astype(np.float64)
            fcell = src.transform.a
        # same extent as the trimmed geometry grid (cell centres 0..cells of the 2 m grid)
        k = int(round(cell / fcell))
        fine = fine[: cells * k + k, : cells * k + k]
    else:
        fine, fcell = dem, cell
    extent_m = cells * cell
    surf_px = int(round(extent_m / SURFACE_M_PER_PX))
    print(f"shading {fine.shape[1]} x {fine.shape[0]} DEM at {fcell:g} m -> {surf_px} px surface image ...")
    # The fine grid covers cell *areas*; the mesh spans cell *centres*: crop half a 2 m cell each side.
    half = int(round(cell / 2 / fcell))
    fine = fine[half: half + int(round(extent_m / fcell)) + 1, half: half + int(round(extent_m / fcell)) + 1]
    surface = surface_image(fine, fcell, surf_px)

    out = Path(args.out) if args.out else REPO / "data" / "terrain" / args.site
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    def build_tile(level, ti, tj):
        n_tiles, step, error = LEVELS[level]
        size = cells // n_tiles
        r0, c0 = ti * size, tj * size
        rr = np.arange(r0, r0 + size + 1, step)
        cc = np.arange(c0, c0 + size + 1, step)
        z = dem[np.ix_(rr, cc)]
        # skirt: repeat the edge ring, lowered, so the grid can be triangulated as one sheet
        zp = np.pad(z, 1, mode="edge")
        zp[0, :] -= SKIRT_M
        zp[-1, :] -= SKIRT_M
        zp[:, 0] -= SKIRT_M
        zp[:, -1] -= SKIRT_M
        zp[0, 0] += SKIRT_M
        zp[0, -1] += SKIRT_M
        zp[-1, 0] += SKIRT_M
        zp[-1, -1] += SKIRT_M  # corners were lowered twice
        latp = np.pad(lat[rr], 1, mode="edge")
        lonp = np.pad(lon[cc], 1, mode="edge")
        lo, la = np.meshgrid(lonp, latp)
        ecef = to_ecef(lo, la, zp).reshape(-1, 3)
        center = to_ecef(lon[c0 + size // 2], lat[r0 + size // 2], float(z.mean()))
        u = np.pad((cc - c0) / size, 1, mode="edge")
        v = np.pad((rr - r0) / size, 1, mode="edge")
        uu, vv = np.meshgrid(u, v)
        uvs = np.stack([uu, vv], axis=-1).reshape(-1, 2)
        idx = grid_indices(len(latp), len(lonp))
        assert len(ecef) <= 65535, "tile too dense for 16-bit indices"

        px0 = int(round(c0 * cell / SURFACE_M_PER_PX))
        py0 = int(round(r0 * cell / SURFACE_M_PER_PX))
        pn = int(round(size * cell / SURFACE_M_PER_PX))
        img = Image.fromarray(surface[py0: py0 + pn, px0: px0 + pn])
        if pn != TEXTURE_PX:
            img = img.resize((TEXTURE_PX, TEXTURE_PX), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=86)

        name = f"L{level}_{ti}_{tj}.glb"
        nbytes = write_glb(out / name, ecef - center, uvs, idx, buf.getvalue(), center)

        # oriented bounding box: east / north / up half-axes at the tile centre
        lam, phi = np.radians(lon[c0 + size // 2]), np.radians(lat[r0 + size // 2])
        east = np.array([-np.sin(lam), np.cos(lam), 0.0])
        up = np.array([np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi)])
        north = np.cross(up, east)
        rel = ecef - center
        box = list(center)
        for axis in (east, north, up):
            d = rel @ axis
            mid, halfw = (d.max() + d.min()) / 2, (d.max() - d.min()) / 2 + 1.0
            box[0:3] = (np.array(box[0:3]) + axis * mid).tolist()
            box += (axis * halfw).tolist()
        tile = {"boundingVolume": {"box": box}, "geometricError": error, "content": {"uri": name}}
        return tile, nbytes, len(ecef)

    total_bytes, counts = 0, []
    tiles_by_level = []
    for level, (n_tiles, step, _) in enumerate(LEVELS):
        level_tiles = {}
        for ti in range(n_tiles):
            for tj in range(n_tiles):
                tile, nbytes, nverts = build_tile(level, ti, tj)
                level_tiles[(ti, tj)] = tile
                total_bytes += nbytes
        counts.append((level, n_tiles * n_tiles, step * cell, nverts))
        tiles_by_level.append(level_tiles)
    # link children: each tile's children are the next level's tiles inside it
    for level in range(len(LEVELS) - 1):
        ratio = LEVELS[level + 1][0] // LEVELS[level][0]
        for (ti, tj), tile in tiles_by_level[level].items():
            tile["children"] = [tiles_by_level[level + 1][(ti * ratio + a, tj * ratio + b)]
                                for a in range(ratio) for b in range(ratio)]
    root = tiles_by_level[0][(0, 0)]
    root["refine"] = "REPLACE"

    west, east_, south, north_ = float(lon[0]), float(lon[-1]), float(lat[-1]), float(lat[0])
    tileset = {
        "asset": {"version": "1.1", "generator": "mars-map terrain_mesh.py"},
        # Tileset-level error: Cesium skips the whole tileset when this is too small to
        # matter on screen. 40 m made the site vanish beyond ~1.7 km; this keeps it
        # drawn from tens of km (the frontend decides when to show it at all).
        "geometricError": 2000.0,
        "root": root,
        # read by the frontend (not part of the 3D Tiles spec, which allows extras)
        "extras": {
            "site": args.site,
            "bounds": [round(west, 7), round(south, 7), round(east_, 7), round(north_, 7)],
            "height_datum": "DEM (same as CONTRACT.md heights)",
            "min_height": float(dem.min()), "max_height": float(dem.max()),
            # [lon, lat, DEM height] on a 6 x 6 grid: the frontend samples Cesium's own
            # terrain at these points to work out the vertical shift between the two.
            "control_points": [
                [round(float(lon[c]), 7), round(float(lat[r]), 7), round(float(dem[r, c]), 2)]
                for r in np.linspace(cells * 0.1, cells * 0.9, 6).astype(int)
                for c in np.linspace(cells * 0.1, cells * 0.9, 6).astype(int)
            ],
        },
    }
    # The same heights as a plain grid (row 0 = north edge, uint16 little-endian), so the
    # frontend can look a height up by arithmetic instead of sampling the rendered scene.
    h_min, h_scale = float(np.floor(dem.min())), 0.01
    quantized = np.round((dem - h_min) / h_scale)
    assert quantized.max() <= 65535, "height range too large for 16 bits at 1 cm"
    (out / "heights.bin").write_bytes(quantized.astype("<u2").tobytes())
    tileset["extras"]["heightmap"] = {
        "uri": "heights.bin", "rows": int(rows), "cols": int(cols),
        "bounds": tileset["extras"]["bounds"], "min": h_min, "scale": h_scale,
    }
    (out / "tileset.json").write_text(json.dumps(tileset))

    for level, n, spacing, nverts in counts:
        print(f"L{level}: {n:2d} tiles, {spacing:g} m mesh, {nverts} vertices per tile")
    print(f"bounds:  {tileset['extras']['bounds']}  ({extent_m:g} m square)")
    print(f"wrote:   {out}  ({total_bytes / 1e6:.0f} MB in {sum(c[1] for c in counts)} tiles)")


if __name__ == "__main__":
    main()
