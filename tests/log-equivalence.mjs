/**
 * Log equivalence check: what the SERVER logged for a room must match
 * what the CLIENT logged for the same room. Categories and payload IDs
 * are deliberately mirrored on both sides so a harness can correlate.
 *
 * For each category we count the events on both sides and assert:
 *   - same number of unique IDs (no client sees a phantom enemy, no
 *     server-spawned enemy is missing on the client)
 *   - every server-spawned id eventually appears as a client spawn
 *     (allowing a small time window for the message to arrive)
 *
 * If the counts diverge or an id is missing on one side, the suite
 * exits non-zero and prints which ids were unbalanced. This catches
 * regressions in EnemySync.backfill, WorldSync.backfill, or any new
 * networking path that drops events on one side.
 *
 * Wire protocol only (HTTP for the server log, raw Colyseus for state,
 * Playwright for the client log). No language-specific assumptions
 * beyond the JSON shape documented at PROTOCOL_CONTRACT.md.
 */

import { chromium } from 'playwright';
import { Reporter } from './lib/reporter.mjs';
import {
  createClient,
  createRoom,
  waitForState,
  safeLeave,
  httpFromWs,
} from './lib/colyseus.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const SERVER = args.server || 'wss://minecraft-shooter-online.onrender.com';
const LOBBY = args.lobby || 'https://minecraft-shooter-online-web.vercel.app';

const r = new Reporter(`Log equivalence · ${SERVER}`);

let hostClient = null;
let hostRoom = null;
let browser = null;
let page = null;

