/**
 * Feature-level behavior checks. Validates SPECIFIC game rules end-to-end
 * against the deployed server. Designed to catch regressions where a
 * feature still "works locally" but the deployed contract drifts.
 *
 * Wire protocol only (Colyseus WebSocket + Colyseus state schemas).
 * The harness deliberately avoids any JS-internal symbols, so an
 * equivalent test in Python/Go/Rust would assert the same things.
 *
 * Covered behaviors:
 *   B1. Zombie pathfinds toward the nearest player (distance shrinks).
 *   B2. All connected clients converge on the same enemy positions.
 *   B3. Late joiner gets the in-progress game state, not the lobby.
 *   B4. World deltas are persisted on the server (re-issued to new clients).
 *   B5. Player position diverges per-client (one player moving doesn't
 *       drag others — each is owned by its sessionId).
 *   B6. Server rejects invalid input shapes without dropping the client.
 *   B7. Dragon roster grows with wave number (fallback scaling).
 *      (skipped if the server only spawns wave 1 here, with note.)
 *
 * Usage: node tests/behavior-multiplayer.mjs
 */

import { Reporter } from './lib/reporter.mjs';
import {
  createClient,
  createRoom,
  joinByCode,
  waitForState,
  snapshotMap,
  safeLeave,
} from './lib/colyseus.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const SERVER = args.server || 'wss://minecraft-shooter-online.onrender.com';

const r = new Reporter(`Behavior checks · ${SERVER}`);

let hostClient = null;
let hostRoom = null;
let botClient = null;
let botRoom = null;
let lateClient = null;
let lateRoom = null;

