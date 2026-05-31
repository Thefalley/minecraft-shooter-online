// WorldSync.js
//
// Bridges the local Voxel-Dragons World (apps/game/src/modules/World.js) to
// the authoritative server via NetworkBridge.
//
// Wiring (per-room, lives for the duration of Game):
//   server                                       client
//   ──────                                       ──────
//   on join → WorldSeed{seed,dims,deltas[]}  →   regenerate world, replay deltas
//   on mine/place broadcast → WorldDelta     →   apply locally via setBlock
//   ←   emitMineIntent({x,y,z})                  (replaces local removeBlock)
//   ←   emitPlaceIntent({x,y,z,t})               (replaces local addBlock)
//
// The patch on world.addBlock / world.removeBlock turns local mutations into
// network intents instead of immediate edits. The server is the only thing
// that can actually change the world — our optimistic local mutation is gone,
// and we wait ~1 RTT for the broadcast to come back.
//
// Re-entrancy: when we APPLY a server-driven edit we must not re-emit it as
// an intent. _suppressEmit gates that. Set true while inside server-driven
// _applyDeltaToWorld() and the regenerate-from-seed pass.
//
// Singleplayer: when no WorldSync.enable() is called, World.js is completely
// unchanged. The patching is opt-in.

import { ID_TO_BLOCK } from "@mvp/shared";

export class WorldSync {
  /**
   * @param {import('../modules/World.js').World} world - the local World instance
   * @param {import('./NetworkBridge.js').NetworkBridge} bridge - the connected NetworkBridge
   * @param {{ debug?: boolean, onWorldRebuilt?: () => void }} [opts]
   */
  constructor(world, bridge, opts = {}) {
    this._world = world;
    this._bridge = bridge;
    this._debug = !!opts.debug;
    this._onWorldRebuilt = typeof opts.onWorldRebuilt === "function" ? opts.onWorldRebuilt : null;
    this._unsubs = [];
    this._suppressEmit = false; // re-entrancy guard while applying server deltas
    this._unpatchWorldMutators = null;
    this._enabled = false;
  }

