import * as THREE from 'three';

const DEFAULT_BOUNDS = { minX: -22, maxX: 22, minZ: -22, maxZ: 22 };

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

// A Minecraft-style witch (purple robe, green skin, hooked nose, pointy black
// hat). It never hurts the player; instead it lobs healing splash potions at
// wounded monsters. It keeps a bit more distance than a skeleton.
export class WitchManager {
  constructor(scene = null, options = {}) {
    this.scene = scene?.isScene ? scene : null;
    this.world = options.world ?? null;
    this.group = new THREE.Group();
    this.group.name = 'WitchManager';
    this.witches = [];
    this.potions = [];
    this.events = [];
    this.elapsed = 0;
    this.kills = 0;

    this.bounds = { ...DEFAULT_BOUNDS, ...(options.bounds ?? {}) };
    this.health = options.health ?? 26;
    this.speed = options.speed ?? 3.0;
    this.keepMin = options.keepMin ?? 12; // a bit more than the skeleton (9)
    this.keepMax = options.keepMax ?? 19;
    this.throwRange = options.throwRange ?? 22;
    this.throwCooldown = options.throwCooldown ?? 2.4;
    this.potionSpeed = options.potionSpeed ?? 14;
    this.healRadius = options.healRadius ?? 4;
    this.healAmount = options.healAmount ?? 14;

    // Set by the game: returns a world position of a wounded ally (or null).
    this.healTargetProvider = null;

    this.tmpPlayer = new THREE.Vector3();
    this.tmpDir = new THREE.Vector3();
    this.tmpRaycaster = new THREE.Raycaster();

    // Multiplayer: 'server' disables local AI/spawn/potions and switches
    // update() to pure snapshot interpolation. Default 'local'.
    this._authority = 'local';
    this._serverEntities = new Map();

    this.geometry = {
      robe: new THREE.BoxGeometry(0.72, 1.3, 0.52),
      skirt: new THREE.BoxGeometry(0.92, 0.45, 0.62),
      head: new THREE.BoxGeometry(0.56, 0.56, 0.56),
      nose: new THREE.BoxGeometry(0.14, 0.14, 0.42),
      box: new THREE.BoxGeometry(1, 1, 1),
      potion: new THREE.BoxGeometry(0.2, 0.2, 0.2),
      cork: new THREE.BoxGeometry(0.09, 0.12, 0.09),
    };
    this.material = {
      robe: new THREE.MeshStandardMaterial({ color: 0x4a3a6a, roughness: 0.9, flatShading: true }),
      skin: new THREE.MeshStandardMaterial({ color: 0x5fa05a, roughness: 0.85, flatShading: true }),
      hat: new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.95, flatShading: true }),
      band: new THREE.MeshStandardMaterial({ color: 0x9b59b6, roughness: 0.8, flatShading: true }),
      potion: new THREE.MeshStandardMaterial({ color: 0xff5fa0, emissive: 0xff2f7a, emissiveIntensity: 0.7, roughness: 0.4, flatShading: true }),
      cork: new THREE.MeshStandardMaterial({ color: 0x9c6a3a, roughness: 0.9, flatShading: true }),
    };

    if (this.scene) this.scene.add(this.group);
  }

  _box(w, h, d, material) {
    const mesh = new THREE.Mesh(this.geometry.box, material);
    mesh.scale.set(w, h, d);
    return mesh;
  }

  createWitchMesh(index) {
    const witch = new THREE.Group();
    witch.name = `Witch_${index}`;

    const robe = new THREE.Mesh(this.geometry.robe, this.material.robe);
    robe.position.y = 0.75;
    robe.castShadow = true;
    witch.add(robe);
    const skirt = new THREE.Mesh(this.geometry.skirt, this.material.robe);
    skirt.position.y = 0.22;
    witch.add(skirt);

    const head = new THREE.Mesh(this.geometry.head, this.material.skin);
    head.position.y = 1.6;
    head.castShadow = true;
    witch.add(head);
    const nose = new THREE.Mesh(this.geometry.nose, this.material.skin);
    nose.position.set(0, 1.52, 0.42); // faces +Z (toward the player)
    witch.add(nose);

    // Pointy black hat: brim + shrinking cone + band.
    const brim = this._box(0.95, 0.1, 0.95, this.material.hat);
    brim.position.y = 1.9;
    witch.add(brim);
    const band = this._box(0.6, 0.1, 0.6, this.material.band);
    band.position.y = 1.97;
    witch.add(band);
    let hy = 2.05;
    let hw = 0.52;
    for (let i = 0; i < 4; i += 1) {
      const seg = this._box(hw, 0.2, hw, this.material.hat);
      seg.position.y = hy;
      witch.add(seg);
      hy += 0.2;
      hw *= 0.6;
    }

    witch.traverse((child) => {
      if (child.isMesh) child.userData.witchRoot = witch;
    });
    return witch;
  }

  spawnWave(count, player, world) {
    this.clearWitches();
    const center = getWorldPosition(player, this.tmpPlayer);
    for (let i = 0; i < count; i += 1) {
      const angle = (i / Math.max(1, count)) * Math.PI * 2 + i * 1.9;
      const radius = 17 + (i % 3) * 3;
      const x = THREE.MathUtils.clamp(center.x + Math.cos(angle) * radius, this.bounds.minX, this.bounds.maxX);
      const z = THREE.MathUtils.clamp(center.z + Math.sin(angle) * radius, this.bounds.minZ, this.bounds.maxZ);
      const witch = {
        id: i,
        health: this.health,
        maxHealth: this.health,
        speed: this.speed * (0.9 + (i % 3) * 0.05),
        throwTimer: 1 + (i % 4) * 0.4,
        mesh: this.createWitchMesh(i),
        dead: false,
      };
      witch.mesh.position.set(x, groundHeight(world, x, z), z);
      witch.mesh.userData.witch = witch;
      this.group.add(witch.mesh);
      this.witches.push(witch);
    }
  }

  update(delta, player, world) {
    const dt = Math.min(delta || 0, 0.08);
    this.elapsed += dt;

    if (this._authority === 'server') {
      const now = performance.now();
      for (const witch of this.witches) {
        if (witch.dead || !witch.serverOwned) continue;
        _interpServerEntity(witch, now);
      }
      return;
    }

    const playerPos = getWorldPosition(player, this.tmpPlayer);

    for (const witch of this.witches) {
      if (witch.dead) continue;

      let speedFactor = 1;
      if (witch.slowTimer > 0) {
        witch.slowTimer -= dt;
        speedFactor = witch.slowFactor ?? 1;
        if (witch.slowTimer <= 0) this._clearSlowTint(witch);
      }
      if (witch.liftTimer > 0) {
        witch.liftTimer -= dt;
        continue; // tornado controls it
      }

      this.tmpDir.set(playerPos.x - witch.mesh.position.x, 0, playerPos.z - witch.mesh.position.z);
      const distance = this.tmpDir.length();
      if (distance > 0.0001) {
        this.tmpDir.normalize();
        witch.mesh.rotation.y = Math.atan2(this.tmpDir.x, this.tmpDir.z);
      }

      // Kite, keeping more distance than skeletons.
      let move = 0;
      if (distance > this.keepMax) move = 1;
      else if (distance < this.keepMin) move = -1;
      if (move !== 0) {
        const nextX = THREE.MathUtils.clamp(witch.mesh.position.x + this.tmpDir.x * witch.speed * speedFactor * dt * move, this.bounds.minX, this.bounds.maxX);
        const nextZ = THREE.MathUtils.clamp(witch.mesh.position.z + this.tmpDir.z * witch.speed * speedFactor * dt * move, this.bounds.minZ, this.bounds.maxZ);
        if (groundHeight(world, nextX, nextZ) - witch.mesh.position.y <= 1.1) {
          witch.mesh.position.x = nextX;
          witch.mesh.position.z = nextZ;
        }
      }
      witch.mesh.position.y = groundHeight(world, witch.mesh.position.x, witch.mesh.position.z);

      witch.throwTimer -= dt;
      if (witch.throwTimer <= 0) {
        const target = this.healTargetProvider ? this.healTargetProvider(witch.mesh.position) : null;
        if (target) {
          this.throwPotion(witch, target);
          witch.throwTimer = this.throwCooldown;
        } else {
          witch.throwTimer = 0.6; // retry soon
        }
      }
    }

    this.updatePotions(dt);
  }

  throwPotion(witch, targetPos) {
    const start = witch.mesh.position.clone();
    start.y += 1.4;
    // Ballistic arc that lands on the target at time T (gravity 22).
    const gravity = 22;
    const dx = targetPos.x - start.x;
    const dy = targetPos.y - start.y;
    const dz = targetPos.z - start.z;
    const dist = Math.hypot(dx, dz);
    const T = Math.max(0.6, dist / 12);
    const velocity = new THREE.Vector3(dx / T, dy / T + 0.5 * gravity * T, dz / T);

    const mesh = new THREE.Group();
    const liquid = new THREE.Mesh(this.geometry.potion, this.material.potion);
    const cork = new THREE.Mesh(this.geometry.cork, this.material.cork);
    cork.position.y = 0.15;
    mesh.add(liquid, cork);
    mesh.position.copy(start);
    this.group.add(mesh);

    this.potions.push({ position: start.clone(), velocity, target: targetPos.clone(), mesh, life: 4 });
  }

  updatePotions(delta) {
    for (let i = this.potions.length - 1; i >= 0; i -= 1) {
      const potion = this.potions[i];
      potion.life -= delta;
      potion.velocity.y -= 22 * delta; // gravity
      potion.position.addScaledVector(potion.velocity, delta);
      potion.mesh.position.copy(potion.position);
      potion.mesh.rotation.x += delta * 6;

      const reached = potion.position.distanceTo(potion.target) < 1.5;
      const grounded = potion.position.y <= potion.target.y + 0.3;
      const blocked = this._blocked(potion.position);
      if (reached || grounded || blocked || potion.life <= 0 || potion.position.y < -4) {
        this.events.push({ type: 'heal', position: potion.position.clone(), radius: this.healRadius, amount: this.healAmount });
        this.group.remove(potion.mesh);
        this.potions.splice(i, 1);
      }
    }
  }

  _blocked(position) {
    if (!this.world || typeof this.world.getBlock !== 'function') return false;
    const type = this.world.getBlock(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    return Boolean(type) && type !== 'water';
  }

  consumeEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  // --- damage / status / hit support (mirrors the other managers) -----------
  // Server-authority: never mutate HP locally; the next snapshot resolves it.
  damageWitch(witch, amount) {
    if (this._authority === 'server') return false;
    witch.health = Math.max(0, witch.health - amount);
    if (witch.health <= 0) {
      this.killWitch(witch);
      return true;
    }
    return false;
  }

  peekRay(ray) {
    const isRaycaster = typeof ray?.intersectObjects === 'function' && ray.ray;
    const raycaster = isRaycaster ? ray : this.tmpRaycaster;
    if (!isRaycaster) {
      if (ray?.origin && ray?.direction) { raycaster.ray.copy(ray); raycaster.near = 0; raycaster.far = Infinity; } else return null;
    }
    const meshes = [];
    for (const w of this.witches) if (!w.dead) w.mesh.traverse((c) => { if (c.isMesh) meshes.push(c); });
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const root = hits[0].object.userData.witchRoot;
    const witch = this.witches.find((c) => c.mesh === root);
    if (!witch || witch.dead) return null;
    return { witch, point: hits[0].point.clone(), distance: hits[0].distance };
  }

  applyRayHit(peek, damage) {
    const killed = this.damageWitch(peek.witch, damage);
    return { dragon: null, witch: peek.witch, point: peek.point, distance: peek.distance, killed, health: peek.witch.health };
  }

  hitByRay(ray, damage = 25) {
    const peek = this.peekRay(ray);
    return peek ? this.applyRayHit(peek, damage) : null;
  }

  hitAllByRay(ray, damage = 25) {
    const isRaycaster = typeof ray?.intersectObjects === 'function' && ray.ray;
    const raycaster = isRaycaster ? ray : this.tmpRaycaster;
    if (!isRaycaster) {
      if (ray?.origin && ray?.direction) { raycaster.ray.copy(ray); raycaster.near = 0; raycaster.far = Infinity; } else return [];
    }
    const meshes = [];
    for (const w of this.witches) if (!w.dead) w.mesh.traverse((c) => { if (c.isMesh) meshes.push(c); });
    const hits = raycaster.intersectObjects(meshes, false);
    const results = [];
    const seen = new Set();
    for (const intersection of hits) {
      const root = intersection.object.userData.witchRoot;
      const witch = this.witches.find((c) => c.mesh === root);
      if (!witch || witch.dead || seen.has(witch.id)) continue;
      seen.add(witch.id);
      const killed = this.damageWitch(witch, damage);
      results.push({ dragon: null, witch, point: intersection.point.clone(), distance: intersection.distance, killed, health: witch.health });
    }
    return results;
  }

  hitMelee(origin, direction, range, damage, arcCos = 0.3) {
    const results = [];
    for (const witch of this.witches) {
      if (witch.dead) continue;
      this.tmpDir.subVectors(witch.mesh.position, origin);
      const distance = this.tmpDir.length();
      if (distance > range || distance < 0.0001) continue;
      this.tmpDir.normalize();
      if (this.tmpDir.dot(direction) < arcCos) continue;
      const killed = this.damageWitch(witch, damage);
      results.push({ position: witch.mesh.position.clone(), killed });
    }
    return results;
  }

  hitBox(origin, forward, right, length, halfWidth, damage) {
    const results = [];
    const v = new THREE.Vector3();
    for (const witch of this.witches) {
      if (witch.dead) continue;
      v.subVectors(witch.mesh.position, origin);
      const f = v.dot(forward);
      const lateral = Math.abs(v.dot(right));
      if (f < -1 || f > length || lateral > halfWidth || Math.abs(v.y) > 5) continue;
      const killed = this.damageWitch(witch, damage);
      results.push({ position: witch.mesh.position.clone(), killed });
    }
    return results;
  }

  knockback(center, radius, force, world) {
    for (const witch of this.witches) {
      if (witch.dead) continue;
      const dx = witch.mesh.position.x - center.x;
      const dz = witch.mesh.position.z - center.z;
      const dist = Math.hypot(dx, dz);
      if (dist > radius || dist < 0.0001) continue;
      const inv = 1 / dist;
      const nx = THREE.MathUtils.clamp(witch.mesh.position.x + dx * inv * force, this.bounds.minX, this.bounds.maxX);
      const nz = THREE.MathUtils.clamp(witch.mesh.position.z + dz * inv * force, this.bounds.minZ, this.bounds.maxZ);
      witch.mesh.position.set(nx, groundHeight(world, nx, nz), nz);
    }
  }

  slow(center, radius, factor, duration) {
    for (const witch of this.witches) {
      if (witch.dead) continue;
      const dx = witch.mesh.position.x - center.x;
      const dz = witch.mesh.position.z - center.z;
      if (Math.hypot(dx, dz) > radius) continue;
      witch.slowTimer = duration;
      witch.slowFactor = factor;
      this._applySlowTint(witch);
    }
  }

  _applySlowTint(witch) {
    witch.mesh.traverse((child) => {
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

  _clearSlowTint(witch) {
    witch.slowTimer = 0;
    witch.mesh.traverse((child) => {
      if (child.isMesh && child.userData.baseMat) child.material = child.userData.baseMat;
    });
  }

  tornadoPull(center, radius, elapsed) {
    for (const witch of this.witches) {
      if (witch.dead) continue;
      const dx = center.x - witch.mesh.position.x;
      const dz = center.z - witch.mesh.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > radius) continue;
      witch.liftTimer = 0.2;
      const angle = elapsed * 6 + witch.id;
      const orbit = Math.min(dist, radius * 0.5);
      witch.mesh.position.x = center.x + Math.cos(angle) * orbit;
      witch.mesh.position.z = center.z + Math.sin(angle) * orbit;
      witch.mesh.position.y = center.y + 1.5 + (Math.sin(elapsed * 3 + witch.id) * 0.5 + 1) * 2.5;
      witch.mesh.rotation.y = angle;
    }
  }

  heal(center, radius, amount) {
    for (const witch of this.witches) {
      if (witch.dead) continue;
      if (witch.mesh.position.distanceTo(center) > radius) continue;
      witch.health = Math.min(witch.maxHealth, witch.health + amount);
    }
  }

  killWitch(witch) {
    witch.dead = true;
    witch.mesh.visible = false;
    this.group.remove(witch.mesh);
    this.kills += 1;
  }

  clearWitches() {
    for (const witch of this.witches) this.group.remove(witch.mesh);
    this.witches.length = 0;
    for (const potion of this.potions) this.group.remove(potion.mesh);
    this.potions.length = 0;
  }

  consumeKills() {
    const kills = this.kills;
    this.kills = 0;
    return kills;
  }

  getAliveCount() {
    let count = 0;
    for (const w of this.witches) if (!w.dead) count += 1;
    return count;
  }

  // --- server authority (multiplayer) --------------------------------------

  setAuthority(mode) {
    const next = mode === 'server' ? 'server' : 'local';
    if (next === this._authority) return;
    this._authority = next;
    if (next === 'server') {
      this.clearWitches();
    } else {
      this.clearServerEntities();
    }
  }

  applyServerEnemy(snap) {
    if (this._authority !== 'server' || !snap || snap.id === undefined || snap.id === null) return;
    let entity = this._serverEntities.get(snap.id);
    if (!entity) {
      const mesh = this.createWitchMesh(this._serverEntities.size);
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
        throwTimer: Infinity,
      };
      mesh.userData.witch = entity;
      this.group.add(mesh);
      this.witches.push(entity);
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
    const idx = this.witches.indexOf(entity);
    if (idx >= 0) this.witches.splice(idx, 1);
    return true;
  }

  clearServerEntities() {
    for (const entity of this._serverEntities.values()) {
      entity.dead = true;
      this.group.remove(entity.mesh);
      const idx = this.witches.indexOf(entity);
      if (idx >= 0) this.witches.splice(idx, 1);
    }
    this._serverEntities.clear();
  }

  dispose() {
    if (this.group.parent) this.group.parent.remove(this.group);
    this.clearWitches();
    this.clearServerEntities();
    for (const geometry of Object.values(this.geometry)) geometry.dispose();
    for (const material of Object.values(this.material)) material.dispose();
  }
}

export default WitchManager;
