/**
 * config.js - deployment configuration.
 *
 * Fill in OGS_CLIENT_ID here, OR leave it empty and enter it in the in-app Settings
 * panel (stored in localStorage as `gowatch.clientId`). PROXY_BASE is the optional
 * Cloudflare Worker URL (see proxy/worker.js); `gowatch.proxy` overrides it.
 * All paths in the app are relative so it works from https://<user>.github.io/gowatch/.
 */
export const CONFIG = {
  OGS_CLIENT_ID: '',
  OGS_BASE: 'https://online-go.com',
  PROXY_BASE: '', // optional CORS proxy base; if set, ALL OGS REST calls go through it
  REDIRECT_URI: location.origin + location.pathname.replace(/[^/]*$/, '') + 'callback.html',
};

const read = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };

/** CONFIG merged with Settings-panel overrides from localStorage. */
export function effectiveConfig() {
  return {
    ...CONFIG,
    OGS_CLIENT_ID: read('gowatch.clientId') || CONFIG.OGS_CLIENT_ID,
    PROXY_BASE: (read('gowatch.proxy') || CONFIG.PROXY_BASE).replace(/\/+$/, ''),
  };
}

export function saveSettings({ clientId, proxy }) {
  try {
    localStorage.setItem('gowatch.clientId', (clientId || '').trim());
    localStorage.setItem('gowatch.proxy', (proxy || '').trim());
  } catch { /* storage unavailable */ }
}
