/**
 * Multiplayer server checks (raw Colyseus, 2 clients, no browser).
 *
 * Verifies that the production server actually does what it claims:
 *  - accepts new rooms
 *  - issues 5-char room codes
 *  - lets a second client join by code
 *  - elects exactly one host
 *  - transitions the lobby on host start
 *  - spawns server-authoritative enemies and dragons
 *  - actually moves them (AI tick) — this is the regression I just fixed
 *  - shares the same enemy IDs and positions with every client
 *  - broadcasts player input so each client sees others moving
 *  - propagates world deltas (mining a block syncs both clients)
 *
 * Runs in ~30s. Exit 0 = green, 1 = at least one check failed.
 *
 * Usage: node tests/server-multiplayer.mjs
 *        node tests/server-multiplayer.mjs --server=ws://localhost:2567
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

const r = new Reporter(`Multiplayer server checks · ${SERVER}`);

let hostClient = null;
let hostRoom = null;
let botClient = null;
let botRoom = null;
let roomCode = null;

try {
  // ─── Backend ──────────────────────────────────────────────
  await r.check('backend /health responds', async () => {
    const httpBase = SERVER.replace(/^ws/, 'http');
    const res = await fetch(`${httpBase}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (!j.uptime || !j.status) throw new Error('missing fields');
    return `uptime=${Math.round(j.uptime)}s`;
  });

  // ─── Lobby phase ──────────────────────────────────────────
  await r.check('host creates room', async () => {
    hostClient = await createClient(SERVER);
    hostRoom = await createRoom(hostClient, { name: 'TestHost', characterId: 'duck' });
    await waitForState(hostRoom, (s) => !!s.roomCode, { timeoutMs: 5000, label: 'roomCode' });
    if (!hostRoom.state.roomCode || !/^[A-Z2-9]{5}$/.test(hostRoom.state.roomCode)) {
      throw new Error(`bad roomCode "${hostRoom.state.roomCode}"`);
    }
    roomCode = hostRoom.state.roomCode;
    return `code=${roomCode}`;
  });

  await r.check('host is elected (isHost=true on host session)', async () => {
    let host = null;
    hostRoom.state.players.forEach((p, sid) => {
      if (sid === hostRoom.sessionId) host = p;
    });
    if (!host) throw new Error('host not in players');
    if (!host.isHost) throw new Error('isHost flag false on host');
    return host.name;
  });

  await r.check('bot joins by code', async () => {
    botClient = await createClient(SERVER);
    botRoom = await joinByCode(botClient, roomCode, { name: 'TestBot', characterId: 'mage' });
    await waitForState(hostRoom, (s) => s.players.size === 2, { timeoutMs: 5000, label: '2 players' });
    return `players=${hostRoom.state.players.size}`;
  });

  await r.check('bot is NOT host (only one host)', async () => {
    let hostCount = 0;
    hostRoom.state.players.forEach((p) => {
      if (p.isHost) hostCount += 1;
    });
    if (hostCount !== 1) throw new Error(`hostCount=${hostCount}, expected 1`);
    return 'exactly 1 host';
  });

  await r.check('character select propagates', async () => {
    hostRoom.send('vp:lobby:characterSelect', { characterId: 'knight' });
    await waitForState(
      botRoom,
      (s) => s.players.get(hostRoom.sessionId)?.characterId === 'knight',
      { timeoutMs: 3000, label: 'knight propagation' }
    );
    return 'host→knight visible on bot';
  });

  // ─── Game phase ───────────────────────────────────────────
  await r.check('host starts → phase=playing', async () => {
    hostRoom.send('vp:lobby:start', { countdownMs: 200 });
    await waitForState(hostRoom, (s) => s.phase === 'playing', {
      timeoutMs: 5000,
      label: 'phase=playing',
    });
    await waitForState(botRoom, (s) => s.phase === 'playing', {
      timeoutMs: 2000,
      label: 'bot phase=playing',
    });
    return `wave=${hostRoom.state.wave}`;
  });

  await r.check('server spawned enemies (zombies/skeletons/witches)', async () => {
    await waitForState(hostRoom, (s) => s.enemies.size > 0, {
      timeoutMs: 5000,
      label: 'enemies>0',
    });
    const kinds = new Set();
    hostRoom.state.enemies.forEach((e) => kinds.add(e.kind));
    return `${hostRoom.state.enemies.size} enemies · kinds=${[...kinds].join(',')}`;
  });

  // Wave 1 roster has 0 dragons by design (first dragon = wave 4). We
  // still report the count so a regression where the spawner breaks for
  // later waves would show up in dedicated wave-progression tests.
  await r.check('dragons MapSchema exists (count may be 0 in wave 1)', async () => {
    if (typeof hostRoom.state.dragons?.size !== 'number') {
      throw new Error('dragons not a MapSchema');
    }
    return `${hostRoom.state.dragons.size} dragons (wave 1 roster spawns 0)`;
  });

  // ─── Enemy AI tick (the regression I just fixed) ───────────
  await r.check('enemies MOVE (server AI tick is running)', async () => {
    const snap1 = snapshotMap(hostRoom.state.enemies, (e, id) => ({
      id,
      x: e.x,
      z: e.z,
    }));
    if (snap1.length === 0) throw new Error('no enemies to observe');
    await new Promise((r) => setTimeout(r, 3000));
    const snap2 = snapshotMap(hostRoom.state.enemies, (e, id) => ({
      id,
      x: e.x,
      z: e.z,
    }));
    let moved = 0;
    let maxDelta = 0;
    for (const a of snap1) {
      const b = snap2.find((x) => x.id === a.id);
      if (!b) continue;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d > 0.01) moved += 1;
      if (d > maxDelta) maxDelta = d;
    }
    if (moved === 0) throw new Error(`no enemy moved in 3s, maxDelta=${maxDelta.toFixed(3)}`);
    return `${moved}/${snap1.length} moved · max Δ=${maxDelta.toFixed(2)}u`;
  });

  await r.check('dragons MOVE (orbit pattern) if any spawned', async () => {
    const snap1 = snapshotMap(hostRoom.state.dragons, (d, id) => ({
      id,
      x: d.x,
      z: d.z,
    }));
    if (snap1.length === 0) {
      // No-op when current wave has no dragons. Dedicated wave-4 test
      // would force this codepath; see comment on dragons spawned check.
      return 'no dragons in current wave (wave 1 roster has 0)';
    }
    await new Promise((r) => setTimeout(r, 2000));
    const snap2 = snapshotMap(hostRoom.state.dragons, (d, id) => ({
      id,
      x: d.x,
      z: d.z,
    }));
    let maxDelta = 0;
    for (const a of snap1) {
      const b = snap2.find((x) => x.id === a.id);
      if (!b) continue;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d > maxDelta) maxDelta = d;
    }
    if (maxDelta < 0.5) {
      throw new Error(`max dragon Δ=${maxDelta.toFixed(2)}u in 2s, expected orbit motion`);
    }
    return `max Δ=${maxDelta.toFixed(2)}u over 2s`;
  });

  // ─── Multi-client consistency ─────────────────────────────
  await r.check('both clients see the SAME enemy IDs', async () => {
    const ids1 = new Set();
    hostRoom.state.enemies.forEach((_, id) => ids1.add(id));
    const ids2 = new Set();
    botRoom.state.enemies.forEach((_, id) => ids2.add(id));
    if (ids1.size === 0) throw new Error('host has no enemies');
    if (ids1.size !== ids2.size) {
      throw new Error(`host=${ids1.size} bot=${ids2.size}`);
    }
    for (const id of ids1) {
      if (!ids2.has(id)) throw new Error(`bot missing id ${id}`);
    }
    return `${ids1.size} matching IDs`;
  });

  await r.check('both clients see same enemy POSITIONS (within tolerance)', async () => {
    // Allow small differences due to network jitter between host's view and bot's view
    let worstDiff = 0;
    let count = 0;
    hostRoom.state.enemies.forEach((a, id) => {
      const b = botRoom.state.enemies.get(id);
      if (!b) return;
      const dx = Math.abs(a.x - b.x);
      const dz = Math.abs(a.z - b.z);
      const diff = Math.max(dx, dz);
      if (diff > worstDiff) worstDiff = diff;
      count += 1;
    });
    if (count === 0) throw new Error('no enemies in common');
    if (worstDiff > 2) throw new Error(`worst diff = ${worstDiff.toFixed(2)}u (>2 tolerance)`);
    return `${count} enemies compared · worst diff=${worstDiff.toFixed(2)}u`;
  });

  // ─── Player input broadcast ───────────────────────────────
  await r.check('player movement broadcasts to other clients', async () => {
    const before = botRoom.state.players.get(hostRoom.sessionId);
    if (!before) throw new Error('host not visible on bot');
    const startZ = before.z;
    let seq = 1;
    for (let i = 0; i < 60; i += 1) {
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
    // Let the broadcast land
    await new Promise((r) => setTimeout(r, 700));
    const after = botRoom.state.players.get(hostRoom.sessionId);
    if (!after) throw new Error('host vanished from bot view');
    const delta = startZ - after.z; // forward → mz -= 1 → z decreases
    if (delta < 0.5) {
      throw new Error(`forward delta=${delta.toFixed(2)}, expected >0.5`);
    }
    return `host moved Δz=${delta.toFixed(2)}u as seen by bot`;
  });

  // ─── World delta sync ─────────────────────────────────────
  await r.check('world delta syncs (host mines → bot sees)', async () => {
    // Pick a coordinate near the host. We mine y=4 (grass layer typically)
    // The server validates range so use coordinates close to host position.
    const host = hostRoom.state.players.get(hostRoom.sessionId);
    const x = Math.round(host.x);
    const z = Math.round(host.z);
    const y = 5;
    const before = botRoom.state.world?.deltas?.size ?? -1;
    hostRoom.send('vp:world:mine', { x, y, z, t: 0 });
    await new Promise((r) => setTimeout(r, 800));
    const after = botRoom.state.world?.deltas?.size ?? -1;
    if (before < 0 || after < 0) throw new Error('world.deltas is not a MapSchema');
    if (after <= before) {
      // Maybe the block at (x,y,z) didn't exist — server returns success silently if so.
      // Try a higher y to maximize chance of hitting a block.
      hostRoom.send('vp:world:mine', { x, y: 1, z, t: 0 });
      hostRoom.send('vp:world:mine', { x: x + 1, y: 1, z, t: 0 });
      hostRoom.send('vp:world:mine', { x, y: 1, z: z + 1, t: 0 });
      await new Promise((r) => setTimeout(r, 800));
      const after2 = botRoom.state.world?.deltas?.size ?? -1;
      if (after2 <= before) {
        throw new Error(`deltas unchanged before=${before} after=${after2}`);
      }
      return `+${after2 - before} delta(s) on bot`;
    }
    return `+${after - before} delta(s) on bot`;
  });

  // ─── Server pong / RTT ────────────────────────────────────
  await r.check('server replies to ping', async () => {
    let pong = null;
    const off = hostRoom.onMessage('vs:pong', (p) => {
      pong = p;
    });
    hostRoom.send('vp:ping', { t: Date.now() });
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (pong) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    off?.();
    if (!pong) throw new Error('no pong in 3s');
    const rtt = Date.now() - pong.t;
    return `rtt≈${rtt}ms`;
  });
} finally {
  await safeLeave(botRoom, hostRoom);
}

const ok = r.summary();
process.exit(ok ? 0 : 1);
