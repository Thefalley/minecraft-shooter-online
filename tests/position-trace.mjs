/**
 * Multi-player position trace.
 *
 * Strategy: a raw Colyseus host (no browser) creates the room and starts
 * the game; N browser clients join the running room via the direct game
 * URL. This sidesteps the brittle React lobby form for Playwright.
 *
 * Each browser is driven through a movement script (idle/forward/sprint/
 * strafe). We sample every 100 ms:
 *   - cameraHolder.position (visual)
 *   - state.players[self].x/y/z (server's view of THIS browser)
 *   - state.enemies (each id) + matching client mesh per id
 *
 * Output:
 *   traces/position-trace.txt   one row per sample, grep-able
 *   traces/position-trace.json  raw structured dump
 *
 * Usage: node tests/position-trace.mjs --clients=2 --secs=20
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createClient, createRoom, waitForState, safeLeave } from './lib/colyseus.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const SERVER = args.server || 'wss://minecraft-shooter-online.onrender.com';
const GAME = args.game || 'https://voxel-dragons-game.vercel.app';
const N = Number(args.clients) || 2;
const SECS = Number(args.secs) || 20;
const OUT_TXT = resolve(args.out || 'traces/position-trace.txt');
const OUT_JSON = OUT_TXT.replace(/\.txt$/, '.json');
await mkdir(dirname(OUT_TXT), { recursive: true });

console.log(`Raw-Colyseus host + ${N} browsers, sampling for ${SECS}s → ${OUT_TXT}`);

let hostClient = null;
let hostRoom = null;
let browser = null;
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
      for (const z of g.zombies._serverEntities.values()) allLocal.set(z.id, z.mesh);
      for (const s of (g.skeletons?._serverEntities?.values() ?? [])) allLocal.set(s.id, s.mesh);
      for (const w of (g.witches?._serverEntities?.values() ?? [])) allLocal.set(w.id, w.mesh);
      state.enemies.forEach((e, id) => {
        const mesh = allLocal.get(id);
        out.enemies.push({
          id,
          kind: e.kind,
          server: { x: e.x, y: e.y, z: e.z },
          client: mesh ? { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z } : null,
        });
      });
    }
    return out;
  });
}

try {
  // 1) Raw Colyseus host creates room and starts the game
  hostClient = await createClient(SERVER);
  hostRoom = await createRoom(hostClient, { name: 'HostBot', characterId: 'duck' });
  await waitForState(hostRoom, (s) => !!s.roomCode, { timeoutMs: 5000 });
  const roomCode = hostRoom.state.roomCode;
  console.log(`Room ${roomCode} ready`);

  // 2) N browser clients navigate directly to the game URL with ?join params
  browser = await chromium.launch({ headless: true });
  for (let i = 0; i < N; i += 1) {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
    const page = await ctx.newPage();
    const url = `${GAME}/?name=P${i + 1}&mode=join&code=${roomCode}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    pages.push(page);
    console.log(`P${i + 1} navigated to game URL`);
  }
  // Wait for all browsers to reach the WaitingRoom (game's networking has connected)
  await new Promise((r) => setTimeout(r, 4000));

  // 3) Host starts the game from raw Colyseus
  hostRoom.send('vp:lobby:start', { countdownMs: 200 });
  await waitForState(hostRoom, (s) => s.phase === 'playing', { timeoutMs: 5000 });
  await waitForState(hostRoom, (s) => s.enemies.size > 0, { timeoutMs: 5000 });
  console.log('Server in playing phase, enemies spawned');

  // Wait for every browser to finish countdown + mount the game scene
  for (let i = 0; i < pages.length; i += 1) {
    try {
      await pages[i].waitForFunction(() => !!window.__voxelGame, { timeout: 30000 });
      console.log(`P${i + 1} scene mounted`);
    } catch (e) {
      console.log(`P${i + 1} scene mount FAILED — ${e.message?.split('\n')[0]}`);
    }
  }
  await new Promise((r) => setTimeout(r, 4000));

  // 4) Engage pointer lock + click center for P1
  const c = await pages[0].$('canvas');
  const box = await c.boundingBox();
  await pages[0].mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await new Promise((r) => setTimeout(r, 400));

  const lines = [];
  const json = { meta: { server: SERVER, game: GAME, clients: N, secs: SECS, roomCode }, samples: [] };
  function fmt(n) { return n == null ? '----' : n.toFixed(2).padStart(7, ' '); }
  lines.push(`# multi-player position trace — ${new Date().toISOString()}`);
  lines.push(`# server=${SERVER} game=${GAME} clients=${N} secs=${SECS} room=${roomCode}`);
  lines.push(`# columns: t_ms src   pid/eid             clientX clientY clientZ  serverX serverY serverZ  drift  note`);

  const startedAt = Date.now();
  const totalMs = SECS * 1000;

  // Drive P1 through a movement script
  const driver = (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(1500);
    lines.push(`# phase 1 idle done @ ${Date.now() - startedAt}ms`);
    await pages[0].keyboard.down('KeyW');
    await sleep(2500);
    lines.push(`# phase 2 forward-slow done @ ${Date.now() - startedAt}ms`);
    await pages[0].keyboard.down('ShiftLeft');
    await sleep(2500);
    await pages[0].keyboard.up('ShiftLeft');
    lines.push(`# phase 3 sprint done @ ${Date.now() - startedAt}ms`);
    await pages[0].keyboard.up('KeyW');
    await pages[0].keyboard.down('KeyD');
    await sleep(1500);
    await pages[0].keyboard.up('KeyD');
    lines.push(`# phase 4 strafe done @ ${Date.now() - startedAt}ms`);
    await pages[0].keyboard.down('KeyS');
    await sleep(2500);
    await pages[0].keyboard.up('KeyS');
    lines.push(`# phase 5 back done @ ${Date.now() - startedAt}ms`);
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
    for (let i = 0; i < snaps.length; i += 1) {
      const s = snaps[i];
      if (!s) continue;
      const pid = `P${i + 1}`;
      const sp = s.serverPlayers[s.selfId];
      const drift = sp ? Math.hypot(s.clientPos.x - sp.x, s.clientPos.z - sp.z) : null;
      lines.push(
        `${String(t).padStart(6, ' ')} ${pid.padEnd(5, ' ')} ${(pid + '/' + (s.selfId || '?')).slice(0, 18).padEnd(18, ' ')} ` +
        `${fmt(s.clientPos.x)} ${fmt(s.clientPos.y)} ${fmt(s.clientPos.z)}  ` +
        `${fmt(sp?.x)} ${fmt(sp?.y)} ${fmt(sp?.z)}  ` +
        `${drift == null ? '----' : drift.toFixed(2).padStart(5, ' ')}  ` +
        `yaw=${s.cameraYaw?.toFixed(2) ?? '----'} pl=${s.pointerLocked ? 'Y' : 'n'}`
      );
    }
    if (snaps[0]?.enemies) {
      for (const e of snaps[0].enemies.slice(0, 4)) {
        const drift = e.client ? Math.hypot(e.client.x - e.server.x, e.client.z - e.server.z) : null;
        lines.push(
          `${String(t).padStart(6, ' ')} E     ${(e.kind + ':' + e.id).padEnd(18, ' ')} ` +
          `${fmt(e.client?.x)} ${fmt(e.client?.y)} ${fmt(e.client?.z)}  ` +
          `${fmt(e.server.x)} ${fmt(e.server.y)} ${fmt(e.server.z)}  ` +
          `${drift == null ? '----' : drift.toFixed(2).padStart(5, ' ')}`
        );
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await driver;

  await writeFile(OUT_TXT, lines.join('\n') + '\n', 'utf8');
  await writeFile(OUT_JSON, JSON.stringify(json, null, 2), 'utf8');
  console.log(`Wrote ${lines.length} rows → ${OUT_TXT}`);
  console.log(`Wrote ${json.samples.length} samples → ${OUT_JSON}`);

  // Summary: max drift across all browsers across the entire run
  let maxDrift = 0;
  for (const sample of json.samples) {
    for (const s of sample.snaps) {
      if (!s) continue;
      const sp = s.serverPlayers[s.selfId];
      if (!sp) continue;
      const d = Math.hypot(s.clientPos.x - sp.x, s.clientPos.z - sp.z);
      if (d > maxDrift) maxDrift = d;
    }
  }
  console.log(`MAX client↔server player drift across ${N} browser(s): ${maxDrift.toFixed(2)}u`);
} finally {
  try { await browser?.close(); } catch {}
  await safeLeave(hostRoom);
}
