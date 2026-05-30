// tests/stress-many-players.mjs
//
// Server-load stress test for the Colyseus GameRoom.
//
// Spawns N bot clients per room, in parallel. Each bot:
//   - joins (first one creates the room with `client.create('game', opts)`,
//     the rest re-join the same room via `client.joinById(roomId, opts)`),
//   - sends a `VoxelClientMessage.Input` payload at INPUT_PUMP_RATE (20 Hz)
//     with randomized direction + jump probability,
//   - sends a `VoxelClientMessage.Ping` payload at 2 Hz and listens for
//     `VoxelServerMessage.Pong` to measure RTT,
//   - listens to `room.onStateChange` and increments a counter per
//     snapshot (we expect 20/s on a healthy server, since the room
//     publishes patches at 1000/20 ms).
//
// At the end of `--duration` seconds, every bot disconnects cleanly and
// the script writes a per-scenario JSON report to
//   screenshots/stress/scenario-X-YYYYMMDDTHHMMSS.json
// (the `screenshots/` directory is already gitignored).
//
// Usage:
//   node tests/stress-many-players.mjs --players=4 --rooms=1 --duration=20
//
// When invoked WITHOUT --players (or with --scenarios=ALL), runs three
// pre-baked scenarios A / B / C and prints a markdown summary at the end:
//
//   A — 1 room × 2 players  (20 s)
//   B — 1 room × 4 players  (20 s)
//   C — 1 room × 8 players  (20 s)        ← MAX_PLAYERS_PER_ROOM
//
// All against the production server at
// `wss://minecraft-shooter-online.onrender.com` (Render Free, sleep 15 min,
// 0.1 vCPU / 512 MB). The first scenario absorbs cold-start latency; we
// report it explicitly as `coldStartMs`.
//
// We import colyseus.js from `apps/game/node_modules/colyseus.js` so the
// script needs zero extra `npm install`. The ESM entry is
// `build/esm/index.mjs`.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Client,
  MatchMakeError,
} from "../apps/game/node_modules/colyseus.js/build/esm/index.mjs";

// ---------------------------------------------------------------------------
// Constants mirrored from packages/shared so this script has no build deps.
// ---------------------------------------------------------------------------
const GAME_ROOM_NAME = "game";
const INPUT_PUMP_RATE = 20; // Hz, matches server tick
const INPUT_PUMP_INTERVAL_MS = 1000 / INPUT_PUMP_RATE;
const PING_INTERVAL_MS = 500;
const MAX_PLAYERS_PER_ROOM = 8;

const VoxelClientMessage = {
  Input: "vp:input",
  Ping: "vp:ping",
};
const VoxelServerMessage = {
  Pong: "vs:pong",
};

const DEFAULT_TARGET = "wss://minecraft-shooter-online.onrender.com";
const DEFAULT_DURATION_S = 30;
const DEFAULT_ROOMS = 1;
const DEFAULT_PLAYERS = 4;
const CHARACTER_IDS = ["duck", "knight", "hunter", "samurai", "mage"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT_DIR = resolve(__dirname, "..", "screenshots", "stress");

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    players: null,
    rooms: DEFAULT_ROOMS,
    duration: DEFAULT_DURATION_S,
    target: DEFAULT_TARGET,
    scenarios: null, // null => run preset A/B/C
    label: null,
    coldRetryMs: 60_000,
  };
  for (const arg of argv) {
    const m = arg.match(/^--([\w-]+)=(.+)$/);
    if (!m) continue;
    const [, k, v] = m;
    switch (k) {
      case "players":
        out.players = Math.max(1, Number(v));
        break;
      case "rooms":
        out.rooms = Math.max(1, Number(v));
        break;
      case "duration":
        out.duration = Math.max(1, Number(v));
        break;
      case "target":
        out.target = String(v);
        break;
      case "scenarios":
        out.scenarios = String(v).toUpperCase();
        break;
      case "label":
        out.label = String(v);
        break;
      case "cold-retry-ms":
        out.coldRetryMs = Math.max(1000, Number(v));
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor((p / 100) * (sortedAsc.length - 1))),
  );
  return sortedAsc[idx];
}

