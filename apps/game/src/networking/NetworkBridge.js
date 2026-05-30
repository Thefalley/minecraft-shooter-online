// NetworkBridge.js
//
// Single source of truth for the game ↔ server connection. The Voxel-Dragons
// modules (Player, World, Weapons, DragonManager, …) get integrated against
// this bridge in Phase 2; for now we just stand it up as a clean Node-style
// EventEmitter-shaped object that translates between:
//
//   game side                       network side
//   ──────────────                  ─────────────────────────────
//   bridge.emitMineIntent(…)  ───▶  room.send(VoxelClientMessage.WorldMine,…)
//   bridge.on('worldDelta',…)  ◀──  room.onMessage(VoxelServerMessage.WorldDelta,…)
//   bridge.pushInput(cmd)      ──▶  InputPump → room.send(Input, …)
//
// Why a custom event bus instead of EventEmitter or a tiny library?
//   - apps/game is plain vanilla JS in a browser; no Node "events" by default.
//   - Subscribers expect a stable surface even before connect() resolves and
//     after disconnect, which a plain Room object can't give them.
//   - We get cheap `on()` returning an unsubscribe fn — friendly with React
//     and with hand-rolled cleanup code in the existing Voxel-Dragons modules.

import { ColyseusClient } from "./ColyseusClient.js";
import { InputPump } from "./InputPump.js";
import {
  VoxelClientMessage,
  VoxelServerMessage,
  LobbyClientMessage,
  LobbyServerMessage,
  ClientMessage,
  ServerMessage,
} from "@mvp/shared";

// Defensive lookups — if the protocol agent ships the constants slightly
// renamed we still get a useful runtime error instead of `undefined` being
// silently sent as the message id.
function mkey(table, key, fallback) {
  if (table && typeof table[key] === "string") return table[key];
  return fallback;
}

export class NetworkBridge {
  constructor({ debug = false } = {}) {
    this._client = new ColyseusClient();
    this._room = null;
    this._listeners = new Map(); // event -> Set<fn>
    this._status = "idle";
    this._latestSnapshot = null;
    this._selfSessionId = null;
    this._roomCode = null;
    this._debug = !!debug;
    this._inputPump = new InputPump((cmd) => this._sendInput(cmd));
    this._roomUnsubs = []; // teardown callbacks registered by _attachRoomListeners
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Connect to the server.
   * @param {{name:string, code?:string|null, mode:'create'|'join', characterId?:string|null}} opts
   */
  async connect({ name, code, mode, characterId }) {
    if (this._status === "connecting" || this._status === "connected") {
      // Idempotent — second caller during the same boot just waits.
      return;
    }
    this._setStatus("connecting");
    try {
      let room;
      if (mode === "join") {
        if (!code) throw new Error("INVALID_CODE");
        room = await this._client.joinByCode(name, code, characterId);
      } else {
        room = await this._client.create(name, characterId);
      }
      this._room = room;
      this._selfSessionId = room.sessionId;
      // The server's state may already contain roomCode by the time the join
      // resolves; the Welcome message will refine it.
      this._roomCode =
        (room.state && room.state.roomCode) || this._roomCode || null;
      this._attachRoomListeners(room);
      this._setStatus("connected");
    } catch (err) {
      this._setStatus("error");
      this._emit("error", {
        code: err && err.message ? err.message : "CONNECT_FAILED",
        message: err && err.message ? err.message : "Failed to connect",
      });
      throw err;
    }
  }

  async disconnect() {
    this._teardownRoomListeners();
    try {
      await this._client.leave();
    } catch {
      /* ignore */
    }
    this._room = null;
    this._selfSessionId = null;
    this._roomCode = null;
    this._latestSnapshot = null;
    this._inputPump.push(null);
    this._setStatus("disconnected");
  }

  isConnected() {
    return !!this._room && this._status === "connected";
  }

  getSelfSessionId() {
    return this._selfSessionId;
  }

  getRoomCode() {
    return this._roomCode;
  }

  getStatus() {
    return this._status;
  }

  /** Snap-of-truth state for the local renderer. May be null before connect. */
  getRoomState() {
    return this._room ? this._room.state : null;
  }

  /**
   * Per-frame input push. The pump throttles to 20 Hz internally and only
   * actually sends when the command changes (or 1s keepalive).
   */
  pushInput(cmd) {
    this._inputPump.push(cmd);
  }

  /**
   * Subscribe to a named event. Returns an unsubscribe function for
   * ergonomic cleanup in module destructors / React effects.
   */
  on(event, fn) {
    if (typeof fn !== "function") return () => {};
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const set = this._listeners.get(event);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) this._listeners.delete(event);
  }

