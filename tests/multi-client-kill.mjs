/**
 * Multi-client kill correlation.
 *
 * Spawns N (default 3) browser clients in the same room, has one of them
 * fire a weapon at the location of a zombie the SERVER tells us exists,
 * and asserts that EVERY connected client logs the enemy:despawn event
 * for the SAME id within a short window, AND that the server's debug
 * ring also has the matching enemy:despawn entry.
 *
 * This is the regression coverage for the user's directive:
 *   "Cuando matas un dragón, en todos salen logs de todos los usuarios."
 *
 * If a future change to combat sync silently regresses (e.g. the despawn
 * broadcast stops reaching one client, or one client's ring buffer
 * doesn't log the despawn), this suite catches it: pass criterion is
 * 100% of clients + the server agree on the kill.
 *
 * Wire protocol only for the server log; window.__voxelDebug for the
 * client logs. Cross-language portable: re-implement in any language
 * by walking each client's WebSocket state.
 */

import { chromium } from 'playwright';
import { Reporter } from './lib/reporter.mjs';
import { createClient, createRoom, waitForState, safeLeave, httpFromWs } from './lib/colyseus.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const SERVER = args.server || 'wss://minecraft-shooter-online.onrender.com';
const LOBBY = args.lobby || 'https://minecraft-shooter-online-web.vercel.app';
const N_CLIENTS = Number(args.clients) || 3;

const r = new Reporter(`Multi-client kill correlation · ${N_CLIENTS} browser clients · ${SERVER}`);

let hostClient = null;
let hostRoom = null;
let browser = null;
const pages = [];

async function dumpRing(page) {
  return await page.evaluate(() => window.__voxelDebug?.ring ?? []);
}

