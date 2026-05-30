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
  // Background pill
  ctx.fillStyle = "rgba(0,0,0,0.55)";
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
   * @param {{sessionId: string, name: string, scene: THREE.Scene}} opts
   */
  constructor({ sessionId, name, scene }) {
    this.sessionId = sessionId;
    this._name = name || sessionId;
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
      color: 0xef5b5b,
      roughness: 0.85,
      metalness: 0.0,
    });
    this._bodyMesh = new THREE.Mesh(bodyGeom, this._bodyMaterial);
    this._bodyMesh.castShadow = true;
    this._bodyMesh.receiveShadow = false;
    this._bodyMesh.position.y = 1.0; // half height so the capsule stands on y=0
    this.group.add(this._bodyMesh);

    // Name label as a sprite.
    this._labelTexture = makeLabelTexture(this._name);
    this._labelMaterial = new THREE.SpriteMaterial({
      map: this._labelTexture,
      depthTest: false,
      transparent: true,
    });
    this._labelSprite = new THREE.Sprite(this._labelMaterial);
    this._labelSprite.scale.set(1.6, 0.4, 1);
    this._labelSprite.position.y = 2.4;
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
      g.position.set(a.x, a.y, a.z);
      g.rotation.y = a.rotationY;
      return;
    }
    // After the newest sample (buffer underrun) → snap to newest. We
    // deliberately do NOT extrapolate; a brief stutter is preferable to a
    // visible overshoot when the next packet finally arrives.
    const newest = buf[buf.length - 1];
    if (renderT >= newest.t) {
      g.position.set(newest.x, newest.y, newest.z);
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
    g.position.y = a.y + (b.y - a.y) * alpha;
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
   */
  setHealth(hp, maxHp) {
    if (this._disposed) return;
    this._hp = Math.max(0, Number(hp) || 0);
    this._maxHp = Math.max(1, Number(maxHp) || this._maxHp);
    if (this._hp <= 0) {
      this._bodyMaterial.color.setHex(0x5a2a31);
    } else {
      this._bodyMaterial.color.setHex(0xef5b5b);
    }
  }

  getHealth() {
    return { hp: this._hp, maxHp: this._maxHp };
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
