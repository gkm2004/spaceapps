// Ground mode: site outlines, click-to-descend, walking camera, minimap, exit to orbit.
import * as Cesium from 'cesium';
import { dangerTileUrl, getDangerTileInfo } from './api.js';
import { flyToSite } from './globe.js';

const EYE_HEIGHT_M = 1.7;
const WALK_SPEED_M_S = 1.4;
const RUN_FACTOR = 8; // hold Shift
const LOOK_RAD_PER_PX = 0.004;
const MAX_PITCH = Cesium.Math.toRadians(85);
const OUTLINE_POINTS_PER_SIDE = 48;

const MOVE_KEYS = {
  KeyW: [1, 0], ArrowUp: [1, 0],
  KeyS: [-1, 0], ArrowDown: [-1, 0],
  KeyD: [0, 1], ArrowRight: [0, 1],
  KeyA: [0, -1], ArrowLeft: [0, -1],
};

const inBbox = (site, lonDeg, latDeg) =>
  lonDeg >= site.bbox[0] && lonDeg <= site.bbox[2] && latDeg >= site.bbox[1] && latDeg <= site.bbox[3];

/** Heights from the tileset at full detail. Needs frames to make progress in requestRenderMode. */
export async function sampleTerrain(scene, cartographics) {
  let done = false;
  const pump = () => {
    if (done) return;
    scene.requestRender();
    requestAnimationFrame(pump);
  };
  pump();
  try {
    return await scene.sampleHeightMostDetailed(cartographics);
  } finally {
    done = true;
  }
}

/** Draw a site's bbox on the terrain. */
async function addSiteOutline(viewer, site) {
  const [west, south, east, north] = site.bbox;
  const corners = [[west, south], [east, south], [east, north], [west, north], [west, south]];
  const cartos = [];
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < OUTLINE_POINTS_PER_SIDE; k++) {
      const t = k / OUTLINE_POINTS_PER_SIDE;
      cartos.push(Cesium.Cartographic.fromDegrees(
        corners[i][0] + (corners[i + 1][0] - corners[i][0]) * t,
        corners[i][1] + (corners[i + 1][1] - corners[i][1]) * t,
      ));
    }
  }
  try {
    await sampleTerrain(viewer.scene, cartos);
  } catch (err) {
    console.warn('Could not sample terrain for the site outline', err);
  }
  const known = cartos.filter((c) => Number.isFinite(c.height)).map((c) => c.height);
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0;
  const positions = cartos.map((c) =>
    Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, (Number.isFinite(c.height) ? c.height : fallback) + 3));
  positions.push(positions[0]);

  const color = Cesium.Color.fromCssColorString('#ff9d5c');
  viewer.entities.add({
    name: `${site.name} ground-view zone`,
    polyline: {
      positions,
      width: 3,
      arcType: Cesium.ArcType.NONE,
      material: color,
      // still visible where the terrain bulges over the line
      depthFailMaterial: color.withAlpha(0.5),
    },
  });
  viewer.scene.requestRender();
}

