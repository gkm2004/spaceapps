// Search bar: fuzzy search over landmarks (and sites), flying to the pick.
import * as Cesium from 'cesium';
import { flyToSite } from './globe.js';

const LANDMARK_RANGE_M = 600_000; // landmarks are regional features: view from 600 km

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** Higher is better, 0 = no match. Prefix > substring > letters-in-order > typo. */
export function fuzzyScore(query, text) {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const at = t.indexOf(q);
  if (at === 0) return 100;
  if (at > 0) return (t[at - 1] === ' ' ? 90 : 80) - Math.min(at, 20) * 0.1;

  // all query letters appear in order ("olmps" -> "Olympus Mons")
  let ti = 0;
  let gaps = 0;
  let matched = 0;
  for (const ch of q.replace(/\s+/g, '')) {
    const found = t.indexOf(ch, ti);
    if (found === -1) break;
    gaps += found - ti;
    ti = found + 1;
    matched++;
  }
  if (matched === q.replace(/\s+/g, '').length && q.length >= 2) return Math.max(40, 70 - gaps * 2);

  // typos / swapped letters ("olypmus"), compared word by word and against the full name
  const candidates = [...t.split(/\s+/), t];
  const best = Math.min(...candidates.map((w) => levenshtein(q, w)));
  const allowed = q.length <= 4 ? 1 : 2;
  return best <= allowed ? 30 - best * 5 : 0;
}

function formatCoords(lon, lat) {
  const ns = lat >= 0 ? 'N' : 'S';
  const east = ((lon % 360) + 360) % 360;
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${east.toFixed(2)}°E`;
}

/**
 * @param viewer Cesium viewer
 * @param landmarks [{ name, lon, lat }]
 * @param sites entries from /api/sites
 * @param beforeFly called before the camera flies to a result (e.g. to leave ground mode)
 */
export function initSearch(viewer, landmarks, sites, beforeFly) {
  const input = document.getElementById('search-input');
  const list = document.getElementById('search-results');

  const siteNames = new Set(sites.map((s) => s.name.toLowerCase()));
  const items = [
    ...sites.map((s) => ({ name: s.name, lon: s.center[0], lat: s.center[1], site: s })),
    // a landmark with the same name as a site would be a duplicate row
    ...landmarks.filter((l) => !siteNames.has(l.name.toLowerCase())),
  ];

  // One reusable marker for the last search result, clamped onto the terrain.
  const marker = viewer.entities.add({
    show: false,
    point: {
      pixelSize: 10,
      color: Cesium.Color.fromCssColorString('#d9693a'),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_3D_TILE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      font: '14px system-ui, sans-serif',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -18),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      heightReference: Cesium.HeightReference.CLAMP_TO_3D_TILE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  let results = [];
  let active = 0;

  function render() {
    list.replaceChildren(
      ...results.map((item, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === active));
        li.classList.toggle('active', i === active);
        const name = document.createElement('span');
        name.textContent = item.name;
        const coords = document.createElement('span');
        coords.className = 'coords';
        coords.textContent = item.site ? 'Site' : formatCoords(item.lon, item.lat);
        li.append(name, coords);
        // mousedown, not click: fires before the input's blur closes the list
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(item);
        });
        return li;
      }),
    );
    if (input.value.trim() && results.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No matching place';
      list.append(li);
    }
    list.hidden = !input.value.trim();
  }

  function update() {
    const q = input.value;
    results = items
      .map((item) => ({ item, score: fuzzyScore(q, item.name) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
      .slice(0, 6)
      .map((r) => r.item);
    active = 0;
    render();
  }

  function choose(item) {
    input.value = item.name;
    list.hidden = true;
    input.blur();
    beforeFly?.();
    if (item.site) {
      marker.show = false;
      flyToSite(viewer, item.site);
    } else {
      marker.position = Cesium.Cartesian3.fromDegrees(item.lon, item.lat);
      marker.label.text = item.name;
      marker.show = true;
      viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(item.lon, item.lat), 0),
        {
          duration: 3,
          offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-60), LANDMARK_RANGE_M),
        },
      );
    }
    viewer.scene.requestRender();
  }

  input.addEventListener('input', update);
  input.addEventListener('focus', () => input.value.trim() && update());
  input.addEventListener('blur', () => (list.hidden = true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === 'Escape') {
      list.hidden = true;
      input.blur();
    }
  });
}
