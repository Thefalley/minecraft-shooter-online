// NetworkMetrics.js
//
// Lightweight RTT sampler + server-stats merger. Owned by Game.js when a
// NetworkBridge is wired. Two cadences:
//   - 1 Hz ping: emit vp:ping, time the matching vs:pong, push into a small
//     ring (so we see a moving min/max/avg without growing unbounded).
//   - 0.2 Hz (every 5 s) server-stats poll: fetch /debug/rooms/<code>/stats
//     from the same HTTP host as the websocket. We deliberately do NOT poll
//     faster — Render's free tier is shared and we don't want to DoS it.
//
// The most recent stats are merged into window.__voxelDebug.dump() so an
// external agent calling __voxelDebug.dump() sees:
//   { network: { rttMs, rttMin, rttMax, rttSamples, lastServerStatsFetchMs },
//     server: { tickRateHz, tickDurationMsAvg, enemyCount, playerCount, … } }
//
// No UI; the existing Profiler HUD (key L / ?profile) covers the visible
// side. NetworkMetrics is purely a background sampler.

/** Cap the RTT ring so a long session doesn't grow forever. */
const RTT_RING_SIZE = 60;
/** Default ping cadence (1 Hz). */
const DEFAULT_PING_INTERVAL_MS = 1000;
/** Default server-stats cadence (0.2 Hz). */
const DEFAULT_STATS_INTERVAL_MS = 5000;
/** Drop a ping that hasn't been answered after this many ms. */
const PING_TIMEOUT_MS = 4000;

export class NetworkMetrics {
  /**
   * @param {{
   *   bridge: object,
   *   pingIntervalMs?: number,
   *   statsIntervalMs?: number,
   *   onDebug?: (category: string, payload: object) => void
   * }} opts
   */
  constructor({
    bridge,
    pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
    statsIntervalMs = DEFAULT_STATS_INTERVAL_MS,
    onDebug = null,
  } = {}) {
    this._bridge = bridge || null;
    this._pingIntervalMs = Math.max(1000, pingIntervalMs);
    this._statsIntervalMs = Math.max(5000, statsIntervalMs);
    this._onDebug = typeof onDebug === 'function' ? onDebug : null;

    this._rttRing = new Array(RTT_RING_SIZE).fill(0);
    this._rttHead = 0;
    this._rttCount = 0;
    this._rttLast = 0;

    /** Map of nonce → start time (performance.now()), so we can match echoes. */
    this._pending = new Map();
    this._nextNonce = 1;

    this._lastServerStats = null;
    this._lastServerStatsFetchMs = 0;

    this._pingTimer = null;
    this._statsTimer = null;
    this._unsubPong = null;
    this._running = false;
  }

  /** Begin sampling. Idempotent — second call is a no-op. */
  startSampling() {
    if (this._running) return;
    if (!this._bridge) return;
    this._running = true;

    // Subscribe to the bridge's 'pong' event. Payload is { t, serverT } where
    // `t` is the value we sent in vp:ping. We use performance.now() at send
    // time (high-res monotonic) so a system clock jump doesn't poison RTT.
    if (typeof this._bridge.on === 'function') {
      this._unsubPong = this._bridge.on('pong', (payload) => this._onPong(payload));
    }

    // Fire one immediate ping so the dump() doesn't show "no samples" for
    // the first second.
    this._sendPing();

    this._pingTimer = setInterval(() => this._sendPing(), this._pingIntervalMs);
    this._statsTimer = setInterval(() => this._fetchServerStats(), this._statsIntervalMs);
    // Also kick the stats fetch immediately. We don't await; failures are
    // swallowed in _fetchServerStats.
    this._fetchServerStats();
  }

  /** Stop sampling and drop subscriptions. */
  stopSampling() {
    this._running = false;
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
    if (typeof this._unsubPong === 'function') {
      try { this._unsubPong(); } catch { /* ignore */ }
      this._unsubPong = null;
    }
    this._pending.clear();
  }

  /**
   * Snapshot of the current RTT stats. Caller-side dump:
   *   { rttMs, rttMin, rttMax, rttSamples, lastServerStatsFetchMs }
   */
  getStats() {
    let min = Infinity;
    let max = 0;
    let sum = 0;
    for (let i = 0; i < this._rttCount; i += 1) {
      const v = this._rttRing[i];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    const avg = this._rttCount > 0 ? sum / this._rttCount : 0;
    return {
      rttMs: this._rttCount > 0 ? +avg.toFixed(1) : null,
      rttMin: this._rttCount > 0 ? +min.toFixed(1) : null,
      rttMax: this._rttCount > 0 ? +max.toFixed(1) : null,
      rttLastMs: this._rttCount > 0 ? +this._rttLast.toFixed(1) : null,
      rttSamples: this._rttCount,
      lastServerStatsFetchMs: this._lastServerStatsFetchMs || null,
    };
  }

  /**
   * Most recently fetched /debug/rooms/<code>/stats payload. Returns null if
   * we haven't polled yet (or every poll has failed).
   */
  getLastServerStats() {
    return this._lastServerStats;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  _sendPing() {
    if (!this._bridge || typeof this._bridge.emitPing !== 'function') return;
    // We use a tiny nonce + performance.now() so:
    //   1. The wire payload stays a single number (server already accepts a
    //      numeric `t`), keeping back-compat with handlePing().
    //   2. Late echoes from a stale ping (after a tab freeze + resume) can be
    //      matched against the right start time.
    // Pack the nonce into the high bits is overkill; just key the pending
    // map by the value we send.
    const t = performance.now();
    this._pending.set(t, t);
    // Expire stale entries (e.g. server never replied due to disconnect).
    if (this._pending.size > 16) {
      const cutoff = t - PING_TIMEOUT_MS;
      for (const [key] of this._pending) {
        if (key < cutoff) this._pending.delete(key);
      }
    }
    try { this._bridge.emitPing(t); } catch { /* ignore */ }
  }

  _onPong(payload) {
    if (!payload || typeof payload !== 'object') return;
    const t = typeof payload.t === 'number' ? payload.t : null;
    if (t === null) return;
    if (!this._pending.has(t)) return;
    this._pending.delete(t);
    const rtt = performance.now() - t;
    if (!Number.isFinite(rtt) || rtt < 0) return;
    this._rttLast = rtt;
    this._rttRing[this._rttHead] = rtt;
    this._rttHead = (this._rttHead + 1) % RTT_RING_SIZE;
    if (this._rttCount < RTT_RING_SIZE) this._rttCount += 1;
  }

  async _fetchServerStats() {
    if (!this._bridge) return;
    const code = typeof this._bridge.getRoomCode === 'function'
      ? this._bridge.getRoomCode()
      : null;
    const base = typeof this._bridge.getHttpBase === 'function'
      ? this._bridge.getHttpBase()
      : null;
    if (!code || !base) return;
    const url = `${base}/debug/rooms/${encodeURIComponent(code)}/stats`;
    try {
      // AbortSignal.timeout is ~universal in Node 20 / modern browsers; if
      // it's missing (older runtime) we just don't time out.
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(3500)
          : undefined;
      const res = await fetch(url, signal ? { signal } : undefined);
      if (!res.ok) return;
      const json = await res.json();
      if (!json || typeof json !== 'object') return;
      this._lastServerStats = json;
      this._lastServerStatsFetchMs = Date.now();
      if (this._onDebug) {
        try { this._onDebug('server:stats', json); } catch { /* ignore */ }
      }
    } catch {
      // Render free tier can blip; silent failure keeps the UI clean. The
      // next 5 s poll retries automatically.
    }
  }
}

export default NetworkMetrics;
