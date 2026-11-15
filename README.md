# Mars Map

A Google Maps-style web app for Mars: a 3D globe, a ground-level view, a
slope "danger" layer and walking-route planning. Hackathon project, built by
two teams working in parallel.

The API between the two halves is defined in [CONTRACT.md](CONTRACT.md).

## Layout

```
CONTRACT.md      API contract between frontend and backend
.env.example     copy to .env and fill in
frontend/        Vite + plain JavaScript + CesiumJS          (Track A)
frontend/mock/   example responses that match CONTRACT.md
backend/         FastAPI server                              (Track B)
data/scripts/    one-off processing scripts (DEMs, slope, tiles)
data/tiles/      generated tiles (not committed)
```

## Setup

Copy the env file at the repo root and fill in your Cesium ion values:

```
cp .env.example .env
```

The frontend reads `.env` from the repo root (Vite `envDir: '..'`).

## Running

Frontend (http://localhost:5173):

```
cd frontend && npm install && npm run dev
```

Backend (http://localhost:8000, docs at http://localhost:8000/docs):

```
cd backend && pip install -r requirements-dev.txt && uvicorn main:app --reload
```

For now, the backend returns the files in `frontend/mock/` from every
endpoint, so the frontend can call a running server from day one.

## Deploying

See [deploy/README.md](deploy/README.md): Cloudflare Pages for the frontend, a small VPS
with `docker compose` (API + Caddy HTTPS) for the backend and data.

## Team rules

- **Track A only edits `frontend/`.**
- **Track B only edits `backend/` and `data/`.**
- **Any change to `CONTRACT.md` needs both teams to agree**, and the mock
  files in `frontend/mock/` must be updated in the same commit.
- Large data files are never committed. `data/scripts/` must be able to
  recreate everything in `data/raw/`, `data/processed/`, `data/tiles/`,
  `data/terrain/` and `data/waypoints/`.

## Branches

- `track-a`: Track A (frontend) work
- `track-b`: Track B (backend + data) work
- Both are merged into `main` at least every few hours.
