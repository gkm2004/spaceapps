// High-resolution local terrain.
// Cesium's Mars tileset has a terrain point every ~73 m at Jezero. For sites
// where data/scripts/terrain_mesh.py has been run, the backend serves a 2 m
// terrain model built from the HiRISE DEM. Near the site we cut the zone out
// of Cesium's ground and show ours instead.
import * as Cesium from 'cesium';
import { API_BASE } from './config.js';
import { heavyTilesets, sampleTerrain } from './ground.js';
import { addHeightmap, setLocalTerrainVisible } from './heights.js';
import { addLayerCheckbox } from './layers.js';

const ACTIVE_WITHIN_M = 6000; // camera closer than this to the site centre -> local terrain
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
 * @param onChange called after the visible ground changes (things clamped to it should re-clamp)
 * @returns { tilesets: Cesium3DTileset[], offsetFor(siteId) }  local tilesets (may be empty)
 */
export async function initLocalTerrain(viewer, mars, sites, onChange) {
  const { scene, camera } = viewer;
  const locals = []; // [{ tileset, center: Cartesian3 }]
  const offsets = new Map(); // site id -> metres added to DEM heights
  const holes = [];

  for (const site of sites) {
    const url = `${API_BASE}/terrain/${site.id}/tileset.json`;
    let tileset;
    try {
      tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
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
      continue; // no local terrain for this site (or backend down): keep Cesium's ground
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
    offsets.set(site.id, offset);

    // The same DEM as a plain grid, so heights can be looked up without touching the renderer.
    if (extras.heightmap) {
      try {
        const res = await fetch(`${API_BASE}/terrain/${site.id}/${extras.heightmap.uri}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        addHeightmap(extras.heightmap, new Uint16Array(await res.arrayBuffer()), offset);
      } catch (err) {
        console.warn('No heightmap for', site.id, '(falling back to sampling the scene)', err);
      }
    }
    tileset.show = false;
    scene.primitives.add(tileset);
    heavyTilesets.push(tileset);
    console.info(`Local terrain for ${site.id}: shifted ${offset.toFixed(1)} m to meet Cesium's ground`);

    // The hole in Cesium's ground is slightly smaller than our model, so the two overlap at the edge.
    const dLat = Cesium.Math.toDegrees(OVERLAP_M / Cesium.Ellipsoid.MARS.maximumRadius);
    const dLon = dLat / Math.cos(Cesium.Math.toRadians((south + north) / 2));
    holes.push(new Cesium.ClippingPolygon({
      positions: Cesium.Cartesian3.fromDegreesArray([
        west + dLon, south + dLat,
        east - dLon, south + dLat,
        east - dLon, north - dLat,
        west + dLon, north - dLat,
      ]),
    }));
    locals.push({ tileset, center: Cesium.Cartesian3.fromDegrees((west + east) / 2, (south + north) / 2, extras.min_height ?? 0) });
  }

  if (locals.length === 0) return { tilesets: [], offsetFor: () => null };

  const clipping = new Cesium.ClippingPolygonCollection({ polygons: holes, enabled: false });
  mars.clippingPolygons = clipping;

  let wanted = true; // the layer checkbox
  let active = false;
  function update() {
    const near = locals.some((l) => Cesium.Cartesian3.distance(camera.positionWC, l.center) < ACTIVE_WITHIN_M);
    const next = wanted && near;
    if (next === active) return;
    active = next;
    for (const l of locals) l.tileset.show = active;
    setLocalTerrainVisible(active);
    syncHole();
    scene.requestRender();
    onChange?.(active);
  }
  /** Only cut the hole in Cesium's ground once our terrain has something to draw there. */
  function syncHole() {
    const ready = active && locals.every((l) => l.tileset.root.contentReady);
    if (clipping.enabled !== ready) {
      clipping.enabled = ready;
      scene.requestRender();
    }
  }
  for (const l of locals) l.tileset.tileLoad.addEventListener(syncHole);
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
    offsetFor: (siteId) => (active && offsets.has(siteId) ? offsets.get(siteId) : null),
  };
}
