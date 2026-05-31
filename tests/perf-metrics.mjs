/**
 * Performance metrics regression check.
 *
 * Drives a room as the host, sends 60 input frames at the natural 20 Hz
 * pace, then asks the server for its per-room tick stats and asserts the
 * room is healthy:
 *
 *   tickRateHz       ≥ 15  (we run at 20 Hz target; 15 leaves headroom for
 *                          jitter on a shared free-tier instance)
 *   tickDurationMsAvg ≤ 20 (a tick that takes >20 ms means we're at risk of
 *                          falling behind the 50 ms cadence)
 *   enemyCount        > 0  (sanity: wave 1 actually populated entities)
 *
 * Endpoints exercised:
 *   GET /debug/rooms/<code>/stats — per-room counters + tick histogram
 *   GET /debug/global/stats        — process-wide aggregate (uptime/mem)
 *
 * Usage: node tests/perf-metrics.mjs
 *        node tests/perf-metrics.mjs --server=ws://localhost:2567
 */

import { Reporter } from './lib/reporter.mjs';
import {
  createClient,
  createRoom,
  waitForState,
  safeLeave,
} from './lib/colyseus.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const SERVER = args.server || 'wss://minecraft-shooter-online.onrender.com';
const HTTP_BASE = SERVER.replace(/^ws/, 'http');

const r = new Reporter(`Performance metrics · ${SERVER}`);

let hostClient = null;
let hostRoom = null;

// Render free-tier warmup: same shape as server-multiplayer.mjs uses so the
// CI runner doesn't fail simply because the deploy is still booting.
try {
  for (let i = 0; i < 10; i += 1) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(`${HTTP_BASE}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const j = await res.json().catch(() => null);
        if ((j?.uptime ?? 0) > 15) break;
      }
    } catch { /* ignore + retry */ }
    await new Promise((res) => setTimeout(res, 6000));
  }
} catch { /* warm-up best-effort */ }

try {
  await r.check('host creates room', async () => {
    hostClient = await createClient(SERVER);
    hostRoom = await createRoom(hostClient, { name: 'PerfHost', characterId: 'duck' });
    await waitForState(hostRoom, (s) => !!s.roomCode, { timeoutMs: 5000, label: 'roomCode' });
    return `code=${hostRoom.state.roomCode}`;
  });

  await r.check('host starts game → phase=playing', async () => {
    hostRoom.send('vp:lobby:start', { countdownMs: 200 });
    await waitForState(hostRoom, (s) => s.phase === 'playing', {
      timeoutMs: 5000,
      label: 'phase=playing',
    });
    return `wave=${hostRoom.state.wave}`;
  });

  await r.check('server populates wave 1 (enemies > 0)', async () => {
    await waitForState(hostRoom, (s) => s.enemies.size > 0, {
      timeoutMs: 5000,
      label: 'enemies>0',
    });
    return `${hostRoom.state.enemies.size} enemies`;
  });

  // ── Drive 60 input frames at 20 Hz (the natural input cadence). This
  // gives the server ~3 s of live tick samples — enough to fill the rolling
  // 60-sample metrics window. ────────────────────────────────────────────
  await r.check('drive 60 input frames at 20 Hz (~3s of telemetry)', async () => {
    let seq = 1;
    const t0 = Date.now();
    for (let i = 0; i < 60; i += 1) {
      hostRoom.send('vp:input', {
        forward: i % 2 === 0,
        backward: false,
        left: false,
        right: i % 3 === 0,
        jump: false,
        rotationY: (i * 0.05) % (Math.PI * 2),
        pitch: 0,
        seq: seq++,
      });
      await new Promise((res) => setTimeout(res, 50));
    }
    return `${seq - 1} frames · ${(Date.now() - t0)}ms`;
  });

  // ── GET /debug/rooms/<code>/stats — assert health thresholds. ──────────
  let stats = null;
  await r.check('GET /debug/rooms/<code>/stats responds', async () => {
    const code = hostRoom.state.roomCode;
    const res = await fetch(`${HTTP_BASE}/debug/rooms/${code}/stats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    stats = await res.json();
    if (!stats || typeof stats !== 'object') throw new Error('no body');
    if (stats.roomCode !== code) throw new Error(`bad code ${stats.roomCode}`);
    return `tickRateHz=${stats.tickRateHz}`;
  });

  await r.check('tickRateHz ≥ 15', async () => {
    if (typeof stats.tickRateHz !== 'number') throw new Error('not a number');
    if (stats.tickRateHz < 15) {
      throw new Error(`tickRateHz=${stats.tickRateHz} < 15`);
    }
    return `${stats.tickRateHz} Hz`;
  });

  await r.check('tickDurationMsAvg ≤ 20', async () => {
    if (typeof stats.tickDurationMsAvg !== 'number') throw new Error('not a number');
    if (stats.tickDurationMsAvg > 20) {
      throw new Error(`tickDurationMsAvg=${stats.tickDurationMsAvg} > 20`);
    }
    return `${stats.tickDurationMsAvg} ms avg (p95=${stats.tickDurationMsP95} ms)`;
  });

  await r.check('enemyCount > 0', async () => {
    if (typeof stats.enemyCount !== 'number') throw new Error('not a number');
    if (stats.enemyCount <= 0) {
      throw new Error(`enemyCount=${stats.enemyCount}`);
    }
    return `${stats.enemyCount} enemies`;
  });

  await r.check('reports playerCount, wave, phase, aiCostMsAvg', async () => {
    const need = ['playerCount', 'wave', 'phase', 'aiCostMsAvg'];
    const missing = need.filter((k) => stats[k] === undefined || stats[k] === null);
    if (missing.length > 0) throw new Error(`missing fields: ${missing.join(',')}`);
    return `players=${stats.playerCount} wave=${stats.wave} phase=${stats.phase} ai=${stats.aiCostMsAvg}ms`;
  });

  // ── /debug/global/stats — uptime + memory + counts. ────────────────────
  await r.check('GET /debug/global/stats responds', async () => {
    const res = await fetch(`${HTTP_BASE}/debug/global/stats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const need = ['uptimeS', 'totalRooms', 'totalPlayers', 'totalEnemies', 'memoryUsedMB'];
    for (const k of need) {
      if (typeof j[k] !== 'number') throw new Error(`missing or bad ${k}`);
    }
    return `up=${j.uptimeS}s mem=${j.memoryUsedMB}MB rooms=${j.totalRooms} players=${j.totalPlayers}`;
  });

  // ── Existing /debug endpoints must keep working (regression). ──────────
  await r.check('regression: /debug/rooms/<code> still returns metadata', async () => {
    const res = await fetch(`${HTTP_BASE}/debug/rooms/${hostRoom.state.roomCode}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.roomCode !== hostRoom.state.roomCode) throw new Error('roomCode mismatch');
    if (typeof j.roomId !== 'string') throw new Error('missing roomId');
    return `roomId=${j.roomId}`;
  });

  await r.check('regression: /debug/rooms/<code>/logs still returns events', async () => {
    const res = await fetch(`${HTTP_BASE}/debug/rooms/${hostRoom.state.roomCode}/logs`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.roomCode !== hostRoom.state.roomCode) throw new Error('roomCode mismatch');
    if (!Array.isArray(j.events)) throw new Error('events is not an array');
    return `${j.count} events`;
  });
} finally {
  await safeLeave(hostRoom);
}

const ok = r.summary();
process.exit(ok ? 0 : 1);
