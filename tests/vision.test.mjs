// Vision test: draws a synthetic, perspective-skewed 19x19 board photo in a real browser
// (Playwright/Chromium), runs js/vision.js on it and checks >=95% of intersections.
//
//   node --test tests/vision.test.mjs
//
// Env: OPENCV_JS_PATH=/path/to/opencv.js  serve a local OpenCV.js build in place of
//      https://docs.opencv.org/4.x/opencv.js (useful when that host is unreachable).
// The pure-JS warp path is always tested. The OpenCV path is skipped if OpenCV.js can't be loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

let chromium;
try { ({ chromium } = await import('playwright')); } catch { chromium = null; }
if (!chromium) { try { ({ chromium } = (await import('node:module')).createRequire(import.meta.url)('playwright')); } catch { /* skip below */ } }

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/** Runs inside the page: builds the synthetic photo and measures accuracy. */
async function synthAndDetect({ seed, withBaseline }) {
  const vision = await import('./js/vision.js');
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const N = 19, T = 1000, m = 60, step = (T - 2 * m) / (N - 1);

  const drawTop = (stones) => {
    const c = document.createElement('canvas'); c.width = c.height = T;
    const g = c.getContext('2d');
    g.fillStyle = '#d6a964'; g.fillRect(0, 0, T, T);
    for (let x = 0; x < T; x += 3) { g.fillStyle = `rgba(${rnd() < 0.5 ? '90,50,10' : '255,230,170'},${0.03 + rnd() * 0.06})`; g.fillRect(x, 0, 2, T); }
    g.strokeStyle = '#2b1d0a'; g.lineWidth = 2;
    for (let i = 0; i < N; i++) {
      g.beginPath(); g.moveTo(m, m + i * step); g.lineTo(T - m, m + i * step); g.stroke();
      g.beginPath(); g.moveTo(m + i * step, m); g.lineTo(m + i * step, T - m); g.stroke();
    }
    g.fillStyle = '#2b1d0a';
    for (const a of [3, 9, 15]) for (const b of [3, 9, 15]) { g.beginPath(); g.arc(m + a * step, m + b * step, 6, 0, 7); g.fill(); }
    const r = step * 0.46;
    for (let k = 0; k < stones.length; k++) {
      if (!stones[k]) continue;
      const x = m + (k % N) * step, y = m + Math.floor(k / N) * step;
      g.save(); g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 8; g.shadowOffsetX = 4; g.shadowOffsetY = 5;
      const grad = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
      if (stones[k] === 1) { grad.addColorStop(0, '#555'); grad.addColorStop(0.5, '#1c1c1c'); grad.addColorStop(1, '#050505'); }
      else { grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.7, '#ececec'); grad.addColorStop(1, '#c4c4c4'); }
      g.fillStyle = grad; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.restore();
    }
    // uneven lighting: darker left, brighter right
    const lg = g.createLinearGradient(0, 0, T, 0);
    lg.addColorStop(0, 'rgba(0,0,0,.25)'); lg.addColorStop(1, 'rgba(255,255,255,.10)');
    g.fillStyle = lg; g.fillRect(0, 0, T, T);
    return g.getImageData(0, 0, T, T);
  };

  const W = 1280, Hh = 720;
  const quad = [[330, 70], [960, 110], [1130, 650], [150, 610]]; // frame positions of the top-view corners
  const render = (stones) => {
    const top = drawTop(stones);
    const H = vision.homography(quad, [[0, 0], [T, 0], [T, T], [0, T]]); // frame -> top-view
    const c = document.createElement('canvas'); c.width = W; c.height = Hh;
    const g = c.getContext('2d');
    const out = g.createImageData(W, Hh);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const [u, v] = vision.applyH(H, x, y), o = (y * W + x) * 4, n = (rnd() - 0.5) * 10;
      if (u >= 0 && v >= 0 && u < T - 1 && v < T - 1) {
        const p = ((v | 0) * T + (u | 0)) * 4;
        out.data[o] = top.data[p] + n; out.data[o + 1] = top.data[p + 1] + n; out.data[o + 2] = top.data[p + 2] + n;
      } else { out.data[o] = 60 + n; out.data[o + 1] = 74 + n; out.data[o + 2] = 62 + n; }
      out.data[o + 3] = 255;
    }
    g.putImageData(out, 0, 0);
    return c;
  };

  const toFrame = vision.homography([[0, 0], [T, 0], [T, T], [0, T]], quad);
  const corners = [[m, m], [T - m, m], [T - m, T - m], [m, T - m]].map(([a, b]) => { const [x, y] = vision.applyH(toFrame, a, b); return [x / W, y / Hh]; });

  const empty = new Array(N * N).fill(0);
  if (withBaseline) vision.calibrateOnEmptyBoard(render(empty), corners, N);
  else vision.clearBaseline();

  const stones = new Array(N * N).fill(0);
  let placed = 0;
  while (placed < 40) { const k = Math.floor(rnd() * N * N); if (!stones[k]) { stones[k] = 1 + (placed % 2); placed++; } }
  // include a few adjacent stones and edge/corner stones
  stones[0] = 1; stones[1] = 2; stones[N * N - 1] = 2; stones[N - 1] = 1; stones[9 * N + 9] = 1; stones[9 * N + 10] = 2;

  const t0 = performance.now();
  const det = vision.detectBoard(render(stones), corners, N, { sensitivity: 0.5 });
  const ms = performance.now() - t0;
  const emptyDet = vision.detectBoard(render(empty), corners, N, { sensitivity: 0.5 });
  let ok = 0, bad = [];
  for (let k = 0; k < N * N; k++) { if (det[k] === stones[k]) ok++; else bad.push([k % N, Math.floor(k / N), stones[k], det[k]]); }
  let emptyOk = 0;
  for (let k = 0; k < N * N; k++) if (emptyDet[k] === 0) emptyOk++;
  return { accuracy: ok / (N * N), bad: bad.slice(0, 12), usedOpenCV: det.usedOpenCV, ms: Math.round(ms), emptyAccuracy: emptyOk / (N * N), stoneCount: stones.filter(Boolean).length };
}

