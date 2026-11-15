# data/scripts

One-off processing scripts go here (e.g. downloading DEMs, computing slope,
cutting danger tiles into `data/tiles/`).

Large inputs and outputs (`data/raw/`, `data/processed/`, `*.tif`, `*.npy`)
are never committed, so every derived file must be reproducible by running
the scripts in this folder.

## Pipeline (run from the repo root, with the backend venv's Python)

```
python data/scripts/crop_dem.py --src PATH/TO/DEM.tif --site jezero --lon 77.4509 --lat 18.4446
python data/scripts/slope.py --site jezero
python data/scripts/danger_tiles.py --site jezero
python data/scripts/waypoints.py --site jezero      # needs internet (NASA feeds)

# optional: high-resolution 3D ground for ground mode (83 MB, ignored by git)
python data/scripts/crop_dem.py --src PATH/TO/DEM.tif --site jezero --res 1 --out data/processed/jezero_dem_1m.tif
python data/scripts/terrain_mesh.py --site jezero
```

| Step | Writes |
|---|---|
| `crop_dem.py` | `data/processed/{site}_dem.tif`: 3 x 3 km at 2 m, local equirectangular (true metres) |
| `slope.py` | `data/processed/{site}_slope.npy`, `{site}_cost.npy`, `{site}_grid.json` (transform + CRS) |
| `danger_tiles.py` | `data/tiles/{site}/danger/{z}/{x}/{y}.png` + `tiles.json` |
| `terrain_mesh.py` | `data/terrain/{site}/tileset.json` + `.glb` tiles: the DEM as a 3D Tiles terrain model, 2 m mesh, shaded-relief colour |
| `waypoints.py` | `data/waypoints/{site}.json`: rover stops inside the site bbox, each with 3-6 photos (small, committed) |

Source DEM for Jezero:
`JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif`
(1 m HiRISE DTM mosaic, Mars 2000 sphere). Download URL: TODO.

## Coordinates

All outputs use the contract's convention: planetocentric latitude,
east-positive longitude, degrees. These values go into Cesium **unchanged**
(no conversion to geodetic latitude on `Ellipsoid.MARS`).

Checked against the Cesium Mars tileset itself (ion asset 3644333): for 275
terrain-mesh vertices around Jezero, vertex height vs this DEM sampled at the
vertex's Cesium lon/lat has correlation 1.000 (std 5 m). Converting
planetocentric -> geodetic first gives 0.615 (std 190 m, i.e. a ~12 km shift).

Heights are different: Cesium's terrain height above its ellipsoid is about
**74 m lower** than the DEM/contract height at Jezero. In the frontend, clamp
lines and markers to the tileset instead of using contract heights as
absolute Cesium heights.
