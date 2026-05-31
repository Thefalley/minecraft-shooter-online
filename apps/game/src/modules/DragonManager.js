import * as THREE from 'three';

const DEFAULT_DRAGON_COUNT = 3;
const FIREBALL_COLLISION_RADIUS = 1.15;

// LOD distance thresholds (squared comparisons used in hot paths).
const LOD0_MAX_DISTANCE = 25;
const LOD1_MAX_DISTANCE = 60;
const LOD0_MAX_DISTANCE_SQ = LOD0_MAX_DISTANCE * LOD0_MAX_DISTANCE;
const LOD1_MAX_DISTANCE_SQ = LOD1_MAX_DISTANCE * LOD1_MAX_DISTANCE;
const HEALTHBAR_MAX_DISTANCE_SQ = 40 * 40;

// Module-scope scratch array reused across every raycast against dragons.
// Cleared at the top of each peek/hit; never re-allocated per shot.
const _INTERSECT_SCRATCH = [];

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

      // Cache per-LOD collision lists once at spawn so the raycast hot path
      // does not walk traverse() over every dragon group every shot. Each
      // LOD has its own list; updateDragon picks the active one based on
      // currentLOD. L2 is a flat billboard quad — still hittable so the
      // player can damage far dragons, just with a single mesh.
      dragon._lodMeshes = [[], [], []];
      // The lod* groups are stored on the Three.Group (dragon.mesh) created by
      // createDragonMesh, not on the wrapper object `dragon`. Confusing
      // because createDragonMesh's local variable is also called `dragon` —
      // there it refers to the Group. Access them via dragon.mesh.userData.
      const ud = dragon.mesh.userData;
      const lodGroups = [ud.lod0, ud.lod1, ud.lod2];
      for (let li = 0; li < lodGroups.length; li += 1) {
        const lodGroup = lodGroups[li];
        if (!lodGroup) continue; // defensive: skip if a LOD wasn't built
        lodGroup.traverse((obj) => {
          if (obj.isMesh && obj.userData.dragonRoot === dragon.mesh) {
            dragon._lodMeshes[li].push(obj);
          }
        });
      }
      // Active list (swapped by updateDragon when LOD changes). Starts at L0
      // because that's the visible LOD at spawn.
      dragon._collisionMeshes = dragon._lodMeshes[0];

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
    // The bar is camera-billboarded each frame to the dragon's head position,
    // so its bounding sphere is recomputed in-place and frustum culling can
    // safely reject it when offscreen. (Previous code forced frustumCulled to
    // false to dodge a flicker bug; we now hide the bar entirely past
    // HEALTHBAR_MAX_DISTANCE, which keeps it onscreen 99% of the time it's
    // visible at all.)
    bg.frustumCulled = true;

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
    fill.frustumCulled = true;

    group.add(bg, fill);
    group.userData.fill = fill;
    group.userData.width = width;
    // Group itself isn't culled by Three.js (only meshes are), so this flag
    // is a no-op — set to true for clarity.
    group.frustumCulled = true;
    return group;
  }

  clearDragons() {
    for (const dragon of this.dragons) {
      this.group.remove(dragon.mesh);
      if (dragon.healthBar) this.group.remove(dragon.healthBar);
    }
    this.dragons.length = 0;
  }

  spawnWave(count) {
    this.clearDragons();
    this.spawnDragons(Math.max(0, Math.floor(count)));
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

    // ----- LOD 0: full detailed mesh (active at distance < 25u). -----
    // Built directly on the dragon root so existing getObjectByName('head'),
    // getObjectByName('leftWing'/'rightWing') and traverse-based code paths
    // (slow tint, etc.) keep working without changes.
    const lod0 = new THREE.Group();
    lod0.name = 'LOD0';

    // Torso + chest + belly.
    const torso = this._box(2.8, 1.5, 1.9);
    torso.position.set(-0.3, 0, 0);
    torso.receiveShadow = true;
    lod0.add(torso);
    const chest = this._box(1.7, 1.7, 2.0);
    chest.position.set(1.2, 0.15, 0);
    lod0.add(chest);
    const belly = this._box(2.6, 0.4, 1.5, this.material.belly, false);
    belly.position.set(0.2, -0.85, 0);
    lod0.add(belly);

    // Neck.
    const neck1 = this._box(1.1, 1.0, 1.0);
    neck1.position.set(2.2, 0.65, 0);
    lod0.add(neck1);
    const neck2 = this._box(0.95, 0.9, 0.85);
    neck2.position.set(3.0, 1.15, 0);
    lod0.add(neck2);

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
    lod0.add(head);

    // Spine spikes from neck to tail.
    for (const [sx, sh] of [[2.0, 0.55], [1.0, 0.55], [0.0, 0.5], [-1.0, 0.45]]) {
      const spike = this._box(0.3, sh, 0.3, this.material.spike, false);
      spike.position.set(sx, 1.05, 0);
      lod0.add(spike);
    }

    // Tapering, drooping tail with fins.
    const segs = [[1.0, 0.9, 0.9], [0.8, 0.75, 0.75], [0.6, 0.6, 0.6], [0.45, 0.45, 0.45], [0.32, 0.36, 0.36]];
    let tx = -1.7;
    let ty = -0.05;
    for (let i = 0; i < segs.length; i += 1) {
      const [w, h, d] = segs[i];
      const seg = this._box(w, h, d);
      seg.position.set(tx, ty, 0);
      lod0.add(seg);
      const fin = this._box(0.16, 0.4, 0.16, this.material.spike, false);
      fin.position.set(tx, ty + h * 0.5 + 0.18, 0);
      lod0.add(fin);
      tx -= (w * 0.5 + (segs[i + 1]?.[0] ?? 0.3) * 0.5) + 0.05;
      ty -= 0.13;
    }

    // Four stubby legs.
    for (const [lx, lz] of [[1.1, 0.85], [1.1, -0.85], [-0.8, 0.85], [-0.8, -0.85]]) {
      const leg = this._box(0.5, 0.95, 0.5);
      leg.position.set(lx, -0.95, lz);
      lod0.add(leg);
    }

    // Wings live INSIDE lod0 so they hide automatically with the rest of the
    // detail mesh at far LODs. updateDragon already skips wing-flap and head
    // tracking when the active LOD isn't 0, so we don't waste those Matrix4
    // updates for a hidden mesh tree. getObjectByName('leftWing'/'rightWing')
    // still resolves through dragon.mesh because it walks descendants.
    const leftWing = this.makeWing(1);
    const rightWing = this.makeWing(-1);
    lod0.add(leftWing);
    lod0.add(rightWing);

    dragon.add(lod0);

    // ----- LOD 1: silhouette hull (active at 25 <= distance < 60). -----
    // A tiny stand-in mesh: body box + two wing planes + head box. Picks up
    // the same body/wing materials so it visually matches at a glance.
    const lod1 = new THREE.Group();
    lod1.name = 'LOD1';
    const lod1Body = this._box(4, 1.5, 2, this.material.body, false);
    lod1Body.position.set(0, 0, 0);
    lod1.add(lod1Body);
    const lod1Head = this._box(1.2, 1.0, 1.0, this.material.body, false);
    lod1Head.position.set(2.6, 0.6, 0);
    lod1.add(lod1Head);
    const lod1WingL = this._box(3, 0.1, 1.6, this.material.wing, false);
    lod1WingL.position.set(0, 0.6, 1.6);
    lod1.add(lod1WingL);
    const lod1WingR = this._box(3, 0.1, 1.6, this.material.wing, false);
    lod1WingR.position.set(0, 0.6, -1.6);
    lod1.add(lod1WingR);
    lod1.visible = false;
    dragon.add(lod1);

    // ----- LOD 2: billboard quad (active at distance >= 60). -----
    // Stub: a plain colored quad until a proper sprite atlas exists. It's
    // not pretty, but at this range it just needs to scream "dragon here".
    // The plane uses a per-dragon material instance (so each dragon can be a
    // different tint) and DoubleSide so we don't have to billboard it.
    const lod2 = new THREE.Group();
    lod2.name = 'LOD2';
    const billboardGeometry = new THREE.PlaneGeometry(2.4, 1.2);
    const billboardMaterial = new THREE.MeshBasicMaterial({
      color: 0x23232e,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
    });
    const billboard = new THREE.Mesh(billboardGeometry, billboardMaterial);
    billboard.position.set(0, 0.5, 0);
    lod2.add(billboard);
    lod2.visible = false;
    dragon.add(lod2);

    // Tag every mesh under the root with its parent dragon group so the
    // raycaster can resolve which dragon was hit from any LOD.
    dragon.traverse((child) => {
      if (child.isMesh) child.userData.dragonRoot = dragon;
    });

    // Expose LOD groups + per-LOD billboard refs for the update loop. Stored
    // on the THREE.Group itself so spawnDragons can read them without an extra
    // map.
    dragon.userData.lod0 = lod0;
    dragon.userData.lod1 = lod1;
    dragon.userData.lod2 = lod2;
    dragon.userData.lod2Material = billboardMaterial;
    dragon.userData.currentLOD = 0;

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
      for (const dragon of this.dragons) {
        if (dragon.dead || !dragon.serverOwned) continue;
        _interpServerDragon(dragon, now);
      }
      return;
    }

    const playerPosition = getWorldPosition(player, this.tmpPlayerPosition);

    for (const dragon of this.dragons) {
      if (dragon.dead) continue;
      this.updateDragon(dragon, dt, playerPosition);
      this.tryFireball(dragon, dt, player, playerPosition);
      this.updateHealthBar(dragon);
    }

    this.updateFireballs(dt, player, playerPosition);
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

    // LOD selection: based on planar distance to the player. Cheaper than
    // distanceTo() (no sqrt) and good enough — the player rarely sees a
    // dragon directly overhead.
    const dy = playerPosition.y - dragon.mesh.position.y;
    const distSq = dxp * dxp + dy * dy + dzp * dzp;
    let nextLOD;
    if (distSq < LOD0_MAX_DISTANCE_SQ) nextLOD = 0;
    else if (distSq < LOD1_MAX_DISTANCE_SQ) nextLOD = 1;
    else nextLOD = 2;

    // Same wrapper vs Group confusion as in spawnDragons: the LOD groups live
    // on the Three.Group (dragon.mesh), not on the wrapper.
    const ud = dragon.mesh.userData;
    if (ud.currentLOD !== nextLOD) {
      if (ud.lod0) ud.lod0.visible = nextLOD === 0;
      if (ud.lod1) ud.lod1.visible = nextLOD === 1;
      if (ud.lod2) ud.lod2.visible = nextLOD === 2;
      ud.currentLOD = nextLOD;
      // Swap the active collision-mesh list so raycasts only test the LOD
      // the player can see. Falls back to the L0 list if a list is empty.
      const lodList = dragon._lodMeshes[nextLOD];
      dragon._collisionMeshes = lodList && lodList.length > 0 ? lodList : dragon._lodMeshes[0];
    }

    // Wing flap and head tracking only matter for the detailed mesh — at L1
    // there are no wing/head sub-groups by name, and at L2 it's a quad. Skip
    // entirely when we're not on L0 to save the matrix work and getObjectByName
    // lookups.
    if (nextLOD === 0) {
      const flap = Math.sin(this.elapsed * 12 + dragon.id) * 0.55;
      const leftWing = dragon.mesh.getObjectByName('leftWing');
      const rightWing = dragon.mesh.getObjectByName('rightWing');
      if (leftWing && rightWing) {
        leftWing.rotation.x = flap;
        rightWing.rotation.x = -flap;
      }

      // The head tracks the player, but only within 30 degrees of the body so
      // it looks natural.
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
    } else if (nextLOD === 2) {
      // Billboard the L2 quad toward the camera. The quad lives inside the
      // dragon root which yaws to face the player, so we have to undo the
      // root's world rotation before applying the camera's: localQ =
      // parentWorldQ.invert() * cameraWorldQ. updateMatrixWorld() is needed
      // first because rotation.y was just changed.
      if (this.camera) {
        dragon.mesh.updateMatrixWorld();
        this.camera.getWorldQuaternion(this.tmpQuaternion);
        dragon.mesh.getWorldQuaternion(this._headParentQuat);
        ud.lod2.quaternion.copy(this._headParentQuat.invert()).multiply(this.tmpQuaternion);
      }
    }

    // Stash the squared distance for the health-bar update so we don't
    // recompute.
    dragon._distSqToPlayer = distSq;
  }

  updateHealthBar(dragon) {
    const bar = dragon.healthBar;
    if (!bar) return;

    // Hide the entire bar when the dragon is far away. Saves a billboard
    // matrix copy + two transparent draw calls per dragon. updateDragon
    // already computed the squared distance to the player; reuse it.
    const distSq = dragon._distSqToPlayer ?? 0;
    if (distSq > HEALTHBAR_MAX_DISTANCE_SQ) {
      if (bar.visible) bar.visible = false;
      return;
    }
    if (!bar.visible) bar.visible = true;

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

    // Build the intersect list from the per-dragon cached collision meshes
    // (populated at spawn time). No traverse() per shot. Reuse a single
    // module-scope scratch array so we don't allocate.
    _INTERSECT_SCRATCH.length = 0;
    for (let i = 0; i < this.dragons.length; i += 1) {
      const dragon = this.dragons[i];
      if (dragon.dead) continue;
      const cached = dragon._collisionMeshes;
      if (!cached) continue;
      for (let j = 0; j < cached.length; j += 1) {
        _INTERSECT_SCRATCH.push(cached[j]);
      }
    }

    const hits = raycaster.intersectObjects(_INTERSECT_SCRATCH, false);
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

    // Same cached-list strategy as peekRay — no traverse() at fire time.
    _INTERSECT_SCRATCH.length = 0;
    for (let i = 0; i < this.dragons.length; i += 1) {
      const dragon = this.dragons[i];
      if (dragon.dead) continue;
      const cached = dragon._collisionMeshes;
      if (!cached) continue;
      for (let j = 0; j < cached.length; j += 1) {
        _INTERSECT_SCRATCH.push(cached[j]);
      }
    }

    const hits = raycaster.intersectObjects(_INTERSECT_SCRATCH, false);
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
        // Default LOD list so peekRay/hitAllByRay's cached-mesh path works.
        _lodMeshes: [[], [], []],
        _collisionMeshes: [],
      };
      // Mirror the spawnDragons LOD-mesh caching so weapons can still raycast
      // against server-driven dragons even though no LOD switching runs.
      const ud = mesh.userData;
      const lodGroups = [ud.lod0, ud.lod1, ud.lod2];
      for (let li = 0; li < lodGroups.length; li += 1) {
        const lodGroup = lodGroups[li];
        if (!lodGroup) continue;
        lodGroup.traverse((obj) => {
          if (obj.isMesh && obj.userData.dragonRoot === mesh) {
            dragon._lodMeshes[li].push(obj);
          }
        });
      }
      dragon._collisionMeshes = dragon._lodMeshes[0];
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
  removeServerEnemy(id) {
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
    this.fireballs.length = 0;
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