test('vision: synthetic perspective-skewed board', async (t) => {
  if (!chromium) return t.skip('playwright not available');
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const local = process.env.OPENCV_JS_PATH;
    if (local && fs.existsSync(local)) {
      await page.route('https://docs.opencv.org/**', (r) => r.fulfill({ path: local, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }));
    }
    await page.goto(`http://127.0.0.1:${srv.address().port}/index.html`);
    await page.waitForLoadState('domcontentloaded');
    assert.deepEqual(errors, [], 'index.html should load without page errors');

    const run = (o) => page.evaluate(`(${synthAndDetect.toString()})(${JSON.stringify(o)})`);

    await t.test('pure-JS warp path', async () => {
      const r = await run({ seed: 7, withBaseline: false });
      console.log('  JS warp:', JSON.stringify(r));
      assert.equal(r.usedOpenCV, false);
      assert.ok(r.accuracy >= 0.95, `accuracy ${r.accuracy} bad: ${JSON.stringify(r.bad)}`);
      assert.ok(r.emptyAccuracy >= 0.99, `empty-board accuracy ${r.emptyAccuracy}`);
    });

    const cvOk = await page.evaluate(async () => {
      try {
        const v = await import('./js/vision.js');
        await Promise.race([v.loadOpenCV(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))]);
        return true;
      } catch (e) { return String(e); }
    });

    await t.test('OpenCV.js warp path', async (st) => {
      if (cvOk !== true) return st.skip(`OpenCV.js unavailable (${cvOk}); set OPENCV_JS_PATH to test it offline`);
      for (const withBaseline of [false, true]) {
        const r = await run({ seed: 11, withBaseline });
        console.log(`  OpenCV (baseline=${withBaseline}):`, JSON.stringify(r));
        assert.equal(r.usedOpenCV, true);
        assert.ok(r.accuracy >= 0.95, `accuracy ${r.accuracy} bad: ${JSON.stringify(r.bad)}`);
        assert.ok(r.emptyAccuracy >= 0.99, `empty-board accuracy ${r.emptyAccuracy}`);
      }
    });
  } finally { await browser.close(); srv.close(); }
});
