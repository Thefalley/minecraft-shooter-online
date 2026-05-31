// ColyseusClient.js
//
// Thin wrapper around colyseus.js for the Voxel-Dragons game.
//
// Responsibilities:
//   - Hold a single Client instance pointed at VITE_SERVER_URL (set at build
//     time by Vite's `define` — falls back to ws://localhost:2567 in dev).
//   - Expose two clear entry points the game UI calls:
//       create(name, characterId)
//       joinByCode(name, code, characterId)
//   - For joinByCode, hit the server's HTTP probe /rooms/by-code/:code FIRST
//     so we can surface user-friendly "room not found" / "invalid code" errors
//     before the websocket handshake even starts. The probe returns the
//     underlying roomId which we then pass to client.joinById().
//
// We deliberately do NOT swallow errors — NetworkBridge is responsible for
// translating them into status changes and 'error' events the game listens to.

import { Client } from "colyseus.js";
import { GAME_ROOM_NAME } from "@mvp/shared";

const DEFAULT_URL =
  (typeof import.meta !== "undefined" &&
    import.meta.env &&
    import.meta.env.VITE_SERVER_URL) ||
  "ws://localhost:2567";

function toHttpBase(wsUrl) {
  if (typeof wsUrl !== "string" || wsUrl.length === 0) return wsUrl;
  if (wsUrl.startsWith("wss://")) return "https://" + wsUrl.slice("wss://".length);
  if (wsUrl.startsWith("ws://")) return "http://" + wsUrl.slice("ws://".length);
  return wsUrl;
}

export class ColyseusClient {
  /**
   * @param {string} [url] - Override the build-time server URL. Mostly for tests.
   */
  constructor(url = DEFAULT_URL) {
    this._url = url;
    this._httpBase = toHttpBase(url);
    this._client = new Client(url);
    this._room = null;
  }

  /** Underlying Colyseus client, exposed for advanced use (do not store). */
  get raw() {
    return this._client;
  }

  /**
   * HTTP base for the same host as the websocket. Used by NetworkMetrics
   * (apps/game/src/dev) to poll /debug/rooms/<code>/stats so the dump()
   * surface can show server-side tick rate alongside client FPS.
   */
  get httpBase() {
    return this._httpBase;
  }

  /** Most recently opened Room, or null. */
  get room() {
    return this._room;
  }

  isConnected() {
    return !!this._room && !!this._room.connection;
  }

  /**
   * Create a new game room. Returns the joined Room.
   * @param {string} name
   * @param {string|null} characterId
   * @returns {Promise<import("colyseus.js").Room>}
   */
  async create(name, characterId) {
    const options = { name };
    if (characterId) options.characterId = characterId;
    const room = await this._client.create(GAME_ROOM_NAME, options);
    this._room = room;
    return room;
  }

  /**
   * Join an existing room by its 5-char human code.
   * Probes /rooms/by-code/:code first so we can throw clean, user-facing errors.
   *
   * Errors thrown have a stable message we can switch on at the UI layer:
   *   - "INVALID_CODE"
   *   - "ROOM_NOT_FOUND"
   *   - any other underlying network/server error bubbles up untouched
   */
  async joinByCode(name, code, characterId) {
    if (typeof code !== "string" || code.length !== 5) {
      throw new Error("INVALID_CODE");
    }
    const normalized = code.toUpperCase();
    const probeUrl = `${this._httpBase}/rooms/by-code/${encodeURIComponent(
      normalized,
    )}`;

    let res;
    try {
      res = await fetch(probeUrl, { method: "GET" });
    } catch (err) {
      // Network failure before we even get HTTP back.
      const wrapped = new Error("NETWORK_ERROR");
      wrapped.cause = err;
      throw wrapped;
    }

    if (res.status === 404) {
      throw new Error("ROOM_NOT_FOUND");
    }
    if (res.status === 400) {
      throw new Error("INVALID_CODE");
    }
    if (!res.ok) {
      throw new Error(`PROBE_FAILED_${res.status}`);
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error("PROBE_BAD_RESPONSE");
    }
    if (!data || typeof data.roomId !== "string") {
      throw new Error("PROBE_BAD_RESPONSE");
    }

    const options = { name };
    if (characterId) options.characterId = characterId;
    const room = await this._client.joinById(data.roomId, options);
    this._room = room;
    return room;
  }

  async leave() {
    if (!this._room) return;
    const room = this._room;
    this._room = null;
    try {
      await room.leave(true);
    } catch {
      /* leave() can reject if the socket is already gone — that's fine */
    }
  }
}
