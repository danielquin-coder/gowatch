/**
 * camera.js - rear camera via getUserMedia, torch toggle, screen wake lock and frame grabbing.
 */
export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.wake = null;
    this.grabCanvas = document.createElement('canvas');
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this.stream) this.requestWake(); });
  }

  get active() { return !!this.stream; }
  get width() { return this.video.videoWidth || 0; }
  get height() { return this.video.videoHeight || 0; }

  async start() {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API not available (HTTPS is required).');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    await this.video.play().catch(() => {});
    if (!this.video.videoWidth) await new Promise((r) => this.video.addEventListener('loadedmetadata', r, { once: true }));
    await this.requestWake();
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.wake?.release?.().catch(() => {});
    this.wake = null;
  }

  get track() { return this.stream?.getVideoTracks()[0]; }
  get torchSupported() { return !!this.track?.getCapabilities?.().torch; }

  async setTorch(on) {
    if (!this.torchSupported) return false;
    await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
    return true;
  }

  async requestWake() {
    try { if ('wakeLock' in navigator && !this.wake) { this.wake = await navigator.wakeLock.request('screen'); this.wake.addEventListener('release', () => { this.wake = null; }); } } catch { /* denied */ }
  }

  /** Copy the current video frame into a reusable canvas of the given width and return it. */
  grab(width = 720) {
    const vw = this.width, vh = this.height;
    if (!vw) return null;
    const k = Math.min(1, width / vw), w = Math.round(vw * k), h = Math.round(vh * k);
    const c = this.grabCanvas;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    c.getContext('2d', { willReadFrequently: true }).drawImage(this.video, 0, 0, w, h);
    return c;
  }
}
