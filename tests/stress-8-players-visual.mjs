// tests/stress-8-players-visual.mjs
//
// Visual 8-player E2E stress test against the production stack:
//   - Lobby   (Vercel) https://minecraft-shooter-online-web.vercel.app
//   - Game    (Vercel) https://voxel-dragons-game.vercel.app
//   - Server  (Render) wss://minecraft-shooter-online.onrender.com
//
// Spawns ONE Chromium browser with EIGHT isolated browser contexts (= 8
// independent players on 8 simulated devices), each with their own
// localStorage / cookies / pointer / viewport. Each context:
//
//   1. Opens the lobby URL.
//   2. Player 1 (Host) types "Host", clicks "Crear sala", waits for the
//      WaitingRoom in the game tab, reads the room code from the visible
//      `.vd-lobby-code` element.
//   3. Players 2..8 type "Bot2".."Bot8", paste the host's room code in
//      the join field, click "Unirse".
//   4. Each of the eight pages should end up in the WaitingRoom of the
//      same Colyseus room. We take per-player screenshots there.
//   5. Host clicks "Empezar partida". All eight pages should see the
//      3-2-1 countdown and then transition into the voxel scene.
//   6. Each bot focuses the canvas, holds W for ~1.5 s, and screenshots
//      its in-game POV.
//   7. We read FPS + PING from each page's `.vd-stats-overlay` (DOM text).
//
// Screenshots land in screenshots/stress-visual/ (already gitignored via
// the `screenshots/` line in .gitignore).
//
// Playwright is resolved relative to this file via the repo-root install
// at ../node_modules/playwright. No `pnpm install` needed.
//
// Run:
//   node tests/stress-8-players-visual.mjs
//
// Total runtime ~90-120 s.  Adds 60 s of slack on the first /health probe
// to absorb a possible Render Free cold-start; logs whether it triggered.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "../node_modules/playwright/index.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const LOBBY_URL = "https://minecraft-shooter-online-web.vercel.app";
const GAME_URL = "https://voxel-dragons-game.vercel.app";
const SERVER_HTTP = "https://minecraft-shooter-online.onrender.com";

const NUM_PLAYERS = 8;
const VIEWPORT = { width: 1280, height: 720 };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SHOTS_DIR = resolve(__dirname, "..", "screenshots", "stress-visual");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