  enable() {
    if (this._enabled || !this._bridge || !this._world) return;
    this._enabled = true;

    // 1. Server hands us seed + the cumulative deltas list on join.
    this._unsubs.push(
      this._bridge.on("worldSeed", (p) => this._onWorldSeed(p)),
    );
    // 2. Anyone's edit (including ours) gets re-broadcast here.
    this._unsubs.push(
      this._bridge.on("worldDelta", (p) => this._onWorldDelta(p)),
    );
    // 3. Intercept local mining / placement so they go through the server.
    this._patchWorldMutators();
  }

  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    for (const off of this._unsubs) {
      try { off?.(); } catch { /* swallow */ }
    }
    this._unsubs.length = 0;
    if (typeof this._unpatchWorldMutators === "function") {
      try { this._unpatchWorldMutators(); } catch { /* swallow */ }
      this._unpatchWorldMutators = null;
    }
  }

  // ── Server → local ─────────────────────────────────────────────────────

  _onWorldSeed(payload) {
    if (!payload) return;
    const { seed, width, depth, maxHeight, waterLevel, deltas } = payload;
    this._suppressEmit = true;
    try {
      // Regenerate the local world from the authoritative seed/dimensions so
      // the procedural base matches every other peer in the room.
      if (typeof this._world.regenerateFromSeed === "function") {
        this._world.regenerateFromSeed({ seed, width, depth, maxHeight, waterLevel });
      } else if (this._debug) {
        console.warn(
          "[WorldSync] world has no regenerateFromSeed(); local base may diverge from server",
        );
      }
      // Replay the cumulative delta list. Each entry is { x, y, z, t } where
      // t === 0 means the block was mined (removed), t in [1..7] means a
      // placed block of that type id.
      if (Array.isArray(deltas)) {
        for (const d of deltas) this._applySeedDelta(d);
      }
    } catch (err) {
      if (this._debug) console.warn("[WorldSync] onWorldSeed failed", err);
    } finally {
      this._suppressEmit = false;
    }
    // Notify the host (Game.js) so it can e.g. re-snap the local player to
    // the new spawn point now that the world geometry has changed.
    if (this._onWorldRebuilt) {
      try { this._onWorldRebuilt(); } catch (err) {
        if (this._debug) console.warn("[WorldSync] onWorldRebuilt threw", err);
      }
    }
  }

  _onWorldDelta(payload) {
    if (!payload) return;
    // Payload shape from GameRoom.broadcast(VoxelServerMessage.WorldDelta):
    //   { op: 'mine' | 'place', x, y, z, t, seq, by }
    // For mine, t === 0; for place, t is the uint8 block id (1..7).
    this._suppressEmit = true;
    try {
      this._applyServerDelta(payload);
    } catch (err) {
      if (this._debug) console.warn("[WorldSync] onWorldDelta failed", err);
    } finally {
      this._suppressEmit = false;
    }
  }

  _applyServerDelta({ op, x, y, z, t }) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if (op === "mine") {
      this._world.setBlock(x, y, z, null);
      return;
    }
    if (op === "place") {
      const type = this._typeFromId(t);
      if (!type) return;
      this._world.setBlock(x, y, z, type);
    }
  }

  // Each seed-bundled delta is the cumulative state of a cell, not an op.
  // t === 0 means "removed" relative to the procedural base; otherwise t is
  // the block id of the placed/replaced block.
  _applySeedDelta({ x, y, z, t }) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if (t === 0 || t === null || t === undefined) {
      this._world.setBlock(x, y, z, null);
      return;
    }
    const type = this._typeFromId(t);
    if (!type) return;
    this._world.setBlock(x, y, z, type);
  }

  _typeFromId(id) {
    if (typeof id !== "number") return null;
    const t = ID_TO_BLOCK[id];
    return typeof t === "string" ? t : null;
  }

  // ── Local → server ─────────────────────────────────────────────────────

  _patchWorldMutators() {
    const world = this._world;
    const originalAdd = typeof world.addBlock === "function" ? world.addBlock.bind(world) : null;
    const originalRemove = typeof world.removeBlock === "function" ? world.removeBlock.bind(world) : null;

    this._unpatchWorldMutators = () => {
      if (originalAdd) world.addBlock = originalAdd;
      if (originalRemove) world.removeBlock = originalRemove;
    };

    if (originalRemove) {
      world.removeBlock = (hit) => {
        // Server-driven path: just run the original mutator.
        if (this._suppressEmit) return originalRemove(hit);
        if (!hit?.position) return false;
        // Don't mine water — the server doesn't track water as a placeable.
        if (hit.type === "water") return false;
        this._bridge.emitMineIntent({
          x: Math.floor(hit.position.x),
          y: Math.floor(hit.position.y),
          z: Math.floor(hit.position.z),
        });
        // Return true so the caller's UX (slash mark, inventory pickup) still
        // fires; the actual mesh removal happens when the server's WorldDelta
        // bounces back.
        return true;
      };
    }

    if (originalAdd) {
      world.addBlock = (hit, type = "dirt") => {
        if (this._suppressEmit) return originalAdd(hit, type);
        const target = this._placementCoords(hit);
        if (!target) return false;
        this._bridge.emitPlaceIntent({
          x: target.x,
          y: target.y,
          z: target.z,
          t: this._idFromType(type),
        });
        // Same as removeBlock: return true so the caller consumes the slot.
        return true;
      };
    }
  }

  // Mirror the placement math World.addBlock uses, but always work in
  // integer cell coordinates because the server validates integer indices.
  _placementCoords(hit) {
    if (!hit?.position) return null;
    if (hit.type === "water") {
      // Building directly into a water cell — replace it in place.
      return {
        x: Math.floor(hit.position.x),
        y: Math.floor(hit.position.y),
        z: Math.floor(hit.position.z),
      };
    }
    const normal = hit.normal ?? { x: 0, y: 1, z: 0 };
    return {
      x: Math.floor(hit.position.x + normal.x),
      y: Math.floor(hit.position.y + normal.y),
      z: Math.floor(hit.position.z + normal.z),
    };
  }

  _idFromType(type) {
    // ID_TO_BLOCK is keyed by number, so build a reverse map on first use.
    if (!this._typeToIdCache) {
      const cache = Object.create(null);
      for (const [idStr, name] of Object.entries(ID_TO_BLOCK)) {
        cache[name] = Number(idStr);
      }
      this._typeToIdCache = cache;
    }
    const id = this._typeToIdCache[type];
    return typeof id === "number" ? id : 0;
  }
}

export default WorldSync;
