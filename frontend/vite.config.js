import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// Cesium loads Workers/Assets/Widgets/ThirdParty at runtime, so they're served
// as static files under /cesium/ (window.CESIUM_BASE_URL is set in globe.js).
const cesiumSource = 'node_modules/cesium/Build/Cesium';

export default defineConfig({
  // .env lives at the repo root, next to .env.example
  envDir: '..',
  plugins: [
    viteStaticCopy({
      targets: ['ThirdParty', 'Workers', 'Assets', 'Widgets'].map((dir) => ({
        src: `${cesiumSource}/${dir}`,
        dest: 'cesium',
        // strip "node_modules/cesium/Build/Cesium" -> cesium/Workers/...
        rename: { stripBase: 4 },
      })),
    }),
  ],
  build: {
    chunkSizeWarningLimit: 5000, // Cesium itself is ~4 MB
  },
});
