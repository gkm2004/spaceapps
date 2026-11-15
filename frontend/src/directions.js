// Directions: route from your current location (or a picked start) to a clicked
// destination. Fetches /api/route, draws it on the terrain, and shows a route
// card with stats and an elevation profile.
import * as Cesium from 'cesium';
import { getRoute } from './api.js';
import { sampleTerrain } from './ground.js';
import { placeOnGround } from './heights.js';

const ROUTE_COLOR = '#4fc3f7'; // blue: distinct from the green/yellow/red danger layer
const MAX_LINE_POINTS = 160;
const LINE_LIFT_M = 0.6;
const DEFAULT_OFFSET_M = -74; // Cesium terrain vs DEM heights at Jezero, if nothing better is known
const SVG_NS = 'http://www.w3.org/2000/svg';

const inBbox = (site, lon, lat) =>
  lon >= site.bbox[0] && lon <= site.bbox[2] && lat >= site.bbox[1] && lat <= site.bbox[3];

const fmtDistance = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
function fmtMinutes(min) {
  const total = Math.round(min);
  return total >= 60 ? `${Math.floor(total / 60)} h ${total % 60} min` : `${total} min`;
}
/** Same classes as the danger layer. */
function slopeClass(deg) {
  if (deg < 10) return { label: 'gentle', color: '#2ecc40' };
  if (deg <= 20) return { label: 'moderate', color: '#ffd200' };
  return { label: 'steep', color: '#e61e1e' };
}

