// Ground heights by arithmetic instead of by asking the renderer.
//
// For sites with local terrain, the backend serves the DEM as a compact grid
// (heights.bin, written by data/scripts/terrain_mesh.py). Looking a height up
// here costs microseconds. The alternatives cost milliseconds each:
//   scene.sampleHeight()            renders off-screen and reads a pixel back
//   HeightReference.CLAMP_TO_3D_TILE  ray-casts the terrain triangles on the CPU
//                                     for every clamped entity when the camera moves
// With 125 rover markers on a 2 m mesh, those two were ~90% of frame time.
import * as Cesium from 'cesium';

const maps = []; // { west, south, east, north, rows, cols, data: Uint16Array, min, scale, offset }
let visible = false; // is the local terrain what's on screen right now?

/**
 * @param meta tileset.extras.heightmap: { rows, cols, bounds: [w, s, e, n], min, scale }
 *   Row 0 is the north edge. height = min + value * scale (DEM metres).
 * @param data Uint16Array, row-major
 * @param offset metres to add to DEM heights to get heights in the Cesium scene
 */
export function addHeightmap(meta, data, offset) {
  const [west, south, east, north] = meta.bounds;
  maps.push({ west, south, east, north, rows: meta.rows, cols: meta.cols, data, min: meta.min, scale: meta.scale, offset });
}

/** terrain.js reports whether the local terrain is currently shown. */
export function setLocalTerrainVisible(on) {
  visible = on;
}

/**
 * Height of our terrain surface in the Cesium scene at a lon/lat (degrees),
 * or undefined outside every heightmap.
 * By default only answers while the local terrain is on screen, because
 * otherwise the visible ground is Cesium's (a few metres different).
 * Pass { evenIfHidden: true } for things that just need a good height.
 */
export function surfaceHeightAt(lon, lat, { evenIfHidden = false } = {}) {
  if (!visible && !evenIfHidden) return undefined;
  for (const m of maps) {
    const x = ((lon - m.west) / (m.east - m.west)) * (m.cols - 1);
    const y = ((m.north - lat) / (m.north - m.south)) * (m.rows - 1);
    if (!(x >= 0 && y >= 0 && x <= m.cols - 1 && y <= m.rows - 1)) continue;
    const x0 = Math.min(Math.floor(x), m.cols - 2);
    const y0 = Math.min(Math.floor(y), m.rows - 2);
    const fx = x - x0;
    const fy = y - y0;
    const i = y0 * m.cols + x0;
    const d = m.data;
    const top = d[i] * (1 - fx) + d[i + 1] * fx;
    const bottom = d[i + m.cols] * (1 - fx) + d[i + m.cols + 1] * fx;
    return m.min + (top * (1 - fy) + bottom * fy) * m.scale + m.offset;
  }
  return undefined;
}

/**
 * Put a point/label entity on the ground at lon/lat (degrees).
 * Uses an exact height when we have one; otherwise falls back to Cesium's
 * terrain clamping (fine on Cesium's own coarse tiles).
 */
export function placeOnGround(entity, lon, lat, lift = 0) {
  const h = surfaceHeightAt(lon, lat, { evenIfHidden: true });
  const known = Number.isFinite(h);
  entity.position = known ? Cesium.Cartesian3.fromDegrees(lon, lat, h + lift) : Cesium.Cartesian3.fromDegrees(lon, lat);
  const ref = known ? Cesium.HeightReference.NONE : Cesium.HeightReference.CLAMP_TO_3D_TILE;
  if (entity.point) entity.point.heightReference = ref;
  if (entity.label) entity.label.heightReference = ref;
}
