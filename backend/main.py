"""Mars Map API. Responses must match CONTRACT.md.

Grids come from data/processed/ (built by data/scripts/, see its README).
Sites whose grids are missing are skipped; with no grids at all, the API
falls back to the mock files in frontend/mock/ so the frontend still runs.
"""

import json
import logging
import mimetypes
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from routing import RouteError, Site

REPO = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR") or REPO / "data")  # mounted volume in deployments
PROCESSED = DATA / "processed"
TILES = DATA / "tiles"
TERRAIN = DATA / "terrain"  # {site}/tileset.json, written by data/scripts/terrain_mesh.py
WAYPOINTS = DATA / "waypoints"  # {site}.json, written by data/scripts/waypoints.py
MOCK = REPO / "frontend" / "mock"

SITE_NAMES = {"jezero": "Jezero Crater", "gale": "Gale Crater"}

mimetypes.add_type("model/gltf-binary", ".glb")  # terrain tiles

log = logging.getLogger("uvicorn.error")
sites: dict[str, Site] = {}


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    for meta in sorted(PROCESSED.glob("*_grid.json")):
        site_id = meta.name.removesuffix("_grid.json")
        sites[site_id] = Site(site_id, SITE_NAMES.get(site_id, site_id.title()), PROCESSED)
        log.info("Loaded site %s: %s cells, bbox %s", site_id, sites[site_id].cost.shape, sites[site_id].bbox)
    if not sites:
        log.warning("No grids in %s: serving mock data from %s", PROCESSED, MOCK)
    yield
    sites.clear()


app = FastAPI(title="Mars Map API", lifespan=lifespan)
# ALLOWED_ORIGINS: comma-separated frontend origins; default "*" for local dev.
origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"], allow_headers=["*"])
# JSON and terrain tiles compress well (waypoints: 790 KB -> ~10x smaller); images pass through.
app.add_middleware(GZipMiddleware, minimum_size=2000, compresslevel=5)


def parse_lonlat(value: str, name: str):
    try:
        lon, lat = (float(v) for v in value.split(","))
    except ValueError:
        raise HTTPException(400, f"{name} must be LON,LAT (got {value!r})")
    if not (-360 <= lon <= 360 and -90 <= lat <= 90):
        raise HTTPException(400, f"{name} is not a valid lon,lat: {value}")
    return lon, lat


def get_site(site_id: str) -> Site:
    if site_id not in sites:
        raise HTTPException(404, f"Unknown site {site_id!r}. Available: {sorted(sites)}")
    return sites[site_id]


@app.get("/health")
def health():
    # 503 when no real grids loaded, so a deploy missing its data volume is caught
    if not sites:
        raise HTTPException(503, f"No grids found in {PROCESSED}")
    return {"status": "ok", "sites": sorted(sites)}


@app.get("/api/sites")
def get_sites():
    if not sites:
        return load_json(MOCK / "sites.json")
    return [s.as_contract() for s in sites.values()]


@app.get("/api/route")
def get_route(
    site: str = Query(..., description="Site id from /api/sites"),
    start: str = Query(..., description="LON,LAT"),
    end: str = Query(..., description="LON,LAT"),
    speed: float | None = Query(None, gt=0, le=50, description="Flat-ground speed in m/s (default: walking, 0.8)"),
    max_slope: float | None = Query(None, gt=0, le=45, description="Steepest slope allowed, degrees (default: walking, 25)"),
):
    start_ll, end_ll = parse_lonlat(start, "start"), parse_lonlat(end, "end")
    if not sites:
        return load_json(MOCK / "route.json")
    try:
        return get_site(site).route(start_ll, end_ll, speed, max_slope)
    except RouteError as exc:
        raise HTTPException(422, str(exc))


@app.get("/api/waypoints")
def get_waypoints(site: str = Query(..., description="Site id from /api/sites")):
    if not re.fullmatch(r"[a-z0-9_-]+", site):  # site goes into a file path
        raise HTTPException(404, f"Unknown site {site!r}.")
    path = WAYPOINTS / f"{site}.json"
    if path.is_file():
        return load_json(path)
    if sites:
        get_site(site)  # 404 for unknown sites
    return load_json(MOCK / "waypoints.json")  # until waypoints.py has been run


# GET /tiles/{site}/danger/{z}/{x}/{y}.png (written by data/scripts/danger_tiles.py)
if not TILES.is_dir():  # the volume may be mounted read-only
    TILES.mkdir(parents=True, exist_ok=True)
app.mount("/tiles", StaticFiles(directory=TILES), name="tiles")

# GET /terrain/{site}/tileset.json + tiles: high-resolution 3D terrain for ground mode.
# Optional: the frontend falls back to Cesium's global terrain when it is missing.
if not TERRAIN.is_dir():
    TERRAIN.mkdir(parents=True, exist_ok=True)
app.mount("/terrain", StaticFiles(directory=TERRAIN), name="terrain")
