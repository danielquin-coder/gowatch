/**
 * app.js - application wiring: state, persistence, the three views (Setup / Record / Review),
 * camera + tracker lifecycle, OGS login and upload.
 *
 * The in-progress game and all settings are saved to localStorage ('gowatch.session') after
 * every change, so a reload never loses a game.
 */
import { effectiveConfig, saveSettings } from './config.js';
import * as ogs from './ogs.js';
import * as vision from './vision.js';
import { Game, BLACK, WHITE, inferMove } from './game.js';
import { Camera } from './camera.js';
import { Tracker } from './tracker.js';
import { $, toast, beep, coordLabel, drawBoard, pointToIntersection, Stage } from './ui.js';

const KEY = 'gowatch.session';
const DEFAULT_CORNERS = [[0.28, 0.18], [0.72, 0.18], [0.72, 0.82], [0.28, 0.82]];

const S = {
  game: new Game(), size: 19, komi: 6.5, names: { black: '', white: '' },
  corners: DEFAULT_CORNERS.map((c) => [...c]), calibrated: false, sens: 50, swap: false,
  view: 'setup', result: { winner: '', how: 'score', points: '' }, startedAt: null,
  paused: false, status: { state: 'idle' }, testMode: false,
};
let ambiguousGrid = null;
let collectionsLoaded = false;

/* ------------------------------------------------------------------ persistence */

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      game: S.game.toJSON(), size: S.size, komi: S.komi, names: S.names, corners: S.corners, calibrated: S.calibrated,
      sens: S.sens, swap: S.swap, result: S.result, startedAt: S.startedAt,
    }));
  } catch { /* storage full or blocked */ }
}

function load() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!o) return;
    S.game = Game.fromJSON(o.game);
    Object.assign(S, { size: o.size, komi: o.komi, names: o.names || S.names, corners: o.corners || S.corners, calibrated: !!o.calibrated,
      sens: o.sens ?? 50, swap: !!o.swap, result: o.result || S.result, startedAt: o.startedAt || null });
  } catch (e) { console.warn('could not restore session', e); }
}

/* ------------------------------------------------------------------ camera, stage, tracker */

const camera = new Camera($('video'));
const stageEl = $('stage');

const stage = new Stage({
  video: $('video'), overlay: $('overlay'), magnifier: $('magnifier'), hint: $('stage-hint'),
  getCorners: () => S.corners, getSize: () => S.size,
  setCorner: (i, p) => { S.corners[i] = p; S.calibrated = true; },
  onCornersChanged: () => { vision.clearBaseline(); save(); },
});

const tracker = new Tracker({
  camera, vision,
  getGame: () => S.game, getCorners: () => S.corners, getSize: () => S.size,
  getParams: () => ({ sensitivity: S.sens / 100 }), getSwap: () => S.swap,
  onFrame: (det) => {
    stage.det = det; stage.draw();
    if (S.testMode && S.view === 'setup') vision.drawDebug($('debug-canvas').getContext('2d'), det, S.size);
  },
  onStatus: (st) => {
    S.status = st;
    if (st.state === 'stable' && !st.note) $('banner').hidden = true;
    renderStatus();
  },
  onMove: (info) => {
    beep(info.color === BLACK ? 740 : 560);
    navigator.vibrate?.(60);
    if (info.outOfTurn) toast(`Out of turn: ${info.color === BLACK ? 'Black' : 'White'} played (expected ${S.game.toPlay === BLACK ? 'Black' : 'White'} next)`);
    $('banner').hidden = true;
    save(); renderRecord();
  },
  onInitial: (grid) => { toast(`Recorded ${grid.filter((v) => v).length} starting stones (handicap / setup)`); save(); renderRecord(); },
  onAmbiguous: (info, grid) => {
    ambiguousGrid = grid;
    $('banner-text').textContent = `Check board - ${info.diffs.length} point${info.diffs.length === 1 ? '' : 's'} differ from the record`;
    $('banner').hidden = false;
    navigator.vibrate?.([40, 60, 40]);
  },
});

async function startCamera() {
  try {
    await camera.start();
  } catch (e) {
    toast('Camera error: ' + (e.message || e), 5000);
    return false;
  }
  const v = $('video');
  stageEl.style.setProperty('--ar', v.videoWidth / v.videoHeight);
  stageEl.classList.add('on');
  $('btn-camera').textContent = 'Stop camera';
  $('btn-torch').hidden = !camera.torchSupported;
  stage.draw();
  loadOpenCV();
  syncTracker();
  return true;
}

function stopCamera() {
  tracker.stop(); camera.stop();
  stageEl.classList.remove('on');
  $('btn-camera').textContent = 'Start camera';
}