function mean(arr) {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function fmtMs(v) {
  if (!Number.isFinite(v)) return "n/a";
  if (v < 10) return `${v.toFixed(1)}ms`;
  return `${Math.round(v)}ms`;
}

function nowIso() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---------------------------------------------------------------------------
// Bot lifecycle
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} BotStats
 * @property {string} id           local id (Bot1, Bot2, ...)
 * @property {string|null} sessionId
 * @property {number} snapshots    total state-change events received
 * @property {number[]} rtts       round-trip times in ms
 * @property {number} pingsSent
 * @property {number} pongsReceived
 * @property {number|null} joinedAt epoch ms when join() resolved
 * @property {number|null} firstStateAt epoch ms of first onStateChange
 * @property {boolean} dropped     true if disconnected before duration ended
 * @property {string[]} errors
 * @property {number} inputsSent
 */

/**
 * Build a randomized 20 Hz input frame. The server only consumes the latest
 * input per session each tick — duplicates are cheap. We rotate slowly so we
 * actually exercise the player-movement integration on the server.
 */
function makeInputFactory() {
  let seq = 0;
  let yaw = Math.random() * Math.PI * 2;
  let pitch = 0;
  let nextDirChangeAt = Date.now() + 800 + Math.random() * 1600;
  let cur = { forward: false, backward: false, left: false, right: false };
  return () => {
    seq += 1;
    const t = Date.now();
    if (t >= nextDirChangeAt) {
      // 70% of the time pick a non-idle direction.
      const idle = Math.random() < 0.3;
      cur = {
        forward: !idle && Math.random() < 0.55,
        backward: !idle && Math.random() < 0.2,
        left: !idle && Math.random() < 0.35,
        right: !idle && Math.random() < 0.35,
      };
      nextDirChangeAt = t + 600 + Math.random() * 1800;
    }
    yaw += (Math.random() - 0.5) * 0.08;
    pitch += (Math.random() - 0.5) * 0.03;
    if (pitch > 1.2) pitch = 1.2;
    if (pitch < -1.2) pitch = -1.2;
    return {
      forward: cur.forward,
      backward: cur.backward,
      left: cur.left,
      right: cur.right,
      jump: Math.random() < 0.05,
      sprint: false,
      dash: false,
      attack: false,
      guard: false,
      reload: false,
      rotationY: yaw,
      pitch,
      inventorySlot: 0,
      seq,
    };
  };
}

/**
 * Spawn a single bot, hold the connection open for `durationMs`, then leave.
 * Returns its accumulated stats.
 *
 * @param {Object} args
 * @param {Client} args.client
 * @param {string} args.botId            display name
 * @param {string|null} args.roomIdToJoin null = create
 * @param {number} args.durationMs
 * @returns {Promise<{ stats: BotStats, roomId: string|null, joinError?: Error }>}
 */
