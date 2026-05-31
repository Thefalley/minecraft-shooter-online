// Reusable per-frame profiler with a live on-screen overlay. Generic (not tied
// to this game): instrument any sequential phases with begin(label)/end(label),
// wrap each frame in beginFrame()/endFrame(), and read live stats from the
// overlay or snapshot().
//
// Enabling (all persist via localStorage so it survives reloads):
//   - URL param ?profile           (on at load)
//   - press F3 in-game              (toggle)
//   - console: voxelProfiler.toggle() / .enable() / .report()
//
// When disabled, begin/end/beginFrame/endFrame are ~free (one boolean check),
// so it is safe to leave the instrumentation in the hot loop permanently.

const STYLE_ID = 'voxel-dragons-profiler-style';
const now = () => performance.now();

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .vd-prof {
      position: fixed;
      left: 8px;
      top: 140px;
      z-index: 60;
      min-width: 250px;
      padding: 8px 10px;
      background: rgba(0, 0, 0, 0.78);
      border: 3px solid #000;
      box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.14);
      color: #cfe8ff;
      font-family: 'PixelFont', 'Courier New', monospace;
      font-size: 8px;
      line-height: 1.7;
      pointer-events: none;
      white-space: pre;
      user-select: none;
    }
    .vd-prof b { color: #5ad84a; }
    .vd-prof .hot { color: #ff6a6a; }
    .vd-prof .sel { background: rgba(255, 209, 102, 0.22); color: #ffd166; }
    .vd-prof .muted { color: #7a8694; text-decoration: line-through; }
    .vd-prof .help { color: #6f7b88; }
  `;
  document.head.appendChild(style);
}

export class Profiler {
  constructor({ enabled = false, windowSize = 120, storageKey = 'vd-profile' } = {}) {
    this.enabled = Boolean(enabled);
    this.windowSize = windowSize;
    this.storageKey = storageKey;
    this.sections = new Map();          // label -> ring buffer state
    this.order = [];                    // first-seen label order (navigation order)
    this.selected = 0;                  // index into `order` for keyboard nav
    this.muted = new Set();             // labels the game should hide (visual only)
    this._stack = [];
    this._frame = { ring: new Float32Array(windowSize), idx: 0, count: 0, t0: 0 };
    this._overlay = null;
    this._sinceRender = 0;

    this._onKey = (event) => {
      if (event.code === 'KeyL') { event.preventDefault(); this.toggle(); return; }
      if (!this.enabled || this.order.length === 0) return;
      if (event.code === 'ArrowUp') {
        event.preventDefault();
        this.selected = (this.selected - 1 + this.order.length) % this.order.length;
        this._renderOverlay();
      } else if (event.code === 'ArrowDown') {
        event.preventDefault();
        this.selected = (this.selected + 1) % this.order.length;
        this._renderOverlay();
      } else if (event.code === 'Enter') {
        event.preventDefault();
        const label = this.order[this.selected];
        if (label) {
          if (this.muted.has(label)) this.muted.delete(label);
          else this.muted.add(label);
          this._renderOverlay();
        }
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKey);
      window.voxelProfiler = this;
    }
    if (this.enabled) this._mountOverlay();
  }

  _section(label) {
    let s = this.sections.get(label);
    if (!s) {
      s = { ring: new Float32Array(this.windowSize), idx: 0, count: 0, last: 0 };
      this.sections.set(label, s);
      this.order.push(label);
    }
    return s;
  }

  beginFrame() { if (this.enabled) this._frame.t0 = now(); }

  begin(label) { if (this.enabled) this._stack.push({ label, t: now() }); }

  end() {
    if (!this.enabled) return;
    const top = this._stack.pop();
    if (!top) return;
    const dt = now() - top.t;
    const s = this._section(top.label);
    s.last = dt;
    s.ring[s.idx] = dt;
    s.idx = (s.idx + 1) % this.windowSize;
    if (s.count < this.windowSize) s.count += 1;
  }

  endFrame() {
    if (!this.enabled) return;
    const f = this._frame;
    f.ring[f.idx] = now() - f.t0;
    f.idx = (f.idx + 1) % this.windowSize;
    if (f.count < this.windowSize) f.count += 1;
    if (this._overlay && (this._sinceRender += 1) >= 15) { this._sinceRender = 0; this._renderOverlay(); }
  }

  // Whether the game should visually hide this phase (Enter in the overlay).
  isMuted(label) { return this.muted.has(label); }

  // --- control ---------------------------------------------------------------
  enable() { this.setEnabled(true); }
  disable() { this.setEnabled(false); }
  toggle() { this.setEnabled(!this.enabled); }

  setEnabled(on) {
    this.enabled = on;
    try { window.localStorage?.setItem(this.storageKey, on ? '1' : '0'); } catch { /* ignore */ }
    if (on) this._mountOverlay();
    else this._unmountOverlay();
  }

  // --- stats -----------------------------------------------------------------
  static _stats(ring, count) {
    if (count === 0) return { avg: 0, max: 0, p95: 0 };
    const slice = Array.prototype.slice.call(ring, 0, count).sort((a, b) => a - b);
    const sum = slice.reduce((a, b) => a + b, 0);
    return { avg: sum / count, max: slice[count - 1], p95: slice[Math.min(count - 1, Math.floor(count * 0.95))] };
  }

  snapshot() {
    const frame = Profiler._stats(this._frame.ring, this._frame.count);
    const sections = this.order.map((label) => {
      const s = this.sections.get(label);
      return { label, last: s.last, ...Profiler._stats(s.ring, s.count) };
    });
    return { fps: frame.avg > 0 ? 1000 / frame.avg : 0, frame, sections };
  }

  // Logs a snapshot table to the console (handy without the overlay).
  report() {
    const snap = this.snapshot();
    // eslint-disable-next-line no-console
    console.log(`FPS ${snap.fps.toFixed(1)} | frame avg ${snap.frame.avg.toFixed(2)} ms (p95 ${snap.frame.p95.toFixed(2)}, max ${snap.frame.max.toFixed(2)})`);
    // eslint-disable-next-line no-console
    console.table(snap.sections.map((s) => ({
      phase: s.label,
      'avg ms': +s.avg.toFixed(3),
      'p95 ms': +s.p95.toFixed(3),
      'max ms': +s.max.toFixed(3),
      '% frame': snap.frame.avg > 0 ? +(100 * s.avg / snap.frame.avg).toFixed(1) : 0,
    })));
    return snap;
  }

  // --- overlay ---------------------------------------------------------------
  _mountOverlay() {
    if (this._overlay || typeof document === 'undefined') return;
    injectStyles();
    this._overlay = document.createElement('div');
    this._overlay.className = 'vd-prof';
    this._overlay.textContent = 'profiler…';
    document.body.appendChild(this._overlay);
    this._renderOverlay();
  }

  _unmountOverlay() {
    this._overlay?.remove();
    this._overlay = null;
  }

  _renderOverlay() {
    if (!this._overlay) return;
    const snap = this.snapshot();
    const frameAvg = snap.frame.avg || 0.0001;
    const byLabel = new Map(snap.sections.map((s) => [s.label, s]));
    // Stable insertion order so the ↑↓ cursor doesn't jump as timings change.
    const lines = this.order.map((label, i) => {
      const s = byLabel.get(label) || { avg: 0, p95: 0 };
      const share = 100 * s.avg / frameAvg;
      const cursor = i === this.selected ? '▶' : ' ';
      const muted = this.muted.has(label);
      const name = label.padEnd(11).slice(0, 11);
      const body = `${cursor}${name} ${s.avg.toFixed(2).padStart(6)} ${share.toFixed(0).padStart(3)}% ${muted ? 'OFF' : '   '}`;
      if (muted) return `<span class="muted">${body}</span>`;
      if (i === this.selected) return `<span class="sel">${body}</span>`;
      if (share >= 35) return `<span class="hot">${body}</span>`;
      return body;
    });
    this._overlay.innerHTML =
      `<b>FPS ${snap.fps.toFixed(0)}</b>  frame ${snap.frame.avg.toFixed(2)}ms (p95 ${snap.frame.p95.toFixed(2)})\n`
      + `${' '.repeat(12)}${'avg'.padStart(6)} ${'sh'.padStart(4)}\n`
      + lines.join('\n')
      + `\n<span class="help">L cerrar  ↑↓ elegir  Enter ocultar/mostrar</span>`;
  }

  dispose() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKey);
      if (window.voxelProfiler === this) delete window.voxelProfiler;
    }
    this._unmountOverlay();
  }
}

// Reads the initial enabled state from ?profile or a persisted localStorage flag.
export function profilerEnabledByDefault(storageKey = 'vd-profile') {
  try {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    if (params.has('profile') || params.has('profiler')) return true;
    return window.localStorage?.getItem(storageKey) === '1';
  } catch {
    return false;
  }
}

export default Profiler;