function svg(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * Elevation profile: one series (height along the route), so no legend;
 * 2px line over a faint area, recessive grid, crosshair + readout on hover.
 * @param profile [[dist_m, height_m], ...]
 * @param onHover (dist_m | null) => void
 */
function renderProfile(container, readout, profile, onHover) {
  const W = 288;
  const H = 120;
  const m = { top: 8, right: 8, bottom: 18, left: 44 };
  const pw = W - m.left - m.right;
  const ph = H - m.top - m.bottom;
  const total = profile[profile.length - 1][0] || 1;
  const hs = profile.map((p) => p[1]);
  let lo = Math.min(...hs);
  let hi = Math.max(...hs);
  if (hi - lo < 4) {
    // nearly flat: don't blow 1 m of relief up to the full height
    const mid = (hi + lo) / 2;
    [lo, hi] = [mid - 2, mid + 2];
  }
  const pad = (hi - lo) * 0.08;
  [lo, hi] = [lo - pad, hi + pad];
  const x = (d) => m.left + (d / total) * pw;
  const y = (h) => m.top + (1 - (h - lo) / (hi - lo)) * ph;

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  root.append(svg('title', {}, `Elevation profile: ${Math.round(Math.min(...hs))} m to ${Math.round(Math.max(...hs))} m over ${fmtDistance(total)}`));

  for (const h of [lo + pad, (lo + hi) / 2, hi - pad]) {
    root.append(svg('line', { x1: m.left, x2: W - m.right, y1: y(h), y2: y(h), class: 'grid' }));
    root.append(svg('text', { x: m.left - 6, y: y(h) + 3, 'text-anchor': 'end', class: 'axis' }, `${Math.round(h)} m`));
  }
  root.append(svg('text', { x: m.left, y: H - 4, class: 'axis' }, '0'));
  root.append(svg('text', { x: W - m.right, y: H - 4, 'text-anchor': 'end', class: 'axis' }, fmtDistance(total)));

  const pts = profile.map(([d, h]) => `${x(d).toFixed(1)},${y(h).toFixed(1)}`);
  root.append(svg('path', {
    d: `M${m.left},${m.top + ph} L${pts.join(' L')} L${x(total).toFixed(1)},${m.top + ph} Z`,
    class: 'area',
  }));
  root.append(svg('path', { d: `M${pts.join(' L')}`, class: 'line' }));

  const cross = svg('line', { y1: m.top, y2: m.top + ph, class: 'crosshair', visibility: 'hidden' });
  const dot = svg('circle', { r: 4.5, class: 'dot', visibility: 'hidden' });
  // hit target = the whole plot, not just the line
  const hit = svg('rect', { x: m.left, y: m.top, width: pw, height: ph, fill: 'transparent' });
  root.append(cross, dot, hit);

  const idle = `${Math.round(Math.min(...hs))} m to ${Math.round(Math.max(...hs))} m elevation`;
  readout.textContent = idle;

  hit.addEventListener('pointermove', (e) => {
    const box = hit.getBoundingClientRect();
    const d = Cesium.Math.clamp((e.clientX - box.left) / box.width, 0, 1) * total;
    // interpolate between the two nearest samples
    let i = profile.findIndex((p) => p[0] >= d);
    if (i <= 0) i = 1;
    const [d0, h0] = profile[i - 1];
    const [d1, h1] = profile[i];
    const h = h0 + ((h1 - h0) * (d - d0)) / (d1 - d0 || 1);
    cross.setAttribute('x1', x(d));
    cross.setAttribute('x2', x(d));
    dot.setAttribute('cx', x(d));
    dot.setAttribute('cy', y(h));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    readout.textContent = `${fmtDistance(d)} along · ${h.toFixed(1)} m elevation`;
    onHover(d);
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    readout.textContent = idle;
    onHover(null);
  });

  container.replaceChildren(root);
}

/**
 * @param viewer Cesium viewer
 * @param sites entries from /api/sites
 * @param ui {
 *   button, bar, card, error(msg),
 *   currentLocation(): { site, lon, lat, label } | null   where "you" are right now
 *   terrainOffset?(site): number | null
 * }
 * @returns { isActive() }
 */
export function initDirections(viewer, sites, ui) {
  const { scene } = viewer;
  const cardEl = (role) => ui.card.querySelector(`[data-role="${role}"]`);
  const barEl = (role) => ui.bar.querySelector(`[data-role="${role}"]`);

  // 'off'     directions closed
  // 'start'   waiting for a click to set the start
  // 'end'     start is set, waiting for a click to set the destination
  // 'loading' route requested
  // 'shown'   route on screen; a click picks a new destination from the same start
  let state = 'off';
  let start = null; // { site, lon, lat, label }
  let requestId = 0;
  let line = null; // { positions: Cartesian3[], cumulative: number[] }

  const pin = (label, css) => viewer.entities.add({
    show: false,
    point: {
      pixelSize: 12,
      color: Cesium.Color.fromCssColorString(css),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_3D_TILE, // positions are lon/lat; the terrain sets the height
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: label,
      font: 'bold 13px system-ui, sans-serif',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -16),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      heightReference: Cesium.HeightReference.CLAMP_TO_3D_TILE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
  const pinA = pin('A', '#1e88e5');
  const pinB = pin('B', '#1e88e5');
  const hoverDot = viewer.entities.add({
    show: false,
    point: {
      pixelSize: 10,
      color: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.fromCssColorString(ROUTE_COLOR),
      outlineWidth: 3,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
  const color = Cesium.Color.fromCssColorString(ROUTE_COLOR);
  const routeEntity = viewer.entities.add({
    show: false,
    polyline: {
      positions: [],
      width: 4,
      arcType: Cesium.ArcType.NONE,
      material: color,
      depthFailMaterial: color.withAlpha(0.45), // keep the line visible where terrain covers it
    },
  });

  const place = (entity, lon, lat) => {
    placeOnGround(entity, lon, lat);
    entity.show = true;
  };

  /** Remove the route and destination; keeps the start. */
  function clearRoute() {
    requestId++; // drop any response still in flight
    line = null;
    for (const e of [pinB, hoverDot, routeEntity]) e.show = false;
    ui.card.hidden = true;
    scene.requestRender();
  }

  function setStart(point) {
    clearRoute();
    start = point;
    if (point) place(pinA, point.lon, point.lat);
    else pinA.show = false;
  }

  function setState(next) {
    state = next;
    const on = state !== 'off';
    ui.button.setAttribute('aria-pressed', String(on));
    ui.button.classList.toggle('active', on);
    ui.bar.hidden = !on;
    scene.canvas.style.cursor = state === 'start' || state === 'end' || state === 'shown' ? 'crosshair' : '';
    barEl('from').textContent = state === 'start' ? 'click the start on the map' : (start?.label ?? '');
    barEl('to').textContent = {
      off: '',
      start: 'To: pick the start first',
      end: 'To: click your destination on the map',
      loading: 'Finding the easiest walking route…',
      shown: 'To: the point you picked. Click the map for a new destination.',
    }[state];
    barEl('pick-start').hidden = state === 'start';
    // "Use my location" only when there is one and it isn't already the start
    const here = ui.currentLocation();
    barEl('use-current').hidden = !here || (state !== 'start' && start?.label === here.label
      && Math.abs(start.lon - here.lon) < 1e-6 && Math.abs(start.lat - here.lat) < 1e-6);
    scene.requestRender();
  }

  /** Put the route on the visible terrain. Contract heights are DEM heights, not Cesium heights. */
  async function drapeRoute(coords) {
    const step = Math.max(1, Math.ceil(coords.length / MAX_LINE_POINTS));
    const kept = coords.filter((_, i) => i % step === 0 || i === coords.length - 1);
    const cartos = kept.map(([lon, lat]) => Cesium.Cartographic.fromDegrees(lon, lat));
    let heights;
    const exact = ui.terrainOffset?.(start.site);
    try {
      if (Number.isFinite(exact)) {
        // The local terrain is the DEM itself (shifted), so the route's own heights are exact.
        heights = kept.map((c) => c[2] + exact);
      } else {
        await sampleTerrain(scene, cartos);
        heights = cartos.map((c) => c.height);
        if (heights.some((h) => !Number.isFinite(h))) throw new Error('terrain not loaded for part of the route');
      }
    } catch (err) {
      // Fallback: shift contract heights by the offset at the start point.
      console.warn('Route not clamped to terrain, using DEM heights', err);
      const ground = scene.sampleHeight(cartos[0]);
      const offset = Number.isFinite(ground) ? ground - kept[0][2] : DEFAULT_OFFSET_M;
      heights = kept.map((c) => c[2] + offset);
    }
    const positions = cartos.map((c, i) => Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, heights[i] + LINE_LIFT_M));
    const cumulative = [0];
    for (let i = 1; i < positions.length; i++) {
      cumulative.push(cumulative[i - 1] + Cesium.Cartesian3.distance(positions[i - 1], positions[i]));
    }
    return { positions, cumulative, ends: [kept[0], kept[kept.length - 1]] };
  }

  /** Map position at a fraction (0..1) of the way along the drawn line. */
  function positionAlong(fraction) {
    const { positions, cumulative } = line;
    const target = fraction * cumulative[cumulative.length - 1];
    let i = cumulative.findIndex((c) => c >= target);
    if (i <= 0) i = 1;
    const t = (target - cumulative[i - 1]) / (cumulative[i] - cumulative[i - 1] || 1);
    return Cesium.Cartesian3.lerp(positions[i - 1], positions[i], t, new Cesium.Cartesian3());
  }

  function showCard(props) {
    cardEl('distance').textContent = fmtDistance(props.distance_m);
    cardEl('time').textContent = fmtMinutes(props.est_minutes);
    cardEl('ascent').textContent = `${Math.round(props.ascent_m)} m`;
    const cls = slopeClass(props.max_slope_deg);
    cardEl('slope').textContent = `${props.max_slope_deg.toFixed(1)}°`;
    cardEl('slope-class').textContent = cls.label;
    cardEl('slope-dot').style.background = cls.color;
    const total = props.profile[props.profile.length - 1][0] || 1;
    renderProfile(cardEl('chart'), cardEl('readout'), props.profile, (d) => {
      hoverDot.show = d !== null && !!line;
      if (hoverDot.show) hoverDot.position = positionAlong(d / total);
      scene.requestRender();
    });
    ui.card.hidden = false;
  }

  async function requestRoute(end) {
    clearRoute();
    place(pinB, end.lon, end.lat);
    const id = requestId;
    setState('loading');
    try {
      const route = await getRoute(start.site.id, [start.lon, start.lat], [end.lon, end.lat]);
      const draped = await drapeRoute(route.geometry.coordinates);
      if (id !== requestId) return; // cancelled or superseded
      line = draped;
      routeEntity.polyline.positions = draped.positions;
      routeEntity.show = true;
      // the API may have snapped the ends to walkable ground: move the pins onto the line
      place(pinA, draped.ends[0][0], draped.ends[0][1]);
      place(pinB, draped.ends[1][0], draped.ends[1][1]);
      showCard(route.properties);
      setState('shown');
    } catch (err) {
      if (id !== requestId) return;
      console.error(err);
      clearRoute();
      ui.error(`No route: ${err.message ?? err}`);
      setState('end');
    }
    scene.requestRender();
  }

  /** Start from where the user is, if that is known; otherwise ask for a click. */
  function useCurrentLocation() {
    const here = ui.currentLocation();
    if (here) {
      setStart(here);
      setState('end');
    } else {
      setStart(null);
      setState('start');
    }
  }

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((click) => {
    if (state !== 'start' && state !== 'end' && state !== 'shown') return;
    if (!scene.pickPositionSupported) return;
    const cartesian = scene.pickPosition(click.position);
    if (!Cesium.defined(cartesian)) return;
    const c = Cesium.Cartographic.fromCartesian(cartesian);
    const lon = Cesium.Math.toDegrees(c.longitude);
    const lat = Cesium.Math.toDegrees(c.latitude);

    if (state === 'start') {
      const site = sites.find((s) => inBbox(s, lon, lat));
      if (!site) {
        ui.error('Routes only work inside a site zone (the orange outline).');
        return;
      }
      setStart({ site, lon, lat, label: 'the point you picked' });
      setState('end');
    } else {
      if (!inBbox(start.site, lon, lat)) {
        ui.error(`The destination must be inside the ${start.site.name} zone (the orange outline).`);
        return;
      }
      requestRoute({ lon, lat });
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  ui.button.addEventListener('click', () => {
    if (state === 'off') {
      useCurrentLocation();
    } else {
      setStart(null);
      setState('off');
    }
  });
  barEl('pick-start').addEventListener('click', () => {
    setStart(null);
    setState('start');
  });
  barEl('use-current').addEventListener('click', useCurrentLocation);
  cardEl('close').addEventListener('click', () => {
    clearRoute();
    if (state !== 'off') setState(start ? 'end' : 'start');
  });

  return { isActive: () => state !== 'off' };
}
