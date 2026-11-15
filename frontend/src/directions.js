// Navigation: a route from A to B, on foot or by rover. A and B are filled by clicking
// the map or typing "lon, lat" into the panel's boxes. Fetches /api/route, draws it on
// the terrain, and shows a route card with stats and an elevation profile.
import * as Cesium from 'cesium';
import { getRoute } from './api.js';
import { sampleTerrain } from './ground.js';
import { placeOnGround } from './heights.js';

const ROUTE_COLOR = '#4fc3f7'; // blue: distinct from the green/yellow/red danger layer
const MAX_LINE_POINTS = 160;
const LINE_LIFT_M = 0.6;
const LOOK_AHEAD_M = 25; // a walk starting at A faces this far down the route

/**
 * Travel modes: flat-ground speed (m/s) and the steepest slope (degrees) each can handle.
 * The user can change both per route. Slope slows every mode the same way (backend cost model).
 */
const MODES = {
  // backend defaults: 0.8 m/s and the 25 degree limit baked into the walking cost grid
  walk: { speed: 0.8, maxSlope: 25 },
  // Perseverance: about 152 m/h top speed on flat, hard ground; drivers avoid tilts over 30 degrees
  rover: { speed: 0.042, maxSlope: 30 },
  // planned crewed vehicle (NASA/JAXA pressurized rover); no published Mars spec, so an
  // estimate: about 10 km/h, and 20 degrees like typical crewed-rover design targets
  crewed: { speed: 2.8, maxSlope: 20 },
};
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
 *   currentLocation(): { site, lon, lat, label } | null   pre-fills A when navigation starts
 *   terrainOffset?(site): number | null
 * }
 * @returns { isActive(), startPoint() }
 */
