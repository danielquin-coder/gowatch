/**
 * ui.js - reusable UI pieces (no app state):
 *   drawBoard()  2D board diagram (move numbers, last-move marker, highlight rings)
 *   pointToIntersection()  canvas tap -> board point
 *   Stage        camera view + overlay canvas: draggable corner handles, "tap 4 corners"
 *                placement with a magnifier, projected grid and detected stones
 *   toast(), beep(), coordLabel()
 */
import { intersectionMapper } from './vision.js';
import { BLACK, WHITE } from './game.js';

export const $ = (id) => document.getElementById(id);

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

let audio;
/** Short WebAudio beep (call once from a user gesture first so the context can start). */
export function beep(freq = 880, dur = 0.09) {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq; o.type = 'sine';
    g.gain.setValueAtTime(0.0001, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
    o.connect(g).connect(audio.destination);
    o.start(); o.stop(audio.currentTime + dur + 0.02);
  } catch { /* audio unavailable */ }
}

/** Human coordinate like "D4" (columns skip the letter I). */
export function coordLabel(x, y, size) {
  const L = 'ABCDEFGHJKLMNOPQRST';
  return L[x] + (size - y);
}

/* ------------------------------------------------------------------ board diagram */

const hoshi = (n) => (n === 19 ? [3, 9, 15] : n === 13 ? [3, 6, 9] : n === 9 ? [2, 4, 6] : []);

/**
 * Draw a board on a canvas.
 * opts: numbers: Map<index, moveNumber>, last: index, marks: Set<index> (red rings), px: pixel size
 */
export function drawBoard(canvas, grid, size, opts = {}) {
  const css = canvas.clientWidth || 320, dpr = window.devicePixelRatio || 1;
  const px = Math.round((opts.px || css) * dpr);
  if (canvas.width !== px || canvas.height !== px) { canvas.width = px; canvas.height = px; }
  const g = canvas.getContext('2d'), cell = px / (size + 1), off = cell;
  g.fillStyle = '#dcb468'; g.fillRect(0, 0, px, px);
  g.strokeStyle = '#3b2a10'; g.lineWidth = Math.max(1, px / 400);
  g.beginPath();
  for (let i = 0; i < size; i++) {
    g.moveTo(off, off + i * cell); g.lineTo(off + (size - 1) * cell, off + i * cell);
    g.moveTo(off + i * cell, off); g.lineTo(off + i * cell, off + (size - 1) * cell);
  }
  g.stroke();
  g.fillStyle = '#3b2a10';
  for (const a of hoshi(size)) for (const b of hoshi(size)) { g.beginPath(); g.arc(off + a * cell, off + b * cell, cell * 0.1, 0, 7); g.fill(); }
  const r = cell * 0.47;
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `600 ${Math.round(cell * (size > 13 ? 0.42 : 0.5))}px system-ui, sans-serif`;
  for (let i = 0; i < grid.length; i++) {
    const c = grid[i];
    if (!c) continue;
    const x = off + (i % size) * cell, y = off + Math.floor(i / size) * cell;
    g.beginPath(); g.arc(x, y, r, 0, 7);
    g.fillStyle = c === BLACK ? '#151515' : '#f6f6f6'; g.fill();
    g.strokeStyle = c === BLACK ? '#000' : '#777'; g.stroke();
    const n = opts.numbers?.get(i);
    if (n) { g.fillStyle = c === BLACK ? '#fff' : '#111'; g.fillText(String(n), x, y + cell * 0.03); }
    if (opts.last === i) {
      g.strokeStyle = '#e53935'; g.lineWidth = Math.max(2, px / 220);
      g.beginPath(); g.arc(x, y, r * 0.62, 0, 7); g.stroke(); g.lineWidth = Math.max(1, px / 400);
    }
  }
  if (opts.marks) {
    g.strokeStyle = '#e53935'; g.lineWidth = Math.max(2, px / 180);
    for (const i of opts.marks) { g.beginPath(); g.arc(off + (i % size) * cell, off + Math.floor(i / size) * cell, r * 1.05, 0, 7); g.stroke(); }
  }
}

/** Map a pointer event on a drawBoard canvas to an intersection index (or -1). */
export function pointToIntersection(canvas, ev, size) {
  const rc = canvas.getBoundingClientRect(), cell = rc.width / (size + 1);
  const x = Math.round((ev.clientX - rc.left) / cell - 1), y = Math.round((ev.clientY - rc.top) / cell - 1);
  return x < 0 || y < 0 || x >= size || y >= size ? -1 : y * size + x;
}

/* ------------------------------------------------------------------ camera stage */

const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

export class Stage {
  /**
   * @param {object} o  video, overlay, magnifier, hint (elements);
   *   getCorners(), setCorner(i, [u,v]), getSize(), onCornersChanged()
   */
  constructor(o) {
    Object.assign(this, o);
    this.det = null;          // latest detection (Int8Array)
    this.placing = -1;        // index of the corner being placed (-1 = not placing)
    this.drag = -1;
    this.showGrid = true;
    this.overlay.addEventListener('pointerdown', (e) => this.down(e));
    this.overlay.addEventListener('pointermove', (e) => this.move(e));
    const up = (e) => this.up(e);
    this.overlay.addEventListener('pointerup', up);
    this.overlay.addEventListener('pointercancel', up);
    new ResizeObserver(() => this.draw()).observe(this.overlay);
    this.video.addEventListener('loadedmetadata', () => this.draw());
  }