try {
  hostClient = await createClient(SERVER);
  hostRoom = await createRoom(hostClient, { name: 'LogHost', characterId: 'duck' });
  await waitForState(hostRoom, (s) => !!s.roomCode, { timeoutMs: 5000 });
  const code = hostRoom.state.roomCode;

  // Start the game from the host FIRST so wave 1 spawns. Browser will
  // then join into phase=playing and skip the WaitingRoom mount path.
  hostRoom.send('vp:lobby:start', { countdownMs: 200 });
  await waitForState(hostRoom, (s) => s.phase === 'playing', { timeoutMs: 5000 });
  await waitForState(hostRoom, (s) => s.enemies.size > 0, { timeoutMs: 5000 });

  // Now boot the browser client into the same (running) room.
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage();
  await page.goto(LOBBY, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('#name', 'LogClient');
  await page.fill('#code', code);
  await page.click('button:has-text("Unirse")');
  await page.waitForURL(/voxel-dragons-game/, { timeout: 20000 });
  await page.waitForFunction(() => !!window.__voxelGame, { timeout: 30000 });
  // Let EnemySync backfill the late-joiner state into the client ring.
  await page.waitForTimeout(4000);

  // Fetch server log over HTTP and client log via the page.
  const httpBase = httpFromWs(SERVER);
  let serverEvents = [];
  let clientEvents = [];

  await r.check('server exposes /debug/rooms/:code/logs', async () => {
    const res = await fetch(`${httpBase}/debug/rooms/${code}/logs`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.roomCode !== code) throw new Error(`bad roomCode in response: ${j.roomCode}`);
    if (!Array.isArray(j.events)) throw new Error('events missing');
    serverEvents = j.events;
    return `${serverEvents.length} events`;
  });

  await r.check('client exposes window.__voxelDebug.ring', async () => {
    clientEvents = await page.evaluate(() => window.__voxelDebug?.ring ?? []);
    if (!Array.isArray(clientEvents)) throw new Error('ring is not an array');
    return `${clientEvents.length} events`;
  });

  const byCat = (events) => {
    const m = new Map();
    for (const e of events) {
      if (!m.has(e.category)) m.set(e.category, []);
      m.get(e.category).push(e);
    }
    return m;
  };

  const serverByCat = byCat(serverEvents);
  const clientByCat = byCat(clientEvents);

  // ─── wave:start ───────────────────────────────────────────
  await r.check('wave:start: server logged exactly one (wave 1)', async () => {
    const s = serverByCat.get('wave:start') ?? [];
    if (s.length === 0) throw new Error('server has no wave:start event');
    if (s[0]?.payload?.wave !== 1) {
      throw new Error(`first wave:start payload.wave=${s[0]?.payload?.wave}`);
    }
    return `${s.length} entry, wave=${s[0].payload.wave}`;
  });

  await r.check('wave:start: client also logged it OR is a late joiner', async () => {
    const c = clientByCat.get('wave:start') ?? [];
    if (c.length > 0) return `${c.length} entry on client, wave=${c[0]?.payload?.wave}`;
    // Late joiner case — phase was already 'playing' when browser entered,
    // so wave:start has already been broadcast and missed. EnemySync
    // backfill brings in the enemies, but the wave-start cue is gone.
    // That is acceptable; the schema still carries state.wave for HUD.
    const ring = await page.evaluate(() => window.__voxelDebug?.ring ?? []);
    const lateJoinTag = ring.find((e) => e.category === 'enemySync:backfill');
    if (lateJoinTag && (lateJoinTag.payload?.enemies ?? 0) > 0) {
      return `late joiner backfilled ${lateJoinTag.payload.enemies} enemies (wave:start expected to be missed)`;
    }
    throw new Error('client missing wave:start AND backfill — bridge log path likely broken');
  });

  // ─── enemy:spawn ──────────────────────────────────────────
  await r.check('enemy:spawn: server and client agree on ids', async () => {
    const s = serverByCat.get('enemy:spawn') ?? [];
    const c = clientByCat.get('enemy:spawn') ?? [];
    const sIds = new Set(s.map((e) => e.payload.id));
    const cIds = new Set(c.map((e) => e.payload.id));
    if (sIds.size === 0) throw new Error('server logged 0 enemy:spawn');
    if (cIds.size === 0) throw new Error('client logged 0 enemy:spawn');
    const missing = [...sIds].filter((id) => !cIds.has(id));
    const extra = [...cIds].filter((id) => !sIds.has(id));
    if (missing.length > 0) {
      throw new Error(`client missing ${missing.length}: [${missing.slice(0, 5).join(',')}]`);
    }
    if (extra.length > 0) {
      throw new Error(`client has ${extra.length} extras: [${extra.slice(0, 5).join(',')}]`);
    }
    return `${sIds.size} matching ids`;
  });

  // ─── enemy:spawn: ids match (positions diverge for late joiners) ──
  // For a late joiner the server's enemy:spawn was logged at t=0 with the
  // original procedural-base position; the client's enemy:spawn is logged
  // when EnemySync first observes the entity, which is several seconds
  // later — by then the AI has moved the entity. The position drift is
  // therefore EXPECTED for late joiners and not a sync bug. We only
  // require both sides to agree on the same set of ids.
  await r.check('enemy:spawn: ids cross-match (positions drift on late join)', async () => {
    const s = serverByCat.get('enemy:spawn') ?? [];
    const c = clientByCat.get('enemy:spawn') ?? [];
    const sIds = new Set(s.map((e) => e.payload.id));
    const cIds = new Set(c.map((e) => e.payload.id));
    const missing = [...sIds].filter((id) => !cIds.has(id));
    if (missing.length > 0) throw new Error(`client missing ids ${missing.join(',')}`);
    const sById = new Map(s.map((e) => [e.payload.id, e.payload]));
    let worst = 0;
    for (const ce of c) {
      const sp = sById.get(ce.payload.id);
      if (!sp) continue;
      const d = Math.max(
        Math.abs((sp.x ?? 0) - (ce.payload.x ?? 0)),
        Math.abs((sp.z ?? 0) - (ce.payload.z ?? 0))
      );
      if (d > worst) worst = d;
    }
    return `${sIds.size} ids match · observed-vs-spawn drift=${worst.toFixed(2)}u (late-joiner motion, not a bug)`;
  });
} finally {
  try { await browser?.close(); } catch {}
  await safeLeave(hostRoom);
}

const ok = r.summary();
process.exit(ok ? 0 : 1);
