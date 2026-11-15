// High-resolution local terrain.
// Cesium's Mars tileset has a terrain point every ~73 m at Jezero. For sites
// where data/scripts/terrain_mesh.py has been run, the backend serves a 2 m
// terrain model built from the HiRISE DEM. Near a site we cut its zone out
// of Cesium's ground and show ours instead. Each site switches on its own.
import * as Cesium from 'cesium';
import { API_BASE } from './config.js';
import { heavyTilesets, sampleTerrain } from './ground.js';
import { addHeightmap } from './heights.js';
import { addLayerCheckbox } from './layers.js';

const MIN_ACTIVE_WITHIN_M = 6000; // camera closer than this to the site centre -> local terrain
const ACTIVE_SPANS = 2.5; // ...or within this many site widths, so a big site still shows from its overview
const OVERLAP_M = 40; // our model reaches this far under Cesium's ground, so no gap at the seam
const DEFAULT_OFFSET_M = -74; // Cesium terrain height minus DEM height at Jezero (see data/scripts/README.md)

/** How far Cesium's terrain sits above (+) or below (-) the DEM, from the tileset's control points. */
async function measureOffset(scene, controlPoints) {
  try {
    const cartos = controlPoints.map(([lon, lat]) => Cesium.Cartographic.fromDegrees(lon, lat));
    await sampleTerrain(scene, cartos);
    const diffs = cartos
      .map((c, i) => c.height - controlPoints[i][2])
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (diffs.length >= 5) return diffs[Math.floor(diffs.length / 2)]; // median
  } catch (err) {
    console.warn('Could not measure the terrain height offset', err);
  }
  return DEFAULT_OFFSET_M;
}

/**
 * Load local terrain for every site that has it.
 * @param viewer Cesium viewer
 * @param mars the global Mars Cesium3DTileset
 * @param sites entries from /api/sites
 * @param hooks {
 *   onChange()   the visible ground changed (things laid on it should re-lay)
 *   onHeights()  a site's heightmap arrived (exact heights are now available there)
 * }
 * @returns { tilesets: Cesium3DTileset[], offsetFor(siteId) }  local tilesets (may be empty)
 */
