import * as Cesium from 'cesium';
import { CESIUM_ION_TOKEN, CESIUM_MARS_ASSET_ID } from './config.js';

/**
 * Create the Mars viewer and start loading the Cesium Mars tileset.
 * Setup follows Cesium's official Mars Sandcastle example.
 * Returns { viewer, tilesetReady } where tilesetReady resolves to the tileset.
 */
export function createGlobe(container) {
  // Where vite.config.js serves Cesium's Workers/Assets/Widgets.
  window.CESIUM_BASE_URL = `${import.meta.env.BASE_URL}cesium/`;

  // Must happen before the Viewer exists: everything built afterwards
  // (Cartesian3.fromDegrees, map projection, camera math) uses Mars.
  Cesium.Ellipsoid.default = Cesium.Ellipsoid.MARS;
  Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;

  const viewer = new Cesium.Viewer(container, {
    baseLayer: false, // no Earth imagery
    baseLayerPicker: false,
    geocoder: false,
    sceneModePicker: false,
    timeline: false,
    animation: false,
    homeButton: false,
    fullscreenButton: false,
    navigationHelpButton: false,
    infoBox: false,
    selectionIndicator: false,
    shadows: false,
    globe: new Cesium.Globe(Cesium.Ellipsoid.MARS),
    skyAtmosphere: new Cesium.SkyAtmosphere(Cesium.Ellipsoid.MARS),
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
  });

  const scene = viewer.scene;
  // The 3D tileset carries the surface; the smooth ellipsoid globe stays hidden.
  scene.globe.show = false;

  // Atmosphere values from Cesium's Mars example ("to be more Mars-like").
  const sky = scene.skyAtmosphere;
  sky.atmosphereMieCoefficient = new Cesium.Cartesian3(9.0e-5, 2.0e-5, 1.0e-5);
  sky.atmosphereRayleighCoefficient = new Cesium.Cartesian3(9.0e-6, 2.0e-6, 1.0e-6);
  sky.atmosphereRayleighScaleHeight = 9000;
  sky.atmosphereMieScaleHeight = 2700.0;
  sky.saturationShift = -0.1;
  sky.perFragmentAtmosphere = true;

  const tilesetReady = Cesium.Cesium3DTileset.fromIonAssetId(CESIUM_MARS_ASSET_ID, {
    enableCollision: true, // keeps the default camera from going underground
  }).then((tileset) => {
    scene.primitives.add(tileset);
    scene.requestRender();
    return tileset;
  });

  return { viewer, tilesetReady };
}

/** Fly to a site from /api/sites, looking down at its bbox at an angle. */
export function flyToSite(viewer, site, duration = 3) {
  const [west, south, east, north] = site.bbox;
  const [lon, lat] = site.center;
  const rect = Cesium.Rectangle.fromDegrees(west, south, east, north);
  // Rough ground size of the bbox, so the whole zone fits on screen.
  const r = Cesium.Ellipsoid.MARS.maximumRadius;
  const span = Math.max(rect.width * Math.cos(rect.north) * r, rect.height * r);

  viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon, lat), span / 2),
    {
      duration,
      offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-50), span * 1.1),
    },
  );
}