  // ── High-level intents ───────────────────────────────────────────────────
  //
  // Each emit* method maps a game-action into a Colyseus message. The keys
  // come from @mvp/shared so server and client never drift out of sync.
  // If the room isn't connected we silently drop — the modules call these
  // from hot paths and shouldn't have to guard.

  emitMineIntent({ x, y, z }) {
    this._sendIfConnected(
      mkey(VoxelClientMessage, "WorldMine", "client:world:mine"),
      { x, y, z },
    );
  }

  emitPlaceIntent({ x, y, z, t }) {
    this._sendIfConnected(
      mkey(VoxelClientMessage, "WorldPlace", "client:world:place"),
      { x, y, z, t },
    );
  }

  emitFireIntent(payload) {
    this._sendIfConnected(
      mkey(VoxelClientMessage, "WeaponFire", "client:weapon:fire"),
      payload,
    );
  }

  emitReloadIntent() {
    this._sendIfConnected(
      mkey(VoxelClientMessage, "WeaponReload", "client:weapon:reload"),
      {},
    );
  }

  emitAbilityIntent({ ability, direction }) {
    this._sendIfConnected(
      mkey(VoxelClientMessage, "AbilityUse", "client:ability:use"),
      { ability, direction },
    );
  }

  emitCharacterSelect(characterId) {
    // Phase 2 introduced the lobby-namespaced variant. Send to BOTH so the
    // server accepts whichever it has wired (lobby-flow agent kept both
    // handlers active for backward-compat).
    const L = LobbyClientMessage || {};
    const lobbyKey = mkey(L, "CharacterSelect", "vp:lobby:characterSelect");
    this._sendIfConnected(lobbyKey, { characterId });
    this._sendIfConnected(
      mkey(VoxelClientMessage, "CharacterSelect", "client:character:select"),
      { characterId },
    );
  }

  emitLobbyStart({ countdownMs = 3000 } = {}) {
    const L = LobbyClientMessage || {};
    this._sendIfConnected(mkey(L, "Start", "vp:lobby:start"), { countdownMs });
  }

  emitLobbyHostKick(sessionId) {
    const L = LobbyClientMessage || {};
    this._sendIfConnected(mkey(L, "HostKick", "vp:lobby:hostKick"), { sessionId });
  }

  emitSlotSelect(slotIndex) {
    this._sendIfConnected(
      mkey(VoxelClientMessage, "SlotSelect", "client:slot:select"),
      { slotIndex },
    );
  }

  emitShopBuy(offerId) {
    this._sendIfConnected(
      mkey(VoxelClientMessage, "ShopBuy", "client:shop:buy"),
      { offerId },
    );
  }

  emitReadyNextWave() {
    this._sendIfConnected(
      mkey(VoxelClientMessage, "ReadyNextWave", "client:wave:ready"),
      {},
    );
  }

