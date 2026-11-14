import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import { CESIUM_ION_TOKEN, USE_MOCK, API_BASE } from './config.js';
import { getLandmarks, getSites } from './api.js';
import { flyToMapView, initCoordinateReadout } from './camera.js';
import { initDirections } from './directions.js';
import * as Cesium from 'cesium';
import { createGlobe, flyToSite } from './globe.js';
import { initGroundMode } from './ground.js';
import { initLayers } from './layers.js';
import { initSearch } from './search.js';

const statusEl = document.getElementById('status');
function showStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
  statusEl.hidden = !msg;
}
const showError = (msg) => showStatus(msg, true);

const { viewer, tilesetReady } = createGlobe('globe');
window.viewer = viewer; // handy for debugging in the console

if (!CESIUM_ION_TOKEN) {
  showError('No Cesium ion token: set VITE_CESIUM_ION_TOKEN in the repo-root .env and restart npm run dev.');
}
tilesetReady.catch((err) => {
  console.error(err);
  showError(`Could not load the Mars tileset: ${err.message ?? err}`);
});

const sitesReady = getSites().catch((err) => {
  console.error(err);
  showError(`Could not load sites: ${err.message}`);
  return [];
});

// Step 1: a "fly to" button per site
sitesReady.then((sites) => {
  const sitesEl = document.getElementById('sites');
  for (const site of sites) {
    const btn = document.createElement('button');
    btn.textContent = site.name;
    btn.title = `Fly to ${site.name}`;
    btn.addEventListener('click', () => {
      ground?.leave();
      flyToSite(viewer, site);
    });
    sitesEl.appendChild(btn);
  }
});

// Step 2: search
Promise.all([getLandmarks(), sitesReady]).then(([landmarks, sites]) =>
  initSearch(viewer, landmarks, sites, () => ground?.leave()));

// Step 3: layers (need the tileset to drape on) and map view
Promise.all([tilesetReady, sitesReady])
  .then(([tileset, sites]) => initLayers(viewer, tileset, sites, showError))
  .catch(() => {}); // tileset failure is already reported above
document.getElementById('map-view').addEventListener('click', () => {
  if (ground?.isActive()) {
    // From the ground: rise straight up to a map view of where we stand.
    ground.leave();
    const c = viewer.camera.positionCartographic;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height + 1500),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      duration: 2,
    });
  } else {
    flyToMapView(viewer);
  }
});

// Step 4: ground mode (outlines need the tileset loaded to sit on the terrain)
let ground = null;
Promise.all([tilesetReady, sitesReady])
  .then(([, sites]) => {
    ground = initGroundMode(viewer, sites, {
      hud: document.getElementById('ground-hud'),
      minimapCanvas: document.getElementById('minimap'),
      exitButton: document.getElementById('exit-ground'),
      // while Directions is on, clicks pick route points instead of descending
      isClickCaptured: () => directions?.isActive() ?? false,
    });
  })
  .catch(() => {});

// Step 5: directions
let directions = null;
let hintTimer = null;
sitesReady.then((sites) => {
  directions = initDirections(viewer, sites, {
    button: document.getElementById('directions'),
    card: document.getElementById('route-card'),
    hint: (msg) => {
      clearTimeout(hintTimer);
      showStatus(msg);
    },
    error: (msg) => {
      showError(msg);
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => showStatus(''), 6000);
    },
  });
});

// Cursor lon/lat readout
initCoordinateReadout(viewer, document.getElementById('coords'));

console.info(`Mars Map: data source = ${USE_MOCK ? 'mock files' : API_BASE}`);
