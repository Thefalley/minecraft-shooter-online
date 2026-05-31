// RemotePlayerMesh.js
//
// Vanilla Three.js counterpart to apps/web/src/game/RemotePlayer.tsx.
//
// Each instance owns:
//   - A THREE.Group at scene root containing:
//     - A red capsule mesh for the body
//     - A Sprite name-label drawn from a small canvas texture (since we're
//       outside React Three Fiber, no <Html> equivalent — sprites are the
//       cheap idiomatic answer)
//   - A snapshot ring buffer (24 entries deep) of {t, x, y, z, rotationY}
//   - An update(now) call site that lerps position and rotates yaw on the
//     shortest path between the two snapshots bracketing
//     (now - SNAPSHOT_INTERPOLATION_DELAY_MS).
//
// Trade-off: remotes lag behind real time by ~120 ms. For a casual shooter
// this is invisible; precision combat would want server-side lag compensation,
// which is out of scope for Phase 1.

import * as THREE from "three";
import { SNAPSHOT_INTERPOLATION_DELAY_MS } from "@mvp/shared";

const BUFFER_SIZE = 24;
const DEFAULT_DELAY_MS = 120;

// Y offset applied to the group every frame so the capsule's FEET line up
// with the server-reported player.y (which represents the player's feet,
// see PLAYER_SPAWN_Y in @mvp/shared and GameRoom.tickPlayers).
//
// CapsuleGeometry(radius=0.4, length=1.2) has its pivot at the GEOMETRIC
// CENTER, so the capsule extends ±(length/2 + radius) = ±1.0 along Y. If we
// placed the mesh at group.y = server.y the capsule's feet would render at
// server.y - 1.0 — i.e. one block BELOW the surface the local player is
// standing on. That's the visible "sunk into the ground" / "in the wrong
// place" bug the user reported ("el personaje de mi amigo me sale en otro
// sitio"). Adding the half-height to the group origin lifts the capsule so
// that:
//   feet  = group.y - 1.0 = server.y           ← matches local player's feet
//   center = group.y      = server.y + 1.0
//   head  = group.y + 1.0 = server.y + 2.0
// The label sprite sits inside the group at local y=1.6 so it stays just
// above the capsule head (world y = server.y + 2.6) — see _labelSprite below.
//
// Kept as a module-level constant: capsule dimensions are baked into the
// geometry and don't change at runtime, so reading them from config would
// only add noise.
const VISUAL_Y_OFFSET = 1.0;

// Per-character body tint so remotes are recognisable at a glance. Mirrors
// the lobby's CharacterSelectStrip palette (loosely). Unknown ids fall back
// to a neutral red so we never throw.
const CHARACTER_COLORS = Object.freeze({
  duck: 0xffd34d,     // yellow / orange
  knight: 0x4a8fff,   // blue
  hunter: 0x4caf50,   // green
  samurai: 0xef5b5b,  // red
  mage: 0xb16cea,     // purple
});
const DEFAULT_BODY_COLOR = 0xef5b5b;
const DEAD_BODY_COLOR = 0x5a2a31;

function colorForCharacter(characterId) {
  if (!characterId) return DEFAULT_BODY_COLOR;
  const hex = CHARACTER_COLORS[characterId];
  return typeof hex === "number" ? hex : DEFAULT_BODY_COLOR;
}

