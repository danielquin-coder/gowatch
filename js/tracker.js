/**
 * tracker.js - turns a stream of camera frames into recorded moves.
 *
 * Every ~300ms: grab a frame, measure motion inside the board's bounding box (a hand over
 * the board = motion), detect the board, and only when the SAME detection has been seen
 * `stableFrames` times in a row (default 4, ~1.2 s) is it accepted as the new state.
 * Accepted states go through inferMove():
 *   move       -> game.play(), onMove()
 *   none       -> nothing
 *   ambiguous  -> after it persisted, onAmbiguous() so the UI can show "Check board"
 * The first stable state when recording starts becomes the root setup (handicap / pre-placed stones).
 * mode 'test' only reports detections (setup screen "test mode").
 */
import { inferMove, BLACK, WHITE } from './game.js';

const same = (a, b) => { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

export class Tracker {
  /**
   * @param {object} o
   *  camera, vision (module), getGame(), getCorners(), getSize(), getParams(), getSwap()
   *  callbacks: onStatus(status), onFrame(det, motion), onMove(info, game), onAmbiguous(info, grid), onInitial(grid)
   */
  constructor(o) {
    Object.assign(this, { stableFrames: 4, intervalMs: 300, motionFrac: 0.012, mode: 'test' }, o);
    this.timer = null;
    this.prevSmall = null;
    this.reset();
    this.small = document.createElement('canvas');
    this.small.width = 64; this.small.height = 48;
  }

  reset() {
    this.cand = null; this.stable = 0; this.ambKey = ''; this.ambSince = 0; this.shownKey = ''; this.ignore = null;
    const g = this.getGame?.();
    this.awaitingInitial = this.mode === 'record' && !!g && !g.nodes.length && !g.root.AB.length && !g.root.AW.length;
    this.prevSmall = null;
  }

  start(mode = this.mode) {
    this.stop();
    this.mode = mode;
    this.reset();
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      const t0 = performance.now();
      try { await this.tick(); } catch (e) { console.error('tracker tick', e); }
      if (this.running) this.timer = setTimeout(loop, Math.max(30, this.intervalMs - (performance.now() - t0)));
    };
    loop();
  }

  stop() { this.running = false; clearTimeout(this.timer); this.timer = null; this.onStatus?.({ state: 'idle' }); }

  /** Call after game.undo(): ignore the (still unchanged) physical board until the user removes the stone. */
  noteUndo(physicalGrid) { this.ignore = Int8Array.from(physicalGrid); this.shownKey = ''; this.ambKey = ''; }

  /** User dismissed the "check board" banner for the current ambiguous state. */
  dismiss() { this.shownKey = this.ambKey; }

  /** Fraction of pixels (inside the board's bounding box) that changed since last tick. */
  motion(frame) {
    const c = this.getCorners(), xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
    const x0 = Math.max(0, Math.min(...xs) - 0.08), x1 = Math.min(1, Math.max(...xs) + 0.08);
    const y0 = Math.max(0, Math.min(...ys) - 0.08), y1 = Math.min(1, Math.max(...ys) + 0.08);
    const g = this.small.getContext('2d', { willReadFrequently: true });
    g.drawImage(frame, x0 * frame.width, y0 * frame.height, (x1 - x0) * frame.width, (y1 - y0) * frame.height, 0, 0, 64, 48);
    const d = g.getImageData(0, 0, 64, 48).data, n = 64 * 48, gray = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) { gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; mean += gray[i]; }
    mean /= n;
    for (let i = 0; i < n; i++) gray[i] -= mean; // ignore global exposure shifts
    const prev = this.prevSmall;
    this.prevSmall = gray;
    if (!prev) return 1;
    let changed = 0;
    for (let i = 0; i < n; i++) if (Math.abs(gray[i] - prev[i]) > 22) changed++;
    return changed / n;
  }

  async tick() {
    const frame = this.camera.grab(720);
    if (!frame) return;
    const m = this.motion(frame);
    if (m > this.motionFrac) {
      this.stable = 0; this.cand = null;
      this.onStatus?.({ state: 'motion', motion: m });
      return;
    }
    const det = this.vision.detectBoard(frame, this.getCorners(), this.getSize(), this.getParams());
    this.onFrame?.(det, m);
    if (this.mode === 'test') { this.onStatus?.({ state: 'stable' }); return; }

    let grid = det;
    if (this.getSwap?.()) { grid = Int8Array.from(det, (v) => (v === BLACK ? WHITE : v === WHITE ? BLACK : 0)); }
    if (same(this.cand, grid)) this.stable++; else { this.cand = Int8Array.from(grid); this.stable = 1; }
    if (this.stable < this.stableFrames) { this.onStatus?.({ state: 'watching', stable: this.stable, need: this.stableFrames }); return; }
    this.accept(this.cand);
  }

  accept(cand) {
    const game = this.getGame();
    if (this.awaitingInitial) {
      this.awaitingInitial = false;
      if (cand.some((v) => v)) { game.setBoard(cand); this.onInitial?.(cand); }
      this.onStatus?.({ state: 'stable' });
      return;
    }
    if (this.ignore) {
      if (same(this.ignore, cand)) { this.onStatus?.({ state: 'stable', note: 'Remove the undone stone from the board' }); return; }
      this.ignore = null;
    }
    const r = inferMove(game.grid, cand, game.toPlay);
    if (r.type === 'none') {
      this.ambKey = ''; this.shownKey = '';
      this.onStatus?.({ state: 'stable' });
      return;
    }
    if (r.type === 'move') {
      const res = game.play(r.color, r.x, r.y);
      if (res.ok) {
        this.ambKey = ''; this.shownKey = '';
        this.onStatus?.({ state: 'stable' });
        this.onMove?.(r, game);
        return;
      }
      r.type = 'ambiguous'; r.reason = res.reason; // e.g. ko
    }
    const key = Array.from(cand).join('');
    if (key !== this.ambKey) { this.ambKey = key; this.ambSince = Date.now(); }
    const age = Date.now() - this.ambSince;
    if (r.pendingCaptures && age < 8000) { this.onStatus?.({ state: 'stable', note: 'Remove the captured stones...' }); return; }
    this.onStatus?.({ state: 'ambiguous' });
    if (this.shownKey !== key && age > 1500) { this.shownKey = key; this.onAmbiguous?.(r, cand); }
  }
}
