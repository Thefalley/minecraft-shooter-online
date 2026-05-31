// Per-room performance metrics. The room calls updateMetrics() once per tick
// with the freshly-measured costs; the HTTP layer reads via getMetrics().
//
// Storage layout:
//   - One {@link RoomBuffers} per roomCode, allocated once on first sample.
//   - Three pre-sized Float64Array rings (tick / ai / broadcast) of
//     {@link WINDOW_SIZE} samples. Writes use a head pointer so we never
//     allocate per tick (no GC pressure on the simulation loop).
//   - A tiny scalar struct for the slow-changing counters (enemyCount, wave,
//     phase, …). These are pushed in whole by the room on each tick and read
//     verbatim by the HTTP endpoint.
//
// HTTP shape — see {@link getMetrics}:
//   {
//     tickRateHz, tickDurationMsAvg, tickDurationMsP95,
//     aiCostMsAvg, broadcastCostMsAvg,
//     enemyCount, dragonCount, fireballCount, bossProjectileCount,
//     playerCount, deltaCount, wave, phase, uptimeS
//   }
//
// Why rolling 60 samples?
//   - At the 20 Hz simulation tick that's ~3 s of history — enough to surface
//     a real spike without being so long that a single slow tick from minutes
//     ago skews the live numbers.
//   - p95 over 60 sorted floats is cheap (one O(n log n) per tick).

/** Number of samples kept per ring. 20 Hz × 3 s ≈ 60. */
const WINDOW_SIZE = 60;

/**
 * Per-room metrics that get serialized over HTTP. Every field is a plain
 * number / string so it stringifies cleanly without leaking schema proxies.
 */
export interface RoomMetrics {
  /** Measured ticks-per-second across the rolling window. */
  tickRateHz: number;
  /** Mean per-tick duration over the rolling window (ms). */
  tickDurationMsAvg: number;
  /** 95th percentile of per-tick duration (ms). */
  tickDurationMsP95: number;
  /** Mean AI sub-cost (tickEnemies + tickDragons + tickFireballs) per tick (ms). */
  aiCostMsAvg: number;
  /** Mean broadcast / state-mutation cost per tick (ms). */
  broadcastCostMsAvg?: number;
  /** Live entity counters at the latest tick. */
  enemyCount: number;
  dragonCount: number;
  fireballCount: number;
  bossProjectileCount: number;
  playerCount: number;
  deltaCount: number;
  wave: number;
  phase: string;
  /** Seconds since the room was first observed by the metrics module. */
  uptimeS: number;
}

/**
 * Fragments callers can pass into {@link updateMetrics}. All fields are
 * optional so the room can stream just the numbers it just measured.
 */
export interface RoomMetricsFragment {
  tickDurationMs?: number;
  aiCostMs?: number;
  broadcastCostMs?: number;
  enemyCount?: number;
  dragonCount?: number;
  fireballCount?: number;
  bossProjectileCount?: number;
  playerCount?: number;
  deltaCount?: number;
  wave?: number;
  phase?: string;
}

interface RoomBuffers {
  /** Rolling tick-duration samples (ms). Plain Float64Array, head-pointer based. */
  tickRing: Float64Array;
  aiRing: Float64Array;
  broadcastRing: Float64Array;
  /** Index of the NEXT write into the rings. Wraps mod WINDOW_SIZE. */
  head: number;
  /** Number of valid samples (<= WINDOW_SIZE). */
  count: number;
  /** Wall-clock time of the most recent tick (Date.now() ms). */
  lastTickAt: number;
  /** Wall-clock at which the buffers were first allocated. */
  createdAt: number;
  /** Last reported entity counters. */
  enemyCount: number;
  dragonCount: number;
  fireballCount: number;
  bossProjectileCount: number;
  playerCount: number;
  deltaCount: number;
  wave: number;
  phase: string;
  /** Scratch arrays reused for p95 sort (no per-tick allocation). */
  sortScratch: Float64Array;
}

const buffers = new Map<string, RoomBuffers>();

function getOrCreate(roomCode: string): RoomBuffers {
  let b = buffers.get(roomCode);
  if (!b) {
    b = {
      tickRing: new Float64Array(WINDOW_SIZE),
      aiRing: new Float64Array(WINDOW_SIZE),
      broadcastRing: new Float64Array(WINDOW_SIZE),
      head: 0,
      count: 0,
      lastTickAt: 0,
      createdAt: Date.now(),
      enemyCount: 0,
      dragonCount: 0,
      fireballCount: 0,
      bossProjectileCount: 0,
      playerCount: 0,
      deltaCount: 0,
      wave: 0,
      phase: "lobby",
      sortScratch: new Float64Array(WINDOW_SIZE),
    };
    buffers.set(roomCode, b);
  }
  return b;
}

/**
 * Push a fresh sample (and optional counters) into the per-room ring. Called
 * once per simulation tick. No-op on empty roomCode so a defensive call from
 * a half-constructed room doesn't leak a buffer keyed under "".
 *
 * Hot path: must not allocate. The rings + sortScratch are reused; only the
 * tiny scalars get reassigned.
 */
