// Layer panel. Layers are imagery draped over the Mars 3D tileset
// (the ellipsoid globe is hidden, so viewer.imageryLayers would show nothing).
import * as Cesium from 'cesium';
import { dangerTileUrl, getDangerTileInfo } from './api.js';

/** Imagery layer for one site's danger tiles (CONTRACT.md: /tiles/{site}/danger/{z}/{x}/{y}.png). */
async function createDangerLayer(site) {
  // tiles.json (written by data/scripts/danger_tiles.py) has the exact bounds and zoom range.
  const info = await getDangerTileInfo(site.id).catch(() => null);
  const [west, south, east, north] = info?.bounds ?? site.bbox;
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: dangerTileUrl(site.id),
    // Same scheme the tiles were cut in: 2x1 tiles at level 0, y counted from the north.
    tilingScheme: new Cesium.GeographicTilingScheme({ ellipsoid: Cesium.Ellipsoid.MARS }),
    rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north),
    minimumLevel: info?.minzoom ?? 10,
    maximumLevel: info?.maxzoom ?? 15,
    tileWidth: 256,
    tileHeight: 256,
  });
  return new Cesium.ImageryLayer(provider);
}

/**
 * Builds the layer panel.
 * @param viewer Cesium viewer
 * @param tilesets every terrain tileset to drape on: the global Mars tileset plus any local high-res terrain
 * @param sites entries from /api/sites
 * @param onError (message) => void
 */
export function initLayers(viewer, tilesets, sites, onError) {
  const legend = document.getElementById('danger-legend');
  let dangerLayers = null; // created on first use

  const layers = [
    {
      id: 'danger',
      label: 'Slope danger',
      async set(on) {
        if (on && !dangerLayers) {
          // an ImageryLayer belongs to one tileset, so each tileset gets its own copy
          dangerLayers = [];
          for (const tileset of tilesets) {
            for (const layer of await Promise.all(sites.map(createDangerLayer))) {
              dangerLayers.push(layer);
              tileset.imageryLayers.add(layer);
            }
          }
          for (const layer of dangerLayers) {
            layer.imageryProvider.errorEvent.addEventListener((err) => {
              // Tiles outside the data simply don't exist; only report a dead server once.
              if (err.timesRetried === 0 && !(err.error?.statusCode === 404)) {
                onError('Danger tiles could not be loaded. Is the backend running?');
              }
            });
          }
        }
        for (const layer of dangerLayers ?? []) layer.show = on;
        legend.hidden = !on;
        viewer.scene.requestRender();
      },
    },
  ];

  for (const layer of layers) addLayerCheckbox(layer, onError);
}

/**
 * Add a checkbox to the layer panel.
 * @param layer { id, label, checked?, set(on) } where set may be async
 */
export function addLayerCheckbox(layer, onError = console.error) {
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = `layer-${layer.id}`;
  box.checked = Boolean(layer.checked);
  box.addEventListener('change', async () => {
    box.disabled = true;
    try {
      await layer.set(box.checked);
    } catch (err) {
      console.error(err);
      box.checked = false;
      onError(`Could not load layer "${layer.label}": ${err.message ?? err}`);
    } finally {
      box.disabled = false;
    }
  });
  label.append(box, ` ${layer.label}`);
  document.getElementById('layer-list').append(label);
}
