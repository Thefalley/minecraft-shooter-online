// RemotePlayerRegistry.js
//
// Owns the lifecycle of every RemotePlayerMesh in the scene. One entry per
// remote sessionId; the local player is filtered out by comparing against
// the self id provider supplied by the coordinator.
//
// The coordinator funnels every Colyseus player-state change here as a
// snapshot; we upsert the mesh and push the new sample into its
// interpolation buffer. Per-frame the coordinator also calls update(now) so
// each mesh can lerp toward the target position.

import { RemotePlayerMesh } from "./RemotePlayerMesh.js";

export class RemotePlayerRegistry {
  /**
   * @param {THREE.Scene} scene
   * @param {{ selfSessionIdProvider: () => (string|null) }} opts
   */
  constructor(scene, { selfSessionIdProvider }) {
    this._scene = scene;
    this._selfIdProvider = selfSessionIdProvider;
    this._remotes = new Map(); // sessionId -> RemotePlayerMesh
  }

  /**
   * Called from the coordinator on every snapshot the server pushes.
   * Filters out self snapshots; everyone else gets upserted.
   */
  onSnapshot({
    sessionId,
    name,
    characterId,
    x,
    y,
    z,
    rotationY,
    health,
    maxHealth,
    connected,
  }) {
    if (!sessionId) return;
    if (sessionId === this._selfIdProvider()) return;

    let mesh = this._remotes.get(sessionId);
    if (!mesh) {
      mesh = new RemotePlayerMesh({
        sessionId,
        name: name || "Player",
        characterId: typeof characterId === "string" ? characterId : null,
        scene: this._scene,
      });
      this._remotes.set(sessionId, mesh);
    }

    mesh.pushSnapshot({ x, y, z, rotationY });
    if (typeof name === "string" && name) mesh.setName(name);
    if (typeof characterId === "string" && characterId) {
      mesh.setCharacter(characterId);
    }
    if (typeof health === "number" && typeof maxHealth === "number") {
      mesh.setHealth(health, maxHealth);
    }
    if (connected === false) mesh.setVisible(false);
    else mesh.setVisible(true);
  }

  /** Called from the coordinator each frame so the meshes can interpolate. */
  update(now) {
    for (const m of this._remotes.values()) m.update(now);
  }

  remove(sessionId) {
    if (!sessionId) return;
    const m = this._remotes.get(sessionId);
    if (!m) return;
    m.dispose();
    this._remotes.delete(sessionId);
  }

  clear() {
    for (const m of this._remotes.values()) m.dispose();
    this._remotes.clear();
  }
}