export async function initLocalTerrain(viewer, mars, sites, hooks = {}) {
  const { scene, camera } = viewer;

  /** One site's terrain, or null if the backend has none for it. */
  async function loadSite(site) {
    let tileset;
    try {
      tileset = await Cesium.Cesium3DTileset.fromUrl(`${API_BASE}/terrain/${site.id}/tileset.json`, {
        // No camera collision here. With it on, Cesium ray-casts this tileset on the CPU every
        // frame to find the ground under the camera: ~100 ms per frame on a 2 m mesh. Ground
        // mode places the camera from the heightmap, and orbit view collides with Cesium's own
        // terrain around the site.
        enableCollision: false,
        preloadWhenHidden: true, // have the overview tile ready before we cut Cesium's ground away
        cacheBytes: 192 * 1024 * 1024, // each 2 m tile is ~8 MB on the GPU: keep the cache modest
        maximumCacheOverflowBytes: 128 * 1024 * 1024,
      });
    } catch {
      return null; // no local terrain for this site (or backend down): keep Cesium's ground
    }
    const extras = tileset.extras ?? {};
    const [west, south, east, north] = extras.bounds ?? site.bbox;

    // Move the model vertically so it meets Cesium's surrounding terrain.
    // Measured before the model is in the scene, so only Cesium's ground is sampled.
    const offset = await measureOffset(scene, extras.control_points ?? []);
    const center = Cesium.Cartesian3.fromDegrees((west + east) / 2, (south + north) / 2, 0);
    const up = Cesium.Ellipsoid.MARS.geodeticSurfaceNormal(center, new Cesium.Cartesian3());
    tileset.modelMatrix = Cesium.Matrix4.fromTranslation(
      Cesium.Cartesian3.multiplyByScalar(up, offset, new Cesium.Cartesian3()));
    tileset.show = false;
    console.info(`Local terrain for ${site.id}: shifted ${offset.toFixed(1)} m to meet Cesium's ground`);

    // The hole in Cesium's ground is slightly smaller than our model, so the two overlap at the edge.
    const dLat = Cesium.Math.toDegrees(OVERLAP_M / Cesium.Ellipsoid.MARS.maximumRadius);
    const dLon = dLat / Math.cos(Cesium.Math.toRadians((south + north) / 2));
    const hole = new Cesium.ClippingPolygon({
      positions: Cesium.Cartesian3.fromDegreesArray([
        west + dLon, south + dLat,
        east - dLon, south + dLat,
        east - dLon, north - dLat,
        west + dLon, north - dLat,
      ]),
    });
    const widthM = Cesium.Math.toRadians(north - south) * Cesium.Ellipsoid.MARS.maximumRadius;
    const local = {
      id: site.id,
      tileset,
      offset,
      hole,
      center: Cesium.Cartesian3.fromDegrees((west + east) / 2, (south + north) / 2, extras.min_height ?? 0),
      radius: Math.max(MIN_ACTIVE_WITHIN_M, ACTIVE_SPANS * widthM),
      active: false,
      heights: null, // set when the heightmap arrives
    };

    // The same DEM as a plain grid, so heights can be looked up without touching the renderer.
    // Several MB: fetched in the background so the interface doesn't wait for it.
    if (extras.heightmap) {
      fetch(`${API_BASE}/terrain/${site.id}/${extras.heightmap.uri}`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.arrayBuffer();
        })
        .then((buffer) => {
          local.heights = addHeightmap(extras.heightmap, new Uint16Array(buffer), offset);
          local.heights.visible = local.active;
          hooks.onHeights?.();
        })
        .catch((err) => console.warn('No heightmap for', site.id, '(falling back to sampling the scene)', err));
    }
    return local;
  }

  // Sites are independent: load them side by side.
  const locals = (await Promise.all(sites.map(loadSite))).filter(Boolean);
  if (locals.length === 0) return { tilesets: [], offsetFor: () => null };

  for (const l of locals) {
    scene.primitives.add(l.tileset);
    heavyTilesets.push(l.tileset);
  }
  const clipping = new Cesium.ClippingPolygonCollection({ polygons: locals.map((l) => l.hole), enabled: false });
  mars.clippingPolygons = clipping;

  let wanted = true; // the layer checkbox

  /**
   * Only cut the holes in Cesium's ground once a site that is showing has something to
   * draw. (All holes switch together; the other sites are thousands of km out of view.)
   */
  function syncHoles() {
    const ready = locals.some((l) => l.active && l.tileset.root.contentReady);
    if (clipping.enabled !== ready) {
      clipping.enabled = ready;
      scene.requestRender();
    }
  }

  function update() {
    let changed = false;
    for (const l of locals) {
      const next = wanted && Cesium.Cartesian3.distance(camera.positionWC, l.center) < l.radius;
      if (next === l.active) continue;
      l.active = next;
      l.tileset.show = next;
      if (l.heights) l.heights.visible = next;
      changed = true;
    }
    if (!changed) return;
    syncHoles();
    scene.requestRender();
    hooks.onChange?.();
  }
  for (const l of locals) l.tileset.tileLoad.addEventListener(syncHoles);
  camera.changed.addEventListener(update);
  camera.moveEnd.addEventListener(update);
  update();

  addLayerCheckbox({
    id: 'terrain',
    label: 'High-res terrain',
    checked: true,
    set(on) {
      wanted = on;
      update();
    },
  });

  return {
    tilesets: locals.map((l) => l.tileset),
    /**
     * While a site's local terrain is showing, its surface is the DEM plus this
     * many metres: contract heights + offset are exact Cesium heights. Else null.
     */
    offsetFor: (siteId) => locals.find((l) => l.id === siteId && l.active)?.offset ?? null,
  };
}
