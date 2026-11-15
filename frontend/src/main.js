import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import { CESIUM_ION_TOKEN, USE_MOCK, API_BASE } from './config.js';
import { getLandmarks, getSites } from './api.js';
import { flyToMapView, initCoordinateReadout, screenCenterPosition } from './camera.js';
import { initDirections } from './directions.js';
import * as Cesium from 'cesium';
import { createGlobe, flyToSite } from './globe.js';
import { initGroundMode } from './ground.js';
import { placeOnGround } from './heights.js';
import { initLayers } from './layers.js';
import { initSearch } from './search.js';
import { initLocalTerrain } from './terrain.js';
import { initWaypoints } from './waypoints.js';

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

// High-res local terrain (optional, per site). Things that sit on the ground wait for it.
let localTerrain = null;
const terrainReady = Promise.all([tilesetReady, sitesReady]).then(([mars, sites]) =>
  initLocalTerrain(viewer, mars, sites, {
    onChange: () => ground?.refreshOutlines(),
    // exact heights are in: stop clamping rover markers to the terrain
    onHeights: () => waypoints?.refreshHeights(),
  })
    .catch((err) => {
      console.warn('Local terrain unavailable', err);
      return { tilesets: [] };
    })
    .then((terrain) => {
      localTerrain = terrain;
      return { mars, sites, terrain };
    }));

// Step 3: layers (draped on every terrain tileset) and map view
terrainReady
  .then(({ mars, sites, terrain }) => initLayers(viewer, [mars, ...terrain.tilesets], sites, showError))
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
const groundViewButton = document.getElementById('ground-view');
terrainReady
  .then(({ sites }) => {
    ground = initGroundMode(viewer, sites, {
      hud: document.getElementById('ground-hud'),
      minimapCanvas: document.getElementById('minimap'),
      exitButton: document.getElementById('exit-ground'),
      haze: document.getElementById('sky-haze'),
      onModeChange: (isGround) => {
        groundViewButton.classList.toggle('active', isGround);
        waypoints?.setGroundMode(isGround);
        showHereMarker(!isGround);
        if (!isGround) stopPrompt.hidden = true;
      },
      onPose: (pose) => {
        lastStood = { site: pose.site, lon: pose.lon, lat: pose.lat };
        updateStopPrompt(pose);
      },
      // while Directions is on, clicks pick route points instead of descending
      // ...and a click on a rover marker opens its photos
      isClickCaptured: (click) => Boolean(directions?.isActive() || waypoints?.hitTest(click.position)),
      isKeyboardCaptured: () => waypoints?.isMarsViewOpen() ?? false,
    });
  })
  .catch(() => {});

// "Where am I?" Mars has no GPS, so the app keeps its own answer:
// the last place you stood in ground mode, marked with a blue dot on the map.
let lastStood = null; // { site, lon, lat }
const hereMarker = viewer.entities.add({
  show: false,
  point: {
    pixelSize: 11,
    color: Cesium.Color.fromCssColorString('#1e88e5'),
    outlineColor: Cesium.Color.WHITE,
    outlineWidth: 3,
    heightReference: Cesium.HeightReference.CLAMP_TO_3D_TILE,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  },
  label: {
    text: 'You were here',
    font: '12px system-ui, sans-serif',
    fillColor: Cesium.Color.WHITE,
    outlineColor: Cesium.Color.BLACK,
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    pixelOffset: new Cesium.Cartesian2(0, 14), // below the dot: a route's "A" label sits above it
    verticalOrigin: Cesium.VerticalOrigin.TOP,
    heightReference: Cesium.HeightReference.CLAMP_TO_3D_TILE,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 20_000),
  },
});
function showHereMarker(on) {
  if (on && lastStood) placeOnGround(hereMarker, lastStood.lon, lastStood.lat);
  hereMarker.show = on && Boolean(lastStood);
  viewer.scene.requestRender();
}

// Step 5: navigation (walking route from A to B)
let directions = null;
let errorTimer = null;
sitesReady.then((sites) => {
  /** Pre-fill for A when navigation starts: where you stand in ground view. On the map, A is picked. */
  function currentLocation() {
    const standing = ground?.position();
    return standing ? { site: standing.site, lon: standing.lon, lat: standing.lat, label: 'your position' } : null;
  }

  directions = initDirections(viewer, sites, {
    button: document.getElementById('directions'),
    bar: document.getElementById('directions-bar'),
    card: document.getElementById('route-card'),
    currentLocation,
    terrainOffset: (site) => localTerrain?.offsetFor(site.id) ?? null,
    error: (msg) => {
      showError(msg);
      clearTimeout(errorTimer);
      errorTimer = setTimeout(() => showStatus(''), 6000);
    },
  });
});

