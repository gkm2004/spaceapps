// All runtime config. Values come from the repo-root .env (vite.config.js envDir).
const env = import.meta.env;

// The single mock/real switch: true = read frontend/mock/*.json,
// false = call the API at API_BASE. Override with VITE_USE_MOCK=false in .env.
export const USE_MOCK = (env.VITE_USE_MOCK ?? 'true') !== 'false';

export const API_BASE = (env.VITE_API_BASE || 'http://localhost:8000').replace(/\/$/, '');

export const CESIUM_ION_TOKEN = env.VITE_CESIUM_ION_TOKEN || '';

// 3644333 is the "Cesium Mars" 3D Tiles asset used in Cesium's Mars example.
export const CESIUM_MARS_ASSET_ID = Number(env.VITE_CESIUM_MARS_ASSET_ID) || 3644333;