function loadOpenCV() {
  if (vision.hasOpenCV()) return;
  const box = $('cv-progress'), bar = $('cv-bar'), label = $('cv-label');
  box.hidden = false;
  vision.loadOpenCV((f) => {
    if (f == null) { bar.classList.add('indet'); label.textContent = 'Loading OpenCV (about 10 MB, cached afterwards)...'; }
    else { bar.classList.remove('indet'); bar.style.width = f * 100 + '%'; label.textContent = `Loading OpenCV ${Math.round(f * 100)}%`; }
  }).then(() => { box.hidden = true; toast('OpenCV ready'); })
    .catch((e) => { label.textContent = 'OpenCV unavailable - using the built-in warp'; console.warn(e); setTimeout(() => { box.hidden = true; }, 5000); });
}

/** Start/stop the tracker to match the current view and settings. */
function syncTracker() {
  if (!camera.active) return;
  if (S.view === 'record' && !S.paused) { if (!tracker.running || tracker.mode !== 'record') tracker.start('record'); }
  else if (S.view === 'setup' && S.testMode) { if (!tracker.running || tracker.mode !== 'test') tracker.start('test'); }
  else if (tracker.running) tracker.stop();
}

/* ------------------------------------------------------------------ views */

function setView(v) {
  S.view = v;
  for (const id of ['setup', 'record', 'review']) $('view-' + id).hidden = id !== v;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  const holder = v === 'setup' ? $('slot-setup') : v === 'record' ? $('slot-record') : null;
  if (holder) { holder.appendChild(stageEl); stageEl.hidden = false; $('video').play?.().catch(() => {}); }
  else { stageEl.hidden = true; document.body.appendChild(stageEl); }
  if (v === 'record') { (camera.active ? Promise.resolve(true) : startCamera()).then(syncTracker); renderRecord(); }
  if (v === 'review') { tracker.stop(); if (camera.active) stopCamera(); renderReview(); maybeLoadCollections(); }
  if (v === 'setup') { renderSetup(); }
  syncTracker();
  stage.draw();
  window.scrollTo(0, 0);
}

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

/* ------------------------------------------------------------------ setup view */

function renderSetup() {
  $('name-black').value = S.names.black;
  $('name-white').value = S.names.white;
  $('board-size').value = String(S.size);
  $('komi').value = S.komi;
  $('sens').value = S.sens; $('sens-out').textContent = S.sens;
  const n = S.game.moveCount;
  $('btn-start-rec').textContent = n ? `Resume recording (${n} move${n === 1 ? '' : 's'} so far)` : 'Start recording';
  $('board-size').disabled = S.game.nodes.length > 0;
  $('size-note').textContent = S.game.nodes.length ? 'A game is in progress - board size is locked. Use New game on the Review tab to start over.' : '';
  renderAccount();
}

$('name-black').addEventListener('input', (e) => { S.names.black = e.target.value; save(); });
$('name-white').addEventListener('input', (e) => { S.names.white = e.target.value; save(); });
$('komi').addEventListener('change', (e) => { const k = parseFloat(e.target.value); S.komi = Number.isFinite(k) ? k : 6.5; S.game.komi = S.komi; save(); });
$('board-size').addEventListener('change', (e) => {
  if (S.game.nodes.length) { e.target.value = S.size; return; }
  S.size = +e.target.value; S.game = new Game({ size: S.size, komi: S.komi });
  vision.clearBaseline(); save(); stage.draw();
});
$('sens').addEventListener('input', (e) => { S.sens = +e.target.value; $('sens-out').textContent = S.sens; save(); });
$('test-mode').addEventListener('change', (e) => {
  S.testMode = e.target.checked; $('test-wrap').hidden = !S.testMode;
  if (!S.testMode) { stage.det = null; stage.draw(); }
  syncTracker();
  if (S.testMode && !camera.active) toast('Start the camera to see live classification');
});
$('btn-camera').addEventListener('click', () => (camera.active ? stopCamera() : startCamera()));
$('btn-torch').addEventListener('click', async () => {
  $('btn-torch').dataset.on = $('btn-torch').dataset.on === '1' ? '' : '1';
  try { await camera.setTorch(!!$('btn-torch').dataset.on); } catch { toast('Torch not available'); }
});
$('btn-corners').addEventListener('click', () => {
  if (!camera.active) return toast('Start the camera first');
  stage.det = null; stage.startPlacing();
});
$('btn-baseline').addEventListener('click', () => {
  if (!camera.active) return toast('Start the camera first');
  if (!S.calibrated) return toast('Set the 4 corners first');
  vision.calibrateOnEmptyBoard(camera.grab(720), S.corners, S.size, { sensitivity: S.sens / 100 });
  toast('Empty board remembered - detection will use it as a baseline');
});
$('btn-start-rec').addEventListener('click', async () => {
  if (!S.calibrated) return toast('Tap the 4 corners of the board first');
  beep(660, 0.05); // also unlocks WebAudio on iOS
  if (!S.startedAt) S.startedAt = Date.now();
  save();
  setView('record');
});

