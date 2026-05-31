import * as THREE from 'three';

const DEFAULT_DRAGON_COUNT = 3;
const FIREBALL_COLLISION_RADIUS = 1.15;

// Snapshot interpolation tuning for server-driven dragons (multiplayer).
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

function _interpServerDragon(entity, now) {
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

function lerpAngle(from, to, alpha) {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * THREE.MathUtils.clamp(alpha, 0, 1);
}

function getWorldPosition(target, fallback = new THREE.Vector3()) {
  if (!target) return fallback.set(0, 0, 0);
  if (target.isVector3) return fallback.copy(target);
  if (target.position?.isVector3) return fallback.copy(target.position);
  if (target.object?.position?.isVector3) return fallback.copy(target.object.position);
  if (typeof target.x === 'number' && typeof target.y === 'number' && typeof target.z === 'number') {
    return fallback.set(target.x, target.y, target.z);
  }
  return fallback.set(0, 0, 0);
}

export class DragonManager {
  constructor(sceneOrOptions = null, maybeOptions = {}) {
    const scene = sceneOrOptions?.isScene ? sceneOrOptions : null;
    const options = scene ? maybeOptions : sceneOrOptions || {};

    this.scene = scene;
    this.camera = options.camera ?? null;
    this.world = options.world ?? null;
    this.group = new THREE.Group();
    this.group.name = 'DragonManager';
    this.dragons = [];
    this.fireballs = [];
    this.impacts = [];
    this.bossProjectiles = []; // miniboss: ground balls, homing bolts, MG bullets
    this.fireZones = [];        // miniboss: burning ground hazards
    this.tmpPlayerPosition = new THREE.Vector3();
    this.tmpTarget = new THREE.Vector3();
    this.tmpDirection = new THREE.Vector3();
    this.tmpPreviousPosition = new THREE.Vector3();
    this.tmpRaycaster = new THREE.Raycaster();
    this.tmpQuaternion = new THREE.Quaternion();
    // Head-tracking scratch objects.
    this._headPos = new THREE.Vector3();
    this._headMatrix = new THREE.Matrix4();
    this._headWorldQuat = new THREE.Quaternion();
    this._headParentQuat = new THREE.Quaternion();
    // Rotates +X (head forward) onto -Z (lookAt forward).
    this._headForwardOffset = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    this._worldUp = new THREE.Vector3(0, 1, 0);
    this.elapsed = 0;

    // Multiplayer: 'server' disables orbit/fireball AI and switches update()
    // to pure snapshot interpolation. Default 'local'.
    this._authority = 'local';
    this._serverEntities = new Map();

    this.count = options.count ?? DEFAULT_DRAGON_COUNT;
    this.origin = options.origin?.isVector3 ? options.origin.clone() : new THREE.Vector3(0, 0, 0);
    this.spawnRadius = options.spawnRadius ?? 34;
    this.minAltitude = options.minAltitude ?? 13;
    this.maxAltitude = options.maxAltitude ?? 22;
    this.bounds = {
      minX: options.bounds?.minX ?? -22,
      maxX: options.bounds?.maxX ?? 22,
      minZ: options.bounds?.minZ ?? -22,
      maxZ: options.bounds?.maxZ ?? 22,
    };
    this.fireballDamage = options.fireballDamage ?? 14;
    this.fireballSpeed = options.fireballSpeed ?? 24;
    this.reflectDamage = options.reflectDamage ?? 100;

    this.createSharedAssets();
    this.spawnDragons(this.count);

    if (this.scene) {
      this.scene.add(this.group);
    }
  }

  createSharedAssets() {
    // A single unit cube is reused and scaled per part for a blocky,
    // Minecraft Ender-Dragon look.
    this.geometry = {
      box: new THREE.BoxGeometry(1, 1, 1),
      fireball: new THREE.SphereGeometry(0.42, 8, 6),
    };

    this.material = {
      body: new THREE.MeshStandardMaterial({ color: 0x23232e, roughness: 0.9, flatShading: true }),
      belly: new THREE.MeshStandardMaterial({ color: 0x33333f, roughness: 0.95, flatShading: true }),
      wing: new THREE.MeshStandardMaterial({
        color: 0x17171f,
        roughness: 0.95,
        flatShading: true,
        side: THREE.DoubleSide,
      }),
      spike: new THREE.MeshStandardMaterial({ color: 0x4a3a6a, roughness: 0.85, flatShading: true }),
      eye: new THREE.MeshStandardMaterial({ color: 0xcf7bff, emissive: 0x7a2fff, emissiveIntensity: 1.5, roughness: 0.4, flatShading: true }),
      fireball: new THREE.MeshStandardMaterial({
        color: 0xb44bff,
        emissive: 0x7a1fff,
        emissiveIntensity: 1.5,
        roughness: 0.55,
        flatShading: true,
      }),
      reflectedFireball: new THREE.MeshStandardMaterial({
        color: 0x54d2ff,
        emissive: 0x1f9bff,
        emissiveIntensity: 1.6,
        roughness: 0.5,
        flatShading: true,
      }),
    };
  }

  spawnDragons(count = DEFAULT_DRAGON_COUNT) {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      const altitude = THREE.MathUtils.lerp(this.minAltitude, this.maxAltitude, i / Math.max(1, count - 1));
      const dragon = {
        id: i,
        health: 100,
        maxHealth: 100,
        aggression: 0.58 + i * 0.13,
        angle,
        altitude,
        // Orbit radius oscillates so dragons drift in and out around the
        // player. Kept inside the map bounds (clamped in updateDragon too).
        orbitRadius: 10 + (i % 3) * 4,
        radiusAmplitude: 5 + (i % 3) * 2,
        radiusRate: 0.45 + (i % 4) * 0.16,
        radiusPhase: i * 1.3,
        speed: 0.24 + i * 0.035,
        attackCooldown: 1.5 + i * 0.55,
        mesh: this.createDragonMesh(i),
        healthBar: this.createHealthBar(),
        velocity: new THREE.Vector3(),
        dead: false,
      };

      dragon.mesh.position.set(
        this.origin.x + Math.cos(angle) * dragon.orbitRadius,
        altitude,
        this.origin.z + Math.sin(angle) * dragon.orbitRadius,
      );
      dragon.mesh.userData.dragon = dragon;
      this.group.add(dragon.mesh);
      this.group.add(dragon.healthBar);
      this.dragons.push(dragon);
    }
  }

  createHealthBar() {
    const width = 3;
    const height = 0.4;
    const group = new THREE.Group();

    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(width + 0.18, height + 0.18),
      new THREE.MeshBasicMaterial({
        color: 0x101418,
        transparent: true,
        opacity: 0.7,
        depthTest: false,
        side: THREE.DoubleSide,
      }),
    );
    bg.renderOrder = 998;
    bg.frustumCulled = false;

    const fillGeometry = new THREE.PlaneGeometry(1, height);
    fillGeometry.translate(0.5, 0, 0); // left-anchored unit quad
    const fill = new THREE.Mesh(
      fillGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x49d049,
        depthTest: false,
        side: THREE.DoubleSide,
      }),
    );
    fill.position.x = -width / 2;
    fill.scale.x = width;
    fill.position.z = 0.01;
    fill.renderOrder = 999;
    fill.frustumCulled = false;

    group.add(bg, fill);
    group.userData.fill = fill;
    group.userData.width = width;
    group.frustumCulled = false;
    return group;
  }

  clearDragons() {
    for (const dragon of this.dragons) {
      this.group.remove(dragon.mesh);
      if (dragon.healthBar) this.group.remove(dragon.healthBar);
    }
    this.dragons.length = 0;
    for (const p of this.bossProjectiles) this.group.remove(p.mesh);
    for (const z of this.fireZones) { this.group.remove(z.mesh); z.mesh.geometry.dispose?.(); z.material.dispose?.(); }
    this.bossProjectiles.length = 0;
    this.fireZones.length = 0;
  }

  spawnWave(count) {
    this.clearDragons();
    this.spawnDragons(Math.max(0, Math.floor(count)));
  }

  // Wave-5 miniboss: one big red dragon with far more HP that cycles attacks.
  spawnBoss(player, config) {
    this.bossConfig = config;
    this.material.bossBall = this.material.bossBall
      || new THREE.MeshStandardMaterial({ color: config.fire, emissive: config.fire, emissiveIntensity: 1.6, roughness: 0.5, flatShading: true });
    this.material.bossBolt = this.material.bossBolt
      || new THREE.MeshStandardMaterial({ color: 0xff7a2a, emissive: 0xff5a10, emissiveIntensity: 1.8, roughness: 0.5, flatShading: true });
    this.material.bossBullet = this.material.bossBullet
      || new THREE.MeshBasicMaterial({ color: 0xffd060 });

    const center = getWorldPosition(player, this.tmpPlayerPosition);
    const boss = {
      id: this.dragons.length,
      boss: true,
      health: config.health,
      maxHealth: config.health,
      aggression: 0.75,
      angle: 0,
      altitude: (this.minAltitude + this.maxAltitude) / 2,
      orbitRadius: 15,
      radiusAmplitude: 4,
      radiusRate: 0.4,
      radiusPhase: 0,
      speed: 0.5,
      attackCooldown: 0,
      attackTimer: 2,
      lastAttack: null,
      burst: null,
      mesh: this.createBossMesh(config),
      healthBar: this.createHealthBar(),
      velocity: new THREE.Vector3(),
      dead: false,
    };
    boss.mesh.position.set(center.x + 16, boss.altitude, center.z);
    boss.mesh.userData.dragon = boss;
    this.group.add(boss.mesh);
    this.group.add(boss.healthBar);
    this.dragons.push(boss);
    return boss;
  }

  createBossMesh(config) {
    const mesh = this.createDragonMesh(this.dragons.length);
    mesh.scale.setScalar(config.scale ?? 1.9);
    // Clone + tint to red so the other dragons keep their dark materials.
    mesh.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const m = child.material.clone();
      if (m.color) m.color.setHex(config.color ?? 0xb01818);
      if (m.emissive) { m.emissive.setHex(config.fire ?? 0xff3a10); m.emissiveIntensity = 0.6; }
      child.material = m;
      child.userData.dragonRoot = mesh; // keep the raycast root tag after cloning
    });
    return mesh;
  }

  _box(w, h, d, material = this.material.body, cast = true) {
    const mesh = new THREE.Mesh(this.geometry.box, material);
    mesh.scale.set(w, h, d);
    mesh.castShadow = cast;
    return mesh;
  }

  makeWing(side) {
    const wing = new THREE.Group();
    wing.name = side > 0 ? 'leftWing' : 'rightWing';
    wing.position.set(0.3, 0.95, side * 0.85);

    // Leading bone slanting back and out.
    const bone = this._box(0.35, 0.35, 3.2, this.material.body);
    bone.position.set(-0.4, 0.1, 1.6);
    wing.add(bone);

    // Big flat membrane panel.
    const membrane = this._box(2.6, 0.12, 3.0, this.material.wing, false);
    membrane.position.set(-1.4, 0, 1.5);
    wing.add(membrane);

    // Outer finger spikes.
    for (let i = 0; i < 3; i += 1) {
      const finger = this._box(0.16, 0.16, 1.0, this.material.wing, false);
      finger.position.set(-2.6, 0, 0.7 + i * 0.85);
      wing.add(finger);
    }

    if (side < 0) wing.scale.z = -1; // mirror the right wing
    return wing;
  }

  createDragonMesh(index) {
    const dragon = new THREE.Group();
    dragon.name = `EnderDragon_${index}`;

    // Torso + chest + belly.
    const torso = this._box(2.8, 1.5, 1.9);
    torso.position.set(-0.3, 0, 0);
    torso.receiveShadow = true;
    dragon.add(torso);
    const chest = this._box(1.7, 1.7, 2.0);
    chest.position.set(1.2, 0.15, 0);
    dragon.add(chest);
    const belly = this._box(2.6, 0.4, 1.5, this.material.belly, false);
    belly.position.set(0.2, -0.85, 0);
    dragon.add(belly);

    // Neck.
    const neck1 = this._box(1.1, 1.0, 1.0);
    neck1.position.set(2.2, 0.65, 0);
    dragon.add(neck1);
    const neck2 = this._box(0.95, 0.9, 0.85);
    neck2.position.set(3.0, 1.15, 0);
    dragon.add(neck2);

    // Head group (pivots at the neck so it can track the player). Its parts
    // extend along +X (the dragon's forward axis).
    const head = new THREE.Group();
    head.name = 'head';
    head.position.set(3.5, 1.45, 0);
    const skull = this._box(1.5, 1.2, 1.25);
    skull.position.set(0.6, 0.1, 0);
    head.add(skull);
    const snout = this._box(1.1, 0.5, 1.0);
    snout.position.set(1.55, 0.2, 0);
    head.add(snout);
    const jaw = this._box(1.15, 0.38, 1.0);
    jaw.position.set(1.5, -0.33, 0);
    head.add(jaw);
    for (const z of [0.55, -0.55]) {
      const eye = this._box(0.42, 0.4, 0.28, this.material.eye, false);
      eye.position.set(0.9, 0.5, z);
      head.add(eye);
      const horn = this._box(0.28, 0.5, 0.28, this.material.spike, false);
      horn.position.set(0.35, 0.85, z * 0.8);
      horn.rotation.z = 0.3;
      head.add(horn);
    }
    dragon.add(head);

    // Spine spikes from neck to tail.
    for (const [sx, sh] of [[2.0, 0.55], [1.0, 0.55], [0.0, 0.5], [-1.0, 0.45]]) {
      const spike = this._box(0.3, sh, 0.3, this.material.spike, false);
      spike.position.set(sx, 1.05, 0);
      dragon.add(spike);
    }

    // Tapering, drooping tail with fins.
    const segs = [[1.0, 0.9, 0.9], [0.8, 0.75, 0.75], [0.6, 0.6, 0.6], [0.45, 0.45, 0.45], [0.32, 0.36, 0.36]];
    let tx = -1.7;
    let ty = -0.05;
    for (let i = 0; i < segs.length; i += 1) {
      const [w, h, d] = segs[i];
      const seg = this._box(w, h, d);
      seg.position.set(tx, ty, 0);
      dragon.add(seg);
      const fin = this._box(0.16, 0.4, 0.16, this.material.spike, false);
      fin.position.set(tx, ty + h * 0.5 + 0.18, 0);
      dragon.add(fin);
      tx -= (w * 0.5 + (segs[i + 1]?.[0] ?? 0.3) * 0.5) + 0.05;
      ty -= 0.13;
    }

    // Four stubby legs.
    for (const [lx, lz] of [[1.1, 0.85], [1.1, -0.85], [-0.8, 0.85], [-0.8, -0.85]]) {
      const leg = this._box(0.5, 0.95, 0.5);
      leg.position.set(lx, -0.95, lz);
      dragon.add(leg);
    }

    // Wings.
    dragon.add(this.makeWing(1));
    dragon.add(this.makeWing(-1));

    dragon.traverse((child) => {
      if (child.isMesh) child.userData.dragonRoot = dragon;
    });

    return dragon;
  }

  update(delta, player = null, scene = null) {
    if (scene && !this.scene) {
      this.scene = scene;
      this.scene.add(this.group);
    }

    const dt = Math.min(delta || 0, 0.08);
    this.elapsed += dt;

    // Server-authoritative mode: no orbit AI, no fireballs, no health bars.
    // Just interpolate every server-owned dragon mesh toward its newest snap.
    // (Health-bar/fireball visuals will return when the dedicated dragon
    // schema fields and the dragonFireball event pipeline land.)
    if (this._authority === 'server') {
      const now = performance.now();
      // Bugfix: server dragons live in _serverEntities, not in this.dragons.
      for (const dragon of this._serverEntities.values()) {
        if (dragon.dead || !dragon.serverOwned) continue;
        _interpServerDragon(dragon, now);
      }
      return;
    }

    const playerPosition = getWorldPosition(player, this.tmpPlayerPosition);

    for (const dragon of this.dragons) {
      if (dragon.dead) continue;
      this.updateDragon(dragon, dt, playerPosition);
      if (dragon.boss) this.updateBoss(dragon, dt, player, playerPosition);
      else this.tryFireball(dragon, dt, player, playerPosition);
      this.updateHealthBar(dragon);
    }

    this.updateFireballs(dt, player, playerPosition);
    this.updateBossProjectiles(dt, player, playerPosition);
    this.updateFireZones(dt, player, playerPosition);
  }

  updateDragon(dragon, delta, playerPosition) {
    let speedFactor = 1;
    if (dragon.slowTimer > 0) {
      dragon.slowTimer -= delta;
      speedFactor = dragon.slowFactor ?? 1;
      if (dragon.slowTimer <= 0) this._clearSlowTint(dragon);
    }
    dragon.angle += dragon.speed * speedFactor * delta;
    const orbitCenter = playerPosition.lengthSq() > 0.001 ? playerPosition : this.origin;

    // Radius breathes in and out so the dragon circles the player, sometimes
    // swooping closer and sometimes pulling away.
    const radius = dragon.orbitRadius
      + Math.sin(this.elapsed * dragon.radiusRate + dragon.radiusPhase) * dragon.radiusAmplitude;
    const bob = Math.sin(this.elapsed * 2.5 + dragon.id * 1.7) * 1.6;

    const targetX = orbitCenter.x + Math.cos(dragon.angle) * radius;
    const targetZ = orbitCenter.z + Math.sin(dragon.angle) * radius;

    this.tmpTarget.set(
      THREE.MathUtils.clamp(targetX, this.bounds.minX, this.bounds.maxX),
      dragon.altitude + bob,
      THREE.MathUtils.clamp(targetZ, this.bounds.minZ, this.bounds.maxZ),
    );

    this.tmpPreviousPosition.copy(dragon.mesh.position);
    dragon.mesh.position.lerp(this.tmpTarget, Math.min(1, delta * (0.75 + dragon.aggression)));
    dragon.velocity.subVectors(dragon.mesh.position, this.tmpPreviousPosition);

    // The body mostly faces the player so it never turns far away from them.
    const dxp = playerPosition.x - dragon.mesh.position.x;
    const dzp = playerPosition.z - dragon.mesh.position.z;
    if (dxp * dxp + dzp * dzp > 0.0001) {
      const faceYaw = Math.atan2(-dzp, dxp);
      dragon.mesh.rotation.y = lerpAngle(dragon.mesh.rotation.y, faceYaw, delta * 3);
    }
    dragon.mesh.rotation.z = THREE.MathUtils.clamp(-dragon.velocity.y * 0.18, -0.35, 0.35);

    const flap = Math.sin(this.elapsed * 12 + dragon.id) * 0.55;
    const leftWing = dragon.mesh.getObjectByName('leftWing');
    const rightWing = dragon.mesh.getObjectByName('rightWing');
    if (leftWing && rightWing) {
      leftWing.rotation.x = flap;
      rightWing.rotation.x = -flap;
    }

    // The head tracks the player, but only within 30 degrees of the body so it
    // looks natural.
    dragon.mesh.updateMatrixWorld();
    const head = dragon.mesh.getObjectByName('head');
    if (head) {
      head.getWorldPosition(this._headPos);
      this.tmpDirection.subVectors(playerPosition, this._headPos);
      if (this.tmpDirection.lengthSq() > 0.0001) {
        this.tmpDirection.normalize();
        dragon.mesh.getWorldQuaternion(this._headParentQuat);
        this.tmpDirection.applyQuaternion(this._headParentQuat.invert()); // to dragon-local space
        const limit = Math.PI / 6; // 30 degrees
        const localYaw = Math.atan2(-this.tmpDirection.z, this.tmpDirection.x);
        const localPitch = Math.asin(THREE.MathUtils.clamp(this.tmpDirection.y, -1, 1));
        head.rotation.set(
          0,
          THREE.MathUtils.clamp(localYaw, -limit, limit),
          THREE.MathUtils.clamp(localPitch, -limit, limit),
        );
      }
    }
  }

  updateHealthBar(dragon) {
    const bar = dragon.healthBar;
    if (!bar) return;

    bar.position.copy(dragon.mesh.position);
    bar.position.y += 3.3;

    if (this.camera) {
      this.camera.getWorldQuaternion(this.tmpQuaternion);
      bar.quaternion.copy(this.tmpQuaternion);
    }

    const ratio = THREE.MathUtils.clamp(dragon.health / dragon.maxHealth, 0, 1);
    const fill = bar.userData.fill;
    fill.scale.x = bar.userData.width * ratio;
    fill.visible = ratio > 0;
    fill.material.color.setHex(ratio > 0.5 ? 0x49d049 : ratio > 0.25 ? 0xe0c020 : 0xd83b3b);
  }

  tryFireball(dragon, delta, player, playerPosition) {
    if (!player) return;

    dragon.attackCooldown -= delta;
    const distanceToPlayer = dragon.mesh.position.distanceTo(playerPosition);
    const attackRange = 52 * dragon.aggression;
    if (dragon.attackCooldown > 0 || distanceToPlayer > attackRange) return;

    this.tmpDirection.subVectors(playerPosition, dragon.mesh.position).normalize();
    if (this.tmpDirection.lengthSq() === 0) return;

    const fireball = new THREE.Mesh(this.geometry.fireball, this.material.fireball);
    fireball.name = 'DragonFireball';
    fireball.position.copy(dragon.mesh.position).addScaledVector(this.tmpDirection, 2.9);
    fireball.userData.velocity = this.tmpDirection.clone().multiplyScalar(this.fireballSpeed);
    fireball.userData.life = 3.25;
    fireball.userData.damage = this.fireballDamage;
    fireball.userData.owner = dragon;
    this.group.add(fireball);
    this.fireballs.push(fireball);

    dragon.attackCooldown = THREE.MathUtils.lerp(3.2, 1.35, dragon.aggression);
  }

  _fireballBlocked(position) {
    if (!this.world || typeof this.world.getBlock !== 'function') return false;
    const type = this.world.getBlock(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    return Boolean(type) && type !== 'water';
  }

  updateFireballs(delta, player, playerPosition) {
    for (let i = this.fireballs.length - 1; i >= 0; i -= 1) {
      const fireball = this.fireballs[i];
      const data = fireball.userData;
      data.life -= delta;

      // Reflected fireballs home back toward the dragon that fired them.
      if (data.reflected) {
        const target = data.homingTarget;
        if (!target || target.dead || data.life <= 0 || fireball.position.y < -2) {
          this.group.remove(fireball);
          this.fireballs.splice(i, 1);
          continue;
        }

        this.tmpDirection.subVectors(target.mesh.position, fireball.position);
        const distance = this.tmpDirection.length();
        if (distance > 0.0001) this.tmpDirection.normalize();
        const speed = data.velocity.length() || this.fireballSpeed;
        data.velocity.lerp(this.tmpDirection.multiplyScalar(speed), Math.min(1, delta * 6));
        fireball.position.addScaledVector(data.velocity, delta);
        fireball.rotation.x += delta * 9;

        if (this._fireballBlocked(fireball.position)) {
          this.impacts.push({ position: fireball.position.clone(), damage: 0, hitPlayer: false });
          this.group.remove(fireball);
          this.fireballs.splice(i, 1);
          continue;
        }

        if (distance <= FIREBALL_COLLISION_RADIUS + 1.4) {
          target.health = Math.max(0, target.health - data.damage);
          const killed = target.health <= 0;
          if (killed) this.killDragon(target);
          this.impacts.push({ position: fireball.position.clone(), damage: 0, hitPlayer: false, hitDragon: true, killed });
          this.group.remove(fireball);
          this.fireballs.splice(i, 1);
        }
        continue;
      }

      fireball.position.addScaledVector(data.velocity, delta);
      fireball.rotation.x += delta * 8;
      fireball.rotation.y += delta * 5;

      // Terrain blocks the fireball.
      if (this._fireballBlocked(fireball.position)) {
        this.impacts.push({ position: fireball.position.clone(), damage: 0, hitPlayer: false });
        this.group.remove(fireball);
        this.fireballs.splice(i, 1);
        continue;
      }

      const hitPlayer = Boolean(player) && fireball.position.distanceTo(playerPosition) <= FIREBALL_COLLISION_RADIUS;
      const expired = data.life <= 0 || fireball.position.y < -2;

      // Parry: a raised guard reflects the fireball back at its owner dragon.
      if (hitPlayer && player?.guardActive && data.owner && !data.owner.dead) {
        data.reflected = true;
        data.homingTarget = data.owner;
        data.damage = this.reflectDamage;
        data.life = 4;
        this.tmpDirection.subVectors(data.owner.mesh.position, fireball.position).normalize();
        data.velocity.copy(this.tmpDirection).multiplyScalar(this.fireballSpeed * 1.3);
        fireball.material = this.material.reflectedFireball;
        this.impacts.push({ position: fireball.position.clone(), damage: 0, hitPlayer: false, reflected: true });
        continue;
      }

      if (hitPlayer || expired) {
        this.impacts.push({ position: fireball.position.clone(), damage: data.damage, hitPlayer });
        this.group.remove(fireball);
        this.fireballs.splice(i, 1);
      }
    }
  }

  // --- miniboss attack cycle --------------------------------------------------
  updateBoss(dragon, dt, player, playerPos) {
    if (!player) return;
    const cfg = this.bossConfig;

    // A machine-gun burst in progress: emit one bullet per sub-interval.
    if (dragon.burst) {
      dragon.burst.timer -= dt;
      if (dragon.burst.timer <= 0) {
        this._bossBullet(dragon, playerPos, cfg.machinegun);
        dragon.burst.left -= 1;
        dragon.burst.timer = cfg.machinegun.interval;
        if (dragon.burst.left <= 0) dragon.burst = null;
      }
      return;
    }

    dragon.attackTimer -= dt;
    if (dragon.attackTimer > 0) return;

    // Rotate between attacks semi-randomly (no immediate repeat).
    const choices = ['ground', 'homing', 'machinegun'].filter((a) => a !== dragon.lastAttack);
    const attack = choices[Math.floor(Math.random() * choices.length)];
    dragon.lastAttack = attack;
    const [lo, hi] = cfg.attackEvery;
    dragon.attackTimer = lo + Math.random() * (hi - lo);

    if (attack === 'ground') {
      for (let i = 0; i < cfg.ground.count; i += 1) this._bossGround(dragon, playerPos, cfg.ground, i);
    } else if (attack === 'homing') {
      for (let i = 0; i < cfg.homing.count; i += 1) this._bossHoming(dragon, playerPos, cfg.homing);
    } else {
      dragon.burst = { left: cfg.machinegun.burst, timer: 0 };
    }
  }

  _bossProjectile(material, scale, position) {
    const mesh = new THREE.Mesh(this.geometry.fireball, material);
    mesh.scale.setScalar(scale);
    mesh.position.copy(position);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  _bossGround(dragon, playerPos, cfg, i) {
    const target = playerPos.clone();
    target.x += (Math.random() - 0.5) * 5 + i * 1.6;
    target.z += (Math.random() - 0.5) * 5;
    target.y = this.world?.getGroundHeight?.(target.x, target.z) ?? (playerPos.y - 1);
    const from = dragon.mesh.position.clone();
    const dir = target.clone().sub(from);
    if (dir.lengthSq() < 0.0001) return;
    dir.normalize();
    const mesh = this._bossProjectile(this.material.bossBall, 2.4, from);
    this.bossProjectiles.push({ type: 'ground', mesh, position: from, velocity: dir.multiplyScalar(cfg.speed), targetY: target.y, life: 5, damage: cfg.damage, radius: 1.3, cfg });
  }

  _bossHoming(dragon, playerPos, cfg) {
    const from = dragon.mesh.position.clone();
    const dir = playerPos.clone().sub(from).normalize();
    dir.x += (Math.random() - 0.5) * 0.25;
    dir.y += (Math.random() - 0.5) * 0.15;
    dir.z += (Math.random() - 0.5) * 0.25;
    dir.normalize();
    const mesh = this._bossProjectile(this.material.bossBolt, 0.7, from);
    this.bossProjectiles.push({ type: 'homing', mesh, position: from, velocity: dir.multiplyScalar(cfg.speed), speed: cfg.speed, turn: cfg.turn, life: cfg.life, damage: cfg.damage, radius: cfg.radius });
  }

  _bossBullet(dragon, playerPos, cfg) {
    const from = dragon.mesh.position.clone();
    const dir = playerPos.clone().sub(from).normalize();
    dir.x += (Math.random() - 0.5) * cfg.spread;
    dir.y += (Math.random() - 0.5) * cfg.spread;
    dir.z += (Math.random() - 0.5) * cfg.spread;
    dir.normalize();
    const mesh = this._bossProjectile(this.material.bossBullet, 0.32, from);
    this.bossProjectiles.push({ type: 'bullet', mesh, position: from, velocity: dir.multiplyScalar(cfg.speed), life: cfg.life, damage: cfg.damage, radius: cfg.radius });
  }

  updateBossProjectiles(dt, player, playerPos) {
    for (let i = this.bossProjectiles.length - 1; i >= 0; i -= 1) {
      const p = this.bossProjectiles[i];
      p.life -= dt;

      if (p.type === 'homing' && player) {
        this.tmpDirection.subVectors(playerPos, p.position);
        if (this.tmpDirection.lengthSq() > 0.0001) {
          this.tmpDirection.normalize().multiplyScalar(p.speed);
          p.velocity.lerp(this.tmpDirection, Math.min(1, dt * p.turn));
        }
      }

      p.position.addScaledVector(p.velocity, dt);
      p.mesh.position.copy(p.position);

      const blocked = this._fireballBlocked(p.position); // terrain = cover
      const hitPlayer = Boolean(player) && p.position.distanceTo(playerPos) <= p.radius + 0.6;

      if (p.type === 'ground' && (blocked || p.position.y <= p.targetY || hitPlayer)) {
        this.spawnFireZone(p.position.clone(), p.cfg);
        this.impacts.push({ position: p.position.clone(), damage: hitPlayer ? p.damage : 0, hitPlayer, kind: 'explosion' });
        this._removeBossProjectile(i);
      } else if (hitPlayer) {
        this.impacts.push({ position: p.position.clone(), damage: p.damage, hitPlayer: true, kind: 'spark' });
        this._removeBossProjectile(i);
      } else if (blocked || p.life <= 0 || p.position.y < -2) {
        if (blocked && p.type === 'homing') this.impacts.push({ position: p.position.clone(), damage: 0, hitPlayer: false, kind: 'spark' });
        this._removeBossProjectile(i);
      }
    }
  }

  _removeBossProjectile(i) {
    this.group.remove(this.bossProjectiles[i].mesh);
    this.bossProjectiles.splice(i, 1);
  }

  spawnFireZone(position, cfg) {
    position.y = this.world?.getGroundHeight?.(position.x, position.z) ?? position.y;
    const geometry = new THREE.CircleGeometry(cfg.zoneRadius, 28);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ color: 0xff5a18, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.position.y += 0.06;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.fireZones.push({ mesh, material, position: position.clone(), radius: cfg.zoneRadius, dps: cfg.zoneDps, ttl: cfg.zoneTtl, age: 0, tick: 0, tickRate: cfg.tickRate });
  }

  updateFireZones(dt, player, playerPos) {
    for (let i = this.fireZones.length - 1; i >= 0; i -= 1) {
      const z = this.fireZones[i];
      z.age += dt;
      z.tick -= dt;
      z.material.opacity = 0.28 + 0.32 * (0.7 + 0.3 * Math.sin(this.elapsed * 14 + i)) * THREE.MathUtils.clamp(1 - z.age / z.ttl, 0, 1);
      if (z.tick <= 0 && player) {
        z.tick = z.tickRate;
        const dx = playerPos.x - z.position.x;
        const dz = playerPos.z - z.position.z;
        if (Math.hypot(dx, dz) <= z.radius && Math.abs(playerPos.y - z.position.y) < 3) {
          this.impacts.push({ position: playerPos.clone(), damage: z.dps * z.tickRate, hitPlayer: true, kind: 'fire' });
        }
      }
      if (z.age >= z.ttl) {
        this.group.remove(z.mesh);
        z.mesh.geometry.dispose();
        z.material.dispose();
        this.fireZones.splice(i, 1);
      }
    }
  }

  peekRay(ray) {
    if (!ray) return null;

    const isRaycaster = typeof ray.intersectObjects === 'function' && ray.ray;
    const raycaster = isRaycaster ? ray : this.tmpRaycaster;
    if (!isRaycaster) {
      if (ray.origin && ray.direction) {
        raycaster.ray.copy(ray);
      } else {
        return null;
      }
      raycaster.near = 0;
      raycaster.far = Infinity;
    }

    const meshes = [];
    for (const dragon of this.dragons) {
      if (!dragon.dead) {
        dragon.mesh.traverse((child) => {
          if (child.isMesh) meshes.push(child);
        });
      }
    }

    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;

    const root = hits[0].object.userData.dragonRoot;
    const dragon = this.dragons.find((candidate) => candidate.mesh === root);
    if (!dragon) return null;

    return { dragon, point: hits[0].point.clone(), distance: hits[0].distance };
  }

  applyRayHit(peek, damage) {
    const dragon = peek.dragon;
    // Server-authority: never mutate HP locally; the server / weapons-hit
    // pipeline owns that. We still return the hit info so the caller can
    // play impact / tracer effects.
    if (this._authority !== 'server') {
      dragon.health = Math.max(0, dragon.health - damage);
      if (dragon.health <= 0) {
        this.killDragon(dragon);
      }
    }
    return {
      dragon,
      point: peek.point,
      distance: peek.distance,
      killed: dragon.dead,
      health: dragon.health,
    };
  }

  hitByRay(ray, damage = 25) {
    const peek = this.peekRay(ray);
    return peek ? this.applyRayHit(peek, damage) : null;
  }

  hitMelee(origin, direction, range, damage, arcCos = 0.3) {
    const results = [];
    const toTarget = new THREE.Vector3();
    const serverMode = this._authority === 'server';
    for (const dragon of this.dragons) {
      if (dragon.dead) continue;
      toTarget.subVectors(dragon.mesh.position, origin);
      const distance = toTarget.length();
      if (distance > range || distance < 0.0001) continue;
      toTarget.normalize();
      if (toTarget.dot(direction) < arcCos) continue;
      let killed = false;
      if (!serverMode) {
        dragon.health = Math.max(0, dragon.health - damage);
        killed = dragon.health <= 0;
        if (killed) this.killDragon(dragon);
      }
      results.push({ position: dragon.mesh.position.clone(), killed });
    }
    return results;
  }

  hitAllByRay(ray, damage = 25) {
    if (!ray) return [];

    const isRaycaster = typeof ray.intersectObjects === 'function' && ray.ray;
    const raycaster = isRaycaster ? ray : this.tmpRaycaster;
    if (!isRaycaster) {
      if (ray.origin && ray.direction) {
        raycaster.ray.copy(ray);
      } else {
        return [];
      }
      raycaster.near = 0;
      raycaster.far = Infinity;
    }

    const meshes = [];
    for (const dragon of this.dragons) {
      if (!dragon.dead) {
        dragon.mesh.traverse((child) => {
          if (child.isMesh) meshes.push(child);
        });
      }
    }

    const hits = raycaster.intersectObjects(meshes, false);
    const results = [];
    const seen = new Set();

    const serverMode = this._authority === 'server';
    for (const intersection of hits) {
      const root = intersection.object.userData.dragonRoot;
      const dragon = this.dragons.find((candidate) => candidate.mesh === root);
      if (!dragon || dragon.dead || seen.has(dragon.id)) continue;

      seen.add(dragon.id);
      if (!serverMode) {
        dragon.health = Math.max(0, dragon.health - damage);
        if (dragon.health <= 0) {
          this.killDragon(dragon);
        }
      }

      results.push({
        dragon,
        point: intersection.point.clone(),
        distance: intersection.distance,
        killed: dragon.dead,
        health: dragon.health,
      });
    }

    return results;
  }

  hitBox(origin, forward, right, length, halfWidth, damage) {
    const results = [];
    const v = new THREE.Vector3();
    const serverMode = this._authority === 'server';
    for (const dragon of this.dragons) {
      if (dragon.dead) continue;
      v.subVectors(dragon.mesh.position, origin);
      const f = v.dot(forward);
      const lateral = Math.abs(v.dot(right));
      if (f < -1 || f > length || lateral > halfWidth || Math.abs(v.y) > 5) continue;
      let killed = false;
      if (!serverMode) {
        dragon.health = Math.max(0, dragon.health - damage);
        killed = dragon.health <= 0;
        if (killed) this.killDragon(dragon);
      }
      results.push({ position: dragon.mesh.position.clone(), killed });
    }
    return results;
  }

  knockback(center, radius, force) {
    for (const dragon of this.dragons) {
      if (dragon.dead) continue;
      const dx = dragon.mesh.position.x - center.x;
      const dz = dragon.mesh.position.z - center.z;
      const dist = Math.hypot(dx, dz);
      if (dist > radius || dist < 0.0001) continue;
      const inv = 1 / dist;
      dragon.mesh.position.x = THREE.MathUtils.clamp(dragon.mesh.position.x + dx * inv * force, this.bounds.minX, this.bounds.maxX);
      dragon.mesh.position.z = THREE.MathUtils.clamp(dragon.mesh.position.z + dz * inv * force, this.bounds.minZ, this.bounds.maxZ);
    }
  }

  slow(center, radius, factor, duration) {
    for (const dragon of this.dragons) {
      if (dragon.dead) continue;
      const dx = dragon.mesh.position.x - center.x;
      const dz = dragon.mesh.position.z - center.z;
      if (Math.hypot(dx, dz) > radius) continue;
      dragon.slowTimer = duration;
      dragon.slowFactor = factor;
      this._applySlowTint(dragon);
    }
  }

  _applySlowTint(dragon) {
    dragon.mesh.traverse((child) => {
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

  _clearSlowTint(dragon) {
    dragon.slowTimer = 0;
    dragon.mesh.traverse((child) => {
      if (child.isMesh && child.userData.baseMat) child.material = child.userData.baseMat;
    });
  }

  heal(center, radius, amount) {
    for (const dragon of this.dragons) {
      if (dragon.dead) continue;
      if (dragon.mesh.position.distanceTo(center) > radius) continue;
      dragon.health = Math.min(dragon.maxHealth, dragon.health + amount);
    }
  }

  killDragon(dragon) {
    dragon.dead = true;
    dragon.mesh.visible = false;
    this.group.remove(dragon.mesh);
    if (dragon.healthBar) this.group.remove(dragon.healthBar);
    this.kills = (this.kills ?? 0) + 1;
  }

  consumeKills() {
    const kills = this.kills ?? 0;
    this.kills = 0;
    return kills;
  }

  getAliveDragons() {
    return this.dragons.filter((dragon) => !dragon.dead);
  }

  // Glow every mesh red (or restore originals) — the "no-hit" threat marker.
  setHighlighted(on, color = 0xff2020) {
    for (const mat of Object.values(this.material)) {
      if (!mat || !mat.emissive) continue;
      if (mat.userData.baseEmissive === undefined) {
        mat.userData.baseEmissive = mat.emissive.getHex();
        mat.userData.baseEmissiveIntensity = mat.emissiveIntensity;
      }
      if (on) { mat.emissive.setHex(color); mat.emissiveIntensity = 0.85; }
      else { mat.emissive.setHex(mat.userData.baseEmissive); mat.emissiveIntensity = mat.userData.baseEmissiveIntensity; }
    }
  }

  getAliveCount() {
    return this.getAliveDragons().length;
  }

  consumeImpacts() {
    const impacts = this.impacts;
    this.impacts = [];
    return impacts;
  }

  // --- server authority (multiplayer) --------------------------------------

  setAuthority(mode) {
    const next = mode === 'server' ? 'server' : 'local';
    if (next === this._authority) return;
    this._authority = next;
    if (next === 'server') {
      // Drop the locally-spawned orbiting dragons and any in-flight fireballs
      // so the player only sees server-driven entities.
      this.clearDragons();
      for (const fireball of this.fireballs) this.group.remove(fireball);
      this.fireballs.length = 0;
    } else {
      this.clearServerEntities();
    }
  }

  /**
   * Upsert a server-broadcast dragon. The first call spawns the visual; later
   * calls push to its interpolation buffer.
   */
  applyServerDragon(snap) {
    if (this._authority !== 'server' || !snap || snap.id === undefined || snap.id === null) return;
    let dragon = this._serverEntities.get(snap.id);
    if (!dragon) {
      const mesh = this.createDragonMesh(this._serverEntities.size);
      mesh.position.set(snap.x, snap.y, snap.z);
      mesh.rotation.y = snap.rotationY ?? 0;
      dragon = {
        id: snap.id,
        serverOwned: true,
        health: snap.health ?? 100,
        maxHealth: snap.maxHealth ?? 100,
        mesh,
        // Health bar visuals only matter once we wire the server HP feed
        // through onChange. Built but kept hidden for now.
        healthBar: null,
        velocity: new THREE.Vector3(),
        dead: false,
        _buffer: [],
      };
      mesh.userData.dragon = dragon;
      this.group.add(mesh);
      this.dragons.push(dragon);
      this._serverEntities.set(snap.id, dragon);
    }
    if (snap.health !== undefined) dragon.health = snap.health;
    if (snap.maxHealth !== undefined) dragon.maxHealth = snap.maxHealth;
    _pushServerSnap(dragon._buffer, snap);
  }

  /**
   * Symmetric with the other managers: EnemySync calls this on any enemy
   * despawn since it doesn't always know the kind. Returns true if owned.
   */
  removeServerDragon(id) {
    if (id === undefined || id === null) return false;
    const dragon = this._serverEntities.get(id);
    if (!dragon) return false;
    dragon.dead = true;
    dragon.mesh.visible = false;
    this.group.remove(dragon.mesh);
    if (dragon.healthBar) this.group.remove(dragon.healthBar);
    this._serverEntities.delete(id);
    const idx = this.dragons.indexOf(dragon);
    if (idx >= 0) this.dragons.splice(idx, 1);
    return true;
  }

  // Alias to keep the EnemySync contract uniform across managers.
  removeServerEnemy(id) {
    return this.removeServerDragon(id);
  }

  clearServerEntities() {
    for (const dragon of this._serverEntities.values()) {
      dragon.dead = true;
      this.group.remove(dragon.mesh);
      if (dragon.healthBar) this.group.remove(dragon.healthBar);
      const idx = this.dragons.indexOf(dragon);
      if (idx >= 0) this.dragons.splice(idx, 1);
    }
    this._serverEntities.clear();
  }

  /**
   * Visual-only hook for the bridge's dragonFireball event. Stubbed: the
   * weapons-server-pipeline agent owns the actual projectile semantics. We
   * keep the method here so EnemySync can call it without a typecheck and
   * a future patch only needs to fill this in.
   */
  // eslint-disable-next-line no-unused-vars
  handleServerFireball(_payload) {
    // intentionally empty — visual stub
  }

  dispose() {
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
    for (const fireball of this.fireballs) {
      this.group.remove(fireball);
    }
    for (const p of this.bossProjectiles) this.group.remove(p.mesh);
    for (const z of this.fireZones) { this.group.remove(z.mesh); z.mesh.geometry.dispose(); z.material.dispose(); }
    this.fireballs.length = 0;
    this.bossProjectiles.length = 0;
    this.fireZones.length = 0;
    this.impacts.length = 0;
    this.dragons.length = 0;
    this._serverEntities.clear();

    for (const geometry of Object.values(this.geometry)) {
      geometry.dispose();
    }
    for (const material of Object.values(this.material)) {
      material.dispose();
    }
  }
}

export default DragonManager;