async function probeHealth(timeoutMs) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${SERVER_HTTP}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    const ms = Date.now() - t0;
    let uptime = null;
    try {
      const j = JSON.parse(body);
      if (typeof j.uptime === "number") uptime = j.uptime;
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, ms, uptime, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - t0,
      uptime: null,
      error: err.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Per-player page operations
// ---------------------------------------------------------------------------
/**
 * Drive a single page from the lobby URL all the way to a connected
 * WaitingRoom. For the host: clicks "Crear sala" without typing a code.
 * For bots: types the room code into the "Código de sala" field and clicks
 * "Unirse".
 *
 * Returns true on success (room code visible in `.vd-lobby-code`), false
 * if the WaitingRoom never appeared within the timeout.
 */
async function gotoLobbyAndEnterRoom({ page, playerName, mode, roomCode }) {
  // 1. Lobby.
  await page.goto(LOBBY_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // The form is client-rendered (`use client`) but the inputs should show up
  // within a second or two after hydration.
  await page.locator('input#name').waitFor({ state: "visible", timeout: 20_000 });
  await page.fill('input#name', playerName);

  if (mode === "create") {
    // The "Crear sala" button is the first button in the lobby card.
    await page.getByRole("button", { name: /^Crear sala$/i }).click();
  } else {
    if (!roomCode) {
      throw new Error(`Bot ${playerName} has no roomCode to join`);
    }
    await page.locator('input#code').waitFor({ state: "visible", timeout: 15_000 });
    await page.fill('input#code', roomCode);
    await page.getByRole("button", { name: /^Unirse$/i }).click();
  }

  // 2. The lobby redirects to GAME_URL with ?name=&mode=&code= params. The
  //    game's main.js calls readJoinParams() and mounts the WaitingRoom once
  //    Colyseus accepts the join. Wait for the room code to render.
  await page.waitForURL(new RegExp("voxel-dragons-game\\.vercel\\.app"), {
    timeout: 30_000,
  });
  await page
    .locator('.vd-lobby-code')
    .waitFor({ state: "visible", timeout: 45_000 });

  // 3. Pull the code that the WaitingRoom is showing (server-confirmed).
  const codeText = (await page.locator(".vd-lobby-code").textContent()) || "";
  return codeText.replace(/\s+/g, "").toUpperCase();
}

/**
 * Read FPS + PING from the StatsOverlay DOM. Returns nulls if the overlay is
 * not mounted (i.e., the player never made it into the game).
 */
async function readStats(page) {
  try {
    const has = await page.locator(".vd-stats-overlay").count();
    if (!has) return { fps: null, ping: null, room: null };
    const fpsText = (await page.locator(".vd-stats-overlay .v-fps").textContent()) || "";
    const pingText = (await page.locator(".vd-stats-overlay .v-ping").textContent()) || "";
    const roomText = (await page.locator(".vd-stats-overlay .v-room").textContent()) || "";
    const fps = parseInt(fpsText.replace(/[^0-9]/g, ""), 10);
    const ping = parseInt(pingText.replace(/[^0-9]/g, ""), 10);
    return {
      fps: Number.isFinite(fps) ? fps : null,
      ping: Number.isFinite(ping) ? ping : null,
      room: roomText.trim() || null,
    };
  } catch {
    return { fps: null, ping: null, room: null };
  }
}

/**
 * Best-effort verification that the page is showing the in-game 3D scene:
 *   - the WaitingRoom overlay (`.vd-lobby`) must be gone
 *   - a `<canvas>` must be present and visible
 *   - the StatsOverlay (`.vd-stats-overlay`) must be mounted
 */
async function isInGame(page) {
  const lobby = await page.locator(".vd-lobby").count();
  if (lobby > 0) {
    // The countdown sometimes leaves `.vd-lobby` briefly visible. Treat that
    // as still-not-in-game.
    const visible = await page.locator(".vd-lobby").first().isVisible();
    if (visible) return false;
  }
  const canvas = await page.locator("canvas").count();
  if (canvas === 0) return false;
  const stats = await page.locator(".vd-stats-overlay").count();
  return stats > 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await mkdir(SHOTS_DIR, { recursive: true });
  const log = (msg) => console.log(`[visual] ${nowIso()} ${msg}`);

  log("--- 8-player visual stress test starting ---");
  log(`lobby=${LOBBY_URL}`);
  log(`game =${GAME_URL}`);
  log(`server=${SERVER_HTTP}`);

  // --- 1. Probe /health to surface Render cold-start ---
  log("probing /health (up to 60 s to allow Render cold start)...");
  const probeStart = Date.now();
  let health = await probeHealth(10_000);
  let coldStart = false;
  let coldStartMs = 0;
  if (!health.ok || health.ms > 8000) {
    coldStart = true;
    log(`/health slow or failed (${health.ms} ms, status=${health.status}). Retrying with 60s timeout.`);
    health = await probeHealth(60_000);
    coldStartMs = Date.now() - probeStart;
    log(`cold start observed: ${(coldStartMs / 1000).toFixed(1)}s`);
  }
  if (!health.ok) {
    throw new Error(`/health unreachable after retry: ${health.error ?? health.status}`);
  }
  const uptimeStart = health.uptime;
  log(`/health ok in ${health.ms}ms, server uptime=${uptimeStart?.toFixed(1)}s`);

  // --- 2. Launch one browser with NUM_PLAYERS isolated contexts ---
  log(`launching Chromium with ${NUM_PLAYERS} isolated contexts...`);
  const browser = await chromium.launch({
    headless: true,
    args: [
      // Helps stabilize WebGL inside headless mode on Render-targeting tests.
      "--use-gl=swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--no-sandbox",
    ],
  });

  // The Host is contexts[0]; bots are contexts[1..7].
  const contexts = [];
  const pages = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const ctx = await browser.newContext({
      viewport: VIEWPORT,
      // Different storage state per player by default — newContext is isolated.
      // Faking a per-player UA avoids any same-machine analytics merging.
      userAgent:
        `Mozilla/5.0 (StressVisualBot/${i}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36`,
    });
    const page = await ctx.newPage();
    page.on("pageerror", (err) =>
      console.warn(`[visual]   p${i} pageerror: ${err.message}`),
    );
    contexts.push(ctx);
    pages.push(page);
  }

  const playerNames = [
    "Host",
    "Bot2",
    "Bot3",
    "Bot4",
    "Bot5",
    "Bot6",
    "Bot7",
    "Bot8",
  ];

  /** @type {Array<{name:string, joinedRoom:boolean, inGame:boolean, fps:number|null, ping:number|null, room:string|null, errors:string[]}>} */
  const perPlayer = playerNames.map((n) => ({
    name: n,
    joinedRoom: false,
    inGame: false,
    fps: null,
    ping: null,
    room: null,
    errors: [],
  }));

  let roomCode = null;
  const errors = [];

  try {
    // --- 3. Host creates the room ---
    log("Host → lobby → Crear sala");
    try {
      roomCode = await gotoLobbyAndEnterRoom({
        page: pages[0],
        playerName: playerNames[0],
        mode: "create",
      });
      perPlayer[0].joinedRoom = true;
      perPlayer[0].room = roomCode;
      log(`Host is in WaitingRoom, room code = ${roomCode}`);
    } catch (err) {
      errors.push(`Host failed to create room: ${err.message}`);
      perPlayer[0].errors.push(err.message);
      log(`!! Host create failed: ${err.message}`);
      // Bail early — no point spawning bots without a room code.
      throw err;
    }

    // Give the room a moment to settle (vd-lobby fully rendered).
    await sleep(1500);

    // --- 4. Bots 2..8 join in parallel ---
    log(`spawning ${NUM_PLAYERS - 1} bots to join room ${roomCode}...`);
    const joinTasks = [];
    for (let i = 1; i < NUM_PLAYERS; i++) {
      joinTasks.push(
        (async () => {
          try {
            const code = await gotoLobbyAndEnterRoom({
              page: pages[i],
              playerName: playerNames[i],
              mode: "join",
              roomCode,
            });
            perPlayer[i].joinedRoom = true;
            perPlayer[i].room = code;
            log(`  ${playerNames[i]} joined room ${code}`);
          } catch (err) {
            perPlayer[i].errors.push(err.message);
            log(`  !! ${playerNames[i]} failed to join: ${err.message}`);
          }
        })(),
      );
    }
    await Promise.all(joinTasks);

    const joinedCount = perPlayer.filter((p) => p.joinedRoom).length;
    log(`waiting-room joined: ${joinedCount}/${NUM_PLAYERS}`);

    // Wait for the host's player list to reflect every connected bot. Up to 8s.
    await sleep(2000);

    // --- 5. Screenshots: waiting room for everyone ---
    log("screenshot 01-host-waiting + per-bot waiting...");
    try {
      await pages[0].screenshot({
        path: resolve(SHOTS_DIR, "01-host-waiting.png"),
        fullPage: false,
      });
    } catch (err) {
      log(`!! host waiting screenshot failed: ${err.message}`);
    }
    for (let i = 1; i < NUM_PLAYERS; i++) {
      try {
        await pages[i].screenshot({
          path: resolve(SHOTS_DIR, `02-bot${i + 1}-waiting.png`),
          fullPage: false,
        });
      } catch (err) {
        log(`!! bot${i + 1} waiting screenshot failed: ${err.message}`);
      }
    }

    // --- 6. Host clicks "Empezar partida" ---
    log("Host clicks Empezar partida...");
    try {
      // Only the host should see the green start button. If host is not
      // considered host by the server we'll see "Esperando al host…" and the
      // click will throw on no-element.
      await pages[0]
        .getByRole("button", { name: /Empezar partida/i })
        .click({ timeout: 10_000 });
    } catch (err) {
      errors.push(`Host could not click Empezar: ${err.message}`);
      log(`!! host start click failed: ${err.message}`);
    }

    // 3-second server countdown — try to snapshot the host mid-count.
    await sleep(1200);
    try {
      await pages[0].screenshot({
        path: resolve(SHOTS_DIR, "03-countdown.png"),
        fullPage: false,
      });
    } catch {
      /* non-fatal */
    }

    // Wait for all pages to leave the lobby and end up in the 3D scene.
    // The server flips phase → "playing" after the 3s countdown completes.
    log("waiting for all clients to enter the 3D scene...");
    const inGameDeadline = Date.now() + 20_000;
    while (Date.now() < inGameDeadline) {
      const checks = await Promise.all(pages.map((p) => isInGame(p).catch(() => false)));
      const inGameCount = checks.filter(Boolean).length;
      if (inGameCount === NUM_PLAYERS) break;
      await sleep(500);
    }
    const finalChecks = await Promise.all(pages.map((p) => isInGame(p).catch(() => false)));
    for (let i = 0; i < NUM_PLAYERS; i++) {
      perPlayer[i].inGame = finalChecks[i];
    }
    log(`in-game: ${finalChecks.filter(Boolean).length}/${NUM_PLAYERS}`);

    // Let the scene render a few frames + let the StatsOverlay sample FPS at
    // least once (1 s rolling window).
    await sleep(2500);

    // --- 7. Each player performs a brief W-walk, then screenshot + stats ---
    log("each player: pointer-lock attempt + W for 1.5s + screenshot...");
    const moveTasks = pages.map(async (page, i) => {
      try {
        // Best-effort pointer-lock acquisition. In headless this may be denied,
        // which is FINE — the W keypress still moves the player.
        try {
          await page.locator("canvas").first().click({ timeout: 3000 });
        } catch {
          /* canvas might be obscured by countdown remnants; safe to skip */
        }
        await page.keyboard.down("KeyW");
        await sleep(1500);
        await page.keyboard.up("KeyW");
        // Settle a frame, then screenshot.
        await sleep(300);
        const shotName = i === 0
          ? "04-host-in-game.png"
          : `05-bot${i + 1}-in-game.png`;
        await page.screenshot({
          path: resolve(SHOTS_DIR, shotName),
          fullPage: false,
        });
      } catch (err) {
        perPlayer[i].errors.push(`in-game ops: ${err.message}`);
        log(`!! ${playerNames[i]} in-game ops failed: ${err.message}`);
      }
    });
    await Promise.all(moveTasks);

    // --- 8. Read stats once everyone has had a chance to render ---
    await sleep(1500);
    for (let i = 0; i < NUM_PLAYERS; i++) {
      const stats = await readStats(pages[i]);
      perPlayer[i].fps = stats.fps;
      perPlayer[i].ping = stats.ping;
      if (!perPlayer[i].room && stats.room) perPlayer[i].room = stats.room;
    }
  } catch (err) {
    log(`FATAL during run: ${err.message}`);
    errors.push(`fatal: ${err.message}`);
  } finally {
    // --- 9. Final /health probe ---
    let finalHealth = null;
    try {
      finalHealth = await probeHealth(15_000);
    } catch {
      /* ignore */
    }

    // --- 10. Tear down browser ---
    try {
      await browser.close();
    } catch {
      /* ignore */
    }

    // --- 11. Markdown report ---
    const runEndedAt = nowIso();
    const lines = [];
    lines.push("");
    lines.push("## Stress test — 8 players visual");
    lines.push("");
    lines.push("### Setup");
    lines.push(`- Lobby: ${LOBBY_URL}`);
    lines.push(`- Game: ${GAME_URL}`);
    lines.push(`- Server: ${SERVER_HTTP}`);
    lines.push(`- Run finished at: ${runEndedAt}`);
    lines.push(
      `- Render uptime at start: ${uptimeStart !== null ? `${uptimeStart.toFixed(1)} s` : "unknown"}`,
    );
    if (coldStart) {
      lines.push(`- Render cold start: yes (${(coldStartMs / 1000).toFixed(1)} s)`);
    } else {
      lines.push("- Render cold start: no (server already warm)");
    }
    lines.push("");
    lines.push("### Per-player results");
    lines.push("| Player | Joined waiting room | Entered game | FPS | PING | Screenshot |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (let i = 0; i < NUM_PLAYERS; i++) {
      const p = perPlayer[i];
      const shot = i === 0 ? "04-host-in-game.png" : `05-bot${i + 1}-in-game.png`;
      lines.push(
        `| ${p.name} | ${p.joinedRoom ? "yes" : "NO"} | ${p.inGame ? "yes" : "NO"} | ${p.fps ?? "n/a"} | ${p.ping !== null ? `${p.ping}ms` : "n/a"} | ${shot} |`,
      );
    }
    lines.push("");
    lines.push("### Server stats");
    if (finalHealth?.ok) {
      const drift = finalHealth.uptime !== null && uptimeStart !== null
        ? `${(finalHealth.uptime - uptimeStart).toFixed(1)} s elapsed`
        : "uptime n/a";
      lines.push(`- Final /health: HTTP ${finalHealth.status} in ${finalHealth.ms}ms (${drift})`);
      lines.push(`- Final uptime: ${finalHealth.uptime !== null ? finalHealth.uptime.toFixed(1) + " s" : "n/a"}`);
    } else {
      lines.push(`- Final /health: UNREACHABLE (${finalHealth?.error ?? finalHealth?.status ?? "?"})`);
    }
    lines.push(`- Was Render cold-started? ${coldStart ? "yes" : "no"}`);
    const playerErrors = perPlayer.flatMap((p) => p.errors);
    const total5xx = playerErrors.filter((e) => /HTTP\s*5\d\d|status\s*5\d\d/i.test(e)).length;
    lines.push(`- 5xx errors observed in client logs: ${total5xx}`);
    lines.push("");

    lines.push("### Observations");
    const joinedAll = perPlayer.every((p) => p.joinedRoom);
    const inGameAll = perPlayer.every((p) => p.inGame);
    lines.push(`- All ${NUM_PLAYERS} reached waiting room: ${joinedAll ? "YES" : "NO"}`);
    lines.push(`- All ${NUM_PLAYERS} transitioned into the 3D scene: ${inGameAll ? "YES" : "NO"}`);
    const fpsValues = perPlayer.map((p) => p.fps).filter((v) => Number.isFinite(v));
    if (fpsValues.length > 0) {
      const minFps = Math.min(...fpsValues);
      const meanFps = Math.round(fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length);
      lines.push(`- FPS: min=${minFps}, mean=${meanFps} across ${fpsValues.length} clients (>=30 target)`);
    } else {
      lines.push("- FPS: no samples (StatsOverlay not mounted on any client?)");
    }
    const pingValues = perPlayer.map((p) => p.ping).filter((v) => Number.isFinite(v));
    if (pingValues.length > 0) {
      const maxPing = Math.max(...pingValues);
      const meanPing = Math.round(pingValues.reduce((a, b) => a + b, 0) / pingValues.length);
      lines.push(`- PING: max=${maxPing}ms, mean=${meanPing}ms across ${pingValues.length} clients (<100ms target)`);
    } else {
      lines.push("- PING: no samples");
    }
    lines.push(
      "- Headless Chromium does NOT acquire pointer lock — the crosshair will not follow mouse moves in screenshots. This is a Playwright/Chromium limitation, not a game bug.",
    );
    lines.push(
      "- Visual presence of other players: check screenshots 04-host-in-game.png and 05-botN-in-game.png for capsule meshes (Phase 3 remote-render renders them with character-id colors).",
    );
    lines.push("");

    lines.push("### Critical findings");
    if (!joinedAll) {
      lines.push(`- ${NUM_PLAYERS - perPlayer.filter((p) => p.joinedRoom).length} player(s) failed to reach the WaitingRoom.`);
    }
    if (!inGameAll && joinedAll) {
      lines.push(`- ${NUM_PLAYERS - perPlayer.filter((p) => p.inGame).length} player(s) reached WaitingRoom but never entered the 3D scene after the countdown.`);
    }
    if (errors.length === 0 && joinedAll && inGameAll) {
      lines.push("- None. All 8 players joined the same room and entered the scene cleanly.");
    } else {
      for (const e of errors) lines.push(`- ${e}`);
    }
    lines.push("");

    const report = lines.join("\n");
    console.log(report);

    try {
      await writeFile(
        resolve(SHOTS_DIR, "REPORT.md"),
        report + "\n",
        "utf8",
      );
    } catch {
      /* ignore */
    }
    try {
      await writeFile(
        resolve(SHOTS_DIR, "report.json"),
        JSON.stringify(
          {
            target: { LOBBY_URL, GAME_URL, SERVER_HTTP },
            roomCode,
            coldStart,
            coldStartMs,
            uptimeStart,
            finalHealth,
            perPlayer,
            errors,
            runEndedAt,
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error("[visual] fatal:", err);
  process.exit(1);
});