/** North-up minimap of one site: danger tiles as background, position dot and heading wedge. */
class Minimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.background = null;
    this.site = null;
  }

  async setSite(site) {
    if (this.site === site) return;
    this.site = site;
    this.background = null;
    const size = this.canvas.width;
    const bg = document.createElement('canvas');
    bg.width = bg.height = size;
    const ctx = bg.getContext('2d');
    ctx.fillStyle = '#3a2a22';
    ctx.fillRect(0, 0, size, size);
    this.background = bg;
    try {
      // Paint the danger tiles (z12 is plenty for 180 px) as a simple base map.
      const info = await getDangerTileInfo(site.id);
      const z = Math.min(Math.max(12, info.minzoom), info.maxzoom);
      const d = 180 / 2 ** z;
      const [w, s, e, n] = site.bbox;
      const jobs = [];
      for (let x = Math.floor((w + 180) / d); x <= Math.floor((e + 180) / d); x++) {
        for (let y = Math.floor((90 - n) / d); y <= Math.floor((90 - s) / d); y++) {
          jobs.push(new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              const px = ((-180 + x * d - w) / (e - w)) * size;
              const py = ((n - (90 - y * d)) / (n - s)) * size;
              ctx.drawImage(img, px, py, (d / (e - w)) * size, (d / (n - s)) * size);
              resolve();
            };
            img.onerror = resolve; // tiles outside the data don't exist
            img.src = dangerTileUrl(site.id).replace('{z}', z).replace('{x}', x).replace('{y}', y);
          }));
        }
      }
      await Promise.all(jobs);
    } catch {
      // no backend: plain background is fine
    }
  }

  draw(lonDeg, latDeg, heading) {
    const { ctx, canvas, site } = this;
    const size = canvas.width;
    ctx.clearRect(0, 0, size, size);
    if (this.background) ctx.drawImage(this.background, 0, 0);
    if (!site) return;
    const [w, s, e, n] = site.bbox;
    const x = ((lonDeg - w) / (e - w)) * size;
    const y = ((n - latDeg) / (n - s)) * size;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading); // heading is clockwise from north, canvas rotation is clockwise too
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'; // field-of-view wedge
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 34, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.fillText('N', size - 14, 14);
  }
}

/**
 * @param viewer Cesium viewer
 * @param sites entries from /api/sites
 * @param ui { hud, minimapCanvas, exitButton, onModeChange(isGround) }
 * @returns { isActive(), leave(), exitToOrbit(), position() }
 */