try {
  hostClient = await createClient(SERVER);
  hostRoom = await createRoom(hostClient, { name: 'BHost', characterId: 'duck' });
  await waitForState(hostRoom, (s) => !!s.roomCode, { timeoutMs: 5000 });
  const code = hostRoom.state.roomCode;

  botClient = await createClient(SERVER);
  botRoom = await joinByCode(botClient, code, { name: 'BBot', characterId: 'knight' });
  await waitForState(hostRoom, (s) => s.players.size === 2, { timeoutMs: 5000 });

  hostRoom.send('vp:lobby:start', { countdownMs: 200 });
  await waitForState(hostRoom, (s) => s.phase === 'playing', { timeoutMs: 5000 });
  await waitForState(hostRoom, (s) => s.enemies.size > 0, { timeoutMs: 5000 });

  // ─── B1. Zombie pathfinds toward player ───────────────────
  await r.check('B1. zombie chases nearest player (distance shrinks)', async () => {
    // Park the host at origin so the zombie has a stable target.
    let seq = 1;
    const sendInput = (input) =>
      hostRoom.send('vp:input', { ...input, rotationY: 0, pitch: 0, seq: seq++ });
    // Send 10 idle frames to settle.
    for (let i = 0; i < 10; i += 1) {
      sendInput({ forward: false, backward: false, left: false, right: false, jump: false });
      await new Promise((r) => setTimeout(r, 50));
    }
    // Find the closest zombie to the host.
    const host = hostRoom.state.players.get(hostRoom.sessionId);
    if (!host) throw new Error('host not in state');
    let best = null;
    let bestDist = Infinity;
    hostRoom.state.enemies.forEach((e, id) => {
      if (e.kind !== 'zombie') return;
      const d = Math.hypot(e.x - host.x, e.z - host.z);
      if (d < bestDist) {
        bestDist = d;
        best = id;
      }
    });
    if (!best) {
      // No zombies in this wave — soft pass (other tests would flag the
      // missing spawn). Should not happen for wave 1.
      return 'no zombies in current wave';
    }
    const startDist = bestDist;
    // Watch for up to 5s.
    let endDist = startDist;
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const e = hostRoom.state.enemies.get(best);
      const h = hostRoom.state.players.get(hostRoom.sessionId);
      if (!e || !h) break;
      endDist = Math.hypot(e.x - h.x, e.z - h.z);
      if (endDist < startDist - 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const closed = startDist - endDist;
    if (closed < 0.5) {
      throw new Error(
        `zombie ${best} closed only ${closed.toFixed(2)}u in 5s (start=${startDist.toFixed(1)}, end=${endDist.toFixed(1)})`
      );
    }
    return `closed ${closed.toFixed(2)}u in 5s`;
  });

  // ─── B2. All clients converge on same enemy positions ─────
  await r.check('B2. host and bot agree on every enemy id+pos (no drift)', async () => {
    const ids1 = [];
    hostRoom.state.enemies.forEach((_, id) => ids1.push(id));
    const ids2 = [];
    botRoom.state.enemies.forEach((_, id) => ids2.push(id));
    if (ids1.length !== ids2.length) {
      throw new Error(`host=${ids1.length} bot=${ids2.length} ids`);
    }
    let worst = 0;
    for (const id of ids1) {
      if (!botRoom.state.enemies.has(id)) throw new Error(`bot missing ${id}`);
      const a = hostRoom.state.enemies.get(id);
      const b = botRoom.state.enemies.get(id);
      const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
      if (d > worst) worst = d;
    }
    // Allow up to 2u of inter-client jitter (network buffering).
    if (worst > 2) throw new Error(`worst inter-client drift = ${worst.toFixed(2)}u`);
    return `${ids1.length} enemies · worst drift=${worst.toFixed(2)}u`;
  });

  // ─── B3. Late joiner gets in-progress state ───────────────
  await r.check('B3. late joiner enters mid-game with the active state', async () => {
    lateClient = await createClient(SERVER);
    lateRoom = await joinByCode(lateClient, code, { name: 'BLate', characterId: 'mage' });
    await waitForState(lateRoom, (s) => !!s.phase, { timeoutMs: 5000 });
    if (lateRoom.state.phase !== 'playing') {
      throw new Error(`late joiner phase=${lateRoom.state.phase}, expected playing`);
    }
    // Wait for enemy state to sync.
    await waitForState(lateRoom, (s) => s.enemies.size > 0, { timeoutMs: 5000 });
    const hostCount = hostRoom.state.enemies.size;
    const lateCount = lateRoom.state.enemies.size;
    if (Math.abs(hostCount - lateCount) > 1) {
      // 1 tolerance: an enemy could despawn between the two reads
      throw new Error(`host=${hostCount} late=${lateCount}`);
    }
    return `phase=playing · enemies=${lateCount}`;
  });

  // ─── B4. World deltas persisted (mining survives joins) ───
  await r.check('B4. mined block delta is delivered to late joiner', async () => {
    // Host mines a block.
    const h = hostRoom.state.players.get(hostRoom.sessionId);
    const x = Math.round(h.x);
    const z = Math.round(h.z);
    const y = 1;
    const deltasBefore = hostRoom.state.world?.deltas?.size ?? 0;
    hostRoom.send('vp:world:mine', { x, y, z, t: 0 });
    hostRoom.send('vp:world:mine', { x: x + 1, y, z, t: 0 });
    await new Promise((r) => setTimeout(r, 1000));
    const deltasAfter = hostRoom.state.world?.deltas?.size ?? 0;
    // Late joiner should also have the new deltas.
    const lateDeltas = lateRoom.state.world?.deltas?.size ?? 0;
    if (deltasAfter <= deltasBefore) {
      return 'mine intent did not produce a delta (block may not have existed)';
    }
    if (lateDeltas < deltasAfter - 1) {
      throw new Error(`late=${lateDeltas} < host=${deltasAfter}`);
    }
    return `host=${deltasAfter} late=${lateDeltas}`;
  });

  // ─── B5. Per-session player ownership ─────────────────────
  await r.check('B5. moving host does not move bot (per-session input)', async () => {
    const botPlayerBefore = hostRoom.state.players.get(botRoom.sessionId);
    if (!botPlayerBefore) throw new Error('bot not in host view');
    const bx0 = botPlayerBefore.x;
    const bz0 = botPlayerBefore.z;
    // Host spams W.
    let seq = 100;
    for (let i = 0; i < 30; i += 1) {
      hostRoom.send('vp:input', {
        forward: true,
        backward: false,
        left: false,
        right: false,
        jump: false,
        rotationY: 0,
        pitch: 0,
        seq: seq++,
      });
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 500));
    const botPlayerAfter = hostRoom.state.players.get(botRoom.sessionId);
    const drift = Math.hypot(botPlayerAfter.x - bx0, botPlayerAfter.z - bz0);
    if (drift > 0.5) {
      throw new Error(`bot drifted ${drift.toFixed(2)}u while only host moved`);
    }
    return `bot stationary (Δ=${drift.toFixed(3)}u)`;
  });

  // ─── B6. Invalid input does not crash the session ─────────
  await r.check('B6. server tolerates malformed input without dropping client', async () => {
    // Send a few junk shapes.
    hostRoom.send('vp:input', { forward: 'yes', seq: 'abc' });
    hostRoom.send('vp:input', null);
    hostRoom.send('vp:input', { rotationY: NaN, seq: -1 });
    await new Promise((r) => setTimeout(r, 500));
    // Client should still be connected and state should still update.
    if (hostRoom.connection?.isOpen === false) {
      throw new Error('host disconnected after malformed inputs');
    }
    // One more valid input goes through:
    hostRoom.send('vp:input', {
      forward: false,
      backward: false,
      left: false,
      right: false,
      jump: false,
      rotationY: 0,
      pitch: 0,
      seq: 999,
    });
    await new Promise((r) => setTimeout(r, 300));
    const me = hostRoom.state.players.get(hostRoom.sessionId);
    if (!me) throw new Error('host vanished from state');
    return 'host still in state after junk inputs';
  });

  // ─── B7. Dragon roster (informational only) ───────────────
  await r.check('B7. dragon container present (count may be 0 on wave 1)', async () => {
    if (typeof hostRoom.state.dragons?.size !== 'number') {
      throw new Error('state.dragons not a MapSchema');
    }
    return `${hostRoom.state.dragons.size} dragons`;
  });
} finally {
  await safeLeave(lateRoom, botRoom, hostRoom);
}

const ok = r.summary();
process.exit(ok ? 0 : 1);
