# Mars Map

**A street-level map for the first people to walk on Mars.**

Built for the [2026 NASA Space Apps Challenge](https://www.spaceappschallenge.org/): *Interplanetary Survival Guide: Martian Map*.

<!-- TODO: add a hero screenshot or GIF here, e.g. ![Mars Map](docs/hero.png) -->
<!-- TODO: Live demo: https://... · Demo video: https://... · Team: ... -->

---

## Sol 1, Jezero Crater

It is the morning of Sol 1. Two astronauts stand at the edge of Jezero Crater,
where a river once drained into a lake. Their target is a delta deposit two
kilometres away, the kind of rock that could hold signs of ancient life.
Each of them carries a pressurized suit and a load of tools, has a fixed oxygen
budget, and gets no second chance at a turned ankle.

On Earth they would open a map app, type a destination and get a route with a
distance, a time and a warning about the hill. Mars doesn't have that.
Mars Trek and the USGS geologic maps are excellent, but they are built for
regional and global views. Nobody has drawn the map an astronaut needs
for one walk: where the safe slopes are, how long it takes, how much climbing
it involves, and what it looks like when you get there.

**Mars Map is that map.** It combines a 3D globe of the planet, 2-metre
terrain from orbital stereo imagery, a slope-hazard layer, real routes on foot
or by rover, and photos that NASA's rovers took at the exact stops along the way,
laid out by the direction they face.

---

## What it does

| Feature | What the astronaut gets |
|---|---|
| **3D globe** | The whole of Mars in CesiumJS, with fuzzy search over landmarks (Olympus Mons, Valles Marineris, Gale, Jezero and more). |
| **Hyperlocal terrain** | Close to a landing site, Cesium's global terrain (one point every ~73 m) is replaced by a **2 m mesh built from HiRISE stereo data**: 36× finer in each direction. |
| **Slope danger layer** | A green / yellow / red overlay draped on the terrain: < 10°, 10–20°, > 20°. You can see the hazards before you plan anything. |
| **Navigation (A → B)** | Click two points to get a least-cost route over the real terrain, with **distance, ascent, estimated time, steepest slope and an elevation profile**. It goes around cliffs and steep ground, not over them. |
| **Three ways to travel** | *On foot* (0.8 m/s, ≤ 25°), *robotic rover* (Perseverance-like, 0.042 m/s, ≤ 30°) and *pressurized crewed rover* (~10 km/h, ≤ 20°). Speed and slope limit can be edited per route. |
| **Ground view** | Walk the surface at 1.7 m eye height with WASD, a minimap and a heading readout. Start at your route's start point and see the terrain the way you will in the suit. |
| **Rover stops and photos** | Every Perseverance (Jezero) and Curiosity (Gale) waypoint inside the site, each with 3–6 Navcam / Mastcam images. |
| **Mars view** | A street-view-style viewer. The Navcam frames taken at a stop are placed by **compass azimuth and elevation**, so you can pan around the actual horizon and step from one stop to the next. |

### Sites

| Site | Rover | Area | Grid | Rover stops | Photos | Mars-view frames |
|---|---|---|---|---|---|---|
| Jezero Crater | Perseverance (sols 13–716) | 6 × 6 km | 3000 × 3000 at 2 m | 259 | 1,485 | 5,906 |
| Gale Crater | Curiosity (sols 3–641) | 6 × 6 km | 3000 × 3000 at 2 m | 183 | 1,045 | 3,042 |

**Why only two sites?** Jezero and Gale are a starting point, not a limit. Each site
means cropping a multi-gigabyte source DEM, computing slope and cost grids, cutting
hazard tiles and building a 3D mesh, and the routing grids stay in server memory.
Within a hackathon's time and compute budget we picked the two places with the most
rover ground truth. Nothing in the pipeline is specific to them: any location with a
high-resolution DEM, such as a candidate human landing site, can be added with the same
scripts, one DEM and one command per step
([see below](#2-build-the-data-for-real-routes-and-terrain)).

---

## How it answers the challenge

| Challenge objective | How Mars Map handles it |
|---|---|
| A map an astronaut could use on a surface mission | A tablet / habitat-display style web app: plan in orbit view, rehearse in ground view, check the destination in Mars view. |
| Hyperlocal, not regional | 2 m terrain and routing grids over 6 × 6 km sites, against the global/regional focus of existing tools. |
| At least three kinds of data, layered | **Topographic** (HiRISE / multi-source DTMs), **derived geophysical** (slope, hazard and traversal-cost grids), **orbital optical / global terrain** (Cesium Mars 3D Tiles), **surface optical** (rover Navcam and Mastcam images) and **mission position data** (rover traverse waypoints and attitude). |
| Astronaut safety first | Steep ground is impassable for routing, slope hazards are visible on the map, and every route reports its maximum slope and total climb. |
| Mobility in a spacesuit, carrying equipment | Slope-dependent travel cost, a configurable walking slope limit, and separate profiles for rover-assisted traverses. |
| A route that avoids obstacles | Least-cost pathfinding over the full 2 m grid that detours around steep terrain. |
| Point-of-view images so the astronaut knows what to expect | Mars view, built from real rover frames oriented using the rover's attitude. |
| Rovers to carry crew and tools | Robotic and pressurized-rover travel modes on the same terrain model. |
| Science objective tied to location | Jezero (delta and lake deposits, Mars 2020 sample caching) and Gale (Mount Sharp layered sediments, studied by Curiosity), both with extensive rover ground truth. |

---

## What's new here

1. **Turn-by-turn routing for Mars at walking scale.** Existing Mars tools let you
   *look* at layers. Mars Map *routes* across them: physics-based travel time,
   ascent and an elevation profile on a 2 m grid, for walkers and two kinds of rover.
2. **One terrain model for every mode.** The same DEM feeds the hazard tiles, the
   route search, the 3D mesh you walk on and the height lookups for markers.
   The danger colour you see is the slope the router avoids.
3. **Street view on Mars from real rover data.** Each Navcam frame's direction is
   computed from its camera axis rotated by the rover's attitude quaternion into
   local north/east/down, so the photos sit where they belong on the horizon.
4. **Seamless global-to-local terrain.** Near a site, the 73 m global terrain is cut away
   and replaced with a 2 m 3D Tiles model, levelled to the surrounding ground using
   a measured median height offset.
5. **Coordinate conventions checked, not assumed.** We tested how Cesium places its Mars
   tileset against the DEM and measured the result ([Validity](#validity-of-methods)).
6. **Reproducible for any site.** Only scripts are committed, so every derived file
   (grids, tiles, meshes, waypoints) can be rebuilt from public NASA / USGS sources.

## Who it helps

- **Crews**, on the surface or in the habitat: a single place to answer
  "can we walk there, how long will it take, and what will we see?"
- **Mission planners**, who can compare foot traverses with rover-assisted ones
  on the same terrain, with numbers instead of guesses.
- **Scientists**, who can tie a target to the rover images that were taken there.
- **Students and the public**: anyone can stand in Jezero and look around
  through Perseverance's cameras.

---

## Data sources

All data is public. Nothing derived is committed; [data/scripts/](data/scripts/) rebuilds it.

| Data | Type | Source | Used for |
|---|---|---|---|
| **Mars 2020 TRN HiRISE DTM Mosaic** (`JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m…`) | Topography, 1 m | USGS Astrogeology: Fergason, Galuszka, Hare, Mayer & Redding, [doi:10.5066/P9REJ9JN](https://doi.org/10.5066/P9REJ9JN) · [product page](https://astrogeology.usgs.gov/search/map/mars_2020_terrain_relative_navigation_hirise_dtm_mosaic) | Jezero slope, routing, 3D mesh. This is the same terrain model used to map landing hazards for Perseverance's Terrain Relative Navigation. |
| **MSL Gale Merged DEM 1m, v3** (`MSL_Gale_DEM_Mosaic_1m_v3`) | Topography, 1 m | USGS Astrogeology: Parker & Calef · [product page](https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_dem_1m) | Gale slope, routing, 3D mesh. HiRISE DEMs, gap-filled with CTX, HRSC and MOLA, all tied to MOLA. |
| **Cesium Mars** 3D Tiles (ion asset 3644333) | Global terrain and imagery | [Cesium ion](https://cesium.com/platform/cesium-ion/) | The globe and terrain outside the site boxes |
| **Mars 2020 & MSL waypoints** | Rover traverse positions | NASA mission maps (MMGIS): [M20](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json), [MSL](https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json) | Rover stop markers and sols |
| **Rover raw images** | Surface optical, with camera pointing and rover attitude | [NASA raw-image feed](https://mars.nasa.gov/rss/api/?feed=raw_images&feedtype=json&ver=1.2) | Photo panels and Mars view (Perseverance Navcam / Mastcam-Z, Curiosity Navcam / Mastcam) |
| Landmark list | Named features | Curated, [frontend/mock/landmarks.json](frontend/mock/landmarks.json) | Search |

Raw NASA images are linked, not re-hosted. Rover photos are courtesy of NASA/JPL-Caltech
(Mastcam-Z also ASU; Mastcam also MSSS).

---

## Methods

```
 Source DEM (1 m, 1.8–3.6 GB)
   │  crop_dem.py     6 × 6 km window, resampled to 2 m, local equirectangular projection
   ▼
 {site}_dem.tif
   │  slope.py        Horn 3×3 slope  →  Tobler-style cost, > 25° = impassable
   ▼
 {site}_slope.npy, {site}_cost.npy ─────┬──► danger_tiles.py   →  /tiles/{site}/danger/{z}/{x}/{y}.png
                                        └──► backend routing   →  /api/route
 {site}_dem.tif ──► terrain_mesh.py     →  /terrain/{site}/tileset.json (3 LOD levels, 2 m at finest)
 NASA feeds    ──► waypoints.py         →  /api/waypoints (stops, photos, oriented POV frames)
```

### 1. Terrain preparation
The source mosaics use a global equirectangular projection that is only true-scale at
the equator. At Jezero (18.4° N) that makes east-west metres about 5% short, which would
skew every slope and distance. [crop_dem.py](data/scripts/crop_dem.py) reprojects each
crop onto a **local equirectangular projection whose standard parallel is the site's
latitude**, so every cell is a true 2 × 2 m on the ground. It reads only the window it
needs from the multi-gigabyte source.

### 2. Slope and hazard
[slope.py](data/scripts/slope.py) computes slope with **Horn's 3×3 method**, the
same algorithm GDAL and ArcGIS use. [danger_tiles.py](data/scripts/danger_tiles.py)
colours it into green (< 10°), yellow (10–20°) and red (> 20°) PNG tiles in Cesium's
native geographic tiling scheme. Planetary data is already equirectangular, and Web
Mercator is an Earth convention that would distort it.

### 3. Traversal cost and routing
Travel cost per metre follows **Tobler's hiking function**, made direction-independent:

```
cost(slope) = exp(3.5 · tan(slope))     10° → 1.9×   20° → 3.6×   25° → 5.1×   > 25° → impassable
```

Here 1.0 is flat ground, so route cost × flat speed = travel time.
[routing.py](backend/routing.py) runs a least-cost search (`skimage.graph.route_through_array`,
8-connected, diagonal steps weighted by √2). It returns:

- **distance**: true 3D length along the terrain,
- **ascent**: summed on a 10 m resampled profile, so 2 m DEM noise doesn't inflate it,
- **time**: the cost-weighted distance divided by the mode's flat-ground speed,
- **max slope** along the path, and the **elevation profile**.

For speed, the search first runs in a box around A and B. The box is widened
(up to the whole grid) only if no route fits, so long detours are still found.
Clicks that land on impassable ground snap to the nearest walkable cell within 30 m.
For vehicle modes, the cost grid is rebuilt for the vehicle's slope limit inside that box only.

### 4. High-resolution 3D terrain
[terrain_mesh.py](data/scripts/terrain_mesh.py) turns the DEM into a 3D Tiles tileset with
three levels of detail (16 m → 8 m → 2 m) and skirts to hide seams. It is coloured with a
Mars-tinted hillshade, and comes with a compact heightmap so the frontend can find a ground
height in microseconds instead of ray-casting the mesh.

### 5. Rover stops and Mars view
[waypoints.py](data/scripts/waypoints.py) keeps the rover waypoints inside each site and
matches images by sol. For Perseverance it also matches by the rover's site/drive counters,
so images come from the exact stop. For each left-Navcam frame, the viewing direction is
the camera axis rotated by the rover's attitude quaternion into local north/east/down, and the
field of view comes from how much of the sensor the frame covers. Sky, Sun and deck shots are
filtered out.

---

## Validity of methods

What we checked, and what we assumed:

**Verified**

- **Coordinate convention, measured against Cesium.** We sampled 275 vertices of
  Cesium's Mars terrain around Jezero and compared them with our DEM. Using
  planetocentric latitudes unchanged gives a **correlation of 1.000 (std 5 m)**.
  Converting to geodetic first gives 0.615 (std 190 m, a ~12 km shift). So all data
  uses planetocentric latitude and east-positive longitude ([CONTRACT.md](CONTRACT.md)).
- **Vertical datum offset, measured.** Cesium's terrain sits about **74 m below**
  the DEM at Jezero. The frontend measures the median offset at control points per site
  and uses −74 m only as a fallback.
- **True-scale grid.** The local projection removes the ~5% east-west scale error
  described above.
- **Source accuracy.** The Jezero mosaic was aligned to CTX for landing-hazard mapping,
  with a reported vertical offset of about 0.4 m from the CTX reference.
- **Routing correctness: 33 automated tests** ([backend/tests/](backend/tests/test_routing.py)),
  all passing. They cover: straight routes on flat ground; stats against known
  answers; never crossing impassable cells across random terrains; finding gaps in walls;
  taking cheaper detours; slope limits opening and closing ridges; windowed search
  matching full-grid search; and real Jezero routes matching the API contract and
  respecting each vehicle's limits.

**Assumptions, stated openly**

- **Tobler's function was fitted to Earth hikers.** Mars gravity (0.38 g) helps,
  while suit mass, stiff joints and limited visibility hurt. We kept Earth's
  curve as a conservative, well-known baseline. `k = 3.5` and the slope limit are single
  parameters, so they can be refitted to suited-mobility data.
- **The 25° walking limit and the < 10° / 10–20° / > 20° hazard classes** are conservative
  planning thresholds we chose, not NASA standards.
- **Vehicle speeds.** The robotic rover uses Perseverance's ~152 m/h flat-ground top
  speed. No Mars pressurized rover has been built, so its 10 km/h and 20° values are
  estimates, labelled as such in the UI.
- **Slope at 2 m** misses boulders smaller than a cell. A ~1 m rock can still be in the way.
- **Local terrain colour is synthetic** (shaded relief). The shapes are real; the colour is not
  an orthophoto.
- **Photos are historical.** They show the site when the rover was there (sols noted), not
  current conditions.

---

## Limitations and roadmap

Not built yet, in rough order of value:

- **Radiation and space weather**: RAD (Curiosity) dose-rate data and solar-event alerts
  as an EVA "go / no-go" layer.
- **Atmosphere and dust**: MEDA / REMS temperature, pressure, wind and dust opacity
  for planning the time of day.
- **Thermal inertia and spectral layers**: THEMIS and CRISM, to show loose sand against
  bedrock and to mark science targets such as hydrated minerals.
- **HiRISE orthophoto texture** (25 cm) instead of synthetic shading.
- **Rock-abundance hazard** from HiRISE rock counts, below the DEM's resolution.
- **Consumables-aware routing**: oxygen and suit-power budgets, return-to-habitat
  margins and multi-stop science traverses.
- **Helmet HUD and offline tablet** builds.

---

## Tech stack

| Part | Tools |
|---|---|
| Frontend | Vite, plain JavaScript, [CesiumJS](https://cesium.com/platform/cesiumjs/) 1.147 |
| Backend | Python, FastAPI, NumPy, SciPy, scikit-image, rasterio, pyproj |
| Data | GDAL-based pipeline in [data/scripts/](data/scripts/), 3D Tiles / glTF output |
| Deploy | Docker; Cloudflare Pages + VPS with Caddy, or Azure Container Apps + Static Web Apps |

```
CONTRACT.md      API contract between frontend and backend
frontend/        Vite + JavaScript + CesiumJS
frontend/mock/   example responses that match CONTRACT.md
backend/         FastAPI server and routing
data/scripts/    reproducible data pipeline
deploy/          Dockerfiles, compose, Caddy, deployment guide
```

---

## Getting started

### 1. Configure

```
cp .env.example .env
```

Set `VITE_CESIUM_ION_TOKEN` (free at [cesium.com/ion](https://cesium.com/ion)). The frontend
reads `.env` from the repo root. With `VITE_USE_MOCK` unset, it runs on the mock files in
`frontend/mock/`, so no backend is needed to try it.

### 2. Build the data (for real routes and terrain)

Download the [Jezero](https://astrogeology.usgs.gov/search/map/mars_2020_terrain_relative_navigation_hirise_dtm_mosaic)
and/or [Gale](https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_dem_1m) DEMs, then
run from the repo root with the backend's Python:

```
python data/scripts/crop_dem.py --src PATH/TO/DEM.tif --site jezero --lon 77.4509 --lat 18.4446
python data/scripts/slope.py --site jezero
python data/scripts/danger_tiles.py --site jezero
python data/scripts/waypoints.py --site jezero          # needs internet

# optional: high-resolution 3D ground
python data/scripts/crop_dem.py --src PATH/TO/DEM.tif --site jezero --res 1 --out data/processed/jezero_dem_1m.tif
python data/scripts/terrain_mesh.py --site jezero
```

For Gale use `--site gale --lon 137.4417 --lat -4.5895`. Details are in
[data/scripts/README.md](data/scripts/README.md).

### 3. Run

```
# backend: http://localhost:8000  (interactive docs at /docs)
cd backend && pip install -r requirements-dev.txt && uvicorn main:app --reload

# frontend: http://localhost:5173  (set VITE_USE_MOCK=false to use the backend)
cd frontend && npm install && npm run dev
```

If no processed grids are found, the backend serves the mock data, and `/health`
returns 503 so a deployment with missing data is caught.

### 4. Test

```
cd backend && pytest
```

### Deploy

See [deploy/README.md](deploy/README.md).

---

## API

Full contract in [CONTRACT.md](CONTRACT.md). Coordinates are planetocentric degrees, east-positive; units are metres.

| Endpoint | Returns |
|---|---|
| `GET /api/sites` | Sites with centre and bounding box |
| `GET /api/route?site=&start=LON,LAT&end=LON,LAT[&speed=][&max_slope=]` | GeoJSON LineString with distance, ascent, time, max slope and profile |
| `GET /api/waypoints?site=` | Rover stops with photos and oriented POV frames |
| `GET /tiles/{site}/danger/{z}/{x}/{y}.png` | Slope hazard tiles |
| `GET /terrain/{site}/tileset.json` | High-resolution 3D terrain |

---

## Team

<!-- TODO: names, roles and links -->

Built in two parallel tracks against a shared API contract: **Track A** (frontend, `frontend/`)
and **Track B** (backend and data, `backend/`, `data/`). Changes to [CONTRACT.md](CONTRACT.md)
need both tracks to agree and must update `frontend/mock/` in the same commit. Large data
files are never committed.

## Acknowledgements

NASA/JPL-Caltech for the Mars 2020 and MSL missions, their waypoint maps and the public raw-image feed;
the USGS Astrogeology Science Center for the HiRISE DTM mosaics; the University of Arizona HiRISE team;
Cesium for CesiumJS and the Cesium Mars tileset; and NASA Space Apps.

## License

[Apache 2.0](LICENSE)
