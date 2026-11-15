// Mars view: a street-view style viewer for rover stops.
// Every photo taken at a stop is laid out by the compass direction it faces
// (az/el/hfov/vfov from /api/waypoints `pov`), so dragging pans across them.
// Plain <img> elements: NASA's image server sends no CORS headers, so the
// photos can't be WebGL textures, but they can be positioned with CSS.

const DEFAULT_FOV = 75; // degrees of compass visible across the screen
const MIN_FOV = 30;
const MAX_FOV = 110;
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const wrap180 = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
const wrap360 = (deg) => ((deg % 360) + 360) % 360;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Compass bearing from one [lon, lat] to another, degrees clockwise from north. */
function bearing(from, to) {
  const lat = (from[1] * Math.PI) / 180;
  const east = (to[0] - from[0]) * Math.cos(lat);
  const north = to[1] - from[1];
  return wrap360((Math.atan2(east, north) * 180) / Math.PI);
}

/**
 * @param root the #pov element
 * @param hooks { onStop(stop), onClose(stop) }
 * @returns { open(stops, index), close(), isOpen() }
 *   stops: [{ rover, sol, lon, lat, pov: [{ url, az, el, hfov, vfov }] }] in travel order
 */
export function initPov(root, hooks = {}) {
  const stage = root.querySelector('[data-role="stage"]');
  const title = root.querySelector('[data-role="title"]');
  const compass = root.querySelector('[data-role="compass"]');
  const empty = root.querySelector('[data-role="empty"]');
  const prevBtn = root.querySelector('[data-role="prev"]');
  const nextBtn = root.querySelector('[data-role="next"]');

  let stops = [];
  let index = 0;
  let frames = []; // [{ ...pov, img, width }]  width = on-screen angular width in degrees
  const view = { heading: 0, pitch: -12, fov: DEFAULT_FOV };
  let pitchRange = [-60, 15];
  let drag = null;
  let raf = null;

  function layout() {
    raf = null;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    const k = W / view.fov; // pixels per degree
    let anyCentred = false;
    for (const f of frames) {
      const dx = wrap180(f.az - view.heading);
      const visible = Math.abs(dx) < view.fov / 2 + f.width / 2 + 2;
      f.img.style.display = visible ? '' : 'none';
      if (!visible) continue;
      if (Math.abs(dx) < f.width / 2) anyCentred = true;
      const left = W / 2 + (dx - f.width / 2) * k;
      const top = H / 2 - (f.el + f.vfov / 2 - view.pitch) * k;
      f.img.style.width = `${f.width * k}px`;
      f.img.style.height = `${f.vfov * k}px`;
      f.img.style.transform = `translate(${left}px, ${top}px)`;
    }
    empty.hidden = anyCentred;
    const h = Math.round(wrap360(view.heading));
    compass.textContent = `${String(h).padStart(3, '0')}° ${CARDINALS[Math.round(h / 45) % 8]}`;
  }
  const schedule = () => {
    if (raf === null) raf = requestAnimationFrame(layout);
  };

  /** Move to another stop with a short zoom-and-fade: zoom in if it is ahead of us, out if behind. */
  function travel(i) {
    const target = clamp(i, 0, stops.length - 1);
    if (target === index || stage.classList.contains('leaving')) return;
    const here = stops[index];
    const there = stops[target];
    const ahead = Math.abs(wrap180(bearing([here.lon, here.lat], [there.lon, there.lat]) - view.heading)) < 90;
    stage.style.setProperty('--travel-out', ahead ? '1.35' : '0.75');
    stage.style.setProperty('--travel-in', ahead ? '0.8' : '1.25');
    stage.classList.add('leaving');
    setTimeout(() => {
      show(target, true);
      layout(); // position the new photos before they fade in
      stage.classList.replace('leaving', 'arriving');
      requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.remove('arriving')));
    }, 260);
  }

  function show(i, keepHeading) {
    index = clamp(i, 0, stops.length - 1);
    const stop = stops[index];
    frames = stop.pov.map((p) => {
      const img = document.createElement('img');
      img.src = p.url;
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      // Lower in the frame a degree of azimuth covers less ground, so a photo
      // looking down spans more compass degrees than its field of view.
      const width = p.hfov / Math.max(Math.cos((p.el * Math.PI) / 180), 0.5);
      return { ...p, img, width };
    });
    stage.replaceChildren(...frames.map((f) => f.img));

    const tops = frames.map((f) => f.el + f.vfov / 2);
    const bottoms = frames.map((f) => f.el - f.vfov / 2);
    pitchRange = [Math.min(...bottoms) + 15, Math.max(...tops) - 10];
    if (pitchRange[0] > pitchRange[1]) pitchRange = [pitchRange[1], pitchRange[1]];

    if (!keepHeading) {
      // Face the way the rover went next (or came from, at the last stop).
      const next = stops[index + 1];
      const prev = stops[index - 1];
      if (next) view.heading = bearing([stop.lon, stop.lat], [next.lon, next.lat]);
      else if (prev) view.heading = bearing([prev.lon, prev.lat], [stop.lon, stop.lat]);
      view.pitch = -12;
      view.fov = DEFAULT_FOV;
    }
    view.pitch = clamp(view.pitch, ...pitchRange);

    title.textContent = `${stop.rover ?? 'Rover'} · Sol ${stop.sol} · stop ${index + 1} of ${stops.length}`;
    prevBtn.disabled = index === 0;
    nextBtn.disabled = index === stops.length - 1;
    hooks.onStop?.(stop);
    schedule();
  }

  /** @param opts { heading?: degrees } start facing this way instead of along the rover's path */
  function open(list, i, opts = {}) {
    stops = list;
    root.hidden = false;
    stage.classList.remove('leaving', 'arriving');
    const keep = Number.isFinite(opts.heading);
    if (keep) Object.assign(view, { heading: wrap360(opts.heading), pitch: -12, fov: DEFAULT_FOV });
    show(i, keep);
    root.focus();
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    stage.replaceChildren(); // stop loading images
    frames = [];
    hooks.onClose?.(stops[index], view.heading);
  }

  // Drag: the scene follows the cursor.
  stage.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const k = stage.clientWidth / view.fov;
    view.heading = wrap360(view.heading - (e.clientX - drag.x) / k);
    view.pitch = clamp(view.pitch + (e.clientY - drag.y) / k, ...pitchRange);
    drag = { x: e.clientX, y: e.clientY };
    schedule();
  });
  const endDrag = () => (drag = null);
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    view.fov = clamp(view.fov * (e.deltaY > 0 ? 1.1 : 1 / 1.1), MIN_FOV, MAX_FOV);
    schedule();
  }, { passive: false });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // don't let ground mode also treat this as "exit to orbit"
      close();
    }
    else if (e.key === 'ArrowLeft') view.heading = wrap360(view.heading - 10);
    else if (e.key === 'ArrowRight') view.heading = wrap360(view.heading + 10);
    else if (e.key === 'ArrowUp') return travel(index + 1);
    else if (e.key === 'ArrowDown') return travel(index - 1);
    else return;
    e.preventDefault();
    schedule();
  });

  prevBtn.addEventListener('click', () => travel(index - 1));
  nextBtn.addEventListener('click', () => travel(index + 1));
  root.querySelector('[data-role="close"]').addEventListener('click', close);
  window.addEventListener('resize', () => !root.hidden && schedule());

  return { open, close, isOpen: () => !root.hidden };
}