/* ------------------------------------------------------------------ account (OGS) */

function renderAccount() {
  const me = ogs.isLoggedIn() ? ogs.cachedMe() : null, inn = ogs.isLoggedIn();
  $('account-in').hidden = !inn; $('account-out').hidden = inn;
  if (inn) { $('username').textContent = me?.username || 'OGS user'; if (me?.icon) $('avatar').src = me.icon; else $('avatar').removeAttribute('src'); }
  if (!ogs.isConfigured() && !inn) { $('account-msg').textContent = 'No OGS client id yet - open Settings (gear icon) to add one.'; $('account-msg').className = 'msg'; }
  else if ($('account-msg').className === 'msg' || inn) $('account-msg').textContent = '';
}

function applyMe(me) {
  if (me && !S.names.black) { S.names.black = me.username; save(); }
  renderAccount(); renderSetup();
}

$('btn-login').addEventListener('click', async () => {
  if (!ogs.isConfigured()) { toast('Add your OGS client id in Settings first'); return openSettings(); }
  try { await ogs.login(); } catch (e) { $('account-msg').textContent = e.message; $('account-msg').className = 'msg err'; }
});
$('btn-logout').addEventListener('click', () => { ogs.logout(); collectionsLoaded = false; renderAccount(); });

try { new BroadcastChannel('gowatch-oauth').onmessage = (e) => onOAuthResult(e.data); } catch { /* unsupported */ }
window.addEventListener('storage', (e) => { if (e.key === 'gowatch.oauth.result' && e.newValue) onOAuthResult(JSON.parse(e.newValue)); });
function onOAuthResult(r) {
  if (r?.ok) { toast(`Logged in as ${r.username}`); applyMe(ogs.cachedMe()); }
  else if (r) { $('account-msg').textContent = 'Login failed: ' + r.error; $('account-msg').className = 'msg err'; }
}

/* ------------------------------------------------------------------ settings dialog */

