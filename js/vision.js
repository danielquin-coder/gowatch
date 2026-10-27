/**
 * vision.js - board detection from a camera frame.
 *
 * Pipeline (detectBoard):
 *   1. downscale the frame to ~720px wide
 *   2. perspective-warp the 4 user-tapped corners (TL,TR,BR,BL = the four CORNER
 *      INTERSECTIONS, not the wooden edge) onto a square canvas (default 608px).
 *      Intersection (i,j) lands at ((i+.5)*cell, (j+.5)*cell), cell = 608/size (32px for 19x19).
 *      Uses OpenCV.js when loaded, otherwise a pure-JS homography warp (same result, slower).
 *   3. for every intersection sample a small disc (r = .3 cell) and compare its mean
 *      luminance L with a LOCAL reference: the median of a 6x6 neighbourhood of
 *      "between" points (square centres, which are never covered by stones). This copes
 *      with lighting gradients. White = clearly brighter AND low saturation, black = clearly darker.
 *   4. optional baseline from an empty board (calibrateOnEmptyBoard) refines the reference.
 *
 * Corners are NORMALISED (0..1) relative to the frame, so they are resolution independent.
 * classifyWarped() is pure and testable without a browser.
 */

export const EMPTY = 0, BLACK = 1, WHITE = 2;
export const WARP = 608;
export const DEFAULT_PARAMS = { sensitivity: 0.5 };
const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';

/* ------------------------------------------------------------------ OpenCV loading */

let cvPromise = null;

/** Lazily load OpenCV.js (~10MB). onProgress(fraction 0..1 | null for indeterminate). Resolves to cv. */
export function loadOpenCV(onProgress = () => {}) {
  if (cvPromise) return cvPromise;
  cvPromise = (async () => {
    if (globalThis.cv?.Mat) return globalThis.cv;
    let url = OPENCV_URL, blobUrl = null;
    try { url = globalThis.localStorage?.getItem('gowatch.opencvUrl') || OPENCV_URL; } catch { /* ignore */ }
    try { // fetch with progress (needs CORS); fall back to a plain <script> tag
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const total = +res.headers.get('content-length') || 0;
      const reader = res.body.getReader(), chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        onProgress(total ? Math.min(0.99, got / total) : null);
      }
      blobUrl = URL.createObjectURL(new Blob(chunks, { type: 'text/javascript;charset=utf-8' }));
    } catch { onProgress(null); }
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = blobUrl || url;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load OpenCV.js'));
      document.head.appendChild(s);
    });
    const cv = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('OpenCV.js initialisation timed out')), 90000);
      const done = (m) => { clearTimeout(t); resolve(m); };
      const c = globalThis.cv;
      if (!c) return reject(new Error('OpenCV.js did not define cv'));
      if (typeof c.then === 'function') c.then((m) => { delete m.then; globalThis.cv = m; done(m); });
      else if (c.Mat) done(c);
      else c.onRuntimeInitialized = () => done(globalThis.cv);
    });
    onProgress(1);
    return cv;
  })();
  cvPromise.catch(() => { cvPromise = null; }); // allow retry
  return cvPromise;
}

export const hasOpenCV = () => !!globalThis.cv?.Mat;

/* ------------------------------------------------------------------ geometry */