async function runBot({ client, botId, roomIdToJoin, durationMs }) {
  /** @type {BotStats} */
  const stats = {
    id: botId,
    sessionId: null,
    snapshots: 0,
    rtts: [],
    pingsSent: 0,
    pongsReceived: 0,
    joinedAt: null,
    firstStateAt: null,
    dropped: false,
    errors: [],
    inputsSent: 0,
  };

  const characterId =
    CHARACTER_IDS[Math.floor(Math.random() * CHARACTER_IDS.length)];
  const opts = { name: botId.slice(0, 16), characterId };

  let room;
  try {
    if (roomIdToJoin === null) {
      room = await client.create(GAME_ROOM_NAME, opts);
    } else {
      room = await client.joinById(roomIdToJoin, opts);
    }
  } catch (err) {
    return { stats, roomId: null, joinError: err };
  }

  stats.joinedAt = Date.now();
  stats.sessionId = room.sessionId;
  const roomId = room.roomId;

  // Pending pings, keyed by client-side timestamp `t`, so RTT is exact.
  const inflight = new Map();

  room.onStateChange((_state) => {
    stats.snapshots += 1;
    if (stats.firstStateAt === null) stats.firstStateAt = Date.now();
  });
  room.onMessage(VoxelServerMessage.Pong, (msg) => {
    const t = typeof msg?.t === "number" ? msg.t : 0;
    const sentAt = inflight.get(t);
    if (sentAt !== undefined) {
      inflight.delete(t);
      stats.rtts.push(Date.now() - sentAt);
      stats.pongsReceived += 1;
    }
  });
  room.onError((code, message) => {
    stats.errors.push(`room:error code=${code} msg=${message ?? ""}`);
  });
  room.onLeave((code) => {
    if (Date.now() - stats.joinedAt < durationMs - 250) {
      stats.dropped = true;
      stats.errors.push(`leave:code=${code} early`);
    }
  });

  const inputFactory = makeInputFactory();

  const inputTimer = setInterval(() => {
    try {
      const payload = inputFactory();
      room.send(VoxelClientMessage.Input, payload);
      stats.inputsSent += 1;
    } catch (err) {
      stats.errors.push(`input:send ${err.message}`);
    }
  }, INPUT_PUMP_INTERVAL_MS);

  const pingTimer = setInterval(() => {
    try {
      const t = Date.now();
      inflight.set(t, t);
      room.send(VoxelClientMessage.Ping, { t });
      stats.pingsSent += 1;
      // Discard pings older than 5 s — server is probably under load.
      if (inflight.size > 20) {
        const cutoff = Date.now() - 5000;
        for (const [k, v] of inflight) {
          if (v < cutoff) inflight.delete(k);
        }
      }
    } catch (err) {
      stats.errors.push(`ping:send ${err.message}`);
    }
  }, PING_INTERVAL_MS);

  await sleep(durationMs);

  clearInterval(inputTimer);
  clearInterval(pingTimer);

  try {
    await room.leave(true);
  } catch (err) {
    stats.errors.push(`leave: ${err.message}`);
  }

  return { stats, roomId };
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------------------------------------------------------------------------
// Scenario runner — one room of N players (parallel)
// ---------------------------------------------------------------------------
/**
 * Run one room: spawn the lead bot which creates the room, then spawn the
 * rest in parallel which all join by id. Returns stats for every bot.
 */
async function runRoom({
  client,
  playersPerRoom,
  durationMs,
  botPrefix,
  roomNumber,
  coldRetryMs,
  onLog,
}) {
  // First bot: create. We retry once with a longer timeout for Render
  // cold-start. The free instance can take 30-60 s to wake.
  const leadId = `${botPrefix}${roomNumber}-Bot1`;
  onLog(`[room ${roomNumber}] lead ${leadId} → create("${GAME_ROOM_NAME}")`);

  const leadStartedAt = Date.now();
  let leadResult = await runBotWithTimeout({
    client,
    botId: leadId,
    roomIdToJoin: null,
    durationMs: durationMs + 1, // matches the rest, see start barrier below
    timeoutMs: coldRetryMs,
    startDeferred: true,
  });

  if (leadResult.error) {
    onLog(
      `[room ${roomNumber}] lead create attempt 1 FAILED: ${leadResult.error.message} — retrying with cold-start window ${coldRetryMs}ms`,
    );
    leadResult = await runBotWithTimeout({
      client,
      botId: leadId,
      roomIdToJoin: null,
      durationMs: durationMs + 1,
      timeoutMs: coldRetryMs,
      startDeferred: true,
    });
    if (leadResult.error) {
      throw new Error(
        `Could not create room (after cold-retry): ${leadResult.error.message}`,
      );
    }
  }

  const roomId = leadResult.roomId;
  const coldStartMs = Date.now() - leadStartedAt;
  onLog(
    `[room ${roomNumber}] lead joined in ${coldStartMs}ms — roomId=${roomId}, spawning ${playersPerRoom - 1} more`,
  );

  // Spawn the rest in parallel.
  const others = [];
  for (let i = 2; i <= playersPerRoom; i++) {
    const botId = `${botPrefix}${roomNumber}-Bot${i}`;
    others.push(
      runBotWithTimeout({
        client,
        botId,
        roomIdToJoin: roomId,
        durationMs,
        timeoutMs: 25_000,
        startDeferred: false,
      }),
    );
  }

  // Kick off the lead bot's lifetime in parallel with the join wave.
  leadResult.start();

  const allResults = await Promise.all([leadResult.lifetime, ...others.map((p) => p)]);

  return { coldStartMs, roomId, results: allResults };
}

/**
 * Wraps {@link runBot} with:
 *   - a join-phase timeout (so a stuck cold-start is bounded),
 *   - an optional `startDeferred` mode: connection is established, but the
 *     lifetime (sending inputs and waiting `durationMs`) does not begin
 *     until `.start()` is called. This lets the lead bot hold a room open
 *     while other bots are joining, then start its lifetime at the same
 *     moment they do.
 */
function runBotWithTimeout({
  client,
  botId,
  roomIdToJoin,
  durationMs,
  timeoutMs,
  startDeferred,
}) {
  // We re-implement just enough of `runBot` to factor the join phase out of
  // the lifetime. The semantics match runBot above.
  return new Promise(async (resolve) => {
    const characterId =
      CHARACTER_IDS[Math.floor(Math.random() * CHARACTER_IDS.length)];
    const opts = { name: botId.slice(0, 16), characterId };

    let room;
    const joinStartedAt = Date.now();
    const timeoutHandle = setTimeout(() => {
      // The colyseus.js Client has no abort handle for matchmake/join, so
      // we resolve with an error and let the actual join either succeed
      // late (we'll close the resulting room) or fail.
      resolveWith({
        error: new Error(`join timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);

    let alreadyResolved = false;
    let pendingStart = null;
    let pendingLifetime = null;

    function resolveWith(payload) {
      if (alreadyResolved) return;
      alreadyResolved = true;
      clearTimeout(timeoutHandle);
      resolve(payload);
    }

    try {
      if (roomIdToJoin === null) {
        room = await client.create(GAME_ROOM_NAME, opts);
      } else {
        room = await client.joinById(roomIdToJoin, opts);
      }
    } catch (err) {
      resolveWith({ error: err });
      return;
    }

    if (alreadyResolved) {
      // Timeout fired but the join eventually succeeded; close it.
      try {
        await room.leave(true);
      } catch {
        /* ignore */
      }
      return;
    }

    clearTimeout(timeoutHandle);

    /** @type {BotStats} */
    const stats = {
      id: botId,
      sessionId: room.sessionId,
      snapshots: 0,
      rtts: [],
      pingsSent: 0,
      pongsReceived: 0,
      joinedAt: Date.now(),
      firstStateAt: null,
      dropped: false,
      errors: [],
      inputsSent: 0,
    };

    const inflight = new Map();

    // Silence colyseus.js "onMessage() not registered" warnings by acking
    // every message the server is currently known to broadcast. We don't
    // care about the payloads — we're just keeping stdout clean.
    const NOOP_MESSAGES = [
      "server:welcome",
      "server:playerJoined",
      "server:playerLeft",
      "server:error",
      "vs:world:seed",
      "vs:world:delta",
      "vs:world:deltaBatch",
      "vs:enemy:spawn",
      "vs:enemy:despawn",
      "vs:enemy:event",
      "vs:dragon:fireball",
      "vs:weapon:hit",
      "vs:weapon:miss",
      "vs:weapon:reloadDone",
      "vs:ammo",
      "vs:damage",
      "vs:player:death",
      "vs:player:respawn",
      "vs:wave:start",
      "vs:wave:end",
      "vs:shop:open",
      "vs:shop:close",
      "vs:shop:applied",
      "vs:coins",
      "vs:lobby:phaseChange",
      "vs:lobby:hostChange",
      "vs:lobby:startCountdown",
    ];
    for (const t of NOOP_MESSAGES) {
      room.onMessage(t, () => {});
    }

    room.onStateChange(() => {
      stats.snapshots += 1;
      if (stats.firstStateAt === null) stats.firstStateAt = Date.now();
    });
    room.onMessage(VoxelServerMessage.Pong, (msg) => {
      const t = typeof msg?.t === "number" ? msg.t : 0;
      const sentAt = inflight.get(t);
      if (sentAt !== undefined) {
        inflight.delete(t);
        stats.rtts.push(Date.now() - sentAt);
        stats.pongsReceived += 1;
      }
    });
    room.onError((code, message) => {
      stats.errors.push(`room:error code=${code} msg=${message ?? ""}`);
    });
    let lifetimeStartedAt = 0;
    room.onLeave((code) => {
      if (lifetimeStartedAt && Date.now() - lifetimeStartedAt < durationMs - 250) {
        stats.dropped = true;
        stats.errors.push(`leave:code=${code} early`);
      }
    });

    const inputFactory = makeInputFactory();
    let inputTimer = null;
    let pingTimer = null;

    function startLifetime() {
      lifetimeStartedAt = Date.now();
      inputTimer = setInterval(() => {
        try {
          const payload = inputFactory();
          room.send(VoxelClientMessage.Input, payload);
          stats.inputsSent += 1;
        } catch (err) {
          stats.errors.push(`input:send ${err.message}`);
        }
      }, INPUT_PUMP_INTERVAL_MS);

      pingTimer = setInterval(() => {
        try {
          const t = Date.now();
          inflight.set(t, t);
          room.send(VoxelClientMessage.Ping, { t });
          stats.pingsSent += 1;
          if (inflight.size > 20) {
            const cutoff = Date.now() - 5000;
            for (const [k, v] of inflight) {
              if (v < cutoff) inflight.delete(k);
            }
          }
        } catch (err) {
          stats.errors.push(`ping:send ${err.message}`);
        }
      }, PING_INTERVAL_MS);

      return new Promise((resolveLifetime) => {
        setTimeout(async () => {
          clearInterval(inputTimer);
          clearInterval(pingTimer);
          try {
            await room.leave(true);
          } catch (err) {
            stats.errors.push(`leave: ${err.message}`);
          }
          resolveLifetime({ stats, roomId: room.roomId, joinMs: Date.now() - joinStartedAt });
        }, durationMs);
      });
    }

    if (startDeferred) {
      // Return immediately, exposing `.start()` and `.lifetime` for the
      // caller to drive.
      pendingLifetime = null;
      pendingStart = () => {
        pendingLifetime = startLifetime();
      };
      resolveWith({
        roomId: room.roomId,
        start: () => {
          pendingStart();
        },
        // Bind `lifetime` lazily so the caller can await it after start().
        get lifetime() {
          if (!pendingLifetime) {
            // start() wasn't called — start now to avoid deadlock.
            pendingStart();
          }
          return pendingLifetime;
        },
      });
    } else {
      const lifetime = startLifetime();
      const result = await lifetime;
      resolveWith(result);
    }
  });
}

// ---------------------------------------------------------------------------
// Per-scenario summary computation
// ---------------------------------------------------------------------------
function summarize({
  scenarioLabel,
  playersPerRoom,
  rooms,
  durationMs,
  coldStartMsList,
  botResults,
  startedAt,
  finishedAt,
}) {
  const expectedClients = playersPerRoom * rooms;
  const connected = botResults.filter((r) => r && r.stats?.joinedAt).length;
  const dropped = botResults.filter((r) => r && r.stats?.dropped).length;
  const allErrors = botResults
    .flatMap((r) => (r?.stats?.errors ?? []))
    .filter(Boolean);
  const errors = allErrors.length;

  const allRtts = botResults
    .flatMap((r) => (r?.stats?.rtts ?? []))
    .filter((v) => Number.isFinite(v) && v >= 0);
  allRtts.sort((a, b) => a - b);

  const meanRtt = mean(allRtts);
  const p50Rtt = percentile(allRtts, 50);
  const p95Rtt = percentile(allRtts, 95);
  const peakRtt = allRtts.length ? allRtts[allRtts.length - 1] : 0;

  const snapshotRates = botResults
    .filter((r) => r?.stats?.firstStateAt && r?.stats?.joinedAt)
    .map((r) => {
      const liveMs = Math.max(1, durationMs);
      return (r.stats.snapshots / liveMs) * 1000;
    });
  const meanSnapshotRate = mean(snapshotRates);

  const coldStartMs = coldStartMsList.length ? Math.max(...coldStartMsList) : null;

  return {
    scenario: scenarioLabel,
    target: undefined, // filled in by caller
    config: {
      playersPerRoom,
      rooms,
      durationMs,
      expectedClients,
      expectedSnapshotRatePerClient: 20,
    },
    timing: {
      startedAt,
      finishedAt,
      coldStartMs,
    },
    clients: {
      connected,
      expected: expectedClients,
      dropped,
    },
    rtt: {
      samples: allRtts.length,
      mean: round(meanRtt),
      p50: round(p50Rtt),
      p95: round(p95Rtt),
      peak: round(peakRtt),
    },
    snapshots: {
      meanRatePerClient: round(meanSnapshotRate, 2),
      expectedRatePerClient: 20,
      lossRatio: round(1 - meanSnapshotRate / 20, 3),
    },
    errors: {
      count: errors,
      samples: allErrors.slice(0, 20),
    },
    perBot: botResults.map((r) => ({
      id: r?.stats?.id ?? null,
      sessionId: r?.stats?.sessionId ?? null,
      snapshots: r?.stats?.snapshots ?? 0,
      pings: r?.stats?.pingsSent ?? 0,
      pongs: r?.stats?.pongsReceived ?? 0,
      inputs: r?.stats?.inputsSent ?? 0,
      dropped: r?.stats?.dropped ?? false,
      errors: r?.stats?.errors ?? [],
    })),
  };
}

function round(v, decimals = 1) {
  if (!Number.isFinite(v)) return null;
  const mult = 10 ** decimals;
  return Math.round(v * mult) / mult;
}

// ---------------------------------------------------------------------------
// Main entry — runs either CLI args or pre-baked A/B/C scenarios
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(OUT_DIR, { recursive: true });

  const runCustom = args.players !== null || args.scenarios === "CUSTOM";

  /** @type {Array<{label:string, players:number, rooms:number, durationMs:number}>} */
  const scenarios = [];
  if (runCustom) {
    scenarios.push({
      label: args.label ?? "X",
      players: args.players ?? DEFAULT_PLAYERS,
      rooms: args.rooms,
      durationMs: args.duration * 1000,
    });
  } else {
    // Pre-baked A / B / C — durations short enough to keep total under ~1.5 min
    // including 60 s of possible cold-start.
    scenarios.push(
      { label: "A", players: 2, rooms: 1, durationMs: 20_000 },
      { label: "B", players: 4, rooms: 1, durationMs: 20_000 },
      { label: "C", players: 8, rooms: 1, durationMs: 20_000 },
    );
  }

  const target = args.target;
  console.log(
    `[stress] target=${target} scenarios=${scenarios.map((s) => s.label).join(",")} coldRetryMs=${args.coldRetryMs}`,
  );

  const allSummaries = [];

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    console.log(
      `\n[stress] === scenario ${s.label}: ${s.rooms} room × ${s.players} players, ${s.durationMs / 1000}s ===`,
    );

    const client = new Client(target);

    /** @type {number[]} */
    const coldStartMsList = [];
    /** @type {Array<{stats:BotStats, roomId:string|null}>} */
    const botResults = [];

    try {
      // We run rooms sequentially in the lead-create phase so we don't fight
      // for matchmaker slots; the lifetime portion is fully parallel within
      // each room (and across rooms if R > 1, since we await all of them
      // together at the bottom).
      const roomPromises = [];
      for (let r = 1; r <= s.rooms; r++) {
        roomPromises.push(
          runRoom({
            client,
            playersPerRoom: s.players,
            durationMs: s.durationMs,
            botPrefix: s.label,
            roomNumber: r,
            // Only the very first scenario (i === 0) and very first room
            // expects a cold-start.
            coldRetryMs: i === 0 && r === 1 ? args.coldRetryMs : 25_000,
            onLog: (line) => console.log(`[stress]   ${line}`),
          }),
        );
      }

      const roomOutcomes = await Promise.all(roomPromises);
      for (const r of roomOutcomes) {
        coldStartMsList.push(r.coldStartMs);
        for (const result of r.results) {
          if (result && result.stats) botResults.push(result);
        }
      }
    } catch (err) {
      console.error(`[stress] scenario ${s.label} aborted: ${err.message}`);
      if (err instanceof MatchMakeError) {
        console.error(`[stress] matchmake error code=${err.code}`);
      }
      allSummaries.push({
        scenario: s.label,
        aborted: true,
        error: err.message,
        config: {
          playersPerRoom: s.players,
          rooms: s.rooms,
          durationMs: s.durationMs,
        },
      });
      continue;
    }

    const finishedAt = new Date().toISOString();
    const elapsedMs = Date.now() - startMs;

    const summary = summarize({
      scenarioLabel: s.label,
      playersPerRoom: s.players,
      rooms: s.rooms,
      durationMs: s.durationMs,
      coldStartMsList,
      botResults,
      startedAt,
      finishedAt,
    });
    summary.target = target;
    summary.elapsedMs = elapsedMs;

    const fileName = `scenario-${s.label}-${nowIso()}.json`;
    const outPath = resolve(OUT_DIR, fileName);
    await writeFile(outPath, JSON.stringify(summary, null, 2), "utf8");
    console.log(`[stress] scenario ${s.label} → ${outPath}`);

    allSummaries.push(summary);

    // Small gap between scenarios so the matchmaker fully cleans up disposed
    // rooms (the server logs `[GameRoom XXXXX] disposed` after every leave).
    if (i < scenarios.length - 1) await sleep(2000);
  }

  // ---------------- Markdown summary ----------------
  console.log("\n");
  console.log("## Stress test results");
  console.log("");
  console.log(`target: \`${target}\``);
  console.log("");

  for (const s of allSummaries) {
    const cfg = s.config;
    const durationS = cfg.durationMs / 1000;
    console.log(
      `### ${s.scenario} — ${cfg.rooms} room × ${cfg.playersPerRoom} players (${durationS}s)`,
    );
    if (s.aborted) {
      console.log(`- **ABORTED**: ${s.error}`);
      console.log("");
      continue;
    }
    const coldLine =
      s.timing.coldStartMs !== null && s.timing.coldStartMs !== undefined
        ? fmtMs(s.timing.coldStartMs)
        : "n/a";
    console.log(`- cold start: ${coldLine}`);
    console.log(
      `- mean RTT: ${fmtMs(s.rtt.mean)} (p50 ${fmtMs(s.rtt.p50)}, p95 ${fmtMs(s.rtt.p95)}, peak ${fmtMs(s.rtt.peak)}) — ${s.rtt.samples} samples`,
    );
    console.log(
      `- snapshot rate per client: ${s.snapshots.meanRatePerClient}/s (expected ${s.snapshots.expectedRatePerClient}) — loss ${Math.round(s.snapshots.lossRatio * 100)}%`,
    );
    console.log(
      `- clients connected: ${s.clients.connected}/${s.clients.expected}, dropped: ${s.clients.dropped}`,
    );
    console.log(`- errors: ${s.errors.count}`);
    console.log("");
  }

  const dropTotal = allSummaries.reduce(
    (n, s) => n + (s.aborted ? 0 : s.clients.dropped),
    0,
  );
  const errTotal = allSummaries.reduce(
    (n, s) => n + (s.aborted ? 0 : s.errors.count),
    0,
  );

  console.log("### Observations");
  if (allSummaries[0]?.timing?.coldStartMs > 5000) {
    console.log(
      `- Scenario A absorbed Render Free **cold-start** of ${fmtMs(allSummaries[0].timing.coldStartMs)}.`,
    );
  }
  for (const s of allSummaries) {
    if (s.aborted) continue;
    const lossPct = Math.round(s.snapshots.lossRatio * 100);
    if (lossPct > 25) {
      console.log(
        `- Scenario ${s.scenario}: server delivered only ${s.snapshots.meanRatePerClient}/s patches per client — ${lossPct}% below expected, indicating the 0.1 vCPU can't keep up with broadcasting.`,
      );
    }
    if (s.rtt.p95 > 250) {
      console.log(
        `- Scenario ${s.scenario}: p95 RTT ${fmtMs(s.rtt.p95)} — well above 250 ms, packets are queueing on the server.`,
      );
    }
  }
  if (dropTotal > 0) {
    console.log(`- ${dropTotal} bot disconnections occurred before duration ended.`);
  }
  if (errTotal > 0) {
    console.log(`- ${errTotal} total error events were logged across all scenarios.`);
  }
  if (dropTotal === 0 && errTotal === 0) {
    console.log(
      `- All ${allSummaries.length} scenarios completed cleanly, no dropped connections, no errors.`,
    );
  }

  console.log("");
}

main().catch((err) => {
  console.error("[stress] FATAL:", err);
  process.exit(1);
});
