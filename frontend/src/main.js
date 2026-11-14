import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import { CESIUM_ION_TOKEN, USE_MOCK, API_BASE } from './config.js';
import { getSites } from './api.js';
import { createGlobe, flyToSite } from './globe.js';

const statusEl = document.getElementById('status');
function showStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
  statusEl.hidden = !msg;
}

const { viewer, tilesetReady } = createGlobe('globe');
window.viewer = viewer; // handy for debugging in the console

if (!CESIUM_ION_TOKEN) {
  showStatus('No Cesium ion token: set VITE_CESIUM_ION_TOKEN in the repo-root .env and restart npm run dev.', true);
}
tilesetReady.catch((err) => {
  console.error(err);
  showStatus(`Could not load the Mars tileset: ${err.message ?? err}`, true);
});

// Site buttons
const sitesEl = document.getElementById('sites');
getSites()
  .then((sites) => {
    for (const site of sites) {
      const btn = document.createElement('button');
      btn.textContent = site.name;
      btn.title = `Fly to ${site.name}`;
      btn.addEventListener('click', () => flyToSite(viewer, site));
      sitesEl.appendChild(btn);
    }
  })
  .catch((err) => {
    console.error(err);
    showStatus(`Could not load sites: ${err.message}`, true);
  });

console.info(`Mars Map: data source = ${USE_MOCK ? 'mock files' : API_BASE}`);
