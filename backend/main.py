"""Mars Map API.

For now every endpoint returns the matching mock file from frontend/mock/
so the frontend can call a real server. Replace one endpoint at a time with
real logic; responses must keep matching CONTRACT.md.
"""

import json
from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

MOCK_DIR = Path(__file__).resolve().parent.parent / "frontend" / "mock"

app = FastAPI(title="Mars Map API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def load_mock(name: str):
    with open(MOCK_DIR / name, encoding="utf-8") as f:
        return json.load(f)


@app.get("/api/sites")
def get_sites():
    return load_mock("sites.json")


@app.get("/api/route")
def get_route(
    site: str = Query(..., description="Site id from /api/sites"),
    start: str = Query(..., description="LON,LAT"),
    end: str = Query(..., description="LON,LAT"),
):
    return load_mock("route.json")


@app.get("/api/waypoints")
def get_waypoints(site: str = Query(..., description="Site id from /api/sites")):
    return load_mock("waypoints.json")
