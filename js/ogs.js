/**
 * ogs.js - online-go.com OAuth2 (Authorization Code + PKCE, public client) and REST helpers.
 * See https://docs.online-go.com/oauth2.html
 *
 *  login()               redirects to the OGS authorize page
 *  handleCallback(qs)    exchanges ?code&state for tokens (used by callback.html)
 *  getAccessToken()      returns a valid token, refreshing it when expired
 *  getMe()               GET /api/v1/me/
 *  listCollections(id)   GET /api/v1/library/{id} -> [{id,name,private,parent}]
 *  uploadSGF(...)        POST /api/v1/me/games/sgf/{collection} (multipart, field "file")
 *
 * If config.PROXY_BASE is set, every REST call (including the token endpoint) goes via the proxy.
 * A fetch TypeError (usually CORS) is rethrown as OgsNetworkError with advice about the proxy.
 */
import { effectiveConfig } from './config.js';

const TOKEN_KEY = 'gowatch.tokens';
const PENDING_KEY = 'gowatch.oauth.pending';
const ME_KEY = 'gowatch.me';

export class OgsNetworkError extends Error {}
export class OgsHttpError extends Error {
  constructor(status, body) {
    super(`OGS returned HTTP ${status}${body ? ': ' + String(body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : ''}`
      + (status === 401 ? ' (not authorized - log out and log in again)' : ''));
    this.status = status;
  }
}

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (n = 64) => b64url(crypto.getRandomValues(new Uint8Array(n))).slice(0, n);
export const pkceChallenge = async (verifier) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));

/** URL for a REST path: via the proxy when configured, else straight to OGS. */
export function apiUrl(path) {
  const c = effectiveConfig();
  return (c.PROXY_BASE || c.OGS_BASE) + path;
}

export const isConfigured = () => !!effectiveConfig().OGS_CLIENT_ID;
export const isLoggedIn = () => !!store.get(TOKEN_KEY)?.access_token;
export const cachedMe = () => store.get(ME_KEY);

/** Start the login flow (full-page redirect; works best on phones and installed PWAs). */
export async function login() {
  const c = effectiveConfig();
  if (!c.OGS_CLIENT_ID) throw new Error('Set your OGS client id in Settings first.');
  const verifier = randomString(64), state = randomString(24);
  store.set(PENDING_KEY, { verifier, state, redirect: c.REDIRECT_URI, t: Date.now() });
  const q = new URLSearchParams({
    client_id: c.OGS_CLIENT_ID, response_type: 'code', redirect_uri: c.REDIRECT_URI,
    scope: 'read write', state, code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256',
  });
  location.href = `${c.OGS_BASE}/oauth2/authorize/?${q.toString().replace(/%20/g, '+')}`;
}

export function logout() { store.del(TOKEN_KEY); store.del(ME_KEY); }

async function tokenRequest(params) {
  const c = effectiveConfig();
  let res;
  try {
    res = await fetch(apiUrl('/oauth2/token/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...params, client_id: c.OGS_CLIENT_ID }).toString(),
    });
  } catch (e) { throw networkError(e); }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok || !json?.access_token) throw new OgsHttpError(res.status, json?.error_description || json?.error || text);
  // a refresh response may omit refresh_token: keep the old one
  const old = store.get(TOKEN_KEY);
  const tokens = { ...json, refresh_token: json.refresh_token || old?.refresh_token, expires_at: Date.now() + (json.expires_in || 3600) * 1000 };
  store.set(TOKEN_KEY, tokens);
  return tokens;
}

/** Complete the login: `search` is location.search of callback.html. Returns the OGS user. */
export async function handleCallback(search) {
  const q = new URLSearchParams(search);
  if (q.get('error')) throw new Error(q.get('error_description') || q.get('error'));
  const code = q.get('code'), state = q.get('state');
  const pending = store.get(PENDING_KEY);
  if (!code) throw new Error('No authorization code in the redirect.');
  if (!pending || pending.state !== state) throw new Error('Login state mismatch (start the login again from GoWatch).');
  store.del(PENDING_KEY); // single use
  await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: pending.redirect, code_verifier: pending.verifier });
  // tokens are already stored; a failed profile fetch must not turn the login into a failure
  return getMe(true).catch(() => cachedMe() || { username: 'OGS user' });
}

/** Returns a valid access token, refreshing it (30-day tokens) when it expires within a minute. */
export async function getAccessToken() {
  let t = store.get(TOKEN_KEY);
  if (!t) throw new Error('Not logged in to OGS.');
  if (t.expires_at - 60000 < Date.now()) {
    if (!t.refresh_token) { logout(); throw new Error('OGS session expired - please log in again.'); }
    try { t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token }); }
    catch (e) { if (e instanceof OgsHttpError) { logout(); throw new Error('OGS session expired - please log in again.'); } throw e; }
  }
  return t.access_token;
}

function networkError(e) {
  const proxy = effectiveConfig().PROXY_BASE;
  return new OgsNetworkError(proxy
    ? `Could not reach the GoWatch proxy (${proxy}). Check the URL in Settings and that the worker is deployed.`
    : 'The browser could not reach online-go.com (probably blocked by CORS or you are offline). '
      + 'Deploy the small proxy in proxy/worker.js and set its URL in Settings, or use Download / Share SGF instead.');
}

/** Authenticated fetch against the OGS API. Retries once after a 401 with a refreshed token. */
export async function ogsFetch(path, init = {}, retry = true) {
  const token = await getAccessToken();
  let res;
  try {
    res = await fetch(apiUrl(path), { ...init, headers: { Accept: 'application/json', ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  } catch (e) { throw networkError(e); }
  if (res.status === 401 && retry) {
    const t = store.get(TOKEN_KEY);
    if (t) store.set(TOKEN_KEY, { ...t, expires_at: 0 });
    return ogsFetch(path, init, false);
  }
  if (!res.ok) throw new OgsHttpError(res.status, await res.text().catch(() => ''));
  return res;
}

export async function getMe(force = false) {
  if (!force && cachedMe()) return cachedMe();
  const me = await (await ogsFetch('/api/v1/me/')).json();
  const slim = { id: me.id, username: me.username, icon: me.icon, ranking: me.ranking };
  store.set(ME_KEY, slim);
  return slim;
}

/** Collections of a player's library, flattened to objects. */
export async function listCollections(playerId) {
  const data = await (await ogsFetch(`/api/v1/library/${playerId}`)).json();
  return (data.collections || []).map(([id, name, priv, parent]) => ({ id, name, private: !!priv, parent }));
}

export const sgfFilename = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `GoWatch-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.sgf`;
};

/** Upload SGF text to the library. collectionId 0 = root collection. */
export async function uploadSGF(sgf, filename = sgfFilename(), collectionId = 0) {
  const fd = new FormData();
  fd.append('file', new File([sgf], filename, { type: 'application/x-go-sgf' }));
  const res = await ogsFetch(`/api/v1/me/games/sgf/${collectionId}`, { method: 'POST', body: fd });
  return res.json().catch(() => ({}));
}
