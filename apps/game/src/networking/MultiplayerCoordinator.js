// MultiplayerCoordinator.js
//
// Top-level orchestrator that wires the singleplayer Voxel-Dragons game to
// the Colyseus server through the Phase 1 NetworkBridge. Owns:
//
//   - The NetworkBridge (network transport)
//   - The RemotePlayerRegistry (one RemotePlayerMesh per remote sessionId)
//   - A reference to the Game instance, bound after construction
//   - The self sessionId, resolved on the "welcome" event
//
// Lifecycle from main.js (multiplayer mode):
//   1. new MultiplayerCoordinator({ joinParams })
//   2. new Game(root, { network: coordinator, ... })
//   3. coordinator.bind(game)
//   4. await coordinator.start()    // connect + welcome
//   5. game.start()                  // begin the render loop
//
// On every snapshot delivered by the bridge, self snapshots are forwarded to
// player.applyServerSnapshot() (added by the CSP agent in the parallel
// branch). All other snapshots flow through the registry which spawns or
// updates the matching RemotePlayerMesh and pushes the sample into its
// interpolation buffer.

import { NetworkBridge } from "./NetworkBridge.js";
import { RemotePlayerRegistry } from "./RemotePlayerRegistry.js";

/**
 * Defensive flattener for snapshot payloads. The bridge currently emits
 * `playerSnapshot` from two places:
 *   - state-callbacks path:    { sessionId, player }           (schema proxy)
 *   - VoxelServerMessage path: { sessionId, x, y, z, ... }     (already flat)
 * We accept either and return a plain object the registry can consume.
 */
function flattenSnapshot(snap) {
  if (!snap || typeof snap !== "object") return null;
  const sessionId = snap.sessionId ?? snap.id ?? null;
  if (!sessionId) return null;
  const src = snap.player && typeof snap.player === "object" ? snap.player : snap;
  return {
    sessionId,
    name: src.name,
    x: src.x,
    y: src.y,
    z: src.z,
    rotationY: src.rotationY ?? src.rotY ?? src.yaw,
    health: src.health,
    maxHealth: src.maxHealth,
    connected: src.connected,
  };
}

export class MultiplayerCoordinator {
  /**
   * @param {{ joinParams: {name:string, code?:string|null, mode:'create'|'join', characterId?:string|null} }} opts
   */
  constructor({ joinParams }) {
    this._joinParams = joinParams;
    this._bridge = new NetworkBridge({ debug: false });
    this._game = null;
    this._registry = null;
    this._selfSessionId = null;
    this._listeners = [];
  }

  /** Called by main.js once Game has finished its constructor and exposes scene. */
  bind(game) {
    this._game = game;
    this._registry = new RemotePlayerRegistry(game.scene, {
      selfSessionIdProvider: () => this._selfSessionId,
    });
    if (game.player) game.player.networkAuthority = "server";
    this._wireBridge();
  }

  /** Should be called from Game.tick(now) before render, after sim. */
  tickFrame(now) {
    this._registry?.update(now);
  }

  /** Sends the latest cmd produced by Player.buildInputCommand to the server. */
  pushInput(cmd) {
    if (!cmd) return;
    this._bridge.pushInput(cmd);
  }

  /** Connects after binding. Resolves once the connect handshake completes. */
  async start() {
    return this._bridge.connect(this._joinParams);
  }

  async stop() {
    this._unwireBridge();
    this._registry?.clear();
    try {
      await this._bridge.disconnect();
    } catch {
      /* ignore */
    }
  }

  getBridge() {
    return this._bridge;
  }

  getSelfSessionId() {
    return this._selfSessionId;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _wireBridge() {
    const b = this._bridge;
    const off = (event, fn) => this._listeners.push(b.on(event, fn));

    off("welcome", (p) => {
      this._selfSessionId = p?.selfSessionId ?? null;
    });

    off("playerJoined", (_p) => {
      /* no-op until the first snapshot arrives */
    });

    off("playerLeft", (p) => {
      this._registry?.remove(p?.id ?? p?.sessionId);
    });

    // playerSnapshot is emitted by NetworkBridge each time the server's
    // player state changes. Payload shape is normalised by flattenSnapshot.
    off("playerSnapshot", (rawSnap) => {
      const snap = flattenSnapshot(rawSnap);
      if (!snap) return;

      if (snap.sessionId === this._selfSessionId) {
        // Self: feed into the CSP path. Fall back to setPosition if the
        // applyServerSnapshot method isn't present (e.g. CSP agent branch
        // hasn't merged yet) so we degrade gracefully.
        const p = this._game?.player;
        if (!p) return;
        if (typeof p.applyServerSnapshot === "function") {
          p.applyServerSnapshot(snap);
        } else if (
          typeof p.setPosition === "function" &&
          Number.isFinite(snap.x) &&
          Number.isFinite(snap.y) &&
          Number.isFinite(snap.z)
        ) {
          p.setPosition(snap.x, snap.y, snap.z);
        }
      } else {
        this._registry?.onSnapshot(snap);
      }
    });

    off("status", (s) => {
      if (s === "disconnected" || s === "error") {
        // Cleanup remote players and notify the host (main.js) so it can
        // route back to the menu. Without this, Game stays mid-tick with
        // networkAuthority='server' but no inputs flowing → player frozen
        // forever.
        this._registry?.clear();
        if (typeof this._onDisconnect === "function") {
          try {
            this._onDisconnect(s);
          } catch (err) {
            console.warn("[coord] onDisconnect handler threw", err);
          }
        }
      }
    });
  }

  /**
   * Register a callback fired when the bridge transitions to
   * 'disconnected' or 'error'. main.js uses this to tear down the Game
   * and bounce back to the menu.
   */
  onDisconnect(fn) {
    this._onDisconnect = fn;
  }

  _unwireBridge() {
    for (const off of this._listeners) {
      try {
        off?.();
      } catch {
        /* ignore */
      }
    }
    this._listeners.length = 0;
  }
}