/** Solve the 3x3 homography H (row-major, h33=1) mapping 4 src points to 4 dst points. */
export function homography(src, dst) {
  const A = [];
  for (let k = 0; k < 4; k++) {
    const [x, y] = src[k], [u, v] = dst[k];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) { // Gaussian elimination with partial pivoting
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [...A.map((row, i) => row[8] / row[i]), 1];
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}

/** Destination (warped) corner points for a board of `size`: the four corner intersections. */
export function warpTargets(size, S = WARP) {
  const cell = S / size, lo = 0.5 * cell, hi = (size - 0.5) * cell;
  return [[lo, lo], [hi, lo], [hi, hi], [lo, hi]];
}

/** Homography from normalised frame coords to warped coords (frame is fw x fh pixels). */
export function frameToWarpH(corners, fw, fh, size, S = WARP) {
  return homography(corners.map(([x, y]) => [x * fw, y * fh]), warpTargets(size, S));
}

/** Returns (i,j) -> normalised frame position of intersection (i,j) - for drawing overlays. */
export function intersectionMapper(corners, size) {
  const H = homography(warpTargets(size, 1), corners);
  return (i, j) => applyH(H, (i + 0.5) / size, (j + 0.5) / size);
}

/* ------------------------------------------------------------------ warping */

function warpJS(img, H, S) {
  const Hinv = invertH(H), { data, width: w, height: h } = img;
  const out = new Uint8ClampedArray(S * S * 4);
  for (let v = 0; v < S; v++) {
    for (let u = 0; u < S; u++) {
      const [x, y] = applyH(Hinv, u, v);
      const o = (v * S + u) * 4;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) { // clamp to edge
        const cx = Math.min(w - 1, Math.max(0, x0)), cy = Math.min(h - 1, Math.max(0, y0)), p = (cy * w + cx) * 4;
        out[o] = data[p]; out[o + 1] = data[p + 1]; out[o + 2] = data[p + 2]; out[o + 3] = 255;
        continue;
      }
      const fx = x - x0, fy = y - y0, p = (y0 * w + x0) * 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] = data[p + c] * (1 - fx) * (1 - fy) + data[p + 4 + c] * fx * (1 - fy)
          + data[p + w * 4 + c] * (1 - fx) * fy + data[p + w * 4 + 4 + c] * fx * fy;
      }
      out[o + 3] = 255;
    }
  }
  return new ImageData(out, S, S);
}

function warpCV(img, H, S) {
  const cv = globalThis.cv;
  const src = cv.matFromImageData(img), dst = new cv.Mat();
  const Hm = cv.matFromArray(3, 3, cv.CV_64F, H);
  try {
    cv.warpPerspective(src, dst, Hm, new cv.Size(S, S), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    cv.GaussianBlur(dst, dst, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT); // light blur
    return new ImageData(new Uint8ClampedArray(dst.data), S, S);
  } finally { src.delete(); dst.delete(); Hm.delete(); }
}

let scratch = null;
/** Draw any drawable (video / canvas / ImageBitmap / ImageData) into an ImageData ~720px wide. */
export function frameToImageData(frame, maxW = 720) {
  if (typeof ImageData !== 'undefined' && frame instanceof ImageData) return frame;
  const sw = frame.videoWidth || frame.width, sh = frame.videoHeight || frame.height;
  const k = Math.min(1, maxW / sw), w = Math.round(sw * k), h = Math.round(sh * k);
  scratch ||= document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(frame, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/* ------------------------------------------------------------------ classification */

function sampleDisc(data, S, cx, cy, r) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(S - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(S - 1, Math.ceil(cy + r));
  let sl = 0, ss = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > r * r) continue;
      const p = (y * S + x) * 4, R = data[p], G = data[p + 1], B = data[p + 2];
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      sl += 0.299 * R + 0.587 * G + 0.114 * B;
      ss += mx ? ((mx - mn) / mx) * 255 : 0;
      n++;
    }
  }
  return n ? [sl / n, ss / n] : [0, 0];
}

const median = (a) => { const s = Float32Array.from(a).sort(); return s[s.length >> 1]; };

/** Thresholds derived from the sensitivity slider (0..1, higher = more sensitive). */
export function thresholds(params = DEFAULT_PARAMS) {
  const s = params.sensitivity ?? 0.5;
  return { dBlack: 85 - 60 * s, dWhite: 55 - 35 * s };
}

/**
 * Pure classification of an already-warped RGBA image (S x S).
 * @param baseline optional {inter:Float32Array(L), between:Float32Array} from calibrateOnEmptyBoard
 * @returns Int8Array(size*size) with `.conf` (Float32Array 0..1), `.lum`, `.sat`
 */