// Warm both Vercel and Render before launching 3 browsers. CI's first
// request on a cold deploy takes 20+ s and the 30 s navigation timeout
// inside Playwright was tripping on this exact race.
try {
  const httpServer = SERVER.replace(/^ws/, 'http');
  for (let i = 0; i < 6; i += 1) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(`${httpServer}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 4000));
  }
  for (let i = 0; i < 3; i += 1) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(LOBBY, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 4000));
  }
} catch {}

try {
  // Headless host (no browser, raw Colyseus) — owns the room and starts the game.
  hostClient = await createClient(SERVER);
  hostRoom = await createRoom(hostClient, { name: 'MCKHost', characterId: 'duck' });
  await waitForState(hostRoom, (s) => !!s.roomCode, { timeoutMs: 5000 });
  const code = hostRoom.state.roomCode;

  // Start the game BEFORE the browsers join so wave 1 enemies are already
  // in state. Browsers come in as late joiners which is fine — EnemySync
  // backfills.
  hostRoom.send('vp:lobby:start', { countdownMs: 200 });
  await waitForState(hostRoom, (s) => s.phase === 'playing', { timeoutMs: 5000 });
  await waitForState(hostRoom, (s) => s.enemies.size > 0, { timeoutMs: 5000 });

  // Spawn N browser clients. Each one fills the lobby form and joins by code.
  browser = await chromium.launch({ headless: true });
  for (let i = 0; i < N_CLIENTS; i += 1) {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
    const page = await ctx.newPage();
    await page.goto(LOBBY, { waitUntil: 'networkidle', timeout: 60000 });
    await page.fill('#name', `MCK${i + 1}`);
    await page.fill('#code', code);
    await page.click('button:has-text("Unirse")');
    await page.waitForURL(/voxel-dragons-game/, { timeout: 40000 });
    await page.waitForFunction(() => !!window.__voxelGame, { timeout: 40000 });
    pages.push(page);
  }
  // Let every client finish EnemySync backfill and reach the same state.
  await new Promise((res) => setTimeout(res, 5000));

  await r.check(`${N_CLIENTS} browser clients connected and in-scene`, async () => {
    const ok = await Promise.all(
      pages.map((p) =>
        p.evaluate(() => {
          const g = window.__voxelGame;
          return !!g && !!g._enemySync?._enabled;
        })
      )
    );
    if (!ok.every((b) => b)) {
      throw new Error(`only ${ok.filter(Boolean).length}/${N_CLIENTS} ready`);
    }
    return `${ok.length}/${N_CLIENTS} ready`;
  });

  // Wait until at least one zombie has pathed within 6 u of the host.
  // AI is server-side; the host doesn't pump inputs so its position stays
  // at spawn and the wave-1 ring closes in. Firing at point-blank avoids
  // the floating-point edge cases of grazing a 0.9 u sphere from 22 u out.
  let targetId = null;
  let targetPos = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const me = hostRoom.state.players.get(hostRoom.sessionId);
    hostRoom.state.enemies.forEach((e, id) => {
      if (targetId || e.kind !== 'zombie') return;
      const d = Math.hypot(e.x - me.x, e.z - me.z);
      if (d <= 6) {
        targetId = id;
        targetPos = { x: e.x, y: e.y, z: e.z };
      }
    });
    if (targetId) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!targetId) throw new Error('no zombie reached firing range in 12 s');

  await r.check(`target zombie ${targetId} present on EVERY browser client`, async () => {
    const presence = await Promise.all(
      pages.map((p) =>
        p.evaluate(
          (id) => !!window.__voxelGame?.zombies?._serverEntities?.get?.(id),
          targetId
        )
      )
    );
    if (!presence.every((b) => b)) {
      throw new Error(`${presence.filter(Boolean).length}/${N_CLIENTS} have ${targetId}`);
    }
    return `${presence.length}/${N_CLIENTS}`;
  });

  // Kill the zombie via the host. Server cheat-guards reject shots whose
  // origin is more than 9 u from the shooter's authoritative position, so
  // we must fire FROM the host's player position TOWARD the zombie, not
  // from the zombie's own position.
  const fireAtTarget = (seqStart, count, delayMs) => {
    return (async () => {
      for (let i = 0; i < count; i += 1) {
        const me = hostRoom.state.players.get(hostRoom.sessionId);
        const tgt = hostRoom.state.enemies.get(targetId);
        if (!me || !tgt) return; // already dead
        const ox = me.x, oy = me.y + 1.6, oz = me.z;
        let dx = tgt.x - ox, dy = tgt.y + 1.0 - oy, dz = tgt.z - oz;
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len; dy /= len; dz /= len;
        hostRoom.send('vp:weapon:fire', {
          seq: seqStart + i,
          slotIndex: 0,
          origin: [ox, oy, oz],
          direction: [dx, dy, dz],
          spreadSeed: 0,
          // clientTime: 0 bypasses lag-comp (server uses live state).
          // Tests against production hit a transient clock skew with Render
          // that pushed lag-comp into a stale snapshot where the zombie was
          // 1+ u away from where my direction was aimed — every shot missed
          // by a sliver. Production browser clients are unaffected because
          // they're co-located with the user and have stable RTT.
          clientTime: 0,
        });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    })();
  };
  await fireAtTarget(1, 25, 60);
  await new Promise((res) => setTimeout(res, 1500));

  await r.check(`server removed ${targetId} from state.enemies`, async () => {
    if (hostRoom.state.enemies.has(targetId)) {
      await fireAtTarget(100, 15, 80);
      await new Promise((res) => setTimeout(res, 1000));
      if (hostRoom.state.enemies.has(targetId)) {
        throw new Error(`${targetId} still alive on server after 40 shots`);
      }
    }
    return 'gone';
  });

  await r.check(`EVERY browser client logged enemy:despawn for ${targetId}`, async () => {
    const rings = await Promise.all(pages.map(dumpRing));
    const losers = [];
    for (let i = 0; i < rings.length; i += 1) {
      const ring = rings[i];
      const found = ring.find(
        (e) => e.category === 'enemy:despawn' && e.payload?.id === targetId
      );
      if (!found) losers.push(`client${i + 1}`);
    }
    if (losers.length > 0) {
      throw new Error(`${losers.length}/${N_CLIENTS} missed despawn: [${losers.join(',')}]`);
    }
    return `${N_CLIENTS}/${N_CLIENTS} clients logged the despawn`;
  });

  await r.check(`server's /debug log ring also has enemy:despawn for ${targetId}`, async () => {
    const httpBase = httpFromWs(SERVER);
    const res = await fetch(`${httpBase}/debug/rooms/${code}/logs`);
    const { events } = await res.json();
    const hit = events.find(
      (e) => e.category === 'enemy:despawn' && e.payload?.id === targetId
    );
    if (!hit) throw new Error('not in server ring');
    return `t=${hit.t} reason=${hit.payload.reason ?? 'unknown'}`;
  });

  await r.check(`EVERY browser client played the kill cinematic (enemy:kill:client)`, async () => {
    // Agent D wired Game.js → EnemySync onKill → pushes 'enemy:kill:client' to
    // the ring buffer right before the explosion + sound fires. If this entry
    // is missing on any client, the cinematic did NOT play there.
    const rings = await Promise.all(pages.map(dumpRing));
    const losers = [];
    for (let i = 0; i < rings.length; i += 1) {
      const ring = rings[i];
      const found = ring.find(
        (e) => e.category === 'enemy:kill:client' && e.payload?.id === targetId
      );
      if (!found) losers.push(`client${i + 1}`);
    }
    if (losers.length > 0) {
      throw new Error(`${losers.length}/${N_CLIENTS} missed kill cinematic: [${losers.join(',')}]`);
    }
    return `${N_CLIENTS}/${N_CLIENTS} clients fired the explosion+sound`;
  });

  // Bonus: every client agrees on the timeline. Sort despawn timestamps; the
  // first and the last should be within 2s.
  await r.check(`despawn timestamps converge across clients (<2s spread)`, async () => {
    const rings = await Promise.all(pages.map(dumpRing));
    const ts = [];
    for (const ring of rings) {
      const e = ring.find(
        (x) => x.category === 'enemy:despawn' && x.payload?.id === targetId
      );
      if (e) ts.push(e.t);
    }
    if (ts.length !== N_CLIENTS) return `only ${ts.length}/${N_CLIENTS} timestamps`;
    const spread = Math.max(...ts) - Math.min(...ts);
    if (spread > 2000) throw new Error(`spread = ${spread}ms`);
    return `spread=${spread}ms across ${N_CLIENTS} clients`;
  });
} finally {
  try { await browser?.close(); } catch {}
  await safeLeave(hostRoom);
}

const ok = r.summary();
process.exit(ok ? 0 : 1);
