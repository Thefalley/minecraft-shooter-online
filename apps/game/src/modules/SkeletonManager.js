import * as THREE from 'three';

const DEFAULT_BOUNDS = { minX: -22, maxX: 22, minZ: -22, maxZ: 22 };
const ARROW_HIT_RADIUS = 1.0;

// Snapshot interpolation tuning for server-driven entities (multiplayer).
const SERVER_SNAPSHOT_BUFFER = 8;
const SERVER_INTERP_DELAY_MS = 120;

function _pushServerSnap(buffer, snap) {
  const now = performance.now();
  const last = buffer[buffer.length - 1];
  if (last && last.t >= now) return;
  buffer.push({
    t: now,
    x: Number.isFinite(snap.x) ? snap.x : 0,
    y: Number.isFinite(snap.y) ? snap.y : 0,
    z: Number.isFinite(snap.z) ? snap.z : 0,
    rotationY: Number.isFinite(snap.rotationY) ? snap.rotationY : 0,
  });
  if (buffer.length > SERVER_SNAPSHOT_BUFFER) buffer.shift();
}

function _shortAngleDelta(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function _interpServerEntity(entity, now) {
  const buf = entity._buffer;
  if (!buf || buf.length === 0) return;
  const renderT = now - SERVER_INTERP_DELAY_MS;
  const pos = entity.mesh.position;
  if (renderT <= buf[0].t) {
    pos.set(buf[0].x, buf[0].y, buf[0].z);
    entity.mesh.rotation.y = buf[0].rotationY;
    return;
  }
  const newest = buf[buf.length - 1];
  if (renderT >= newest.t) {
    pos.set(newest.x, newest.y, newest.z);
    entity.mesh.rotation.y = newest.rotationY;
    return;
  }
  let i = buf.length - 1;
  while (i > 0 && buf[i].t > renderT) i--;
  const a = buf[i];
  const b = buf[i + 1];
  const span = b.t - a.t;
  const alpha = span > 0 ? (renderT - a.t) / span : 0;
  pos.x = a.x + (b.x - a.x) * alpha;
  pos.y = a.y + (b.y - a.y) * alpha;
  pos.z = a.z + (b.z - a.z) * alpha;
  entity.mesh.rotation.y = a.rotationY + _shortAngleDelta(a.rotationY, b.rotationY) * alpha;
}

function getWorldPosition(target, fallback = new THREE.Vector3()) {
  if (!target) return fallback.set(0, 0, 0);
  if (target.isVector3) return fallback.copy(target);
  if (target.object?.position?.isVector3) return fallback.copy(target.object.position);
  if (target.position?.isVector3) return fallback.copy(target.position);
  return fallback.set(0, 0, 0);
}

function groundHeight(world, x, z, fallback = 0) {
  if (typeof world?.getGroundHeight === 'function') return world.getGroundHeight(x, z);
  return fallback;
}

// Skeletons follow the player and shoot arrows. Slightly less health than a
// zombie (killable by the fire tornado). Their arrows are reflected by the
// knight's guard.
export class SkeletonManager {
  constructor(scene = null, options = {}) {
    this.scene = scene?.isScene ? scene : null;
    this.world = options.world ?? null;
    this.group = new THREE.Group();
    this.group.name = 'SkeletonManager';
    this.skeletons = [];
    this.arrows = [];
    this.impacts = [];
    this.elapsed = 0;
    this.kills = 0;

    this.bounds = { ...DEFAULT_BOUNDS, ...(options.bounds ?? {}) };
    this.health = options.health ?? 22;
    this.speed = options.speed ?? 3.0;
    this.shootRange = options.shootRange ?? 18;
    this.keepMin = options.keepMin ?? 9; // retreat if the player is closer than this
    this.keepMax = options.keepMax ?? 15; // follow if the player is farther than this
    this.shootCooldown = options.shootCooldown ?? 2.0;
    this.arrowSpeed = options.arrowSpeed ?? 24;
    this.arrowDamage = options.arrowDamage ?? 6;
    this.reflectDamage = options.reflectDamage ?? 30;

    this.tmpPlayer = new THREE.Vector3();
    this.tmpDir = new THREE.Vector3();
    this.tmpRaycaster = new THREE.Raycaster();

    // Multiplayer: 'server' disables local AI/spawn/arrows and switches
    // update() to pure snapshot interpolation. Default 'local'.
    this._authority = 'local';
    this._serverEntities = new Map();

    this.geometry = {
      body: new THREE.BoxGeometry(0.5, 1.2, 0.32),
      head: new THREE.BoxGeometry(0.55, 0.55, 0.55),
      arm: new THREE.BoxGeometry(0.16, 0.8, 0.16),
      bow: new THREE.TorusGeometry(0.45, 0.05, 6, 10, Math.PI * 1.2),
      arrow: new THREE.BoxGeometry(0.07, 0.07, 0.7),
    };
    this.material = {
      bone: new THREE.MeshStandardMaterial({ color: 0xe8e6dc, roughness: 0.85, flatShading: true }),
      bow: new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.9, flatShading: true }),
      arrow: new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.8, flatShading: true }),
    };

    if (this.scene) this.scene.add(this.group);
  }

  createSkeletonMesh(index) {
    const skeleton = new THREE.Group();
    skeleton.name = `Skeleton_${index}`;

    const body = new THREE.Mesh(this.geometry.body, this.material.bone);
    body.position.y = 0.6;
    body.castShadow = true;
    skeleton.add(body);

    const head = new THREE.Mesh(this.geometry.head, this.material.bone);
    head.position.y = 1.5;
    head.castShadow = true;
    skeleton.add(head);

    const armL = new THREE.Mesh(this.geometry.arm, this.material.bone);
    armL.position.set(-0.4, 0.9, 0.1);
    armL.rotation.x = -Math.PI / 2.4;
    skeleton.add(armL);

    const armR = new THREE.Mesh(this.geometry.arm, this.material.bone);
    armR.position.set(0.4, 0.9, 0.1);
    armR.rotation.x = -Math.PI / 2.4;
    skeleton.add(armR);

    const bow = new THREE.Mesh(this.geometry.bow, this.material.bow);
    bow.position.set(0.45, 0.95, 0.35);
    bow.rotation.y = Math.PI / 2;
    skeleton.add(bow);

    skeleton.traverse((child) => {
      if (child.isMesh) child.userData.skeletonRoot = skeleton;
    });
    return skeleton;
  }

  spawnWave(count, player, world) {
    this.clearSkeletons();
    const center = getWorldPosition(player, this.tmpPlayer);

    for (let i = 0; i < count; i += 1) {
      const angle = (i / Math.max(1, count)) * Math.PI * 2 + i * 2.3;
      const radius = 16 + (i % 4) * 3;
      const x = THREE.MathUtils.clamp(center.x + Math.cos(angle) * radius, this.bounds.minX, this.bounds.maxX);
      const z = THREE.MathUtils.clamp(center.z + Math.sin(angle) * radius, this.bounds.minZ, this.bounds.maxZ);

      const skeleton = {
        id: i,
        health: this.health,
        maxHealth: this.health,
        speed: this.speed * (0.9 + (i % 3) * 0.06),
        shootTimer: 0.8 + (i % 5) * 0.3,
        mesh: this.createSkeletonMesh(i),
        dead: false,
      };
      skeleton.mesh.position.set(x, groundHeight(world, x, z), z);
      skeleton.mesh.userData.skeleton = skeleton;
      this.group.add(skeleton.mesh);
      this.skeletons.push(skeleton);
    }
  }

  update(delta, player, world) {
    const dt = Math.min(delta || 0, 0.08);
    this.elapsed += dt;

    if (this._authority === 'server') {
      const now = performance.now();
      for (const skeleton of this.skeletons) {
        if (skeleton.dead || !skeleton.serverOwned) continue;
        _interpServerEntity(skeleton, now);
      }
      return;
    }

    const playerPos = getWorldPosition(player, this.tmpPlayer);

    for (const skeleton of this.skeletons) {
      if (skeleton.dead) continue;

      let speedFactor = 1;
      if (skeleton.slowTimer > 0) {
        skeleton.slowTimer -= dt;
        speedFactor = skeleton.slowFactor ?? 1;
        if (skeleton.slowTimer <= 0) this._clearSlowTint(skeleton);
      }

      if (skeleton.liftTimer > 0) {
        skeleton.liftTimer -= dt;
        continue; // tornado controls it
      }

      this.tmpDir.set(playerPos.x - skeleton.mesh.position.x, 0, playerPos.z - skeleton.mesh.position.z);
      const distance = this.tmpDir.length();
      if (distance > 0.0001) {
        this.tmpDir.normalize();
        skeleton.mesh.rotation.y = Math.atan2(this.tmpDir.x, this.tmpDir.z);
      }

      // Kiting: keep a comfortable distance. Back off if the player gets close,
      // hold and fire at mid range, follow if the player runs away.
      let move = 0;
      if (distance > this.keepMax) move = 1; // follow
      else if (distance < this.keepMin) move = -1; // retreat
      if (move !== 0) {
        const stepX = this.tmpDir.x * skeleton.speed * speedFactor * dt * move;
        const stepZ = this.tmpDir.z * skeleton.speed * speedFactor * dt * move;
        const nextX = THREE.MathUtils.clamp(skeleton.mesh.position.x + stepX, this.bounds.minX, this.bounds.maxX);
        const nextZ = THREE.MathUtils.clamp(skeleton.mesh.position.z + stepZ, this.bounds.minZ, this.bounds.maxZ);
        if (groundHeight(world, nextX, nextZ) - skeleton.mesh.position.y <= 1.1) {
          skeleton.mesh.position.x = nextX;
          skeleton.mesh.position.z = nextZ;
        }
      }

      skeleton.mesh.position.y = groundHeight(world, skeleton.mesh.position.x, skeleton.mesh.position.z);

      skeleton.shootTimer -= dt;
      if (distance <= this.shootRange && skeleton.shootTimer <= 0) {
        this.shootArrow(skeleton, playerPos);
        skeleton.shootTimer = this.shootCooldown;
      }
    }

    this.updateArrows(dt, player, playerPos);
  }

  shootArrow(skeleton, playerPos) {
    const start = skeleton.mesh.position.clone();
    start.y += 1.1;
    const target = playerPos.clone();
    target.y += 1.3; // aim at the torso
    const dir = target.sub(start);
    if (dir.lengthSq() < 0.0001) return;
    dir.normalize();

    const mesh = new THREE.Mesh(this.geometry.arrow, this.material.arrow);
    mesh.position.copy(start);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    this.group.add(mesh);

    this.arrows.push({
      position: start.clone(),
      velocity: dir.multiplyScalar(this.arrowSpeed),
      owner: skeleton,
      mesh,
      life: 4,
      damage: this.arrowDamage,
      reflected: false,
    });
  }

  updateArrows(delta, player, playerPos) {
    for (let i = this.arrows.length - 1; i >= 0; i -= 1) {
      const arrow = this.arrows[i];
      arrow.life -= delta;
      arrow.position.addScaledVector(arrow.velocity, delta);
      arrow.mesh.position.copy(arrow.position);

      if (arrow.velocity.lengthSq() > 0.0001) {
        this.tmpDir.copy(arrow.velocity).normalize();
        arrow.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.tmpDir);
      }

      // Reflected arrows home toward the skeleton that fired them.
      if (arrow.reflected) {
        const owner = arrow.owner;
        if (!owner || owner.dead || arrow.life <= 0 || this._blocked(arrow.position)) {
          this._removeArrow(i);
          continue;
        }
        this.tmpDir.subVectors(owner.mesh.position, arrow.position);
        const dist = this.tmpDir.length();
        if (dist > 0.0001) this.tmpDir.normalize();
        const speed = arrow.velocity.length() || this.arrowSpeed;
        arrow.velocity.lerp(this.tmpDir.multiplyScalar(speed), Math.min(1, delta * 6));
        if (dist <= ARROW_HIT_RADIUS + 0.8) {
          owner.health = Math.max(0, owner.health - arrow.damage);
          if (owner.health <= 0) this.killSkeleton(owner);
          this.impacts.push({ position: arrow.position.clone(), damage: 0, hitPlayer: false });
          this._removeArrow(i);
        }
        continue;
      }

      if (arrow.life <= 0 || arrow.position.y < -4 || this._blocked(arrow.position)) {
        this._removeArrow(i);
        continue;
      }

      const hitPlayer = Boolean(player) && arrow.position.distanceTo(playerPos) <= ARROW_HIT_RADIUS + 0.6;
      if (hitPlayer) {
        // The knight's guard reflects the arrow back at its owner.
        if (player.guardActive && arrow.owner && !arrow.owner.dead) {
          arrow.reflected = true;
          arrow.damage = this.reflectDamage;
          arrow.life = 4;
          this.tmpDir.subVectors(arrow.owner.mesh.position, arrow.position).normalize();
          arrow.velocity.copy(this.tmpDir).multiplyScalar(this.arrowSpeed * 1.3);
          this.impacts.push({ position: arrow.position.clone(), damage: 0, hitPlayer: false, reflected: true });
          continue;
        }
        this.impacts.push({ position: arrow.position.clone(), damage: arrow.damage, hitPlayer: true });
        this._removeArrow(i);
      }
    }
  }

  _blocked(position) {
    if (!this.world || typeof this.world.getBlock !== 'function') return false;
    const type = this.world.getBlock(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    return Boolean(type) && type !== 'water';
  }

  _removeArrow(index) {
    const arrow = this.arrows[index];
    this.group.remove(arrow.mesh);
    this.arrows.splice(index, 1);
  }

  consumeImpacts() {
    const impacts = this.impacts;
    this.impacts = [];
    return impacts;
  }

  // --- damage / hit support -------------------------------------------------
  // In server-authority mode the client never mutates HP — the server's
  // snapshots / a future weapon-hit event own that. Returns false so callers
  // still get to draw the visual impact at the ray point.
  damageSkeleton(skeleton, amount) {
    if (this._authority === 'server') return false;
    skeleton.health = Math.max(0, skeleton.health - amount);
    if (skeleton.health <= 0) {
      this.killSkeleton(skeleton);
      return true;
    }
    return false;
  }

  peekRay(ray) {
    const isRaycaster = typeof ray?.intersectObjects === 'function' && ray.ray;
    const raycaster = isRaycaster ? ray : this.tmpRaycaster;
    if (!isRaycaster) {
      if (ray?.origin && ray?.direction) {
        raycaster.ray.copy(ray);
        raycaster.near = 0;
        raycaster.far = Infinity;
      } else {
        return null;
      }
    }
    const meshes = [];
    for (const s of this.skeletons) {
      if (!s.dead) s.mesh.traverse((child) => { if (child.isMesh) meshes.push(child); });
    }
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const root = hits[0].object.userData.skeletonRoot;
    const skeleton = this.skeletons.find((c) => c.mesh === root);
    if (!skeleton || skeleton.dead) return null;
    return { skeleton, point: hits[0].point.clone(), distance: hits[0].distance };
  }

  applyRayHit(peek, damage) {
    const killed = this.damageSkeleton(peek.skeleton, damage);
    return { dragon: null, zombie: null, skeleton: peek.skeleton, point: peek.point, distance: peek.distance, killed, health: peek.skeleton.health };
  }

  hitByRay(ray, damage = 25) {
    const peek = this.peekRay(ray);
    return peek ? this.applyRayHit(peek, damage) : null;
  }

  hitAllByRay(ray, damage = 25) {
    const isRaycaster = typeof ray?.intersectObjects === 'function' && ray.ray;
    const raycaster = isRaycaster ? ray : this.tmpRaycaster;
    if (!isRaycaster) {
      if (ray?.origin && ray?.direction) {
        raycaster.ray.copy(ray);
        raycaster.near = 0;
        raycaster.far = Infinity;
      } else {
        return [];
      }
    }
    const meshes = [];
    for (const s of this.skeletons) {
      if (!s.dead) s.mesh.traverse((child) => { if (child.isMesh) meshes.push(child); });
    }
    const hits = raycaster.intersectObjects(meshes, false);
    const results = [];
    const seen = new Set();
    for (const intersection of hits) {
      const root = intersection.object.userData.skeletonRoot;
      const skeleton = this.skeletons.find((c) => c.mesh === root);
      if (!skeleton || skeleton.dead || seen.has(skeleton.id)) continue;
      seen.add(skeleton.id);
      const killed = this.damageSkeleton(skeleton, damage);
      results.push({ dragon: null, zombie: null, skeleton, point: intersection.point.clone(), distance: intersection.distance, killed, health: skeleton.health });
    }
    return results;
  }

  hitMelee(origin, direction, range, damage, arcCos = 0.3) {
    const results = [];
    for (const skeleton of this.skeletons) {
      if (skeleton.dead) continue;
      this.tmpDir.subVectors(skeleton.mesh.position, origin);
      const distance = this.tmpDir.length();
      if (distance > range || distance < 0.0001) continue;
      this.tmpDir.normalize();
      if (this.tmpDir.dot(direction) < arcCos) continue;
      const killed = this.damageSkeleton(skeleton, damage);
      results.push({ position: skeleton.mesh.position.clone(), killed });
    }
    return results;
  }

  hitBox(origin, forward, right, length, halfWidth, damage) {
    const results = [];
    const v = new THREE.Vector3();
    for (const skeleton of this.skeletons) {
      if (skeleton.dead) continue;
      v.subVectors(skeleton.mesh.position, origin);
      const f = v.dot(forward);
      const lateral = Math.abs(v.dot(right));
      if (f < -1 || f > length || lateral > halfWidth || Math.abs(v.y) > 5) continue;
      const killed = this.damageSkeleton(skeleton, damage);
      results.push({ position: skeleton.mesh.position.clone(), killed });
    }
    return results;
  }

  knockback(center, radius, force, world) {
    for (const skeleton of this.skeletons) {
      if (skeleton.dead) continue;
      const dx = skeleton.mesh.position.x - center.x;
      const dz = skeleton.mesh.position.z - center.z;
      const dist = Math.hypot(dx, dz);
      if (dist > radius || dist < 0.0001) continue;
      const inv = 1 / dist;
      const nx = THREE.MathUtils.clamp(skeleton.mesh.position.x + dx * inv * force, this.bounds.minX, this.bounds.maxX);
      const nz = THREE.MathUtils.clamp(skeleton.mesh.position.z + dz * inv * force, this.bounds.minZ, this.bounds.maxZ);
      skeleton.mesh.position.set(nx, groundHeight(world, nx, nz), nz);
    }
  }

  slow(center, radius, factor, duration) {
    for (const skeleton of this.skeletons) {
      if (skeleton.dead) continue;
      const dx = skeleton.mesh.position.x - center.x;
      const dz = skeleton.mesh.position.z - center.z;
      if (Math.hypot(dx, dz) > radius) continue;
      skeleton.slowTimer = duration;
      skeleton.slowFactor = factor;
      this._applySlowTint(skeleton);
    }
  }

  _applySlowTint(skeleton) {
    skeleton.mesh.traverse((child) => {
      if (!child.isMesh) return;
      if (!child.userData.baseMat) child.userData.baseMat = child.material;
      if (!child.userData.iceMat) {
        child.userData.iceMat = child.userData.baseMat.clone();
        child.userData.iceMat.color = child.userData.baseMat.color.clone().lerp(new THREE.Color(0x8fd3ff), 0.7);
        child.userData.iceMat.emissive = new THREE.Color(0x2a6bdf);
        child.userData.iceMat.emissiveIntensity = 0.6;
      }
      child.material = child.userData.iceMat;
    });
  }

  _clearSlowTint(skeleton) {
    skeleton.slowTimer = 0;
    skeleton.mesh.traverse((child) => {
      if (child.isMesh && child.userData.baseMat) child.material = child.userData.baseMat;
    });
  }

  tornadoPull(center, radius, elapsed) {
    for (const skeleton of this.skeletons) {
      if (skeleton.dead) continue;
      const dx = center.x - skeleton.mesh.position.x;
      const dz = center.z - skeleton.mesh.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > radius) continue;
      skeleton.liftTimer = 0.2;
      const angle = elapsed * 6 + skeleton.id;
      const orbit = Math.min(dist, radius * 0.5);
      skeleton.mesh.position.x = center.x + Math.cos(angle) * orbit;
      skeleton.mesh.position.z = center.z + Math.sin(angle) * orbit;
      skeleton.mesh.position.y = center.y + 1.5 + (Math.sin(elapsed * 3 + skeleton.id) * 0.5 + 1) * 2.5;
      skeleton.mesh.rotation.y = angle;
    }
  }

  heal(center, radius, amount) {
    for (const skeleton of this.skeletons) {
      if (skeleton.dead) continue;
      if (skeleton.mesh.position.distanceTo(center) > radius) continue;
      skeleton.health = Math.min(skeleton.maxHealth, skeleton.health + amount);
    }
  }

  killSkeleton(skeleton) {
    skeleton.dead = true;
    skeleton.mesh.visible = false;
    this.group.remove(skeleton.mesh);
    this.kills += 1;
  }

  clearSkeletons() {
    for (const skeleton of this.skeletons) this.group.remove(skeleton.mesh);
    this.skeletons.length = 0;
    for (const arrow of this.arrows) this.group.remove(arrow.mesh);
    this.arrows.length = 0;
  }

  consumeKills() {
    const kills = this.kills;
    this.kills = 0;
    return kills;
  }

  getAliveCount() {
    let count = 0;
    for (const s of this.skeletons) if (!s.dead) count += 1;
    return count;
  }

  // --- server authority (multiplayer) --------------------------------------

  setAuthority(mode) {
    const next = mode === 'server' ? 'server' : 'local';
    if (next === this._authority) return;
    this._authority = next;
    if (next === 'server') {
      this.clearSkeletons();
    } else {
      this.clearServerEntities();
    }
  }

  applyServerEnemy(snap) {
    if (this._authority !== 'server' || !snap || snap.id === undefined || snap.id === null) return;
    let entity = this._serverEntities.get(snap.id);
    if (!entity) {
      const mesh = this.createSkeletonMesh(this._serverEntities.size);
      mesh.position.set(snap.x, snap.y, snap.z);
      mesh.rotation.y = snap.rotationY ?? 0;
      entity = {
        id: snap.id,
        serverOwned: true,
        health: snap.health ?? this.health,
        maxHealth: snap.maxHealth ?? this.health,
        mesh,
        dead: false,
        _buffer: [],
        speed: 0,
        shootTimer: Infinity,
      };
      mesh.userData.skeleton = entity;
      this.group.add(mesh);
      this.skeletons.push(entity);
      this._serverEntities.set(snap.id, entity);
    }
    if (snap.health !== undefined) entity.health = snap.health;
    if (snap.maxHealth !== undefined) entity.maxHealth = snap.maxHealth;
    _pushServerSnap(entity._buffer, snap);
  }

  removeServerEnemy(id) {
    if (id === undefined || id === null) return false;
    const entity = this._serverEntities.get(id);
    if (!entity) return false;
    entity.dead = true;
    entity.mesh.visible = false;
    this.group.remove(entity.mesh);
    this._serverEntities.delete(id);
    const idx = this.skeletons.indexOf(entity);
    if (idx >= 0) this.skeletons.splice(idx, 1);
    return true;
  }

  clearServerEntities() {
    for (const entity of this._serverEntities.values()) {
      entity.dead = true;
      this.group.remove(entity.mesh);
      const idx = this.skeletons.indexOf(entity);
      if (idx >= 0) this.skeletons.splice(idx, 1);
    }
    this._serverEntities.clear();
  }

  dispose() {
    if (this.group.parent) this.group.parent.remove(this.group);
    this.clearSkeletons();
    this.clearServerEntities();
    for (const geometry of Object.values(this.geometry)) geometry.dispose();
    for (const material of Object.values(this.material)) material.dispose();
  }
}

export default SkeletonManager;
