# Build context is the repo root: docker build -f deploy/Dockerfile .
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt

COPY backend/ backend/
# mock responses are the fallback when no grids are mounted
COPY frontend/mock/ frontend/mock/

# data/ (processed, terrain, tiles, waypoints) is mounted at /data, not baked in
ENV DATA_DIR=/data
VOLUME /data

RUN useradd --system --no-create-home app
USER app

WORKDIR /app/backend
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/health')"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
