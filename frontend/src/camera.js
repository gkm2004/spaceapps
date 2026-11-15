// Camera helpers shared by the UI.
import * as Cesium from 'cesium';

/** World position at the centre of the screen: on the terrain if possible, else on the ellipsoid. */
export function screenCenterPosition(viewer) {
  const { scene } = viewer;
  const center = new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
  if (scene.pickPositionSupported) {
    const hit = scene.pickPosition(center);
    if (Cesium.defined(hit)) return hit;
  }
  return scene.camera.pickEllipsoid(center, Cesium.Ellipsoid.MARS);
}

/**
 * "Map view": fly to a top-down, north-up view of whatever is at the centre
 * of the screen, keeping roughly the same distance from it.
 */
export function flyToMapView(viewer, duration = 1.5) {
  const { camera } = viewer;
  const target = screenCenterPosition(viewer);
  let lon;
  let lat;
  let height;
  if (Cesium.defined(target)) {
    const c = Cesium.Cartographic.fromCartesian(target);
    const range = Cesium.Cartesian3.distance(camera.positionWC, target);
    [lon, lat, height] = [c.longitude, c.latitude, c.height + range];
  } else {
    // Looking at space: go straight down from where the camera is.
    const c = camera.positionCartographic;
    [lon, lat, height] = [c.longitude, c.latitude, c.height];
  }
  camera.flyTo({
    destination: Cesium.Cartesian3.fromRadians(lon, lat, height),
    orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    duration,
  });
}

/**
 * Live readout of the lon/lat under the mouse cursor, in the contract's
 * convention (degrees, east-positive longitude), plus the camera altitude.
 */
export function initCoordinateReadout(viewer, element) {
  const { scene } = viewer;
  let pending = null; // latest mouse position, handled once per animation frame

  function format(position) {
    const altKm = scene.camera.positionCartographic.height / 1000;
    const alt = altKm >= 10 ? `${altKm.toFixed(0)} km` : `${(altKm * 1000).toFixed(0)} m`;
    let where = 'Lon —  Lat —';
    if (position) {
      const hit =
        (scene.pickPositionSupported && scene.pickPosition(position)) ||
        scene.camera.pickEllipsoid(position, Cesium.Ellipsoid.MARS);
      if (Cesium.defined(hit)) {
        const c = Cesium.Cartographic.fromCartesian(hit);
        if (c) {
          const lon = Cesium.Math.toDegrees(c.longitude).toFixed(4);
          const lat = Cesium.Math.toDegrees(c.latitude).toFixed(4);
          where = `Lon ${lon}°  Lat ${lat}°`;
        }
      }
    }
    return `${where}  ·  Camera ${alt}`;
  }

  let last = null;
  function update() {
    pending = null;
    element.textContent = format(last);
  }
  function schedule() {
    if (pending === null) pending = requestAnimationFrame(update);
  }

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((move) => {
    last = Cesium.Cartesian2.clone(move.endPosition, last ?? new Cesium.Cartesian2());
    schedule();
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  scene.canvas.addEventListener('mouseleave', () => {
    last = null;
    schedule();
  });
  scene.camera.changed.addEventListener(schedule); // altitude changes while flying/zooming
  scene.camera.percentageChanged = 0.01;
  update();
}
