// Data access for everything in CONTRACT.md. Callers never know whether the
// data came from mock files or the real server; USE_MOCK decides.
import { USE_MOCK, API_BASE } from './config.js';

const mocks = {
  sites: () => import('../mock/sites.json'),
  route: () => import('../mock/route.json'),
  waypoints: () => import('../mock/waypoints.json'),
  landmarks: () => import('../mock/landmarks.json'),
};

async function mock(name) {
  return (await mocks[name]()).default;
}

async function get(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) {
    // FastAPI puts the reason in { detail }
    const detail = await res.json().then((b) => b.detail, () => null);
    throw new Error(typeof detail === 'string' ? detail : `GET ${url.pathname} -> HTTP ${res.status}`);
  }
  return res.json();
}

const lonLat = ([lon, lat]) => `${lon},${lat}`;

/** -> [{ id, name, center: [lon, lat], bbox: [west, south, east, north] }] */
export function getSites() {
  return USE_MOCK ? mock('sites') : get('/api/sites');
}

/** start/end are [lon, lat]. -> GeoJSON Feature (LineString of [lon, lat, height]) */
export function getRoute(site, start, end) {
  return USE_MOCK
    ? mock('route')
    : get('/api/route', { site, start: lonLat(start), end: lonLat(end) });
}

/** -> GeoJSON FeatureCollection of Points; properties { sol, images, pov } (see CONTRACT.md) */
export function getWaypoints(site) {
  return USE_MOCK ? mock('waypoints') : get('/api/waypoints', { site });
}

/** Not part of the API contract; always a local file. -> [{ name, lon, lat }] */
export function getLandmarks() {
  return mock('landmarks');
}

/** URL template for the danger imagery layer (CONTRACT.md). */
export function dangerTileUrl(site) {
  return `${API_BASE}/tiles/${site}/danger/{z}/{x}/{y}.png`;
}

/**
 * Bounds and zoom range of a site's danger tiles: { bounds: [w, s, e, n], minzoom, maxzoom }.
 * Static file next to the tiles; there is no mock for tiles, they always come from the backend.
 */
export async function getDangerTileInfo(site) {
  const res = await fetch(`${API_BASE}/tiles/${site}/danger/tiles.json`);
  if (!res.ok) throw new Error(`danger tiles.json -> HTTP ${res.status}`);
  return res.json();
}