function openSettings() {
  const c = effectiveConfig();
  $('set-client').value = c.OGS_CLIENT_ID; $('set-proxy').value = c.PROXY_BASE; $('set-redirect').value = c.REDIRECT_URI;
  $('dlg-settings').returnValue = '';
  $('dlg-settings').showModal();
}
$('btn-settings').addEventListener('click', openSettings);
$('set-redirect').addEventListener('focus', (e) => e.target.select());
$('dlg-settings').addEventListener('close', () => {
  if ($('dlg-settings').returnValue === 'save') {
    saveSettings({ clientId: $('set-client').value, proxy: $('set-proxy').value });
    toast('Settings saved'); renderAccount();
  }
});
$('set-reset').addEventListener('click', () => {
  if (!confirm('Delete the saved game, settings and OGS login from this browser?')) return;
  try { Object.keys(localStorage).filter((k) => k.startsWith('gowatch.')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  location.reload();
});

/* ------------------------------------------------------------------ record view */

const sideName = (c) => (c === BLACK ? 'Black' : 'White');

/** Move numbers for stones on the board + list rows. */
function numbering() {
  const numbers = new Map(), rows = [];
  let n = 0, last = -1;
  S.game.nodes.forEach((nd) => {
    if (nd.type === 'move') {
      n++;
      for (const i of nd.captured) numbers.delete(i);
      last = nd.y * S.size + nd.x; numbers.set(last, n);
      rows.push({ n, color: nd.color, text: coordLabel(nd.x, nd.y, S.size) + (nd.captured.length ? ` x${nd.captured.length}` : '') });
    } else if (nd.type === 'pass') { n++; last = -1; rows.push({ n, color: nd.color, text: 'pass' }); }
    else {
      for (const i of [...nd.AE, ...nd.AB, ...nd.AW]) numbers.delete(i);
      rows.push({ n: '', color: 0, text: `setup +${nd.AB.length}B +${nd.AW.length}W -${nd.AE.length}` });
    }
  });
  return { numbers, last, rows };
}

function renderRecord() {
  const { numbers, last, rows } = numbering();
  drawBoard($('diagram'), S.game.grid, S.size, { numbers, last });
  const ol = $('movelist');
  ol.replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="n">${r.n}</span><span>${r.color ? sideName(r.color) : ''} ${r.text}</span>`;
    return li;
  }));
  ol.scrollTop = ol.scrollHeight;
  renderStatus();
}

function renderStatus() {
  const g = S.game, st = S.status;
  $('turn-dot').classList.toggle('w', g.toPlay === WHITE);
  const label = S.paused ? 'paused' : ({
    idle: 'camera idle', motion: 'motion...', stable: 'stable', ambiguous: 'check board',
    watching: `watching... ${st.stable || 0}/${st.need || ''}`,
  }[st.state] || st.state);
  $('status-text').textContent = `${sideName(g.toPlay)} to play · move ${g.moveCount + 1} · ${label}${st.note ? ' · ' + st.note : ''}`;
}

$('btn-pass').addEventListener('click', () => { S.game.pass(S.game.toPlay); save(); renderRecord(); toast('Pass recorded'); });
$('btn-undo').addEventListener('click', () => {
  const physical = Int8Array.from(S.game.grid), nd = S.game.undo();
  if (!nd) return toast('Nothing to undo');
  if (nd.type === 'move' || nd.type === 'setup') tracker.noteUndo(physical);
  save(); renderRecord();
  toast(nd.type === 'move' ? 'Undone - remove that stone from the board' : 'Undone');
});
$('btn-swap').addEventListener('click', (e) => {
  S.swap = !S.swap; e.target.setAttribute('aria-pressed', S.swap); tracker.cand = null; save();
  toast(S.swap ? 'Colors swapped: camera black = SGF white' : 'Colors normal');
});
$('btn-pause').addEventListener('click', (e) => {
  S.paused = !S.paused; e.target.textContent = S.paused ? 'Resume' : 'Pause';
  syncTracker(); renderStatus();
});
$('btn-end').addEventListener('click', () => ($('dlg-end').returnValue = '', $('dlg-end').showModal()));
$('dlg-end').addEventListener('close', () => {
  const v = $('dlg-end').returnValue;
  if (v === 'BR') S.result = { winner: 'W', how: 'R', points: '' };
  else if (v === 'WR') S.result = { winner: 'B', how: 'R', points: '' };
  else if (v !== 'score') return;
  save(); setView('review');
});
$('banner-x').addEventListener('click', () => { $('banner').hidden = true; tracker.dismiss(); });
$('banner-fix').addEventListener('click', () => openFix(ambiguousGrid || S.game.grid));
$('btn-fix').addEventListener('click', () => openFix(S.game.grid));
window.addEventListener('resize', () => { if (S.view === 'record') renderRecord(); if (S.view === 'review') renderReview(); });

/* ---- correction dialog ---- */

const fix = { grid: null };

function fixRedraw() {
  const base = S.game.grid, marks = new Set();
  for (let i = 0; i < base.length; i++) if (base[i] !== fix.grid[i]) marks.add(i);
  drawBoard($('fix-board'), fix.grid, S.size, { marks });
  const r = inferMove(base, fix.grid, S.game.toPlay);
  $('fix-result').textContent = r.type === 'none' ? 'Matches the recorded game - nothing to change.'
    : r.type === 'move' ? `Will be recorded as a move: ${sideName(r.color)} ${coordLabel(r.x, r.y, S.size)}${r.captured.length ? ` (captures ${r.captured.length})` : ''}.`
      : `Will be recorded as a board setup change (${marks.size} point${marks.size === 1 ? '' : 's'}; written as AB/AW/AE in the SGF).`;
}

function openFix(initial) {
  fix.grid = Int8Array.from(initial);
  $('dlg-fix').returnValue = '';
  $('dlg-fix').showModal();
  requestAnimationFrame(fixRedraw);
}
$('fix-board').addEventListener('click', (e) => {
  const i = pointToIntersection($('fix-board'), e, S.size);
  if (i < 0) return;
  fix.grid[i] = (fix.grid[i] + 1) % 3;
  fixRedraw();
});
$('fix-reset').addEventListener('click', () => { fix.grid = Int8Array.from(S.game.grid); fixRedraw(); });
$('dlg-fix').addEventListener('close', () => {
  if ($('dlg-fix').returnValue !== 'accept') return;
  const r = inferMove(S.game.grid, fix.grid, S.game.toPlay);
  if (r.type === 'move') {
    if (!S.game.play(r.color, r.x, r.y).ok) S.game.setBoard(fix.grid);
  } else if (r.type !== 'none') S.game.setBoard(fix.grid);
  $('banner').hidden = true; tracker.cand = null; tracker.ambKey = ''; tracker.ignore = null;
  save(); renderRecord();
});

/* ------------------------------------------------------------------ review view */

function resultString() {
  const { winner, how, points } = S.result;
  if (!winner) return '';
  if (winner === '0') return '0';
  if (how === 'score') return points === '' || points == null ? '' : `${winner}+${points}`;
  return `${winner}+${how}`;
}

function buildSGF() {
  return S.game.toSGF({
    komi: S.komi, playerBlack: S.names.black || 'Black', playerWhite: S.names.white || 'White',
    result: resultString(), date: new Date(S.startedAt || Date.now()), app: 'GoWatch',
  });
}

function renderReview() {
  const { numbers, last } = numbering();
  drawBoard($('final-board'), S.game.grid, S.size, { numbers, last });
  const caps = S.game.nodes.reduce((a, n) => a + (n.captured?.length || 0), 0);
  $('review-summary').textContent = `${S.game.moveCount} moves, ${caps} stones captured, ${S.size}x${S.size}, komi ${S.komi}`;
  $('res-winner').value = S.result.winner; $('res-how').value = S.result.how; $('res-points').value = S.result.points;
  $('res-points').disabled = S.result.how !== 'score' || S.result.winner === '0';
  $('res-string').textContent = resultString() || '(none)';
  $('sgf-preview').value = buildSGF();
}

for (const id of ['res-winner', 'res-how', 'res-points']) {
  $(id).addEventListener('input', () => {
    S.result = { winner: $('res-winner').value, how: $('res-how').value, points: $('res-points').value };
    save(); renderReview();
  });
}

const sgfFile = () => new File([buildSGF()], ogs.sgfFilename(new Date(S.startedAt || Date.now())), { type: 'application/x-go-sgf' });
function say(msg, cls = '') { const m = $('upload-msg'); m.textContent = msg; m.className = 'msg ' + cls; }

$('btn-upload').addEventListener('click', async () => {
  if (!ogs.isLoggedIn()) return say('Log in to OGS first (Setup tab). You can still download or share the SGF.', 'err');
  if (!S.game.nodes.length) return say('No moves recorded yet.', 'err');
  $('btn-upload').disabled = true; say('Uploading...');
  try {
    const f = sgfFile();
    await ogs.uploadSGF(await f.text(), f.name, +$('collection').value || 0);
    say(`Uploaded ${f.name} to your OGS library.`, 'ok');
  } catch (e) {
    say(e.message + (e instanceof ogs.OgsNetworkError || e instanceof ogs.OgsHttpError ? ' - Use Download SGF or Share SGF as a fallback.' : ''), 'err');
  } finally { $('btn-upload').disabled = false; }
});

$('btn-download').addEventListener('click', () => {
  const f = sgfFile(), a = document.createElement('a');
  a.href = URL.createObjectURL(f); a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('btn-share').addEventListener('click', async () => {
  const f = sgfFile();
  try {
    if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], title: f.name });
    else if (navigator.share) await navigator.share({ title: f.name, text: buildSGF() });
    else { say('Sharing is not supported here - use Download SGF.', 'err'); }
  } catch (e) { if (e.name !== 'AbortError') say('Share failed: ' + e.message, 'err'); }
});

async function maybeLoadCollections() {
  if (collectionsLoaded || !ogs.isLoggedIn()) return;
  try {
    const me = await ogs.getMe();
    const cols = await ogs.listCollections(me.id);
    const sel = $('collection'), depth = (c) => { let d = 0, p = c; while (p && p.parent && d < 8) { p = cols.find((x) => x.id === p.parent); d++; } return d; };
    sel.replaceChildren(new Option('Library (root)', '0'), ...cols.map((c) => new Option(' '.repeat(depth(c)) + c.name + (c.private ? ' (private)' : ''), String(c.id))));
    collectionsLoaded = true;
  } catch { /* optional feature: keep the root option */ }
}

$('btn-back-rec').addEventListener('click', () => setView('record'));
$('btn-new').addEventListener('click', () => {
  if (S.game.nodes.length && !confirm('Start a new game? The current record will be removed from this device (download or upload it first).')) return;
  S.game = new Game({ size: S.size, komi: S.komi }); S.startedAt = null; S.result = { winner: '', how: 'score', points: '' };
  S.paused = false; $('btn-pause').textContent = 'Pause'; say('');
  save(); setView('setup');
});

/* ------------------------------------------------------------------ boot */

load();
$('test-wrap').hidden = true;
$('btn-swap').setAttribute('aria-pressed', S.swap);
renderSetup();
setView('setup');
if (ogs.isLoggedIn()) { applyMe(ogs.cachedMe()); ogs.getMe(true).then(applyMe).catch(() => {}); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
