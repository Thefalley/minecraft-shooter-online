// Top-right HUD with live FPS + PING. Mounted while Game is running.
// Mirrors apps/web/src/components/StatsOverlay.tsx so feel parity is preserved.

import './lobby.css';

const SERVER_URL_RAW = import.meta.env.VITE_SERVER_URL || 'ws://localhost:2567';

function toHttpBase(url) {
  return url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/$/, '');
}

function pingClass(ms) {
  if (ms === 0) return 'p-idle';
  if (ms < 80) return 'p-good';
  if (ms < 160) return 'p-ok';
  return 'p-bad';
}

export class StatsOverlay {
  constructor() {
    this._root = null;
    this._fpsEl = null;
    this._pingEl = null;
    this._frames = 0;
    this._lastFpsT = 0;
    this._fps = 0;
    this._pingMs = 0;
    this._pingTimer = null;
    this._rafHandle = 0;
    this._stopped = false;
  }

  mount() {
    if (this._root) return;
    const el = document.createElement('div');
    el.className = 'vd-stats-overlay';
    el.innerHTML = `
      <div class="row room"><span class="lbl">SALA</span><span class="val v-room">-----</span></div>
      <div class="row"><span class="lbl">FPS</span><span class="val v-fps">--</span></div>
      <div class="row"><span class="lbl">PING</span><span class="val v-ping p-idle">--</span></div>
    `;
    document.body.appendChild(el);
    this._root = el;
    this._roomEl = el.querySelector('.v-room');
    this._fpsEl = el.querySelector('.v-fps');
    this._pingEl = el.querySelector('.v-ping');
    this._stopped = false; // reset so a remount after unmount re-enables the rAF loop
    this._startFpsLoop();
    this._startPingPoller();
  }

  /**
   * External setter: main.js calls this with the authoritative room code
   * once the bridge welcome event arrives so the player always sees which
   * room they're in without having to alt-tab to the lobby.
   */
  setRoomCode(code) {
    if (!this._roomEl) return;
    this._roomEl.textContent = code ? String(code).toUpperCase() : '-----';
  }

  unmount() {
    this._stopped = true;
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._root?.remove();
    this._root = null;
  }

  _startFpsLoop() {
    const tick = (now) => {
      if (this._stopped) return;
      this._frames++;
      if (this._lastFpsT === 0) this._lastFpsT = now;
      const elapsed = now - this._lastFpsT;
      if (elapsed >= 1000) {
        this._fps = Math.round((this._frames * 1000) / elapsed);
        this._frames = 0;
        this._lastFpsT = now;
        if (this._fpsEl) this._fpsEl.textContent = String(this._fps || '--');
      }
      this._rafHandle = requestAnimationFrame(tick);
    };
    this._rafHandle = requestAnimationFrame(tick);
  }

  _startPingPoller() {
    const httpBase = toHttpBase(SERVER_URL_RAW);
    const url = `${httpBase}/health`;
    const probe = async () => {
      const t0 = performance.now();
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        await res.text();
        const rtt = performance.now() - t0;
        this._pingMs = this._pingMs === 0 ? rtt : this._pingMs * 0.7 + rtt * 0.3;
        if (this._pingEl) {
          this._pingEl.textContent = `${Math.round(this._pingMs)} ms`;
          this._pingEl.className = `val v-ping ${pingClass(this._pingMs)}`;
        }
      } catch {
        /* Render Free may be cold-starting */
      }
    };
    probe();
    this._pingTimer = setInterval(probe, 2000);
  }
}
