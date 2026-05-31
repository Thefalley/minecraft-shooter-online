// EnemySync.js
//
// Bridges the local enemy managers (Zombie/Skeleton/Witch/Dragon) to the
// authoritative server. Phase 4 client side.
//
// In SINGLEPLAYER (no bridge), this is never enabled and the managers run
// their local AI exactly as before.
//
// In MULTIPLAYER:
//   - enable() flips every manager into authority='server'.
//   - The managers stop spawning / ticking AI; they only render+interpolate
//     entities the server tells them about.
//   - Every onAdd / onChange / onRemove on state.enemies (and state.dragons,
//     if exposed) is routed to the matching manager via:
//       zombies.applyServerEnemy(snap)       /  removeServerEnemy(id)
//       skeletons.applyServerEnemy(snap)     /  removeServerEnemy(id)
//       witches.applyServerEnemy(snap)       /  removeServerEnemy(id)
//       dragons.applyServerDragon(snap)      /  removeServerEnemy(id)
//
// The NetworkBridge re-emits per-enemy snapshots from state.enemies as the
// flat events 'enemySpawn' / 'enemyState' / 'enemyDespawn'. We listen to
// those and route by enemy.kind. Dragons may either travel inside
// state.enemies with kind='dragon' or live on a separate state.dragons map;
// both paths are handled here.
//
// 'enemyEvent' (attack / shoot / throw) is treated as a visual-only hook —
// the actual server-authoritative position still flows through enemyState,
// so a missed enemyEvent is never a correctness bug.
//
// 'dragonFireball' is forwarded onto the dragon manager so it can spawn /
// despawn / reflect the visual projectile without the local AI deciding
// when to fire.

function flattenEnemySnapshot(payload) {
  if (!payload) return null;
  // payload arrives as either { id, enemy } from a bridge re-emit, or as a
  // pre-flattened snap from a future caller. Normalize.
  const e = payload.enemy ?? payload;
  if (!e || typeof e !== "object") return null;
  const id = payload.id ?? e.id;
  if (id === undefined || id === null) return null;
  // The dragon schema doesn't carry a `kind` field — the NetworkBridge
  // injects it at the top of the payload so we accept either source.
  const kind =
    (typeof e.kind === "string" && e.kind) ||
    (typeof payload.kind === "string" && payload.kind) ||
    null;
  return {
    id,
    kind,
    x: Number.isFinite(e.x) ? e.x : 0,
    y: Number.isFinite(e.y) ? e.y : 0,
    z: Number.isFinite(e.z) ? e.z : 0,
    rotationY: Number.isFinite(e.rotationY) ? e.rotationY : 0,
    health: Number.isFinite(e.health) ? e.health : undefined,
    maxHealth: Number.isFinite(e.maxHealth) ? e.maxHealth : undefined,
  };
}

export class EnemySync {
  /**
   * @param {{
   *   bridge: import('./NetworkBridge.js').NetworkBridge,
   *   zombies?: any,
   *   skeletons?: any,
   *   witches?: any,
   *   dragons?: any,
   *   debug?: boolean,
   * }} opts
   */
  constructor({ bridge, zombies, skeletons, witches, dragons, debug = false } = {}) {
    this._bridge = bridge ?? null;
    this._zombies = zombies ?? null;
    this._skeletons = skeletons ?? null;
    this._witches = witches ?? null;
    this._dragons = dragons ?? null;
    this._debug = !!debug;
    this._unsubs = [];
    this._enabled = false;
  }