  emitPing(t) {
    this._sendIfConnected(
      mkey(VoxelClientMessage, "Ping", "client:ping"),
      { t: typeof t === "number" ? t : performance.now() },
    );
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _setStatus(s) {
    if (this._status === s) return;
    this._status = s;
    this._emit("status", s);
  }

  _sendInput(cmd) {
    if (!this._room) return;
    try {
      this._room.send(
        mkey(VoxelClientMessage, "Input", ClientMessage.Input || "client:input"),
        cmd,
      );
    } catch (err) {
      if (this._debug) console.warn("[bridge] send input failed", err);
    }
  }

  _sendIfConnected(key, payload) {
    if (!this._room || this._status !== "connected") return;
    try {
      this._room.send(key, payload);
    } catch (err) {
      if (this._debug) console.warn("[bridge] send failed", key, err);
    }
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return;
    // Copy because handlers may unsubscribe themselves during dispatch.
    const handlers = Array.from(set);
    for (const fn of handlers) {
      try {
        fn(payload);
      } catch (err) {
        // Never let a buggy subscriber take down the whole bus.
        if (this._debug) console.warn("[bridge] listener threw", event, err);
      }
    }
  }

  _teardownRoomListeners() {
    for (const fn of this._roomUnsubs) {
      try {
        fn();
      } catch {
        /* swallow */
      }
    }
    this._roomUnsubs.length = 0;
  }

  /**
   * Wires up the Room. We bind both:
   *   - room.onMessage(*) for every VoxelServerMessage + ServerMessage entry
   *     in the shared protocol, and
   *   - state callbacks (players add/change/remove, world deltas array, etc.)
   *     using getStateCallbacks() when colyseus.js exposes it.
   *
   * We forward everything to the local event bus under stable names. The
   * Voxel-Dragons modules subscribe via bridge.on('worldDelta', …) etc.
   */
  _attachRoomListeners(room) {
    this._teardownRoomListeners();

    // ── ServerMessage (existing protocol: Welcome, Error, PlayerJoined, …) ──
    const onMsg = (key, event, mapFn) => {
      if (!key) return;
      try {
        room.onMessage(key, (payload) => {
          this._emit(event, mapFn ? mapFn(payload) : payload);
        });
        // Colyseus doesn't expose an off() per-handler — handler stays for the
        // life of the room; the room itself is replaced on reconnect.
      } catch (err) {
        if (this._debug)
          console.warn("[bridge] onMessage register failed", key, err);
      }
    };

    onMsg(ServerMessage.Welcome, "welcome", (p) => {
      const selfId = p?.selfId ?? room.sessionId;
      this._selfSessionId = selfId;
      this._roomCode = p?.roomCode ?? this._roomCode;
      return { selfSessionId: selfId, roomCode: this._roomCode };
    });
    onMsg(ServerMessage.Error, "error", (p) => p);
    onMsg(ServerMessage.PlayerJoined, "playerJoined", (p) => p);
    onMsg(ServerMessage.PlayerLeft, "playerLeft", (p) => p);

    // ── VoxelServerMessage (combat/world/economy added in protocol agent) ──
    const V = VoxelServerMessage || {};
    onMsg(mkey(V, "WorldSeed", "server:world:seed"), "worldSeed");
    onMsg(mkey(V, "WorldDelta", "server:world:delta"), "worldDelta");
    onMsg(mkey(V, "PlayerSnapshot", "server:player:snapshot"), "playerSnapshot");
    onMsg(mkey(V, "EnemySpawn", "server:enemy:spawn"), "enemySpawn");
    onMsg(mkey(V, "EnemyDespawn", "server:enemy:despawn"), "enemyDespawn");
    onMsg(mkey(V, "EnemyState", "server:enemy:state"), "enemyState");
    onMsg(mkey(V, "EnemyEvent", "server:enemy:event"), "enemyEvent");
    onMsg(mkey(V, "DragonFireball", "server:dragon:fireball"), "dragonFireball");
    onMsg(mkey(V, "WeaponHit", "server:weapon:hit"), "weaponHit");
    onMsg(mkey(V, "WeaponMiss", "server:weapon:miss"), "weaponMiss");
    onMsg(
      mkey(V, "WeaponReloadComplete", "server:weapon:reloadComplete"),
      "weaponReloadComplete",
    );
    onMsg(mkey(V, "AmmoChange", "server:weapon:ammo"), "ammoChange");
    onMsg(mkey(V, "Damage", "server:damage"), "damage");
    onMsg(mkey(V, "PlayerDeath", "server:player:death"), "playerDeath");
    onMsg(mkey(V, "PlayerRespawn", "server:player:respawn"), "playerRespawn");
    onMsg(mkey(V, "WaveStart", "server:wave:start"), "waveStart");
    onMsg(mkey(V, "WaveEnd", "server:wave:end"), "waveEnd");
    onMsg(mkey(V, "ShopOpen", "server:shop:open"), "shopOpen");
    onMsg(mkey(V, "ShopClose", "server:shop:close"), "shopClose");
    onMsg(mkey(V, "ShopApplied", "server:shop:applied"), "shopApplied");
    onMsg(mkey(V, "CoinsChange", "server:coins"), "coinsChange");
    onMsg(mkey(V, "Pong", "server:pong"), "pong");

    // ── LobbyServerMessage (Phase 2 — waiting room lifecycle) ───────────
    const L = LobbyServerMessage || {};
    onMsg(mkey(L, "PhaseChange", "vs:lobby:phaseChange"), "lobbyPhaseChange");
    onMsg(mkey(L, "HostChange", "vs:lobby:hostChange"), "lobbyHostChange");
    onMsg(mkey(L, "StartCountdown", "vs:lobby:startCountdown"), "lobbyStartCountdown");

    // ── Room lifecycle ──────────────────────────────────────────────────
    const offLeave = room.onLeave?.((code) => {
      this._room = null;
      this._selfSessionId = null;
      this._roomCode = null;
      this._inputPump.push(null);
      // code 1000 == normal close on our side; anything else is server-driven.
      this._setStatus(code === 1000 ? "disconnected" : "error");
    });
    if (typeof offLeave === "function") this._roomUnsubs.push(offLeave);

    const offErr = room.onError?.((code, message) => {
      this._emit("error", {
        code: "TRANSPORT_ERROR",
        message: message || `Colyseus error ${code}`,
      });
    });
    if (typeof offErr === "function") this._roomUnsubs.push(offErr);

    // ── Schema state callbacks ──────────────────────────────────────────
    // colyseus.js v0.16 ships getStateCallbacks as a named export. We import
    // lazily to keep the bridge importable even in unit tests that mock the
    // colyseus.js package without that helper.
    this._attachStateCallbacks(room).catch((err) => {
      if (this._debug)
        console.warn("[bridge] attachStateCallbacks failed", err);
    });
  }

  async _attachStateCallbacks(room) {
    let getStateCallbacks;
    try {
      ({ getStateCallbacks } = await import("colyseus.js"));
    } catch {
      return;
    }
    if (typeof getStateCallbacks !== "function") return;

    let $;
    try {
      $ = getStateCallbacks(room);
    } catch (err) {
      if (this._debug) console.warn("[bridge] getStateCallbacks threw", err);
      return;
    }
    const state = room.state;
    if (!state) return;

    // Players ────────────────────────────────────────────────────────────
    try {
      const players$ = $(state).players;
      if (players$ && typeof players$.onAdd === "function") {
        players$.onAdd((player, sessionId) => {
          this._emit("playerSnapshot", { sessionId, player });
          try {
            $(player).onChange(() => {
              this._emit("playerSnapshot", { sessionId, player });
            });
          } catch {
            /* schema-callbacks proxy may reject — non-fatal */
          }
        });
        players$.onRemove?.((player, sessionId) => {
          this._emit("playerLeft", { id: sessionId, name: player?.name });
        });
      }
    } catch (err) {
      if (this._debug) console.warn("[bridge] players state binding", err);
    }

    // World deltas (when the server exposes them on state.world.deltas) ──
    try {
      const world$ = $(state).world;
      const deltas$ = world$ && world$.deltas;
      if (deltas$ && typeof deltas$.onAdd === "function") {
        deltas$.onAdd((delta) => {
          this._emit("worldDelta", {
            op: delta.op,
            x: delta.x,
            y: delta.y,
            z: delta.z,
            t: delta.t,
            by: delta.by,
            seq: delta.seq,
          });
        });
      }
    } catch (err) {
      if (this._debug) console.warn("[bridge] world deltas binding", err);
    }

    // Enemies (state.enemies.onAdd/onChange/onRemove if exposed) ─────────
    try {
      const enemies$ = $(state).enemies;
      if (enemies$ && typeof enemies$.onAdd === "function") {
        enemies$.onAdd((enemy, id) => {
          this._emit("enemySpawn", { id, enemy });
          try {
            $(enemy).onChange(() => {
              this._emit("enemyState", { id, enemy });
            });
          } catch {
            /* non-fatal */
          }
        });
        enemies$.onRemove?.((_enemy, id) => {
          this._emit("enemyDespawn", { id });
        });
      }
    } catch (err) {
      if (this._debug) console.warn("[bridge] enemies state binding", err);
    }
  }
}