export function classifyWarped(data, S, size, params = DEFAULT_PARAMS, baseline = null) {
  const cell = S / size, nb = size - 1;
  const { dBlack, dWhite } = thresholds(params);
  const interL = new Float32Array(size * size), interS = new Float32Array(size * size);
  const betL = new Float32Array(nb * nb), betS = new Float32Array(nb * nb);
  for (let j = 0; j < nb; j++) for (let i = 0; i < nb; i++) {
    const [l, s] = sampleDisc(data, S, (i + 1) * cell, (j + 1) * cell, 0.2 * cell);
    betL[j * nb + i] = l; betS[j * nb + i] = s;
  }
  const out = new Int8Array(size * size), conf = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const k = j * size + i;
    const [l, s] = sampleDisc(data, S, (i + 0.5) * cell, (j + 0.5) * cell, 0.3 * cell);
    interL[k] = l; interS[k] = s;
    // local reference: median of between-points in a 6x6 window around this intersection
    const ls = [], ss = [];
    for (let bj = Math.max(0, j - 3); bj <= Math.min(nb - 1, j + 2); bj++) {
      for (let bi = Math.max(0, i - 3); bi <= Math.min(nb - 1, i + 2); bi++) { ls.push(betL[bj * nb + bi]); ss.push(betS[bj * nb + bi]); }
    }
    let refL = median(ls);
    const refS = median(ss);
    if (baseline && baseline.size === size) { // empty-board baseline (includes grid lines) + local lighting drift
      refL = baseline.inter[k] + (refL - baseline.between[k]);
    } else refL -= 6; // grid lines make an empty intersection slightly darker than the plain wood
    const d = l - refL;
    let c = EMPTY;
    if (d < -dBlack) c = BLACK;
    else if ((d > dWhite && s < Math.max(0.55 * refS, 45)) || (d > 0.4 * dWhite && s < 0.3 * refS && refS > 40)) c = WHITE;
    out[k] = c;
    const T = c === WHITE ? dWhite : dBlack;
    conf[k] = c === EMPTY ? 1 - 0.5 * Math.min(1, Math.max(-d / dBlack, d / dWhite, 0))
      : Math.min(1, 0.5 + (Math.abs(d) - T) / (2 * T));
  }
  out.conf = conf; out.lum = interL; out.sat = interS;
  out.betweenRef = betL;
  return out;
}

/**
 * Detect the board in a frame.
 * @param frame   video / canvas / ImageBitmap / ImageData
 * @param corners [[x,y]x4] normalised TL,TR,BR,BL
 * @returns Int8Array (0 empty, 1 black, 2 white) with extra props: conf, warped (ImageData), usedOpenCV
 */
export function detectBoard(frame, corners, size, params = DEFAULT_PARAMS) {
  const img = frameToImageData(frame);
  const H = frameToWarpH(corners, img.width, img.height, size);
  const useCV = hasOpenCV();
  const warped = useCV ? warpCV(img, H, WARP) : warpJS(img, H, WARP);
  const res = classifyWarped(warped.data, WARP, size, params, params.baseline || baselineStore);
  res.warped = warped; res.usedOpenCV = useCV;
  return res;
}

let baselineStore = null;

/** Record the current (empty) board as a baseline for later detections. */
export function calibrateOnEmptyBoard(frame, corners, size, params = DEFAULT_PARAMS) {
  const img = frameToImageData(frame);
  const H = frameToWarpH(corners, img.width, img.height, size);
  const warped = hasOpenCV() ? warpCV(img, H, WARP) : warpJS(img, H, WARP);
  const r = classifyWarped(warped.data, WARP, size, params, null);
  const nb = size - 1, between = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const ls = [];
    for (let bj = Math.max(0, j - 3); bj <= Math.min(nb - 1, j + 2); bj++) for (let bi = Math.max(0, i - 3); bi <= Math.min(nb - 1, i + 2); bi++) ls.push(r.betweenRef[bj * nb + bi]);
    between[j * size + i] = median(ls);
  }
  baselineStore = { size, inter: Float32Array.from(r.lum), between };
  return baselineStore;
}
export const clearBaseline = () => { baselineStore = null; };
export const hasBaseline = () => !!baselineStore;

/* ------------------------------------------------------------------ debug overlay */

/** Draw the warped image with detected stones on a canvas context (canvas should be WARP x WARP). */
export function drawDebug(ctx, result, size) {
  ctx.putImageData(result.warped, 0, 0);
  const cell = WARP / size;
  ctx.lineWidth = 2;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const c = result[j * size + i];
    if (!c) continue;
    ctx.beginPath();
    ctx.arc((i + 0.5) * cell, (j + 0.5) * cell, cell * 0.38, 0, Math.PI * 2);
    ctx.strokeStyle = c === BLACK ? '#f0f' : '#0ff';
    ctx.stroke();
  }
}
