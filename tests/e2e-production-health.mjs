/**
 * E2E health check against production. Runs in <90s, requires zero manual
 * input, prints a pass/fail report. Designed so you can run it after every
 * commit to verify nothing regressed without having to click through the
 * lobby yourself.
 *
 * Usage:
 *   node tests/e2e-production-health.mjs
 *   node tests/e2e-production-health.mjs --lobby=URL --game=URL --server=URL
 *
 * Exit code 0 if all checks pass, 1 otherwise.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const LOBBY  = args.lobby  || 'https://minecraft-shooter-online-web.vercel.app';
const GAME   = args.game   || 'https://voxel-dragons-game.vercel.app';
const SERVER = args.server || 'https://minecraft-shooter-online.onrender.com';
const OUT    = resolve('screenshots/e2e-health');

const results = [];
const startedAt = Date.now();

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => {
      results.push({ name, pass: true, detail });
      console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
    })
    .catch((err) => {
      results.push({ name, pass: false, error: err?.message || String(err) });
      console.log(`  ✗ ${name} — ${err?.message || err}`);
    });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log('=== E2E production health check ===');
  console.log(`Lobby:  ${LOBBY}`);
  console.log(`Game:   ${GAME}`);
  console.log(`Server: ${SERVER}`);
  console.log('');

  // ── 1. Backend reachable ────────────────────────────────────────────────
  console.log('1) Backend (Render)');
  await check('GET /health returns 200', async () => {
    const r = await fetch(`${SERVER}/health`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return `uptime ${Math.round(j.uptime)}s`;
  });
  await check('GET /rooms/by-code/NONEX returns 404', async () => {
    const r = await fetch(`${SERVER}/rooms/by-code/NONEX`);
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
    return '404 as expected';
  });

  // ── 2. Lobby reachable and form present ─────────────────────────────────
  console.log('\n2) Lobby (Vercel #1)');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 200)}`);
  });

  await check('Lobby loads, name+code inputs present', async () => {
    await page.goto(LOBBY, { waitUntil: 'networkidle', timeout: 30000 });
    const ok = await page.evaluate(() => !!document.querySelector('#name') && !!document.querySelector('#code'));
    if (!ok) throw new Error('inputs missing');
    return 'inputs ok';
  });

  // ── 3. Create room redirects to game ────────────────────────────────────
  console.log('\n3) Lobby → Game handoff');
  await check('Crear sala redirige a voxel-dragons-game (not localhost, not /play)', async () => {
    await page.fill('#name', 'E2E');
    await page.click('button:has-text("Crear sala")');
    await page.waitForURL(/voxel-dragons-game\.vercel\.app/, { timeout: 15000 });
    const url = page.url();
    if (url.includes('localhost')) throw new Error(`redirected to localhost: ${url}`);
    if (url.includes('/play?')) throw new Error('redirected to legacy /play instead of game');
    return url.slice(0, 80);
  });

  // ── 4. WaitingRoom shows up correctly ───────────────────────────────────
  console.log('\n4) Waiting room (multiplayer)');
  await page.waitForTimeout(8000);
  await check('WaitingRoom DOM present with room code', async () => {
    const data = await page.evaluate(() => ({
      hasOverlay: !!document.querySelector('.vd-lobby'),
      code: document.querySelector('.vd-lobby-code')?.textContent?.trim() || null,
      startBtn: !!document.querySelector('.vd-lobby-start'),
      charCards: document.querySelectorAll('.vd-lobby-char, [class*="char-card"]').length,
    }));
    if (!data.hasOverlay) throw new Error('overlay missing');
    if (!data.code || !/[A-Z2-9]{5}/.test(data.code)) throw new Error(`bad code: "${data.code}"`);
    if (!data.startBtn) throw new Error('start button missing');
    return `code=${data.code}, cards=${data.charCards}`;
  });
  await page.screenshot({ path: `${OUT}/01-waitingroom.png`, fullPage: true });

  // ── 5. Start game brings up the 3D scene ───────────────────────────────
  console.log('\n5) Empezar partida → game scene');
  await check('Click Empezar partida → 3D canvas appears, HUD mounts', async () => {
    await page.click('.vd-lobby-start');
    await page.waitForTimeout(6500); // countdown 3s + transition
    const data = await page.evaluate(() => ({
      hasCanvas: !!document.querySelector('canvas'),
      lobbyGone: !document.querySelector('.vd-lobby'),
      hasHud: !!document.querySelector('.vd-hud'),
      hasStats: !!document.querySelector('.vd-stats-overlay'),
      hasPointerHint: !!document.querySelector('.vd-pointer-hint'),
      hintIsClickThrough: (() => {
        const el = document.querySelector('.vd-pointer-hint .hint');
        return el ? getComputedStyle(el).pointerEvents === 'none' : false;
      })(),
      roomShown: document.querySelector('.v-room')?.textContent?.trim() || null,
    }));
    if (!data.hasCanvas) throw new Error('canvas missing');
    if (!data.lobbyGone) throw new Error('lobby overlay still in DOM');
    if (!data.hasHud) throw new Error('HUD missing');
    if (!data.hasStats) throw new Error('stats overlay missing');
    if (!data.hasPointerHint) throw new Error('pointer hint missing');
    if (!data.hintIsClickThrough) throw new Error('pointer hint .hint child does NOT have pointer-events:none — clicks will be swallowed');
    if (!data.roomShown || data.roomShown === '-----') throw new Error('room code not in stats overlay');
    return `canvas + hud + stats + hint(click-through) + room=${data.roomShown}`;
  });
  await page.screenshot({ path: `${OUT}/02-in-game.png`, fullPage: true });

  // ── 6. Solo direct URL still works for debug ───────────────────────────
  console.log('\n6) Singleplayer escape hatch (?solo=1)');
  await page.goto(`${GAME}/?solo=1`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2000);
  await check('Singleplayer menu reachable with ?solo=1', async () => {
    const ok = await page.evaluate(() => !!document.querySelector('.vd-char-card, .vd-menu'));
    if (!ok) throw new Error('menu not present');
    return 'menu visible';
  });

  // ── 7. Bare game URL redirects to lobby (no singleplayer leak) ─────────
  console.log('\n7) Bare game URL → lobby');
  await page.goto(GAME, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1500);
  await check('voxel-dragons-game.vercel.app/ (no params) redirects to lobby', async () => {
    const url = page.url();
    if (!url.includes('minecraft-shooter-online-web.vercel.app')) {
      throw new Error(`expected lobby URL, got: ${url}`);
    }
    return url;
  });

  // ── 8. No fatal console errors during the flow ─────────────────────────
  console.log('\n8) JS errors / pageerrors during the flow');
  await check('No fatal pageerror / console.error during the flow', () => {
    if (errors.length === 0) return 'none';
    // Tolerate Colyseus's reconnection close (1000 normal close) and benign HMR
    const fatal = errors.filter(
      (e) => !/WebSocket is already in CLOSING/i.test(e) && !/cleared/i.test(e),
    );
    if (fatal.length > 0) throw new Error(`${fatal.length} fatal: ${fatal[0]}`);
    return `${errors.length} benign warnings filtered`;
  });

  await browser.close();

  // ── Summary ────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log(`RESULT: ${pass}/${pass + fail} passed in ${elapsed}s`);
  if (fail > 0) {
    console.log('Failures:');
    for (const r of results.filter((r) => !r.pass)) console.log(`  ✗ ${r.name}: ${r.error}`);
  }
  console.log('═══════════════════════════════════════════');
  console.log(`Screenshots: ${OUT}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('SUITE ABORTED:', err);
  process.exit(1);
});
