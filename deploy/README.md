# Deploying Mars Map

- **Frontend**: static Vite build on Cloudflare Pages (free).
- **Backend + data**: one small VPS (e.g. Hetzner CX22, 4 GB RAM) running
  `docker-compose.yml` (FastAPI container + Caddy for automatic HTTPS).

The same `Dockerfile` image also runs on Azure Container Apps / AWS
Fargate later. See "Moving to Azure / AWS" below.

## 1. Server (VPS)

1. Create an Ubuntu 24.04 VPS, point a DNS name at it (an `A` record, or a free
   DuckDNS subdomain), and open ports 80 and 443.
2. Install Docker: `curl -fsSL https://get.docker.com | sh`
3. Clone the repo and create the server env file (`deploy/.env`):

   ```
   git clone https://github.com/gkm2004/spaceapps.git && cd spaceapps/deploy
   cp .env.example .env     # then edit API_DOMAIN and ALLOWED_ORIGINS
   ```

   `ALLOWED_ORIGINS` is a comma-separated list of frontend origins
   (add your custom domain too). Leave it unset only for local dev (`*`).

4. Upload the data from your machine. It is gitignored, so it is not in the
   clone. `data/raw` is not needed at runtime (139 MB of source files):

   ```
   rsync -avz --progress --exclude raw --exclude scripts --exclude __pycache__ \
     data/ user@SERVER:~/spaceapps/data/
   ```

   On Windows without rsync, use WSL, or `scp -r` for `data/processed`,
   `data/terrain`, `data/tiles` and `data/waypoints`.

5. Start it (from `deploy/`):

   ```
   docker compose up -d --build
   curl https://api.example.com/health      # {"status":"ok","sites":["gale","jezero"]}
   ```

   `/health` returns 503 if no grids were found (data not uploaded / wrong
   path), so it catches a missing volume instead of silently serving mocks.

Update later: `git pull && docker compose up -d --build`. Data changes are
just a new rsync (the volume is mounted read-only; restart `api` to reload
grids: `docker compose restart api`).

## 2. Frontend (Cloudflare Pages)

Create a Pages project from the GitHub repo:

| Setting | Value |
|---|---|
| Root directory | `frontend` |
| Build command | `npm install && npm run build` |
| Output directory | `dist` |

Environment variables (Production). These are baked into the JS at build
time, so redeploy after changing them:

```
NODE_VERSION=22
VITE_USE_MOCK=false
VITE_API_BASE=https://api.example.com
VITE_CESIUM_ION_TOKEN=<your token>
```

`VITE_API_BASE` must be an absolute `https://` URL; an empty value falls back
to `http://localhost:8000`, and `http://` is blocked as mixed content.

The Cesium ion token ships in the public JS. In the ion dashboard, restrict it
to your Pages/custom domain and the assets you use.

Netlify or Vercel work the same way with the same settings; Pages has no
bandwidth cap.

## Local test of the container

```
docker build -f deploy/Dockerfile -t marsmap-api .
docker run --rm -p 8000:8000 -v "$PWD/data:/data:ro" marsmap-api
curl localhost:8000/health
```

## Moving to Azure / AWS

The image is stateless apart from the `/data` mount and needs about 0.5 to 1 GB
of RAM per replica (routing grids are held in memory); routing is CPU-bound.

- Push the image to ACR / ECR.
- Run on Azure Container Apps or AWS Fargate (App Runner), port 8000,
  health probe `GET /health`, env `ALLOWED_ORIGINS`.
- Data: either mount Azure Files / EFS at `/data`, or put `data/processed`
  and `data/waypoints` in the image (~260 MB) and serve `terrain/` and
  `tiles/` from Blob Storage / S3 + CDN. For the latter, the frontend would
  need a separate base URL for those two paths (currently both use
  `VITE_API_BASE`).
- Put it behind the platform's HTTPS ingress and drop Caddy.

## Cost notes

Hetzner CX22 is about 4 to 5 EUR/mo with ~20 TB traffic included, which covers the
~700 MB of terrain. Always-on Azure/AWS containers are roughly $15 to 40/mo, so use
them only for compute tests.