  startPlacing() { this.placing = 0; this.updateHint(); this.draw(); }

  updateHint() {
    const h = this.hint;
    if (this.placing >= 0) { h.hidden = false; h.textContent = `Tap the ${CORNER_NAMES[this.placing]} corner intersection (${this.placing + 1}/4)`; }
    else h.hidden = true;
  }

  pt(e) {
    const rc = this.overlay.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - rc.left) / rc.width)), Math.min(1, Math.max(0, (e.clientY - rc.top) / rc.height))];
  }

  down(e) {
    const p = this.pt(e);
    if (this.placing >= 0) { this.drag = this.placing; this.setCorner(this.drag, p); }
    else {
      const rc = this.overlay.getBoundingClientRect(), cs = this.getCorners();
      let best = -1, bd = 36 * 36;
      cs.forEach((c, i) => { const dx = (c[0] - p[0]) * rc.width, dy = (c[1] - p[1]) * rc.height, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } });
      this.drag = best;
      if (best < 0) return;
    }
    this.overlay.setPointerCapture(e.pointerId);
    this.showMag(this.getCorners()[this.drag], p);
    this.draw();
  }

  move(e) {
    if (this.drag < 0) return;
    const p = this.pt(e);
    this.setCorner(this.drag, p);
    this.showMag(p, p);
    this.draw();
  }

  up() {
    if (this.drag < 0) return;
    if (this.placing >= 0) { this.placing++; if (this.placing > 3) this.placing = -1; this.updateHint(); }
    this.drag = -1;
    this.magnifier.hidden = true;
    this.onCornersChanged?.();
    this.draw();
  }

  /** 4x zoomed view of the video around p (placed on the side away from the finger). */
  showMag(p) {
    const m = this.magnifier, v = this.video;
    if (!v.videoWidth) return;
    m.hidden = false;
    m.style.left = p[0] < 0.5 ? 'auto' : '8px';
    m.style.right = p[0] < 0.5 ? '8px' : 'auto';
    const rc = this.overlay.getBoundingClientRect();
    const sw = 27.5 * (v.videoWidth / rc.width); // 110 CSS px magnifier = 4x zoom
    const sh = sw, sx = p[0] * v.videoWidth - sw / 2, sy = p[1] * v.videoHeight - sh / 2;
    const g = m.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, m.width, m.height);
    g.drawImage(v, sx, sy, sw, sh, 0, 0, m.width, m.height);
    g.strokeStyle = '#ff0'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(m.width / 2, 0); g.lineTo(m.width / 2, m.height); g.moveTo(0, m.height / 2); g.lineTo(m.width, m.height / 2); g.stroke();
  }

  draw() {
    const c = this.overlay, rc = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.round(rc.width * dpr), h = Math.round(rc.height * dpr);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    const size = this.getSize(), cs = this.getCorners(), P = ([u, v]) => [u * w, v * h];
    if (this.placing < 0) {
      // projected grid
      const map = intersectionMapper(cs, size);
      if (this.showGrid) {
        g.strokeStyle = 'rgba(90,200,255,.45)'; g.lineWidth = dpr;
        g.beginPath();
        for (let i = 0; i < size; i++) {
          let [x, y] = P(map(i, 0)); g.moveTo(x, y); [x, y] = P(map(i, size - 1)); g.lineTo(x, y);
          [x, y] = P(map(0, i)); g.moveTo(x, y); [x, y] = P(map(size - 1, i)); g.lineTo(x, y);
        }
        g.stroke();
      }
      // detected stones
      if (this.det) {
        for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
          const s = this.det[j * size + i];
          if (!s) continue;
          const [x, y] = P(map(i, j)), [x2, y2] = P(map(i + 1, j)), [x3, y3] = P(map(i, j + 1));
          const r = Math.max(3, 0.36 * Math.min(Math.hypot(x2 - x, y2 - y), Math.hypot(x3 - x, y3 - y)));
          g.beginPath(); g.arc(x, y, r, 0, 7);
          g.fillStyle = s === BLACK ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.6)'; g.fill();
          g.lineWidth = 1.5 * dpr; g.strokeStyle = s === BLACK ? '#f0f' : '#0ff'; g.stroke();
        }
      }
    }
    // quad + handles
    const pts = cs.map(P), n = this.placing < 0 ? 4 : this.placing + (this.drag >= 0 ? 1 : 0);
    g.strokeStyle = '#ffd54a'; g.lineWidth = 2 * dpr;
    if (n > 1) { g.beginPath(); pts.slice(0, n).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (n === 4) g.closePath(); g.stroke(); }
    pts.slice(0, n).forEach(([x, y], i) => {
      g.beginPath(); g.arc(x, y, 11 * dpr, 0, 7);
      g.fillStyle = i === this.drag ? 'rgba(255,213,74,.9)' : 'rgba(255,213,74,.35)'; g.fill(); g.stroke();
      g.fillStyle = '#000'; g.font = `${11 * dpr}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(['TL', 'TR', 'BR', 'BL'][i], x, y - 20 * dpr);
    });
  }
}