export function initGroundMode(viewer, sites, ui) {
  const { scene, camera } = viewer;
  const controller = scene.screenSpaceCameraController;
  const minimap = new Minimap(ui.minimapCanvas);

  // 'orbit' | 'entering' | 'ground'
  let mode = 'orbit';
  let site = null;
  const pose = { lon: 0, lat: 0, ground: 0, heading: 0, pitch: 0 }; // radians, metres
  const keys = new Set();
  let lastTime = 0;
  let frame = null;
  let drag = null;

  for (const s of sites) addSiteOutline(viewer, s);

  function setMode(next) {
    mode = next;
    const ground = mode === 'ground';
    ui.hud.hidden = !ground;
    ui.onModeChange?.(ground);
  }

  function applyCamera() {
    camera.setView({
      destination: Cesium.Cartesian3.fromRadians(pose.lon, pose.lat, pose.ground + EYE_HEIGHT_M),
      orientation: { heading: pose.heading, pitch: pose.pitch, roll: 0 },
    });
    minimap.draw(Cesium.Math.toDegrees(pose.lon), Cesium.Math.toDegrees(pose.lat), pose.heading);
    scene.requestRender();
  }

  /** Terrain height under the camera; keeps the previous value while tiles are missing. */
  function clampToTerrain() {
    const h = scene.sampleHeight(new Cesium.Cartographic(pose.lon, pose.lat));
    if (Number.isFinite(h)) pose.ground = h;
  }

  function tick(now) {
    frame = requestAnimationFrame(tick);
    const dt = Math.min((now - lastTime) / 1000, 0.1); // cap: no teleport after a tab switch
    lastTime = now;

    let forward = 0;
    let right = 0;
    for (const code of keys) {
      const move = MOVE_KEYS[code];
      if (move) {
        forward += move[0];
        right += move[1];
      }
    }
    const before = pose.ground;
    if (forward || right) {
      const len = Math.hypot(forward, right);
      const speed = WALK_SPEED_M_S * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN_FACTOR : 1);
      const step = (speed * dt) / len;
      // heading is clockwise from north
      const north = (forward * Math.cos(pose.heading) - right * Math.sin(pose.heading)) * step;
      const east = (forward * Math.sin(pose.heading) + right * Math.cos(pose.heading)) * step;
      const radius = Cesium.Ellipsoid.MARS.maximumRadius;
      const [w, s, e, n] = site.bbox.map(Cesium.Math.toRadians);
      pose.lat = Cesium.Math.clamp(pose.lat + north / radius, s, n);
      pose.lon = Cesium.Math.clamp(pose.lon + east / (radius * Math.cos(pose.lat)), w, e);
    }
    clampToTerrain(); // every frame: tiles under us may have just loaded at higher detail
    if (forward || right || pose.ground !== before) applyCamera();
  }

  function start(targetSite, lonRad, latRad, groundHeight) {
    site = targetSite;
    setMode('entering');
    controller.enableInputs = false;
    minimap.setSite(site).then(() => mode === 'ground' && applyCamera());
    Object.assign(pose, {
      lon: lonRad,
      lat: latRad,
      ground: groundHeight,
      heading: camera.heading,
      pitch: 0,
    });
    camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(lonRad, latRad, groundHeight + EYE_HEIGHT_M),
      orientation: { heading: pose.heading, pitch: 0, roll: 0 },
      duration: 3,
      complete: () => {
        if (mode !== 'entering') return;
        setMode('ground');
        keys.clear();
        lastTime = performance.now();
        clampToTerrain();
        applyCamera();
        frame = requestAnimationFrame(tick);
      },
      cancel: () => mode === 'entering' && leave(),
    });
  }

  /** Stop ground mode without moving the camera (the caller is about to fly somewhere). */
  function leave() {
    if (mode === 'orbit') return;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    drag = null;
    keys.clear();
    controller.enableInputs = true;
    setMode('orbit');
  }

  function exitToOrbit() {
    if (mode === 'orbit') return;
    const from = site;
    leave();
    flyToSite(viewer, from, 2.5);
  }

  // --- input -----------------------------------------------------------------
  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((click) => {
    if (mode !== 'orbit' || ui.isClickCaptured?.()) return;
    if (!scene.pickPositionSupported) return;
    const hit = scene.pickPosition(click.position);
    if (!Cesium.defined(hit)) return;
    const c = Cesium.Cartographic.fromCartesian(hit);
    const lon = Cesium.Math.toDegrees(c.longitude);
    const lat = Cesium.Math.toDegrees(c.latitude);
    const target = sites.find((s) => inBbox(s, lon, lat));
    if (target) start(target, c.longitude, c.latitude, c.height);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // Mouse drag looks around, street-view style: the scene follows the cursor.
  scene.canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'ground' || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY };
    scene.canvas.setPointerCapture(e.pointerId);
  });
  scene.canvas.addEventListener('pointermove', (e) => {
    if (mode !== 'ground' || !drag) return;
    pose.heading = Cesium.Math.zeroToTwoPi(pose.heading - (e.clientX - drag.x) * LOOK_RAD_PER_PX);
    pose.pitch = Cesium.Math.clamp(pose.pitch + (e.clientY - drag.y) * LOOK_RAD_PER_PX, -MAX_PITCH, MAX_PITCH);
    drag = { x: e.clientX, y: e.clientY };
    applyCamera();
  });
  const endDrag = () => (drag = null);
  scene.canvas.addEventListener('pointerup', endDrag);
  scene.canvas.addEventListener('pointercancel', endDrag);

  const typing = (e) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
  window.addEventListener('keydown', (e) => {
    if (mode !== 'ground' || typing(e)) return;
    if (e.code === 'Escape') {
      exitToOrbit();
    } else if (MOVE_KEYS[e.code] || e.code.startsWith('Shift')) {
      keys.add(e.code);
      e.preventDefault(); // arrows would scroll the page
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  ui.exitButton.addEventListener('click', exitToOrbit);

  return {
    isActive: () => mode !== 'orbit',
    leave,
    exitToOrbit,
    /** { site, lon, lat } in degrees while on the ground, else null. */
    position: () => (mode === 'ground'
      ? { site, lon: Cesium.Math.toDegrees(pose.lon), lat: Cesium.Math.toDegrees(pose.lat) }
      : null),
  };
}
