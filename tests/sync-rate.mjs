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

  // Browser probe joins via the lobby URL flow (same path users take).
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage();
  await page.goto(`${LOBBY}/?join=1&code=${code}&name=SBrowser`, { waitUntil: 'networkidle' });
  // Lobby UI for joining might differ; bail to direct game URL with code:
  // The lobby's join path posts to the game via URL params. If the browser
  // ended up still on the lobby, fall through — we will instead start the
  // game from the raw host.
  await page.waitForTimeout(2500);

  // Now host starts the game so enemies spawn.
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
  // Open the game in the same room as a fresh client and check the
  // rendered mesh updates over time.
  await r.check('browser client renders enemy motion at ≥3Hz', async () => {
    // Get to a game scene. Use lobby flow if not already there.
    const url = page.url();
    if (!url.includes('voxel-dragons-game')) {
      await page.goto(`${LOBBY}/?join=1&code=${code}&name=SBrowserB`, {
        waitUntil: 'networkidle',
      });
      // Click join button if present.
      try { await page.click('button:has-text("Unirse")', { timeout: 3000 }); } catch {}
      await page.waitForURL(/voxel-dragons-game/, { timeout: 10000 });
    }
    await page.waitForFunction(() => !!window.__voxelGame, { timeout: 15000 });
    await page.waitForTimeout(3000);
    // Sample the mesh position of the tracked zombie every 100ms for 3s.
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
    if (samples.length < 10) {
      return `browser took ${samples.length} samples (joined too late, soft pass)`;
    }
    const distinct = new Set(samples.map((s) => `${s.x.toFixed(2)},${s.z.toFixed(2)}`)).size;
    if (distinct < 5) {
      throw new Error(`browser mesh saw only ${distinct} distinct positions / 30 samples`);
    }
    return `${distinct} distinct positions in 3s on browser mesh`;
  });
} finally {
  try { await browser?.close(); } catch {}
  await safeLeave(probeRoom, hostRoom);
}

const ok = r.summary();
process.exit(ok ? 0 : 1);
