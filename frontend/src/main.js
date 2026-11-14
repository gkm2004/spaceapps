// Env vars come from the repo-root .env (see vite.config.js envDir).
export const config = {
  cesiumIonToken: import.meta.env.VITE_CESIUM_ION_TOKEN ?? '',
  cesiumMarsAssetId: import.meta.env.VITE_CESIUM_MARS_ASSET_ID ?? '',
  apiBase: import.meta.env.VITE_API_BASE ?? 'http://localhost:8000',
};

document.getElementById('config').textContent = [
  `Cesium ion token: ${config.cesiumIonToken ? 'set' : 'not set'}`,
  `Cesium Mars asset id: ${config.cesiumMarsAssetId || 'not set'}`,
  `API base: ${config.apiBase}`,
].join('\n');