// Ground view button: plan on the map, then walk it.
// Starts at the route's point A (facing down the route) when Directions has one;
// otherwise in the middle of the site in view (or the nearest site).
sitesReady.then((sites) => {
  function siteInView() {
    const centre = screenCenterPosition(viewer);
    if (centre) {
      const c = Cesium.Cartographic.fromCartesian(centre);
      const lon = Cesium.Math.toDegrees(c.longitude);
      const lat = Cesium.Math.toDegrees(c.latitude);
      const site = sites.find((s) => lon >= s.bbox[0] && lon <= s.bbox[2] && lat >= s.bbox[1] && lat <= s.bbox[3]);
      if (site) return site;
    }
    const camera = viewer.camera.positionWC;
    return sites
      .map((site) => ({ site, d: Cesium.Cartesian3.distance(camera, Cesium.Cartesian3.fromDegrees(site.center[0], site.center[1])) }))
      .sort((a, b) => a.d - b.d)[0]?.site ?? null;
  }

  groundViewButton.addEventListener('click', () => {
    if (!ground) {
      showError('Ground view is still loading the terrain. Try again in a moment.');
      return;
    }
    const a = directions?.startPoint();
    if (a) {
      ground.enterAt(a.site, a.lon, a.lat, a.toward);
      return;
    }
    const site = siteInView();
    if (!site) return;
    const [w, s, e, n] = site.bbox;
    ground.enterAt(site, (w + e) / 2, (s + n) / 2);
  });
});

// Step 6: rover waypoints, photos and Mars view
let waypoints = null;
sitesReady.then((sites) => {
  waypoints = initWaypoints(viewer, sites, {
    panel: document.getElementById('photo-panel'),
    lightbox: document.getElementById('lightbox'),
    pov: document.getElementById('pov'),
    isBlocked: () => directions?.isActive() ?? false,
    // opened from the photo panel while walking: come back to the ground afterwards
    marsViewOptions: () => (ground?.position() ? { onClose: returnToGround } : {}),
    error: showError,
  });
});

// Ground mode <-> rover photos: point the walker at the nearest rover stop,
// and offer Mars view when standing where the rover stood.
const AT_STOP_M = 20;
const NEARBY_M = 1500;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const stopPrompt = document.getElementById('stop-prompt');
const stopPromptText = stopPrompt.querySelector('[data-role="text"]');
const stopPromptAction = stopPrompt.querySelector('[data-role="action"]');
let promptTarget = null; // { stop, atStop, heading }
let lastPromptUpdate = 0;

function returnToGround(stop, heading) {
  ground?.setPose(stop.lon, stop.lat, heading);
}

function updateStopPrompt(pose) {
  const now = performance.now();
  if (now - lastPromptUpdate < 200) return; // a few times a second is plenty
  lastPromptUpdate = now;
  const near = waypoints?.nearest(pose.lon, pose.lat);
  if (!near || near.distance > NEARBY_M) {
    stopPrompt.hidden = true;
    promptTarget = null;
    return;
  }
  const atStop = near.distance <= AT_STOP_M;
  promptTarget = { stop: near.stop, atStop, heading: pose.heading };
  stopPromptText.textContent = atStop
    ? `${near.stop.rover} stood here on sol ${near.stop.sol}.`
    : `Nearest rover stop: sol ${near.stop.sol}, ${Math.round(near.distance)} m ${COMPASS[Math.round(near.bearing / 45) % 8]}`;
  stopPromptAction.textContent = atStop ? 'See the rover photos' : 'Go there';
  stopPrompt.hidden = false;
}

stopPromptAction.addEventListener('click', () => {
  if (!promptTarget) return;
  const { stop, atStop, heading } = promptTarget;
  if (atStop) waypoints.openMarsView(stop, { heading, onClose: returnToGround });
  else ground.glideTo(stop.lon, stop.lat);
});

// Cursor lon/lat readout
initCoordinateReadout(viewer, document.getElementById('coords'));

console.info(`Mars Map: data source = ${USE_MOCK ? 'mock files' : API_BASE}`);
