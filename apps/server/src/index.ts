import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { SERVER_DEFAULT_PORT, GAME_ROOM_NAME } from "@mvp/shared";
import cors from "cors";
import express from "express";
import http from "node:http";
import { GameRoom } from "./rooms/GameRoom.js";
import { isValidRoomCode, normalizeRoomCode } from "./utils/roomCode.js";

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