  enable() {
    if (this._enabled || !this._bridge) return;
    this._enabled = true;

    // Switch every manager to server authority: local AI off, ready to receive
    // server snapshots. Any pre-existing locally-spawned enemies are cleared
    // by setAuthority('server').
    this._setManagerAuthority("server");
    if (typeof window !== "undefined" && window.__voxelDebug) {
      window.__voxelDebug.push("enemySync:enable", { authority: "server" });
    }

    const on = (event, fn) => {
      try {
        const off = this._bridge.on(event, fn);
        if (typeof off === "function") this._unsubs.push(off);
      } catch (err) {
        if (this._debug) console.warn("[EnemySync] subscribe failed", event, err);
      }
    };

    // Bridge re-emits state.enemies onAdd/onChange/onRemove as these:
    on("enemySpawn", (p) => this._onEnemyUpsert(p));
    on("enemyState", (p) => this._onEnemyUpsert(p));
    on("enemyDespawn", (p) => this._onEnemyDespawn(p));

    // Visual-only hooks. Position is still driven by enemyState; these are
    // best-effort cues for an attack animation / arrow flash / potion arc.
    on("enemyEvent", (p) => this._onEnemyEvent(p));

    // Dragon fireballs: spawn / despawn / reflect a purely visual projectile.
    on("dragonFireball", (p) => this._onDragonFireball(p));

    // ── Initial backfill ────────────────────────────────────────────────
    // EnemySync is created when the Game scene mounts, but the bridge has
    // already joined the room — Colyseus has fired state.enemies.onAdd for
    // every pre-existing entry, and the bridge has already re-emitted those
    // as "enemySpawn" events that we missed. Walk the current room state
    // once and upsert every entry we find so the visuals catch up.
    try {
      const state = typeof this._bridge.getRoomState === "function"
        ? this._bridge.getRoomState()
        : null;
      let backfilledEnemies = 0;
      let backfilledDragons = 0;
      if (state) {
        state.enemies?.forEach?.((enemy, id) => {
          this._onEnemyUpsert({ id, enemy });
          backfilledEnemies += 1;
        });
        state.dragons?.forEach?.((dragon, id) => {
          this._onEnemyUpsert({
            id,
            enemy: dragon,
            kind: "dragon",
            x: dragon.x,
            y: dragon.y,
            z: dragon.z,
            rotationY: dragon.rotationY,
            health: dragon.health,
            maxHealth: dragon.maxHealth,
          });
          backfilledDragons += 1;
        });
      }
      if (typeof window !== "undefined" && window.__voxelDebug) {
        window.__voxelDebug.push("enemySync:backfill", {
          enemies: backfilledEnemies,
          dragons: backfilledDragons,
          stateAvailable: !!state,
        });
      }
    } catch (err) {
      if (this._debug) console.warn("[EnemySync] initial backfill failed", err);
    }
  }

  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    for (const off of this._unsubs) {
      try { off?.(); } catch { /* swallow */ }
    }
    this._unsubs.length = 0;
    // Flip authority back to local so the managers can be reused for a
    // singleplayer session in the same process (used by tests and by the
    // training-ground reset path).
    this._setManagerAuthority("local");
  }

  // ── routing ─────────────────────────────────────────────────────────────

  _setManagerAuthority(mode) {
    for (const m of [this._zombies, this._skeletons, this._witches, this._dragons]) {
      if (m && typeof m.setAuthority === "function") {
        try { m.setAuthority(mode); }
        catch (err) { if (this._debug) console.warn("[EnemySync] setAuthority", err); }
      }
    }
  }

  _managerForKind(kind) {
    switch (kind) {
      case "zombie": return this._zombies;
      case "skeleton": return this._skeletons;
      case "witch": return this._witches;
      case "dragon": return this._dragons;
      default: return null;
    }
  }

  _onEnemyUpsert(payload) {
    const snap = flattenEnemySnapshot(payload);
    if (!snap) return;
    const manager = this._managerForKind(snap.kind);
    if (!manager) return;
    try {
      if (snap.kind === "dragon") {
        if (typeof manager.applyServerDragon === "function") {
          manager.applyServerDragon(snap);
        }
      } else if (typeof manager.applyServerEnemy === "function") {
        manager.applyServerEnemy(snap);
      }
    } catch (err) {
      if (this._debug) console.warn("[EnemySync] upsert failed", snap.kind, err);
    }
  }

  _onEnemyDespawn(payload) {
    if (!payload) return;
    const id = payload.id ?? payload;
    if (id === undefined || id === null) return;
    // We don't always know the kind on despawn — try every manager that
    // tracks this id. removeServerEnemy returns falsy if it doesn't own it.
    for (const m of [this._zombies, this._skeletons, this._witches, this._dragons]) {
      if (m && typeof m.removeServerEnemy === "function") {
        try { m.removeServerEnemy(id); }
        catch (err) { if (this._debug) console.warn("[EnemySync] despawn", err); }
      }
    }
  }

  _onEnemyEvent(payload) {
    // Visual-only routing. We don't mutate state here; the next snapshot will
    // bring the source of truth.
    // payload shape: { enemyId, event: 'attack'|'shoot'|'throw', target? }
    if (!payload || !payload.enemyId) return;
    // Best-effort: forward to whichever manager owns this id, if it cares.
    for (const m of [this._zombies, this._skeletons, this._witches, this._dragons]) {
      if (m && typeof m.handleServerEnemyEvent === "function") {
        try { m.handleServerEnemyEvent(payload); } catch { /* swallow */ }
      }
    }
  }

  _onDragonFireball(payload) {
    if (!this._dragons || !payload) return;
    if (typeof this._dragons.handleServerFireball === "function") {
      try { this._dragons.handleServerFireball(payload); }
      catch (err) { if (this._debug) console.warn("[EnemySync] fireball", err); }
    }
  }
}

export default EnemySync;