function shortAngleDelta(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function makeLabelTexture(name) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Background pill — bumped to a near-opaque black so the white text stays
  // crisp even when the player is in front of a bright voxel texture.
  ctx.fillStyle = "rgba(0,0,0,0.82)";
  const pad = 8;
  const r = 18;
  const x = pad;
  const y = pad;
  const w = canvas.width - pad * 2;
  const h = canvas.height - pad * 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
  // Thin white outline for extra contrast on noisy backgrounds.
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.65)";
  ctx.stroke();
  // Text
  ctx.font = "bold 28px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, canvas.width / 2, canvas.height / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export class RemotePlayerMesh {
  /**
   * @param {{sessionId: string, name: string, characterId?: string|null, scene: THREE.Scene}} opts
   */
  constructor({ sessionId, name, characterId, scene }) {
    this.sessionId = sessionId;
    this._name = name || sessionId;
    this._characterId = typeof characterId === "string" ? characterId : null;
    this._scene = scene;
    this._buffer = [];
    this._delayMs = SNAPSHOT_INTERPOLATION_DELAY_MS || DEFAULT_DELAY_MS;
    this._hp = 100;
    this._maxHp = 100;
    this._disposed = false;

    this.group = new THREE.Group();
    this.group.name = `remote:${sessionId}`;

    // Body: capsule (radius 0.4, length 1.2 between hemispheres).
    const bodyGeom = new THREE.CapsuleGeometry(0.4, 1.2, 8, 16);
    this._bodyMaterial = new THREE.MeshStandardMaterial({
      color: colorForCharacter(this._characterId),
      roughness: 0.85,
      metalness: 0.0,
    });
    this._bodyMesh = new THREE.Mesh(bodyGeom, this._bodyMaterial);
    this._bodyMesh.castShadow = true;
    this._bodyMesh.receiveShadow = false;
    // No local-Y offset here: the entire group is shifted by VISUAL_Y_OFFSET
    // in update() so the capsule's feet land at server.y instead of
    // server.y - 1.0 (which would visually bury the player into the ground).
    this._bodyMesh.position.y = 0;
    this.group.add(this._bodyMesh);

    // Name label as a sprite. depthTest=false + renderOrder=10 means the
    // pill stays readable even when the player is behind a voxel column —
    // very useful when scouting an enemy through a wall in the lobby.
    this._labelTexture = makeLabelTexture(this._name);
    this._labelMaterial = new THREE.SpriteMaterial({
      map: this._labelTexture,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this._labelSprite = new THREE.Sprite(this._labelMaterial);
    this._labelSprite.scale.set(1.6, 0.4, 1);
    // Body mesh is now centered at local y=0 (the VISUAL_Y_OFFSET lives on
    // the group), so the capsule head sits at body-local y=1.0. 1.6 keeps a
    // comfortable gap above the head; in world coords that's
    // server.y + VISUAL_Y_OFFSET + 1.6 = server.y + 2.6, identical to the
    // pre-fix label height.
    this._labelSprite.position.y = 1.6;
    this._labelSprite.renderOrder = 10;
    this.group.add(this._labelSprite);

    scene.add(this.group);
  }

  /**
   * Server snapshot for this player. Called from NetworkBridge when the
   * Colyseus state listener fires.
   */
  pushSnapshot({ x, y, z, rotationY }) {
    if (this._disposed) return;
    const buf = this._buffer;
    const now = performance.now();
    const last = buf[buf.length - 1];
    // Drop out-of-order / duplicate frames so the interpolator never sees a
    // negative time span.
    if (last && last.t >= now) return;
    buf.push({
      t: now,
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      z: Number.isFinite(z) ? z : 0,
      rotationY: Number.isFinite(rotationY) ? rotationY : 0,
    });
    if (buf.length > BUFFER_SIZE) buf.shift();
  }

  /**
   * Per-frame update. Call from your render loop with performance.now().
   */
  update(now) {
    if (this._disposed) return;
    const buf = this._buffer;
    if (buf.length === 0) return;

    const renderT = now - this._delayMs;
    const g = this.group;

    // Before the oldest sample → snap to oldest.
    if (renderT <= buf[0].t) {
      const a = buf[0];
      g.position.set(a.x, a.y + VISUAL_Y_OFFSET, a.z);
      g.rotation.y = a.rotationY;
      return;
    }
    // After the newest sample (buffer underrun) → snap to newest. We
    // deliberately do NOT extrapolate; a brief stutter is preferable to a
    // visible overshoot when the next packet finally arrives.
    const newest = buf[buf.length - 1];
    if (renderT >= newest.t) {
      g.position.set(newest.x, newest.y + VISUAL_Y_OFFSET, newest.z);
      g.rotation.y = newest.rotationY;
      return;
    }
    // Linear scan from the end to find the pair bracketing renderT.
    let i = buf.length - 1;
    while (i > 0 && buf[i].t > renderT) i--;
    const a = buf[i];
    const b = buf[i + 1];
    const span = b.t - a.t;
    const alpha = span > 0 ? (renderT - a.t) / span : 0;

    g.position.x = a.x + (b.x - a.x) * alpha;
    // VISUAL_Y_OFFSET centers the capsule above the server-reported feet
    // position (server.y is feet, capsule pivot is center → +1.0 half-height).
    g.position.y = a.y + (b.y - a.y) * alpha + VISUAL_Y_OFFSET;
    g.position.z = a.z + (b.z - a.z) * alpha;
    g.rotation.y =
      a.rotationY + shortAngleDelta(a.rotationY, b.rotationY) * alpha;
  }

  setVisible(v) {
    if (this._disposed) return;
    this.group.visible = !!v;
  }

  setName(name) {
    if (this._disposed || !name || name === this._name) return;
    this._name = name;
    // Rebuild the label texture in place so we don't need a new material.
    if (this._labelTexture) this._labelTexture.dispose();
    const tex = makeLabelTexture(this._name);
    this._labelTexture = tex;
    this._labelMaterial.map = tex;
    this._labelMaterial.needsUpdate = true;
  }

  /**
   * Hook for the HP bar. We just stash the numbers and tint the body when
   * dead; the actual bar UI is in HUD-land and will read these later.
   * "Alive" recolours back to the per-character tint, not a hard-coded red.
   */
  setHealth(hp, maxHp) {
    if (this._disposed) return;
    this._hp = Math.max(0, Number(hp) || 0);
    this._maxHp = Math.max(1, Number(maxHp) || this._maxHp);
    if (this._hp <= 0) {
      this._bodyMaterial.color.setHex(DEAD_BODY_COLOR);
    } else {
      this._bodyMaterial.color.setHex(colorForCharacter(this._characterId));
    }
  }

  getHealth() {
    return { hp: this._hp, maxHp: this._maxHp };
  }

  /**
   * Late-arriving character pick from the server. We swap the body tint to
   * the matching colour unless the player is currently flagged dead — they
   * keep the desaturated dead colour until they respawn.
   */
  setCharacter(characterId) {
    if (this._disposed) return;
    if (typeof characterId !== "string" || !characterId) return;
    if (characterId === this._characterId) return;
    this._characterId = characterId;
    if (this._hp > 0) {
      this._bodyMaterial.color.setHex(colorForCharacter(this._characterId));
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.group.parent) this.group.parent.remove(this.group);
    this._bodyMesh.geometry.dispose();
    this._bodyMaterial.dispose();
    if (this._labelTexture) this._labelTexture.dispose();
    this._labelMaterial.dispose();
    this._buffer.length = 0;
  }
}
