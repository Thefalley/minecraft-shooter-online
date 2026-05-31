import * as THREE from 'three';

const DEFAULT_BOUNDS = { minX: -22, maxX: 22, minZ: -22, maxZ: 22 };

// Snapshot interpolation tuning for server-driven entities. Matches the
// RemotePlayerMesh pattern: render ~120ms in the past so we always have two
// real samples bracketing the playback time.
const SERVER_SNAPSHOT_BUFFER = 8;
const SERVER_INTERP_DELAY_MS = 120;

function _pushServerSnap(buffer, snap) {
  const now = performance.now();
  const last = buffer[buffer.length - 1];
  if (last && last.t >= now) return; // drop dupes / out-of-order
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
  if (typeof world?.getGroundHeight === 'function') {
    return world.getGroundHeight(x, z);
  }
  return fallback;
}

export class ZombieManager {
  constructor(scene = null, options = {}) {
    this.scene = scene?.isScene ? scene : null;
    this.camera = options.camera ?? null;
    this.group = new THREE.Group();
    this.group.name = 'ZombieManager';
    this.zombies = [];
    this.events = [];
    this.elapsed = 0;

    // Training-ground damage dummy.
    this.dummy = null;
    this.dummyLabel = null;
    this.dummyTimer = 0;
    this._lastDummyValue = -1;
    this.tmpQuaternion = new THREE.Quaternion();

    this.bounds = { ...DEFAULT_BOUNDS, ...(options.bounds ?? {}) };
    this.health = options.health ?? 30;
    this.speed = options.speed ?? 3.4;
    this.damage = options.damage ?? 8;
    this.attackRange = options.attackRange ?? 2.3;
    this.attackCooldown = options.attackCooldown ?? 1.1;
    this.spawnRadiusMin = options.spawnRadiusMin ?? 14;
    this.spawnRadiusMax = options.spawnRadiusMax ?? 24;

    this.tmpPlayer = new THREE.Vector3();
    this.tmpDir = new THREE.Vector3();
    this.tmpRaycaster = new THREE.Raycaster();

    // Multiplayer: 'server' disables local AI/spawn and switches update() to
    // pure snapshot interpolation. Default 'local' preserves singleplayer.
    this._authority = 'local';
    this._serverEntities = new Map(); // id -> zombie wrapper (serverOwned=true)

    this.geometry = {
      body: new THREE.BoxGeometry(0.8, 1.3, 0.5),
      head: new THREE.BoxGeometry(0.6, 0.6, 0.6),
      arm: new THREE.BoxGeometry(0.22, 0.9, 0.22),
    };
    this.material = {
      body: new THREE.MeshStandardMaterial({ color: 0x4f7a3a, roughness: 0.95, flatShading: true }),
      head: new THREE.MeshStandardMaterial({ color: 0x6fae54, roughness: 0.95, flatShading: true }),
    };

    if (this.scene) this.scene.add(this.group);
  }

  createZombieMesh(index) {
    const zombie = new THREE.Group();
    zombie.name = `Zombie_${index}`;

    const body = new THREE.Mesh(this.geometry.body, this.material.body);
    body.position.y = 0.65;
    body.castShadow = true;
    zombie.add(body);

    const head = new THREE.Mesh(this.geometry.head, this.material.head);
    head.position.y = 1.6;
    head.castShadow = true;
    zombie.add(head);

    // Outstretched arms so it reads as a zombie shambling forward.
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(this.geometry.arm, this.material.body);
      arm.position.set(side * 0.5, 0.95, 0.35);
      arm.rotation.x = -Math.PI / 2.2;
      zombie.add(arm);
    }

    zombie.traverse((child) => {
      if (child.isMesh) child.userData.zombieRoot = zombie;
    });

