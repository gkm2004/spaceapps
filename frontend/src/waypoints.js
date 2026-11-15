// Rover waypoints: markers on the globe, a photo panel per stop, and the
// Mars view viewer (pov.js) for stops that have direction-tagged photos.
import * as Cesium from 'cesium';
import { getWaypoints } from './api.js';
import { placeOnGround } from './heights.js';
import { addLayerCheckbox } from './layers.js';
import { initPov } from './pov.js';

// Cesium's terrain sits about 74 m below contract (DEM) heights at Jezero; see data/scripts/README.md.
const CESIUM_HEIGHT_OFFSET_M = -74;
// Not in the API contract: which rover's stops a site holds.
const ROVER_BY_SITE = { jezero: 'Perseverance', gale: 'Curiosity' };
const MARKER = Cesium.Color.WHITE;
const MARKER_OUTLINE = Cesium.Color.fromCssColorString('#d9693a');
const SELECTED = Cesium.Color.fromCssColorString('#ffd24a');

/**
 * @param viewer Cesium viewer
 * @param sites entries from /api/sites
 * @param ui { panel, lightbox, pov, isBlocked(), beforeMarsView(), error(msg) }
 * @returns { hitTest(windowPosition) } so other click handlers can stand down
 */
export function initWaypoints(viewer, sites, ui) {
  const { scene } = viewer;
  const el = (role) => ui.panel.querySelector(`[data-role="${role}"]`);
  const stopByEntity = new Map();
  let stops = []; // all stops, travel order
  let selected = null;
  let groundMode = false;
  let afterMarsView = null; // set when Mars view was entered from ground mode
  const baseSize = () => (groundMode ? 10 : 7);

  function select(stop) {
    if (selected) {
      selected.entity.point.pixelSize = baseSize();
      selected.entity.point.color = MARKER;
    }
    selected = stop;
    if (stop) {
      stop.entity.point.pixelSize = 12;
      stop.entity.point.color = SELECTED;
    }
    scene.requestRender();
  }

  function flyAbove(stop, duration = 1.5) {
    viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        Cesium.Cartesian3.fromDegrees(stop.lon, stop.lat, stop.height + CESIUM_HEIGHT_OFFSET_M), 0),
      { duration, offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-55), 350) },
    );
  }

  const pov = initPov(ui.pov, {
    onStop: (stop) => showPanel(stop), // keep panel + marker in step while moving between stops
    onClose: (stop, heading) => {
      if (!stop) return;
      if (afterMarsView) afterMarsView(stop, heading); // back on the ground, at this stop
      else flyAbove(stop, 0); // the globe is where you were standing
      afterMarsView = null;
    },
  });

  // --- photo panel -------------------------------------------------------------
  function showPanel(stop) {
    select(stop);
    el('title').textContent = `${stop.rover} · Sol ${stop.sol}`;
    el('where').textContent = `Lon ${stop.lon.toFixed(4)}°  Lat ${stop.lat.toFixed(4)}°`;
    const marsView = el('mars-view');
    marsView.disabled = stop.pov.length === 0;
    marsView.textContent = stop.pov.length ? 'Mars view' : 'No Mars view at this stop';
    el('thumbs').replaceChildren(...stop.images.map((image) => {
      const button = document.createElement('button');
      button.title = `${image.camera}: click to enlarge`;
      const img = document.createElement('img');
      img.src = image.thumb_url;
      img.alt = `${image.camera} photo, sol ${stop.sol}`;
      img.loading = 'lazy';
      button.append(img);
      button.addEventListener('click', () => openLightbox(image, stop));
      return button;
    }));
    el('empty').hidden = stop.images.length > 0;
    ui.panel.hidden = false;
  }

  function closePanel() {
    ui.panel.hidden = true;
    select(null);
  }

  el('close').addEventListener('click', closePanel);
  /** @param opts { heading?: degrees, onClose?(stop, heading) } */
  function openMarsView(stop, opts = {}) {
    // Mars view walks along one rover's path: only stops from the same site
    const withPov = stops.filter((s) => s.site === stop.site && s.pov.length > 0);
    const i = withPov.indexOf(stop);
    if (i < 0) return;
    afterMarsView = opts.onClose ?? null;
    pov.open(withPov, i, { heading: opts.heading });
  }
  el('mars-view').addEventListener('click', () => {
    if (selected) openMarsView(selected, ui.marsViewOptions?.() ?? {});
  });

  /** Closest stop that has Mars view photos: { stop, distance (m), bearing (deg from north) } or null. */
  function nearest(lon, lat) {
    const radius = Cesium.Ellipsoid.MARS.maximumRadius;
    const cosLat = Math.cos(Cesium.Math.toRadians(lat));
    let best = null;
    for (const stop of stops) {
      if (!stop.pov.length) continue;
      const east = Cesium.Math.toRadians(stop.lon - lon) * cosLat * radius;
      const north = Cesium.Math.toRadians(stop.lat - lat) * radius;
      const distance = Math.hypot(east, north);
      if (!best || distance < best.distance) {
        best = { stop, distance, bearing: (Cesium.Math.toDegrees(Math.atan2(east, north)) + 360) % 360 };
      }
    }
    return best;
  }

  /** On the ground the stops become beacons: bigger dots with a sol label when close. */
  function setGroundMode(on) {
    groundMode = on;
    for (const stop of stops) {
      stop.entity.label.show = on;
      if (stop !== selected) stop.entity.point.pixelSize = baseSize();
    }
    scene.requestRender();
  }

  // --- lightbox ------------------------------------------------------------------
  const boxImg = ui.lightbox.querySelector('img');
  const boxCaption = ui.lightbox.querySelector('figcaption');
  function openLightbox(image, stop) {
    boxImg.src = image.full_url;
    boxImg.alt = `${image.camera} photo, sol ${stop.sol}`;
    boxCaption.textContent = `${image.camera} · Sol ${stop.sol} · NASA/JPL-Caltech`;
    ui.lightbox.hidden = false;
  }
  function closeLightbox() {
    ui.lightbox.hidden = true;
    boxImg.removeAttribute('src');
  }
  ui.lightbox.addEventListener('click', closeLightbox);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!ui.lightbox.hidden) closeLightbox();
  });

  // --- markers -------------------------------------------------------------------
  const hitTest = (position) => {
    const picked = scene.pick(position);
    return (picked && stopByEntity.get(picked.id)) || null;
  };

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((click) => {
    if (ui.isBlocked?.()) return;
    const stop = hitTest(click.position);
    if (stop) showPanel(stop);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  Promise.all(sites.map((site) => getWaypoints(site.id).then((collection) => ({ site, collection }))))
    .then((results) => {
      for (const { site, collection } of results) {
        for (const feature of collection.features) {
          const [lon, lat, height = 0] = feature.geometry.coordinates;
          const p = feature.properties;
          const stop = {
            site: site.id,
            rover: ROVER_BY_SITE[site.id] ?? 'Rover',
            sol: p.sol,
            lon,
            lat,
            height,
            images: p.images ?? [],
            pov: p.pov ?? [],
          };
          stop.entity = viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lon, lat),
            point: {
              pixelSize: 7,
              color: MARKER,
              outlineColor: MARKER_OUTLINE,
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_3D_TILE,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              // from orbit 125 dots would be one blob: only show them close up
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 60_000),
            },
            label: {
              show: groundMode,
              text: `Sol ${p.sol}`,
              font: '12px system-ui, sans-serif',
              fillColor: Cesium.Color.WHITE,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -14),
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              heightReference: Cesium.HeightReference.CLAMP_TO_3D_TILE,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 300),
            },
          });
          placeOnGround(stop.entity, lon, lat); // exact height if the heightmap is loaded
          stopByEntity.set(stop.entity, stop);
          stops.push(stop);
        }
      }
      scene.requestRender();
    })
    .catch((err) => {
      console.error(err);
      ui.error(`Could not load rover waypoints: ${err.message ?? err}`);
    });

  addLayerCheckbox({
    id: 'waypoints',
    label: 'Rover waypoints',
    checked: true,
    set(on) {
      for (const stop of stops) stop.entity.show = on;
      if (!on) closePanel();
      scene.requestRender();
    },
  });

  return {
    hitTest,
    isMarsViewOpen: pov.isOpen,
    nearest,
    openMarsView,
    setGroundMode,
    /** Call when heightmaps arrive: markers switch from terrain clamping to exact heights. */
    refreshHeights() {
      for (const stop of stops) placeOnGround(stop.entity, stop.lon, stop.lat);
      scene.requestRender();
    },
  };
}