export function updateMetrics(
  roomCode: string | undefined | null,
  fragment: RoomMetricsFragment,
): void {
  if (!roomCode) return;
  const b = getOrCreate(roomCode);
  const idx = b.head;
  // Only push timing samples if at least the tickDurationMs field is present;
  // otherwise this is a counters-only update (used when phase changes).
  if (typeof fragment.tickDurationMs === "number") {
    b.tickRing[idx] = fragment.tickDurationMs;
    b.aiRing[idx] = typeof fragment.aiCostMs === "number" ? fragment.aiCostMs : 0;
    b.broadcastRing[idx] =
      typeof fragment.broadcastCostMs === "number" ? fragment.broadcastCostMs : 0;
    b.head = (idx + 1) % WINDOW_SIZE;
    if (b.count < WINDOW_SIZE) b.count += 1;
    b.lastTickAt = Date.now();
  }
  if (typeof fragment.enemyCount === "number") b.enemyCount = fragment.enemyCount;
  if (typeof fragment.dragonCount === "number") b.dragonCount = fragment.dragonCount;
  if (typeof fragment.fireballCount === "number") b.fireballCount = fragment.fireballCount;
  if (typeof fragment.bossProjectileCount === "number")
    b.bossProjectileCount = fragment.bossProjectileCount;
  if (typeof fragment.playerCount === "number") b.playerCount = fragment.playerCount;
  if (typeof fragment.deltaCount === "number") b.deltaCount = fragment.deltaCount;
  if (typeof fragment.wave === "number") b.wave = fragment.wave;
  if (typeof fragment.phase === "string") b.phase = fragment.phase;
}

/** Read the latest metrics snapshot for a room. Returns null if unseen. */
export function getMetrics(roomCode: string): RoomMetrics | null {
  const b = buffers.get(roomCode);
  if (!b) return null;

  const tickStats = ringStats(b.tickRing, b.count, b.sortScratch);
  const aiStats = ringStats(b.aiRing, b.count, b.sortScratch);
  const broadcastStats = ringStats(b.broadcastRing, b.count, b.sortScratch);

  // Tick rate is derived from the mean tick PERIOD over the last window. We
  // don't try to time the gap between ticks because TICK_INTERVAL_MS already
  // sets a hard cadence — what we actually want is "are we keeping up". So:
  // if the mean duration is < TICK_INTERVAL_MS, we're hitting the cadence
  // exactly; if it exceeds it, the simulation is overrunning and the rate is
  // 1000/duration. Either way we report 1000/max(duration, INTERVAL).
  // We approximate the target interval from a default of 50ms (20 Hz) because
  // the metrics module shouldn't import shared just for one constant.
  const INTERVAL_MS = 50;
  const effective = Math.max(tickStats.avg, INTERVAL_MS);
  const tickRateHz = effective > 0 ? 1000 / effective : 0;

  return {
    tickRateHz: +tickRateHz.toFixed(2),
    tickDurationMsAvg: +tickStats.avg.toFixed(3),
    tickDurationMsP95: +tickStats.p95.toFixed(3),
    aiCostMsAvg: +aiStats.avg.toFixed(3),
    broadcastCostMsAvg: +broadcastStats.avg.toFixed(3),
    enemyCount: b.enemyCount,
    dragonCount: b.dragonCount,
    fireballCount: b.fireballCount,
    bossProjectileCount: b.bossProjectileCount,
    playerCount: b.playerCount,
    deltaCount: b.deltaCount,
    wave: b.wave,
    phase: b.phase,
    uptimeS: +((Date.now() - b.createdAt) / 1000).toFixed(1),
  };
}

/** Drop a room's buffer on dispose so old codes don't accumulate. */
export function clearMetrics(roomCode: string): void {
  buffers.delete(roomCode);
}

/** List every room currently tracked. Used by the global stats endpoint. */
export function listMetrics(): { roomCode: string; metrics: RoomMetrics }[] {
  const out: { roomCode: string; metrics: RoomMetrics }[] = [];
  for (const code of buffers.keys()) {
    const m = getMetrics(code);
    if (m) out.push({ roomCode: code, metrics: m });
  }
  return out;
}

/**
 * Compute mean + p95 over the last `count` samples of `ring`. Uses a shared
 * scratch buffer so we don't allocate per call. The buffer is sorted
 * destructively over [0, count).
 */
function ringStats(
  ring: Float64Array,
  count: number,
  scratch: Float64Array,
): { avg: number; p95: number } {
  if (count === 0) return { avg: 0, p95: 0 };
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const v = ring[i];
    scratch[i] = v;
    sum += v;
  }
  const sub = scratch.subarray(0, count);
  // Float64Array.sort is in-place and uses the natural numeric order.
  sub.sort();
  const p95Idx = Math.min(count - 1, Math.floor(count * 0.95));
  return { avg: sum / count, p95: sub[p95Idx] };
}
