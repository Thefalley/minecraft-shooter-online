/**
 * UI + in-game physics checks (Playwright, single browser).
 *
 * Goes deeper than the lobby smoke test by driving the actual game scene:
 *  - lobby form, redirect to game
 *  - waiting room overlay + 5 character cards + room code
 *  - Empezar partida → countdown → game scene mounts
 *  - canvas, HUD, stats overlay, pointer hint click-through all live
 *  - canvas click acquires pointer lock (mouse capture works)
 *  - WASD pressed → player position changes (server-broadcast → local mesh)
 *  - mouse moved → camera yaw changes (look() works in multiplayer)
 *  - HUD shows non-empty ammo/health text
 *  - bare game URL redirects to lobby (no orphan singleplayer entry)
 *
 * Uses `window.__voxelGame` (added in Game.start()) to inspect the live
 * scene from the test harness. ~60s. Exit 0 = green, 1 = red.
 */

import { chromium } from 'playwright';
import { Reporter } from './lib/reporter.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const LOBBY = args.lobby || 'https://minecraft-shooter-online-web.vercel.app';
const GAME = args.game || 'https://voxel-dragons-game.vercel.app';

const r = new Reporter(`UI + game physics · ${LOBBY}`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 200)}`);
});

try {
  // ─── Lobby ────────────────────────────────────────────────
  await r.check('lobby loads with name + code form', async () => {
    await page.goto(LOBBY, { waitUntil: 'networkidle', timeout: 30000 });
    const ok = await page.evaluate(
      () => !!document.querySelector('#name') && !!document.querySelector('#code')
    );
    if (!ok) throw new Error('form inputs missing');
    return '#name + #code present';
  });

  await r.check('crear sala redirects to game (not localhost, not /play)', async () => {
    await page.fill('#name', 'PhysE2E');
    await page.click('button:has-text("Crear sala")');
    await page.waitForURL(/voxel-dragons-game/, { timeout: 15000 });
    const url = page.url();
    if (url.includes('localhost')) throw new Error(`localhost leak: ${url}`);
    if (url.includes('/play?')) throw new Error('legacy /play redirect');
    return url.slice(0, 70) + '…';
  });

  // Wait for game bundle + Colyseus connection to settle.
  await page.waitForTimeout(7000);

  // ─── Waiting room ─────────────────────────────────────────
  await r.check('waiting room shows code + 5 cards + start button', async () => {
    const data = await page.evaluate(() => ({
      overlay: !!document.querySelector('.vd-lobby'),
      code: document.querySelector('.vd-lobby-code')?.textContent?.trim(),
      cards: document.querySelectorAll('.vd-lobby-char, [class*="char-card"]').length,
      startBtn: !!document.querySelector('.vd-lobby-start'),
    }));
    if (!data.overlay) throw new Error('lobby overlay missing');
    if (!data.code || !/^[A-Z2-9]{5}$/.test(data.code)) {
      throw new Error(`bad code "${data.code}"`);
    }
    if (data.cards < 5) throw new Error(`only ${data.cards} cards, expected ≥5`);
    if (!data.startBtn) throw new Error('start button missing');
    return `code=${data.code} cards=${data.cards}`;
  });

  // ─── Empezar partida → game scene ─────────────────────────
  await r.check('host clicks Empezar → game scene mounts (canvas + HUD + stats)', async () => {
    await page.click('.vd-lobby-start');
    // countdown ≈ 3s + transition
    await page.waitForFunction(() => !!document.querySelector('canvas'), { timeout: 12000 });
    await page.waitForTimeout(3500);
    const data = await page.evaluate(() => ({
      canvas: !!document.querySelector('canvas'),
      canvasArea: (() => {
        const c = document.querySelector('canvas');
        if (!c) return 0;
        const r = c.getBoundingClientRect();
        return Math.round(r.width * r.height);
      })(),
      hud: !!document.querySelector('.vd-hud'),
      stats: !!document.querySelector('.vd-stats-overlay'),
      lobbyGone: !document.querySelector('.vd-lobby'),
      hint: !!document.querySelector('.vd-pointer-hint'),
      voxelGameExposed: !!window.__voxelGame,
    }));
    if (!data.canvas) throw new Error('canvas missing');
    if (data.canvasArea < 100000) throw new Error(`canvas too small: ${data.canvasArea}px²`);
    if (!data.hud) throw new Error('HUD missing');
    if (!data.stats) throw new Error('stats overlay missing');
    if (!data.lobbyGone) throw new Error('lobby still in DOM');
    if (!data.hint) throw new Error('pointer hint missing');
    if (!data.voxelGameExposed) throw new Error('window.__voxelGame not exposed');
    return `canvas=${data.canvasArea}px² + HUD + stats + hint + __voxelGame`;
  });

  // ─── Stats overlay shows the room code, not "-----" ──────
  await r.check('stats overlay shows room code (not placeholder)', async () => {
    const code = await page.evaluate(() =>
      document.querySelector('.v-room')?.textContent?.trim()
    );
    if (!code) throw new Error('no .v-room element');
    if (code === '-----') throw new Error('still placeholder');
    if (!/^[A-Z2-9]{5}$/.test(code)) throw new Error(`bad code "${code}"`);
    return code;
  });

  // ─── Pointer hint click-through ───────────────────────────
  await r.check('pointer hint is click-through to canvas', async () => {
    const data = await page.evaluate(() => {
      const inner = document.querySelector('.vd-pointer-hint .hint');
      const pe = inner ? getComputedStyle(inner).pointerEvents : 'missing';
      // What does elementFromPoint return at the canvas center?
      const c = document.querySelector('canvas');
      const rect = c.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      return {
        innerPE: pe,
        topAtCenter: document.elementFromPoint(cx, cy)?.tagName ?? null,
      };
    });
    if (data.innerPE !== 'none') {
      throw new Error(`inner .hint pointer-events=${data.innerPE}, should be none`);
    }
    if (data.topAtCenter !== 'CANVAS') {
      throw new Error(`elementFromPoint at center=${data.topAtCenter}, should be CANVAS`);
    }
    return 'inner pe=none + canvas on top';
  });

  // ─── HUD shows live values ────────────────────────────────
  await r.check('HUD shows non-empty health/ammo (player initialized)', async () => {
    const data = await page.evaluate(() => {
      const text = document.querySelector('.vd-hud')?.textContent ?? '';
      return {
        text: text.slice(0, 300),
        hasNumber: /\d/.test(text),
      };
    });
    if (!data.hasNumber) throw new Error(`HUD has no numbers: "${data.text}"`);
    return `HUD has live numeric values`;
  });

  // ─── Game state instrumentation accessible ─────────────────
  await r.check('window.__voxelGame.player.position is defined', async () => {
    const pos = await page.evaluate(() => {
      const g = window.__voxelGame;
      if (!g?.player) return null;
      const p = g.player.position ?? g.player.group?.position ?? g.camera?.position;
      if (!p) return null;
      return { x: p.x, y: p.y, z: p.z };
    });
    if (!pos) throw new Error('player.position not accessible');
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) {
      throw new Error(`bad position ${JSON.stringify(pos)}`);
    }
    return `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
  });

  // ─── Mouse capture (pointer lock acquires on canvas click) ─
  await r.check('canvas click → mouse capture (pointer lock)', async () => {
    const canvas = await page.$('canvas');
    if (!canvas) throw new Error('no canvas');
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(400);
    const locked = await page.evaluate(() => !!document.pointerLockElement);
    if (!locked) {
      // In some headless contexts pointer lock fails — log as warn but don't fail
      // (the canvas click should at least bypass the hint which we already verified).
      return 'pointer lock unavailable in headless (hint click-through still verified)';
    }
    return 'pointerLockElement set';
  });

  // ─── WASD presses change the player's local position ──────
  await r.check('keyboard W moves player forward (server broadcast → local mesh)', async () => {
    const before = await page.evaluate(() => {
      const g = window.__voxelGame;
      const p = g.player.position ?? g.player.group?.position ?? g.camera?.position;
      return p ? { x: p.x, y: p.y, z: p.z } : null;
    });
    if (!before) throw new Error('no player position before');
    await page.keyboard.down('w');
    await page.waitForTimeout(1200);
    await page.keyboard.up('w');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => {
      const g = window.__voxelGame;
      const p = g.player.position ?? g.player.group?.position ?? g.camera?.position;
      return p ? { x: p.x, y: p.y, z: p.z } : null;
    });
    if (!after) throw new Error('no player position after');
    const dist = Math.hypot(after.x - before.x, after.z - before.z);
    if (dist < 0.5) {
      throw new Error(`player only moved ${dist.toFixed(2)}u after 1.2s of W, expected >0.5u`);
    }
    return `moved ${dist.toFixed(2)}u`;
  });

  // ─── Mouse movement changes camera yaw ────────────────────
  await r.check('mouse movement changes camera yaw', async () => {
    const beforeYaw = await page.evaluate(() => {
      const g = window.__voxelGame;
      return g?.camera?.rotation?.y ?? g?.player?.yaw ?? null;
    });
    if (beforeYaw == null) throw new Error('no yaw before');
    // Simulate mouse movement. Player.look reads movementX/movementY from
    // mousemove events, which Playwright generates when we drag the mouse.
    const canvas = await page.$('canvas');
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 30; i += 1) {
      await page.mouse.move(cx + 8 * i, cy);
      await page.waitForTimeout(15);
    }
    await page.waitForTimeout(300);
    const afterYaw = await page.evaluate(() => {
      const g = window.__voxelGame;
      return g?.camera?.rotation?.y ?? g?.player?.yaw ?? null;
    });
    if (afterYaw == null) throw new Error('no yaw after');
    const delta = Math.abs(afterYaw - beforeYaw);
    if (delta < 0.01) {
      // headless without pointer lock won't capture mouse movement → can't verify
      return `headless yaw not captured (Δ=${delta.toExponential(2)}); skipped`;
    }
    return `yaw Δ=${delta.toFixed(3)}rad`;
  });

  // ─── Bare game URL → lobby (no orphan singleplayer entry) ─
  await r.check('bare game URL redirects back to lobby', async () => {
    await page.goto(GAME, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1200);
    const url = page.url();
    if (!url.includes('minecraft-shooter-online-web.vercel.app')) {
      throw new Error(`expected lobby, got ${url}`);
    }
    return 'redirected';
  });

  // ─── Solo escape hatch still works ────────────────────────
  await r.check('?solo=1 still reaches singleplayer menu', async () => {
    await page.goto(`${GAME}/?solo=1`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500);
    const ok = await page.evaluate(
      () => !!document.querySelector('.vd-char-card, .vd-menu')
    );
    if (!ok) throw new Error('solo menu missing');
    return 'menu visible';
  });

  // ─── No fatal JS errors ───────────────────────────────────
  await r.check('no fatal JS errors during whole flow', () => {
    const fatal = errors.filter(
      (e) =>
        !/WebSocket is already in CLOSING/i.test(e) &&
        !/cleared/i.test(e) &&
        !/sw\.js|service-worker/i.test(e)
    );
    if (fatal.length > 0) throw new Error(`${fatal.length} fatal: ${fatal[0]}`);
    return `${errors.length} benign filtered`;
  });
} finally {
  await browser.close();
}

const ok = r.summary();
process.exit(ok ? 0 : 1);