    return zombie;
  }

  spawnWave(count, player, world) {
    this.clearZombies();
    const center = getWorldPosition(player, this.tmpPlayer);

    for (let i = 0; i < count; i += 1) {
      const angle = (i / Math.max(1, count)) * Math.PI * 2 + (i * 1.7);
      const radius = THREE.MathUtils.lerp(this.spawnRadiusMin, this.spawnRadiusMax, (i % 3) / 2);
      const x = THREE.MathUtils.clamp(center.x + Math.cos(angle) * radius, this.bounds.minX, this.bounds.maxX);
      const z = THREE.MathUtils.clamp(center.z + Math.sin(angle) * radius, this.bounds.minZ, this.bounds.maxZ);

      const zombie = {
        id: i,
        health: this.health,
        maxHealth: this.health,
        speed: this.speed * (0.85 + (i % 4) * 0.08),
        damage: this.damage,
        attackTimer: 0.6 + (i % 5) * 0.15,
        mesh: this.createZombieMesh(i),
        dead: false,
      };
      zombie.mesh.position.set(x, groundHeight(world, x, z), z);
      zombie.mesh.userData.zombie = zombie;
      this.group.add(zombie.mesh);
      this.zombies.push(zombie);
    }
  }

  spawnTrainingGround(player, world) {
    this.clearZombies();
    const center = getWorldPosition(player, this.tmpPlayer);
    const yaw = player?.cameraHolder?.rotation?.y ?? 0;
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    const rows = 3;
    const perRow = 9;
    const lateral = 1.8;
    const rowGap = 4; // 4 blocks between rows
    const startDist = 6;

    let id = 0;
    for (let r = 0; r < rows; r += 1) {
      const dist = startDist + r * rowGap;
      for (let i = 0; i < perRow; i += 1) {
        const off = (i - (perRow - 1) / 2) * lateral;
        const x = center.x + forwardX * dist + rightX * off;
        const z = center.z + forwardZ * dist + rightZ * off;
        this._spawnStaticZombie(id, x, z, yaw, world, false);
        id += 1;
      }
    }

    // Invincible damage dummy, set apart to the side.
    const dummyX = center.x + forwardX * 8 + rightX * 13;
    const dummyZ = center.z + forwardZ * 8 + rightZ * 13;
    this.dummy = this._spawnStaticZombie(id, dummyX, dummyZ, yaw, world, true);
    this.dummyTimer = 0;
    this._lastDummyValue = -1;
    this.dummyLabel = this._createDummyLabel();
  }

  _spawnStaticZombie(id, x, z, yaw, world, isDummy) {
    const cx = THREE.MathUtils.clamp(x, this.bounds.minX, this.bounds.maxX);
    const cz = THREE.MathUtils.clamp(z, this.bounds.minZ, this.bounds.maxZ);
    const zombie = {
      id,
      health: isDummy ? Infinity : this.health,
      maxHealth: isDummy ? Infinity : this.health,
      speed: 0,
      damage: 0,
      attackTimer: Infinity,
      static: true,
      dummy: isDummy,
      damageAccum: 0,
      mesh: this.createZombieMesh(id),
      dead: false,
    };
    zombie.mesh.position.set(cx, groundHeight(world, cx, cz), cz);
    zombie.mesh.rotation.y = yaw + Math.PI; // face the player
    zombie.mesh.userData.zombie = zombie;

    if (isDummy) {
      // Tint it gold so it reads as the special meter dummy.
      zombie.mesh.traverse((child) => {
        if (child.isMesh) {
          child.material = child.material.clone();
          child.material.color.setHex(0xd9b44a);
        }
      });
    }

    this.group.add(zombie.mesh);
    this.zombies.push(zombie);
    return zombie;
  }

  _createDummyLabel() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 2), material);
    mesh.renderOrder = 1001;
    mesh.frustumCulled = false;
    mesh.userData.canvas = canvas;
    mesh.userData.texture = texture;
    this.group.add(mesh);
    return mesh;
  }

  _drawDummyLabel(value) {
    const canvas = this.dummyLabel.userData.canvas;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 128);
    ctx.fillStyle = 'rgba(8, 12, 16, 0.6)';
    ctx.fillRect(8, 8, 240, 112);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffe066';
    ctx.font = 'bold 28px Arial';
    ctx.fillText('Daño (10s)', 128, 36);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 60px Arial';
    ctx.fillText(String(Math.round(value)), 128, 88);
    this.dummyLabel.userData.texture.needsUpdate = true;
  }

  _updateDummy(dt) {
    if (!this.dummy || this.dummy.dead || !this.dummyLabel) return;

    this.dummyTimer += dt;
    if (this.dummyTimer >= 10) {
      this.dummyTimer = 0;
      this.dummy.damageAccum = 0; // reset every 10 seconds
    }

    if (this.dummy.damageAccum !== this._lastDummyValue) {
      this._drawDummyLabel(this.dummy.damageAccum);
      this._lastDummyValue = this.dummy.damageAccum;
    }

    this.dummyLabel.position.copy(this.dummy.mesh.position);
    this.dummyLabel.position.y += 3.6;
    if (this.camera) {
      this.camera.getWorldQuaternion(this.tmpQuaternion);
      this.dummyLabel.quaternion.copy(this.tmpQuaternion);
    }
  }

  update(delta, player, world) {
    const dt = Math.min(delta || 0, 0.08);
    this.elapsed += dt;

    // Server-authoritative mode: no AI, no spawning, no attacks. Just
    // interpolate every server-owned visual toward its newest snapshot.
    // Bugfix: server entities live in _serverEntities (Map), NOT in
    // this.zombies (which is the local-AI pool, empty in MP). Iterate the
    // Map values so the interpolation actually runs.
    if (this._authority === 'server') {
      const now = performance.now();
      for (const zombie of this._serverEntities.values()) {
        if (zombie.dead || !zombie.serverOwned) continue;
        _interpServerEntity(zombie, now);
      }
      return;
    }

    const playerPos = getWorldPosition(player, this.tmpPlayer);
    const guardActive = Boolean(player?.guardActive);

    for (const zombie of this.zombies) {
      if (zombie.dead) continue;

      // Slow (mage blizzard): reduce speed and keep the frozen tint.
      let speedFactor = 1;
      if (zombie.slowTimer > 0) {
        zombie.slowTimer -= dt;
        speedFactor = zombie.slowFactor ?? 1;
        if (zombie.slowTimer <= 0) this._clearSlowTint(zombie);
      }

      // Lifted by the fire tornado: the tornado controls the position this frame.
      if (zombie.liftTimer > 0) {
        zombie.liftTimer -= dt;
        continue;
      }

      if (zombie.static) continue; // training dummies never move or attack

      this.tmpDir.set(playerPos.x - zombie.mesh.position.x, 0, playerPos.z - zombie.mesh.position.z);
      const distance = this.tmpDir.length();

      if (distance > 0.0001) {
        this.tmpDir.normalize();
        zombie.mesh.rotation.y = Math.atan2(this.tmpDir.x, this.tmpDir.z);
      }

      if (distance > this.attackRange) {
        const nextX = THREE.MathUtils.clamp(
          zombie.mesh.position.x + this.tmpDir.x * zombie.speed * speedFactor * dt,
          this.bounds.minX,
          this.bounds.maxX,
        );
        const nextZ = THREE.MathUtils.clamp(
          zombie.mesh.position.z + this.tmpDir.z * zombie.speed * speedFactor * dt,
          this.bounds.minZ,
          this.bounds.maxZ,
        );
        // Zombies can only step up one block. A taller wall blocks them in that
        // direction (they keep facing/trying, but can't pass).
        const nextGround = groundHeight(world, nextX, nextZ);
        if (nextGround - zombie.mesh.position.y <= 1.1) {
          zombie.mesh.position.x = nextX;
          zombie.mesh.position.z = nextZ;
        }
      }

      zombie.mesh.position.y = groundHeight(world, zombie.mesh.position.x, zombie.mesh.position.z);

      // shamble bob
      zombie.mesh.children[0].rotation.z = Math.sin(this.elapsed * 6 + zombie.id) * 0.08;

      zombie.attackTimer -= dt;
      if (distance <= this.attackRange && zombie.attackTimer <= 0) {
        if (guardActive) {
          // Parried: the zombie dies on the player's guard.
          this.killZombie(zombie);
          this.events.push({ type: 'parry', position: zombie.mesh.position.clone() });
        } else {
          this.events.push({ type: 'attack', position: zombie.mesh.position.clone(), damage: zombie.damage });
        }
        zombie.attackTimer = this.attackCooldown;
      }
    }

    this._updateDummy(dt);
  }

  // --- ranged hit support (guns) -------------------------------------------
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
    for (const zombie of this.zombies) {
      if (!zombie.dead) zombie.mesh.traverse((child) => { if (child.isMesh) meshes.push(child); });
    }

    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;

    const root = hits[0].object.userData.zombieRoot;
    const zombie = this.zombies.find((candidate) => candidate.mesh === root);
    if (!zombie || zombie.dead) return null;
    return { zombie, point: hits[0].point.clone(), distance: hits[0].distance };
  }

  // Applies damage. The invincible training dummy just tallies the damage.
  // In server-authority mode, the client never mutates HP — it just reports
  // "no kill" so the caller can still play the visual impact effect. The
  // real HP/kill resolution arrives via the next server snapshot (or a
  // future hit-pipeline event from the weapons agent).
  damageZombie(zombie, amount) {
    if (this._authority === 'server') return false;
    if (zombie.dummy) {
      zombie.damageAccum = (zombie.damageAccum || 0) + amount;
      return false;
    }
    zombie.health = Math.max(0, zombie.health - amount);
    if (zombie.health <= 0) {
      this.killZombie(zombie);
      return true;
    }
    return false;
  }

  applyRayHit(peek, damage) {
    const zombie = peek.zombie;
    const killed = this.damageZombie(zombie, damage);
    return {
      dragon: null,
      zombie,
      point: peek.point,
      distance: peek.distance,
      killed,
      health: zombie.health,
    };
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
    for (const zombie of this.zombies) {
      if (!zombie.dead) zombie.mesh.traverse((child) => { if (child.isMesh) meshes.push(child); });
    }

    const hits = raycaster.intersectObjects(meshes, false);
    const results = [];
    const seen = new Set();
    for (const intersection of hits) {
      const root = intersection.object.userData.zombieRoot;
      const zombie = this.zombies.find((candidate) => candidate.mesh === root);
      if (!zombie || zombie.dead || seen.has(zombie.id)) continue;
      seen.add(zombie.id);
      const killed = this.damageZombie(zombie, damage);
      results.push({ dragon: null, zombie, point: intersection.point.clone(), distance: intersection.distance, killed, health: zombie.health });
    }
    return results;
  }

  // --- status effects (mage) -----------------------------------------------
  slow(center, radius, factor, duration) {
    for (const zombie of this.zombies) {
      if (zombie.dead) continue;
      const dx = zombie.mesh.position.x - center.x;
      const dz = zombie.mesh.position.z - center.z;
      if (Math.hypot(dx, dz) > radius) continue;
      zombie.slowTimer = duration;
      zombie.slowFactor = factor;
      this._applySlowTint(zombie);
    }
  }

  _applySlowTint(zombie) {
    zombie.mesh.traverse((child) => {
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

  _clearSlowTint(zombie) {
    zombie.slowTimer = 0;
    zombie.mesh.traverse((child) => {
      if (child.isMesh && child.userData.baseMat) child.material = child.userData.baseMat;
    });
  }

  // Fire tornado: pull zombies in, lift and spin them while damaging over time.
  tornadoPull(center, radius, elapsed) {
    const lifted = [];
    for (const zombie of this.zombies) {
      if (zombie.dead || zombie.static) continue;
      const dx = center.x - zombie.mesh.position.x;
      const dz = center.z - zombie.mesh.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > radius) continue;
      zombie.liftTimer = 0.2; // keep it controlled by the tornado
      const angle = elapsed * 6 + zombie.id;
      const orbit = Math.min(dist, radius * 0.5);
      zombie.mesh.position.x = center.x + Math.cos(angle) * orbit;
      zombie.mesh.position.z = center.z + Math.sin(angle) * orbit;
      zombie.mesh.position.y = center.y + 1.5 + (Math.sin(elapsed * 3 + zombie.id) * 0.5 + 1) * 2.5;
      zombie.mesh.rotation.y = angle;
      lifted.push(zombie);
    }
    return lifted;
  }

  // --- melee hit support (sword) -------------------------------------------
  hitMelee(origin, direction, range, damage, arcCos = 0.3) {
    const results = [];
    for (const zombie of this.zombies) {
      if (zombie.dead) continue;
      this.tmpDir.subVectors(zombie.mesh.position, origin);
      const distance = this.tmpDir.length();
      if (distance > range || distance < 0.0001) continue;
      this.tmpDir.normalize();
      if (this.tmpDir.dot(direction) < arcCos) continue;
      const killed = this.damageZombie(zombie, damage);
      results.push({ position: zombie.mesh.position.clone(), killed });
    }
    return results;
  }

  hitBox(origin, forward, right, length, halfWidth, damage) {
    const results = [];
    const v = new THREE.Vector3();
    for (const zombie of this.zombies) {
      if (zombie.dead) continue;
      v.subVectors(zombie.mesh.position, origin);
      const f = v.dot(forward);
      const lateral = Math.abs(v.dot(right));
      if (f < -1 || f > length || lateral > halfWidth || Math.abs(v.y) > 5) continue;
      const killed = this.damageZombie(zombie, damage);
      results.push({ position: zombie.mesh.position.clone(), killed });
    }
    return results;
  }

  knockback(center, radius, force, world) {
    for (const zombie of this.zombies) {
      if (zombie.dead || zombie.static) continue;
      const dx = zombie.mesh.position.x - center.x;
      const dz = zombie.mesh.position.z - center.z;
      const dist = Math.hypot(dx, dz);
      if (dist > radius || dist < 0.0001) continue;
      const inv = 1 / dist;
      const nx = THREE.MathUtils.clamp(zombie.mesh.position.x + dx * inv * force, this.bounds.minX, this.bounds.maxX);
      const nz = THREE.MathUtils.clamp(zombie.mesh.position.z + dz * inv * force, this.bounds.minZ, this.bounds.maxZ);
      zombie.mesh.position.set(nx, groundHeight(world, nx, nz), nz);
    }
  }

  heal(center, radius, amount) {
    for (const zombie of this.zombies) {
      if (zombie.dead || zombie.dummy) continue;
      if (zombie.mesh.position.distanceTo(center) > radius) continue;
      zombie.health = Math.min(zombie.maxHealth, zombie.health + amount);
    }
  }

  killZombie(zombie) {
    zombie.dead = true;
    zombie.mesh.visible = false;
    this.group.remove(zombie.mesh);
    this.kills = (this.kills ?? 0) + 1;
  }

  consumeKills() {
    const kills = this.kills ?? 0;
    this.kills = 0;
    return kills;
  }

  clearZombies() {
    for (const zombie of this.zombies) {
      this.group.remove(zombie.mesh);
    }
    this.zombies.length = 0;

    if (this.dummyLabel) {
      this.group.remove(this.dummyLabel);
      this.dummyLabel.userData.texture?.dispose?.();
      this.dummyLabel.material?.dispose?.();
      this.dummyLabel.geometry?.dispose?.();
      this.dummyLabel = null;
    }
    this.dummy = null;
    this.dummyTimer = 0;
    this._lastDummyValue = -1;
  }

  getAliveCount() {
    let count = 0;
    for (const zombie of this.zombies) if (!zombie.dead) count += 1;
    return count;
  }

  consumeEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  // --- server authority (multiplayer) --------------------------------------

  /**
   * Switch between singleplayer ('local') and multiplayer ('server') modes.
   * - 'local': existing AI runs unchanged.
   * - 'server': update() becomes a no-op for AI; only server-driven entities
   *   render, animated by interpolation between snapshots.
   *
   * Side effect: changing modes clears any entities that belong to the
   * opposite mode so the scene stays consistent.
   */
  setAuthority(mode) {
    const next = mode === 'server' ? 'server' : 'local';
    if (next === this._authority) return;
    this._authority = next;
    if (next === 'server') {
      // Drop any locally-spawned zombies that were left around so the player
      // only sees server-broadcast enemies.
      this.clearZombies();
    } else {
      // Returning to singleplayer — toss any server-driven visuals.
      this.clearServerEntities();
    }
  }

  /**
   * Upsert a server-broadcast zombie. Called by EnemySync on enemySpawn /
   * enemyState. The first call for an id spawns the visual; subsequent
   * calls just push to its interpolation buffer.
   */
  applyServerEnemy(snap) {
    if (this._authority !== 'server' || !snap || snap.id === undefined || snap.id === null) return;
    let entity = this._serverEntities.get(snap.id);
    if (!entity) {
      const mesh = this.createZombieMesh(this._serverEntities.size);
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
        // Locally-required AI fields that hit code reads — defaults are fine
        // because no AI runs in server mode.
        speed: 0,
        damage: 0,
        attackTimer: Infinity,
      };
      mesh.userData.zombie = entity;
      this.group.add(mesh);
      this.zombies.push(entity);
      this._serverEntities.set(snap.id, entity);
    }
    if (snap.health !== undefined) entity.health = snap.health;
    if (snap.maxHealth !== undefined) entity.maxHealth = snap.maxHealth;
    _pushServerSnap(entity._buffer, snap);
  }

  /**
   * Remove a server-broadcast zombie. Returns true if it owned that id.
   */
  removeServerEnemy(id) {
    if (id === undefined || id === null) return false;
    const entity = this._serverEntities.get(id);
    if (!entity) return false;
    entity.dead = true;
    entity.mesh.visible = false;
    this.group.remove(entity.mesh);
    this._serverEntities.delete(id);
    const idx = this.zombies.indexOf(entity);
    if (idx >= 0) this.zombies.splice(idx, 1);
    return true;
  }

  clearServerEntities() {
    for (const entity of this._serverEntities.values()) {
      entity.dead = true;
      this.group.remove(entity.mesh);
      const idx = this.zombies.indexOf(entity);
      if (idx >= 0) this.zombies.splice(idx, 1);
    }
    this._serverEntities.clear();
  }

  dispose() {
    if (this.group.parent) this.group.parent.remove(this.group);
    this.clearZombies();
    this.clearServerEntities();
    for (const geometry of Object.values(this.geometry)) geometry.dispose();
    for (const material of Object.values(this.material)) material.dispose();
  }
}

export default ZombieManager;