export function initDirections(viewer, sites, ui) {
  const { scene } = viewer;
  const cardEl = (role) => ui.card.querySelector(`[data-role="${role}"]`);
  const barEl = (role) => ui.bar.querySelector(`[data-role="${role}"]`);

  // 'off'     navigation ended
  // 'pick'    waiting for A and/or B (map click or typed)
  // 'loading' route requested
  // 'shown'   route on screen; a map click picks a new B (or a new A if its box is selected)
  let state = 'off';
  let start = null; // A: { site, lon, lat, label }
  let end = null; // B: { lon, lat }
  let field = 'a'; // the box the next map click fills
  let requestId = 0;
  let line = null; // { positions: Cartesian3[], cumulative: number[] }
  const inputA = barEl('a');
  const inputB = barEl('b');
  const inputSpeed = barEl('speed');
  const inputSlope = barEl('max-slope');
  const modeButtons = [...ui.bar.querySelectorAll('[data-mode]')];
  let travel = { mode: 'walk', ...MODES.walk }; // speed in m/s, maxSlope in degrees
  const fmtLonLat = (p) => `${p.lon.toFixed(5)}, ${p.lat.toFixed(5)}`;

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
    ui.button.textContent = on ? 'End navigation' : 'Start navigation';
    ui.bar.hidden = !on;
    scene.canvas.style.cursor = on && state !== 'loading' ? 'crosshair' : '';
    inputA.classList.toggle('active', on && field === 'a');
    inputB.classList.toggle('active', on && field === 'b');
    barEl('hint').textContent = state === 'loading'
      ? 'Finding the easiest route…'
      : field === 'a'
        ? 'Click the map to set the start (A), or type lon, lat.'
        : state === 'shown'
          ? 'Click the map for a new destination, or select A to move the start.'
          : 'Click the map to set the destination (B), or type lon, lat.';
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

  async function requestRoute() {
    clearRoute();
    place(pinB, end.lon, end.lat);
    const id = requestId;
    setState('loading');
    try {
      const route = await getRoute(start.site.id, [start.lon, start.lat], [end.lon, end.lat],
        { speed: travel.speed, maxSlope: travel.maxSlope });
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
      setB(null);
      ui.error(`No route: ${err.message ?? err}`);
      setState('pick');
    }
    scene.requestRender();
  }

  /** Set (or clear, with null) A, then route if B is already set. */
  function setA(point) {
    setStart(point);
    inputA.value = point ? fmtLonLat(point) : '';
    if (point && end && !inBbox(point.site, end.lon, end.lat)) setB(null); // B is in another site
    field = point ? 'b' : 'a';
    if (point && end) requestRoute();
    else setState('pick');
  }

  /** Set (or clear) B. Routing is up to the caller. */
  function setB(point) {
    end = point;
    inputB.value = point ? fmtLonLat(point) : '';
    if (!point) pinB.show = false;
  }

  /** Fill box `which` ('a' | 'b') with a point, from a map click or typed coordinates. */
  function pickPoint(which, lon, lat, label) {
    if (which === 'a') {
      const site = sites.find((s) => inBbox(s, lon, lat));
      if (!site) {
        ui.error('The start must be inside a site zone (the orange outline).');
        return false;
      }
      setA({ site, lon, lat, label });
      return true;
    }
    if (!start) {
      ui.error('Set the start (A) first.');
      field = 'a';
      setState('pick');
      return false;
    }
    if (!inBbox(start.site, lon, lat)) {
      ui.error(`The destination must be inside the ${start.site.name} zone (the orange outline).`);
      return false;
    }
    setB({ lon, lat });
    requestRoute();
    return true;
  }

  /** Show the travel settings; re-route when they change and a route is wanted. */
  function showTravel() {
    for (const b of modeButtons) {
      const on = b.dataset.mode === travel.mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const kmh = travel.speed * 3.6;
    inputSpeed.value = String(Number(kmh.toFixed(kmh < 1 ? 2 : 1)));
    inputSlope.value = String(travel.maxSlope);
  }

  function setTravel(next) {
    travel = { ...travel, ...next };
    showTravel();
    if (start && end && state !== 'off') requestRoute();
  }

  function begin() {
    setB(null);
    // walking: start from where you stand; on the map, A is yours to pick
    setA(ui.currentLocation());
  }

  function finish() {
    setB(null);
    setStart(null);
    inputA.value = '';
    field = 'a';
    setState('off');
  }

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((click) => {
    if (state === 'off' || state === 'loading') return;
    if (!scene.pickPositionSupported) return;
    const cartesian = scene.pickPosition(click.position);
    if (!Cesium.defined(cartesian)) return;
    const c = Cesium.Cartographic.fromCartesian(cartesian);
    const lon = Cesium.Math.toDegrees(c.longitude);
    const lat = Cesium.Math.toDegrees(c.latitude);

    pickPoint(field, lon, lat, 'the point you picked');
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // Typed coordinates: "lon, lat" (comma or space separated). Committed on Enter or leaving the box.
  for (const [which, input] of [['a', inputA], ['b', inputB]]) {
    input.addEventListener('focus', () => {
      field = which;
      setState(state);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur(); // blur fires 'change'
    });
    input.addEventListener('change', () => {
      const text = input.value.trim();
      if (!text) {
        if (which === 'a') {
          setA(null);
        } else {
          clearRoute();
          setB(null);
          field = 'b';
          setState('pick');
        }
        return;
      }
      const m = text.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
      if (!m) ui.error('Type coordinates as lon, lat, for example 77.45, 18.44.');
      const ok = Boolean(m) && pickPoint(which, Number(m[1]), Number(m[2]), 'typed coordinates');
      if (!ok) {
        // put back the point that is actually set
        const current = which === 'a' ? start : end;
        input.value = current ? fmtLonLat(current) : '';
      }
    });
  }

  // Travel mode presets, and hand-tuned speed / slope limit
  for (const b of modeButtons) {
    b.addEventListener('click', () => setTravel({ mode: b.dataset.mode, ...MODES[b.dataset.mode] }));
  }
  inputSpeed.addEventListener('change', () => {
    const kmh = Number(inputSpeed.value);
    if (kmh > 0 && kmh <= 180) setTravel({ speed: kmh / 3.6 });
    else {
      ui.error('Speed must be above 0 and at most 180 km/h.');
      showTravel();
    }
  });
  inputSlope.addEventListener('change', () => {
    const deg = Math.round(Number(inputSlope.value));
    if (deg >= 1 && deg <= 45) setTravel({ maxSlope: deg });
    else {
      ui.error('Max slope must be between 1 and 45 degrees.');
      showTravel();
    }
  });
  for (const input of [inputSpeed, inputSlope]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur(); // blur fires 'change'
    });
  }
  showTravel();

  ui.button.addEventListener('click', () => (state === 'off' ? begin() : finish()));
  cardEl('close').addEventListener('click', () => {
    clearRoute();
    setB(null);
    field = 'b';
    if (state !== 'off') setState('pick');
  });

  return {
    isActive: () => state !== 'off',
    /**
     * Point A, for starting a walk there: { site, lon, lat, toward } or null when no start is set.
     * With a route on screen, A is the route's (possibly snapped) first point and `toward` is
     * a point a few metres along it, so the walker faces down the route; otherwise toward is null.
     */
    startPoint() {
      if (state === 'off' || !start) return null;
      if (!line) return { site: start.site, lon: start.lon, lat: start.lat, toward: null };
      const total = line.cumulative[line.cumulative.length - 1];
      let toward = null;
      if (total > 0) {
        const c = Cesium.Cartographic.fromCartesian(positionAlong(Math.min(1, LOOK_AHEAD_M / total)));
        toward = [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
      }
      const [lon, lat] = line.ends[0];
      return { site: start.site, lon, lat, toward };
    },
  };
}
