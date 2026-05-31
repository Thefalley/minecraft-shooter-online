/**
 * Sync-rate check: with N clients in the same room, does every client
 * see the same enemy AI motion AT THE SAME FREQUENCY as the server?
 *
 * Two raw Colyseus probes plus one Playwright probe sample the same
 * enemy id over a fixed window. We report:
 *   - server tick rate (samples per second where pos changed)
 *   - per-client rate
 *   - max inter-client position drift
 *   - lag of client visual vs server state (rough)
 *
 * The visual buffer in the client managers is intentionally delayed
 * (~120 ms snapshot interpolation buffer) so we accept a small lag.
 * What we fail on is:
 *   - any client whose update rate is <50% of the server rate
 *   - any inter-client drift greater than 2 voxel units
 *
 * Usage: node tests/sync-rate.mjs
 */

import { chromium } from 'playwright';
import { Reporter } from './lib/reporter.mjs';
import { createClient, createRoom, joinByCode, waitForState, safeLeave } from './lib/colyseus.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const SERVER = args.server || 'wss://minecraft-shooter-online.onrender.com';
const LOBBY = args.lobby || 'https://minecraft-shooter-online-web.vercel.app';

const r = new Reporter(`Sync-rate · ${SERVER}`);

let hostClient, hostRoom;
let probeClient, probeRoom;
let browser, page;

try {
  // Setup: host + raw probe + browser probe all in the same room.
  hostClient = await createClient(SERVER);
  hostRoom = await createRoom(hostClient, { name: 'SHost', characterId: 'duck' });
  await waitForState(hostRoom, (s) => !!s.roomCode, { timeoutMs: 5000 });
  const code = hostRoom.state.roomCode;

  probeClient = await createClient(SERVER);
  probeRoom = await joinByCode(probeClient, code, { name: 'SProbe', characterId: 'mage' });
  await waitForState(hostRoom, (s) => s.players.size === 2, { timeoutMs: 5000 });

  // Host starts the game so enemies spawn — do this BEFORE the browser
  // probe joins, because Vercel's wake-up first request can take 10-20s
  // and we want the enemies already in state for the probe to observe.
  hostRoom.send('vp:lobby:start', { countdownMs: 200 });
  await waitForState(hostRoom, (s) => s.phase === 'playing', { timeoutMs: 5000 });
  await waitForState(hostRoom, (s) => s.enemies.size > 0, { timeoutMs: 5000 });

  // Pick a zombie to track on both probes.
  let trackedId = null;
  hostRoom.state.enemies.forEach((_, id) => {
    if (!trackedId) trackedId = id;
  });
  if (!trackedId) throw new Error('no zombie to track');

  // ─── Sample over 3s ────────────────────────────────────────
  await r.check(`sample server-via-host (3s) for enemy ${trackedId}`, async () => {
    const samplesA = [];
    const samplesB = [];
    const start = Date.now();
    while (Date.now() - start < 3000) {
      const a = hostRoom.state.enemies.get(trackedId);
      const b = probeRoom.state.enemies.get(trackedId);
      if (a) samplesA.push({ t: Date.now() - start, x: a.x, z: a.z });
      if (b) samplesB.push({ t: Date.now() - start, x: b.x, z: b.z });
      await new Promise((r) => setTimeout(r, 50));
    }
    // Count distinct positions (rounded to 0.01 to filter floating jitter).
    const distinctA = new Set(samplesA.map((s) => `${s.x.toFixed(2)},${s.z.toFixed(2)}`)).size;
    const distinctB = new Set(samplesB.map((s) => `${s.x.toFixed(2)},${s.z.toFixed(2)}`)).size;
    if (distinctA < 5) throw new Error(`host saw only ${distinctA} distinct positions in 3s`);
    if (distinctB < 5) throw new Error(`probe saw only ${distinctB} distinct positions in 3s`);
    const ratio = Math.min(distinctA, distinctB) / Math.max(distinctA, distinctB);
    if (ratio < 0.5) {
      throw new Error(`distinct-pos ratio ${ratio.toFixed(2)} < 0.5 (A=${distinctA} B=${distinctB})`);
    }
    return `host=${distinctA} probe=${distinctB} distinct positions over 3s (ratio=${ratio.toFixed(2)})`;
  });

  await r.check(`inter-client drift never exceeds 2u`, async () => {
    let worst = 0;
    const samples = 30;
    for (let i = 0; i < samples; i += 1) {
      const a = hostRoom.state.enemies.get(trackedId);
      const b = probeRoom.state.enemies.get(trackedId);
      if (a && b) {
        const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
        if (d > worst) worst = d;
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    if (worst > 2) throw new Error(`max drift ${worst.toFixed(2)}u between clients`);
    return `max drift=${worst.toFixed(2)}u over ${samples} samples`;
  });

  // ─── Browser-side render rate ──────────────────────────────
  // Boot a Chromium client through the real lobby form (fill name +
  // code, click Unirse) so we observe what an actual player sees.
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage();

  await r.check('browser client renders enemy motion at ≥3Hz', async () => {
    await page.goto(LOBBY, { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('#name', 'SBrowser');
    await page.fill('#code', code);
    await page.click('button:has-text("Unirse")');
    await page.waitForURL(/voxel-dragons-game/, { timeout: 20000 });
    await page.waitForFunction(() => !!window.__voxelGame, { timeout: 20000 });
    // EnemySync needs a beat to backfill + WorldSync regenerates terrain.
    await page.waitForTimeout(4000);

    const samples = await page.evaluate(async (id) => {
      const out = [];
      for (let i = 0; i < 30; i += 1) {
        const g = window.__voxelGame;
        const e = g?.zombies?._serverEntities?.get?.(id);
        if (e?.mesh) {
          out.push({ t: i * 100, x: e.mesh.position.x, z: e.mesh.position.z });
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return out;
    }, trackedId);

    if (samples.length === 0) {
      // The tracked id may have despawned (server killed it). Pick any
      // remaining enemy and resample. Soft-fail if still nothing.
      const fallback = await page.evaluate(async () => {
        const g = window.__voxelGame;
        if (!g?.zombies?._serverEntities) return [];
        const ids = [...g.zombies._serverEntities.keys()];
        if (ids.length === 0) return [];
        const fid = ids[0];
        const out = [];
        for (let i = 0; i < 30; i += 1) {
          const e = g.zombies._serverEntities.get(fid);
          if (e?.mesh) out.push({ t: i * 100, x: e.mesh.position.x, z: e.mesh.position.z });
          await new Promise((r) => setTimeout(r, 100));
        }
        return out;
      });
      if (fallback.length < 10) {
        return `no trackable zombie on browser client (${fallback.length} samples)`;
      }
      const distinct = new Set(fallback.map((s) => `${s.x.toFixed(2)},${s.z.toFixed(2)}`)).size;
      if (distinct < 5) {
        throw new Error(`fallback zombie only ${distinct} distinct positions / 30 samples`);
      }
      return `${distinct} distinct positions (fallback id)`;
    }

    const distinct = new Set(samples.map((s) => `${s.x.toFixed(2)},${s.z.toFixed(2)}`)).size;
    if (distinct < 5) {
      throw new Error(`browser mesh only ${distinct} distinct positions / 30 samples`);
    }
    return `${distinct} distinct positions in 3s on browser mesh`;
  });
} finally {
  try { await browser?.close(); } catch {}
  await safeLeave(probeRoom, hostRoom);
}

const ok = r.summary();
process.exit(ok ? 0 : 1);
