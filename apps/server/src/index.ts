import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { SERVER_DEFAULT_PORT, GAME_ROOM_NAME } from "@mvp/shared";
import cors from "cors";
import express from "express";
import http from "node:http";
import { getDebugLog } from "./debugLog.js";
import { getMetrics, listMetrics } from "./metrics.js";
import { GameRoom } from "./rooms/GameRoom.js";
import { isValidRoomCode, normalizeRoomCode } from "./utils/roomCode.js";

const PROCESS_STARTED_AT = Date.now();

const PORT = Number(process.env.PORT ?? SERVER_DEFAULT_PORT);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";

const app = express();
app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",") }));
app.use(express.json());

const httpServer = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define(GAME_ROOM_NAME, GameRoom);

// Health endpoint
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Debug endpoint: server's structured event ring for a room. Mirrors the
// client-side window.__voxelDebug.ring exactly — categories are the same
// strings (wave:start, enemy:spawn, enemy:despawn, …) so a diagnostic
// harness can fetch both and line them up by category + payload.id.
app.get("/debug/rooms/:code/logs", (req, res) => {
  const raw = req.params.code ?? "";
  if (!isValidRoomCode(raw)) {
    res.status(400).json({ error: "INVALID_CODE" });
    return;
  }
  const code = normalizeRoomCode(raw);
  const events = getDebugLog(code);
  res.json({ roomCode: code, count: events.length, events });
});

// Debug endpoint: dump a snapshot of a live room's state by code. Useful
// when an external diagnostic (test harness, agent) needs to verify what
// the authoritative state actually looks like — positions, enemy AI
// state, world deltas. Read-only.
app.get("/debug/rooms/:code", async (req, res) => {
  const raw = req.params.code ?? "";
  if (!isValidRoomCode(raw)) {
    res.status(400).json({ error: "INVALID_CODE" });
    return;
  }
  const code = normalizeRoomCode(raw);
  try {
    const rooms = await matchMaker.query({ name: GAME_ROOM_NAME });
    const match = rooms.find((r) => r.metadata?.roomCode === code);
    if (!match) {
      res.status(404).json({ error: "ROOM_NOT_FOUND" });
      return;
    }
    // matchMaker.remoteRoomCall would round-trip through the room actor.
    // For a simple read we expose only the metadata-safe shape.
    res.json({
      roomId: match.roomId,
      roomCode: code,
      clients: match.clients,
      maxClients: match.maxClients,
      metadata: match.metadata,
      hint: "Live state schema is not stringifiable over HTTP — use a Colyseus client to read state.",
    });
  } catch (err) {
    console.error("[/debug/rooms]", err);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// Debug endpoint: per-room performance metrics. Mirrors the per-tick struct
// the room captures into apps/server/src/metrics.ts. The client samples this
// every 5 s (see apps/game/src/dev/NetworkMetrics.js) so an external agent
// can call `__voxelDebug.dump()` and see both sides at once.
app.get("/debug/rooms/:code/stats", (req, res) => {
  const raw = req.params.code ?? "";
  if (!isValidRoomCode(raw)) {
    res.status(400).json({ error: "INVALID_CODE" });
    return;
  }
  const code = normalizeRoomCode(raw);
  const metrics = getMetrics(code);
  if (!metrics) {
    res.status(404).json({ error: "ROOM_NOT_FOUND" });
    return;
  }
  res.json({ roomCode: code, ...metrics });
});

// Debug endpoint: process-wide stats. Aggregates room counters and reports the
// resident-set memory + process uptime. Cheap to call; intended for a single
// dashboard tick (not per-frame).
app.get("/debug/global/stats", (_req, res) => {
  const rooms = listMetrics();
  let totalPlayers = 0;
  let totalEnemies = 0;
  for (const r of rooms) {
    totalPlayers += r.metrics.playerCount;
    totalEnemies += r.metrics.enemyCount + r.metrics.dragonCount;
  }
  const mem = process.memoryUsage();
  res.json({
    uptimeS: +((Date.now() - PROCESS_STARTED_AT) / 1000).toFixed(1),
    totalRooms: rooms.length,
    totalPlayers,
    totalEnemies,
    memoryUsedMB: +(mem.rss / (1024 * 1024)).toFixed(1),
  });
});

// Lookup endpoint: does a room with this code exist? Returns its roomId so the client can joinById.
app.get("/rooms/by-code/:code", async (req, res) => {
  const raw = req.params.code ?? "";
  if (!isValidRoomCode(raw)) {
    res.status(400).json({ error: "INVALID_CODE" });
    return;
  }
  const code = normalizeRoomCode(raw);
  try {
    const rooms = await matchMaker.query({ name: GAME_ROOM_NAME });
    const match = rooms.find((r) => r.metadata?.roomCode === code);
    if (!match) {
      res.status(404).json({ error: "ROOM_NOT_FOUND" });
      return;
    }
    res.json({ roomId: match.roomId, roomCode: code, clients: match.clients, maxClients: match.maxClients });
  } catch (err) {
    console.error("[/rooms/by-code]", err);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

httpServer.listen(PORT, () => {
  console.log(`[server] Colyseus listening on http://localhost:${PORT}`);
  console.log(`[server] Health:   http://localhost:${PORT}/health`);
  console.log(`[server] Room API: http://localhost:${PORT}/rooms/by-code/<CODE>`);
});

const shutdown = async (sig: string) => {
  console.log(`[server] ${sig} received, shutting down`);
  await gameServer.gracefullyShutdown();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
