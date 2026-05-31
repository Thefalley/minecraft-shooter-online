/**
 * Multi-player position trace.
 *
 * Spawns N (default 2) real browser clients in the same room. One of them
 * moves through a predetermined sequence (idle → forward slow → forward
 * sprint → strafe → spin) while the trace samples every 100 ms:
 *   - client cameraHolder.position (what the user sees)
 *   - server state.players[selfId].x/y/z (what the AI targets)
 *   - server state.enemies (each zombie's xyz)
 *   - corresponding client mesh position per zombie
 *   - input cmd flips logged into __voxelDebug.ring
 *
 * Output: trace.txt — one row per sample, columns:
 *   t_ms  who  what            x        y        z        extra
 * Easy to grep ('grep ^P1 trace.txt' → only player1 rows, etc).
 *
 * Plus trace.json — the raw structured dump for programmatic analysis.
 *
 * Designed to surface:
 *   - drift between client and server position of the SAME player
 *   - whether the drift grows with movement speed (overflow theory)
 *   - whether the zombie AI is targeting the server pos or some stale value
 *   - whether the input pump is firing at the expected 20 Hz
 *
 * Usage:
 *   node tests/position-trace.mjs                   # 2 clients, 30 s
 *   node tests/position-trace.mjs --clients=3 --secs=45
 *   node tests/position-trace.mjs --out=mytrace.txt
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const LOBBY = args.lobby || 'https://minecraft-shooter-online-web.vercel.app';
const N = Number(args.clients) || 2;
const SECS = Number(args.secs) || 30;
const OUT_TXT = resolve(args.out || 'traces/position-trace.txt');
const OUT_JSON = OUT_TXT.replace(/\.txt$/, '.json');

await mkdir(dirname(OUT_TXT), { recursive: true });

console.log(`Spawning ${N} browsers, sampling for ${SECS}s, output → ${OUT_TXT}`);

const browser = await chromium.launch({ headless: true });
const pages = [];

async function dump(page) {
  return await page.evaluate(() => {
    const g = window.__voxelGame;
    if (!g) return null;
    const bridge = g.network?.getBridge?.();
    const state = bridge?.getRoomState?.();
    const selfId = bridge?.getSelfSessionId?.();
    const cp = g.player.cameraHolder?.position ?? g.player.position;
    const out = {
      selfId,
      clientPos: { x: cp.x, y: cp.y, z: cp.z },
      cameraYaw: g.camera?.rotation?.y ?? null,
      pointerLocked: !!document.pointerLockElement,
      serverPlayers: {},
      enemies: [],
    };
    if (state?.players) {
      state.players.forEach((p, sid) => {
        out.serverPlayers[sid] = { x: p.x, y: p.y, z: p.z, rotationY: p.rotationY };
      });
    }
    if (state?.enemies && g.zombies?._serverEntities) {
      const allLocal = new Map();
      for (const z of g.zombies._serverEntities.values()) allLocal.set(z.id, { mgr: 'zombie', mesh: z.mesh });
      for (const s of (g.skeletons?._serverEntities?.values() ?? [])) allLocal.set(s.id, { mgr: 'skel', mesh: s.mesh });
      for (const w of (g.witches?._serverEntities?.values() ?? [])) allLocal.set(w.id, { mgr: 'witch', mesh: w.mesh });
      state.enemies.forEach((e, id) => {
        const local = allLocal.get(id);
        out.enemies.push({
          id,
          kind: e.kind,
          server: { x: e.x, y: e.y, z: e.z },
          client: local?.mesh ? { x: local.mesh.position.x, y: local.mesh.position.y, z: local.mesh.position.z } : null,
        });
      });
    }
    return out;
  });
}

async function lastInputCmds(page) {
  return await page.evaluate(() => {
    const ring = window.__voxelDebug?.ring ?? [];
    return ring.filter((e) => e.category === 'mp:input:cmd').slice(-10);
  });
}

try {
  // Host (P1) creates the room
  let roomCode;
  for (let i = 0; i < N; i += 1) {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
    const page = await ctx.newPage();
    if (i === 0) {
      await page.goto(LOBBY, { waitUntil: 'networkidle', timeout: 60000 });
      await page.fill('#name', `P${i + 1}`);
      await page.click('button:has-text("Crear sala")');
      await page.waitForURL(/voxel-dragons-game/, { timeout: 40000 });
      await page.waitForFunction(() => !!document.querySelector('.vd-lobby-code'), { timeout: 30000 });
      roomCode = await page.evaluate(
        () => document.querySelector('.vd-lobby-code')?.textContent?.trim()
      );
      console.log(`P1 created room ${roomCode}`);
    } else {
      await page.goto(LOBBY, { waitUntil: 'networkidle', timeout: 60000 });
      await page.fill('#name', `P${i + 1}`);
      await page.fill('#code', roomCode);
      // React state catches up after fill; wait until Unirse button enables.
      await page.waitForFunction(
        () => {
          const btns = [...document.querySelectorAll('button')];
          const b = btns.find((x) => /Unirse/i.test(x.textContent || ''));
          return b && !b.disabled;
        },
        { timeout: 20000 }
      ).catch(() => {});
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const b = btns.find((x) => /Unirse/i.test(x.textContent || ''));
        if (b) { b.disabled = false; b.click(); }
      });
      await page.waitForURL(/voxel-dragons-game/, { timeout: 40000 });
      console.log(`P${i + 1} joined ${roomCode}`);
    }
    pages.push(page);
  }
  // Wait for everyone in waiting room then host starts. Triggering the
  // button via DOM directly bypasses Playwright actionability — the button
  // may briefly appear disabled while React reconciles.
  await new Promise((r) => setTimeout(r, 7000));
  await pages[0].evaluate(() => {
    const btn = document.querySelector('.vd-lobby-start');
    if (btn) {
      btn.disabled = false;
      btn.click();
    }
  });
  for (const page of pages) {
    await page.waitForFunction(() => !!document.querySelector('canvas'), { timeout: 30000 });
    await page.waitForFunction(() => !!window.__voxelGame, { timeout: 30000 });
  }
  console.log('All clients in scene. Waiting 4 s for EnemySync backfill.');
  await new Promise((r) => setTimeout(r, 4000));

  // Engage pointer lock on P1 by clicking the canvas centre
  const c = await pages[0].$('canvas');
  const box = await c.boundingBox();
  await pages[0].mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await new Promise((r) => setTimeout(r, 400));

  const lines = [];
  const json = { meta: { lobby: LOBBY, clients: N, secs: SECS, roomCode }, samples: [] };

  // Drive P1 through the script while sampling all clients.
  const startedAt = Date.now();
  const sampleEveryMs = 100;
  const totalMs = SECS * 1000;

  function fmt(n) { return n == null ? '----' : n.toFixed(2).padStart(7, ' '); }

  // Header
  lines.push(`# multi-player position trace — ${new Date().toISOString()}`);
  lines.push(`# lobby=${LOBBY} clients=${N} secs=${SECS} room=${roomCode}`);
  lines.push(`# columns: t_ms  src   pid/eid                clientX clientY clientZ  serverX serverY serverZ  drift   note`);

  // Movement script (driven on P1 only)
  const driver = (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Phase 1: idle 2 s
    await sleep(2000);
    lines.push(`# phase 1 idle done @ ${Date.now() - startedAt}ms`);
    // Phase 2: forward slow 3 s
    await pages[0].keyboard.down('KeyW');
    await sleep(3000);
    lines.push(`# phase 2 forward-slow done @ ${Date.now() - startedAt}ms`);
    // Phase 3: forward sprint 3 s
    await pages[0].keyboard.down('ShiftLeft');
    await sleep(3000);
    await pages[0].keyboard.up('ShiftLeft');
    lines.push(`# phase 3 forward-sprint done @ ${Date.now() - startedAt}ms`);
    // Phase 4: strafe right 2 s
    await pages[0].keyboard.up('KeyW');
    await pages[0].keyboard.down('KeyD');
    await sleep(2000);
    await pages[0].keyboard.up('KeyD');
    lines.push(`# phase 4 strafe-right done @ ${Date.now() - startedAt}ms`);
    // Phase 5: spin (mouse rotation) for 2 s while idle
    for (let i = 0; i < 40; i += 1) {
      await pages[0].mouse.move(box.x + box.width / 2 + i * 8, box.y + box.height / 2);
      await sleep(50);
    }
    lines.push(`# phase 5 spin done @ ${Date.now() - startedAt}ms`);
    // Phase 6: back to spawn — backward + sprint 4 s
    await pages[0].keyboard.down('KeyS');
    await pages[0].keyboard.down('ShiftLeft');
    await sleep(4000);
    await pages[0].keyboard.up('ShiftLeft');
    await pages[0].keyboard.up('KeyS');
    lines.push(`# phase 6 back-to-spawn done @ ${Date.now() - startedAt}ms`);
    // Phase 7: idle remainder
    while (Date.now() - startedAt < totalMs) await sleep(200);
  })();

  while (Date.now() - startedAt < totalMs) {
    const t = Date.now() - startedAt;
    const snaps = [];
    for (let i = 0; i < pages.length; i += 1) {
      try { snaps.push(await dump(pages[i])); }
      catch { snaps.push(null); }
    }
    json.samples.push({ t, snaps });
    // Plain-text row per player + per enemy as seen by P1.
    for (let i = 0; i < snaps.length; i += 1) {
      const s = snaps[i];
      if (!s) continue;
      const pid = `P${i + 1}`;
      const sp = s.serverPlayers[s.selfId];
      const dx = sp ? (s.clientPos.x - sp.x) : null;
      const dy = sp ? (s.clientPos.y - sp.y) : null;
      const dz = sp ? (s.clientPos.z - sp.z) : null;
      const drift = sp ? Math.hypot(dx, dz) : null;
      lines.push(
        `${String(t).padStart(6, ' ')} ${pid.padEnd(5, ' ')} ${(pid + '/' + (s.selfId || '?')).slice(0, 18).padEnd(18, ' ')} ` +
        `${fmt(s.clientPos.x)} ${fmt(s.clientPos.y)} ${fmt(s.clientPos.z)}  ` +
        `${fmt(sp?.x)} ${fmt(sp?.y)} ${fmt(sp?.z)}  ` +
        `${drift == null ? '----' : drift.toFixed(2).padStart(5, ' ')}  ` +
        `yaw=${s.cameraYaw?.toFixed(2) ?? '----'} pl=${s.pointerLocked ? 'Y' : 'n'}`
      );
    }
    // Enemy rows from P1's view only (the AI position is server-side anyway)
    if (snaps[0]?.enemies) {
      for (const e of snaps[0].enemies) {
        const dx = e.client ? e.client.x - e.server.x : null;
        const dz = e.client ? e.client.z - e.server.z : null;
        const drift = dx != null ? Math.hypot(dx, dz) : null;
        lines.push(
          `${String(t).padStart(6, ' ')} E     ${(e.kind + ':' + e.id).padEnd(18, ' ')} ` +
          `${fmt(e.client?.x)} ${fmt(e.client?.y)} ${fmt(e.client?.z)}  ` +
          `${fmt(e.server.x)} ${fmt(e.server.y)} ${fmt(e.server.z)}  ` +
          `${drift == null ? '----' : drift.toFixed(2).padStart(5, ' ')}`
        );
      }
    }
    await new Promise((r) => setTimeout(r, sampleEveryMs));
  }

  await driver;

  // Append the input-cmd ring tail from each client so we see what was pumped.
  for (let i = 0; i < pages.length; i += 1) {
    const cmds = await lastInputCmds(pages[i]);
    lines.push(`# last 10 mp:input:cmd entries for P${i + 1}`);
    for (const c of cmds) {
      lines.push(`#   t=${c.t}  seq=${c.payload.seq}  fwd=${c.payload.forward} back=${c.payload.backward} L=${c.payload.left} R=${c.payload.right} jump=${c.payload.jump} sprint=${c.payload.sprint} yaw=${c.payload.rotationY}`);
    }
  }

  await writeFile(OUT_TXT, lines.join('\n') + '\n', 'utf8');
  await writeFile(OUT_JSON, JSON.stringify(json, null, 2), 'utf8');
  console.log(`Wrote ${lines.length} text rows → ${OUT_TXT}`);
  console.log(`Wrote ${json.samples.length} sample dumps → ${OUT_JSON}`);

  // Quick spoiler: report max drift over the whole run for the moving player.
  let maxSelfDrift = 0;
  for (const sample of json.samples) {
    const s = sample.snaps[0];
    if (!s) continue;
    const sp = s.serverPlayers[s.selfId];
    if (!sp) continue;
    const d = Math.hypot(s.clientPos.x - sp.x, s.clientPos.z - sp.z);
    if (d > maxSelfDrift) maxSelfDrift = d;
  }
  console.log(`MAX P1 client↔server drift across run: ${maxSelfDrift.toFixed(2)}u`);
} finally {
  await browser.close();
}
