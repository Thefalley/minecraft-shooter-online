import * as THREE from 'three';

const DEFAULT_WEAPONS = [
  {
    name: 'Rifle',
    damage: 22,
    range: 90,
    fireRate: 8,
    clipSize: 30,
    reserveAmmo: 120,
    reloadTime: 1.4,
    pellets: 1,
    spread: 0.008,
    automatic: true,
    projectile: false,
    flashColor: 0xffd166,
  },
  {
    name: 'Shotgun',
    damage: 11,
    range: 42,
    fireRate: 1.35,
    clipSize: 8,
    reserveAmmo: 40,
    reloadTime: 1.85,
    pellets: 8,
    spread: 0.075,
    automatic: false,
    projectile: false,
    flashColor: 0xff9f1c,
  },
  {
    name: 'Blaster',
    damage: 36,
    range: 120,
    fireRate: 3.2,
    clipSize: 18,
    reserveAmmo: 72,
    reloadTime: 1.7,
    pellets: 1,
    spread: 0.004,
    automatic: true,
    projectile: true,
    projectileSpeed: 72,
    projectileRadius: 0.12,
    flashColor: 0x54d2ff,
  },
];

const UP = new THREE.Vector3(0, 1, 0);
const PROJECTILE_FORWARD = new THREE.Vector3(0, 0, -1);
const CALLBACK_NAMES = [
  'onAmmoChange',
  'onBeam',
  'onEmpty',
  'onFire',
  'onHit',
  'onMuzzleFlash',
  'onProjectileExpire',
  'onProjectileImpact',
  'onProjectileSpawn',
  'onReloadComplete',
  'onReloadStart',
  'onTracer',
  'onWeaponSwitch',
];

// ---------------------------------------------------------------------------
// Module-scope scratch Vector3 pool. Reused across every fire() call to keep
// the per-shot allocations out of the hot path. Each one has a single, fixed
// role; never read from two of them concurrently for different purposes.
//
// SAFETY: these vectors are passed into synchronous callbacks (onHit, onFire,
// onBeam, onMuzzleFlash, onProjectileImpact) whose Game.js implementations
// either read the components immediately or pass them to Effects.* helpers
// which clone (via resolvePosition) before storing — so it is safe to reuse
// the underlying Vector3 between calls. The ONLY exception is onTracer, whose
// Effects.tracer() stores the start/end vectors across multiple frames; for
// that path we still clone once per tracer (vs 5+ allocations before).
// ---------------------------------------------------------------------------
const _V_ORIGIN  = new THREE.Vector3();
const _V_DIR     = new THREE.Vector3();
const _V_END     = new THREE.Vector3();
const _V_POINT   = new THREE.Vector3();
const _V_NORMAL  = new THREE.Vector3();
const _V_TMP1    = new THREE.Vector3();
const _V_TMP2    = new THREE.Vector3();
const _V_SPREAD  = new THREE.Vector3();
const _V_CONE    = new THREE.Vector3();
const _V_RIGHT   = new THREE.Vector3();
const _V_UPAX    = new THREE.Vector3();
const _V_BEAMEND = new THREE.Vector3();
const _V_FLASHPOS = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Muzzle flash pool. We share one tiny SphereGeometry across all flashes (it
// would be wasteful to allocate a fresh geometry for each frame). Each Mesh
// has its OWN MeshBasicMaterial so the per-flash opacity fade still works.
// ---------------------------------------------------------------------------
const _FLASH_GEOM = new THREE.SphereGeometry(0.08, 8, 6);
const _FLASH_POOL_MAX = 6;
const _flashPool = []; // populated lazily

// Returns a pooled flash mesh, or null if the pool is exhausted (caller
// allocates fresh in that case — keeps behaviour correct without corrupting
// in-flight flashes' opacity fades).
function _acquireFlashMesh() {
  for (let i = 0; i < _flashPool.length; i += 1) {
    if (!_flashPool[i]._inUse) {
      _flashPool[i]._inUse = true;
      return _flashPool[i];
    }
  }
  if (_flashPool.length < _FLASH_POOL_MAX) {
    const mesh = new THREE.Mesh(
      _FLASH_GEOM,
      new THREE.MeshBasicMaterial({
        color: 0xffd166,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      }),
    );
    mesh.frustumCulled = false;
    mesh._pooled = true;
    mesh._inUse = true;
    _flashPool.push(mesh);
    return mesh;
  }
  return null;
}

function _releaseFlashMesh(mesh) {
  if (mesh) mesh._inUse = false;
}

// ---------------------------------------------------------------------------
// Projectile pool. Shared SphereGeometry; per-instance material so colour can
// match each weapon. Limited to 16; falls back to fresh allocation otherwise.
// Daggers and other custom-shape projectiles do NOT use the pool — they keep
// their old per-spawn allocation path.
// ---------------------------------------------------------------------------
const _PROJ_GEOM = new THREE.SphereGeometry(0.12, 10, 10);
const _PROJ_POOL_MAX = 16;
const _projPool = [];

function _acquireProjectileMesh() {
  for (let i = 0; i < _projPool.length; i += 1) {
    if (!_projPool[i]._inUse) {
      _projPool[i]._inUse = true;
      return _projPool[i];
    }
  }
  if (_projPool.length < _PROJ_POOL_MAX) {
    const mesh = new THREE.Mesh(
      _PROJ_GEOM,
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    mesh.frustumCulled = false;
    mesh._pooled = true;
    mesh._inUse = true;
    _projPool.push(mesh);
    return mesh;
  }
  return null; // signal to caller: pool exhausted, allocate
}

function _releaseProjectileMesh(mesh) {
  if (mesh) mesh._inUse = false;
}

export class Weapons {
  constructor(options = {}) {
    if (options?.isCamera || typeof options?.getWorldDirection === 'function') {
      options = { camera: options };
    }

    this.scene = options.scene ?? null;
    this.camera = options.camera ?? null;
    this.targets = options.targets ?? [];
    this.callbacks = { ...(options.callbacks ?? {}) };
    for (const name of CALLBACK_NAMES) {
      if (typeof options[name] === 'function') {
        this.callbacks[name] = options[name];
      }
    }
    this.raycaster = options.raycaster ?? new THREE.Raycaster();
    this.projectilesEnabled = options.projectilesEnabled ?? true;

    this.inventory = (options.weapons ?? DEFAULT_WEAPONS).map((weapon) => ({
      ...weapon,
      ammo: weapon.ammo ?? weapon.clipSize,
      reserveAmmo: weapon.reserveAmmo ?? 0,
      cooldownRemaining: 0,
      reloadRemaining: 0,
      isReloading: false,
    }));

    this.currentIndex = THREE.MathUtils.clamp(options.startIndex ?? 0, 0, this.inventory.length - 1);
    this.muzzleFlashes = [];
    this.projectiles = [];
    this._scratchStep = new THREE.Vector3();
    this._scratchProjDir = new THREE.Vector3();
  }

  get currentWeapon() {
    return this.inventory[this.currentIndex] ?? null;
  }

  getCurrentWeaponName() {
    return this.currentWeapon?.name ?? '';
  }

  getAmmoState(detailed = false) {
    const weapon = this.currentWeapon;
    if (!weapon) {
      return detailed
        ? { ammo: 0, maxAmmo: 0, reserveAmmo: 0, isReloading: false, reloadProgress: 0 }
        : 0;
    }

    const state = {
      ammo: weapon.ammo,
      currentAmmo: weapon.ammo,
      maxAmmo: weapon.clipSize,
      clipSize: weapon.clipSize,
      reserveAmmo: weapon.reserveAmmo,
      isReloading: weapon.isReloading,
      reloadProgress: weapon.isReloading
        ? 1 - weapon.reloadRemaining / Math.max(weapon.reloadTime, 0.001)
        : 0,
      weapon: weapon.name,
    };

    return detailed ? state : weapon.ammo;
  }

  update(delta) {
    const dt = Math.max(0, delta || 0);

    for (const weapon of this.inventory) {
      weapon.cooldownRemaining = Math.max(0, weapon.cooldownRemaining - dt);

      if (weapon.isReloading) {
        weapon.reloadRemaining = Math.max(0, weapon.reloadRemaining - dt);
        if (weapon.reloadRemaining === 0) {
          this._completeReload(weapon);
        }
      }
    }

    this._updateMuzzleFlashes(dt);
    this._updateProjectiles(dt);
  }

  fire(context = {}) {
    const weapon = this.currentWeapon;
    if (!weapon) return this._miss('no-weapon');

    if (weapon.isReloading) return this._miss('reloading', weapon);
    if (weapon.cooldownRemaining > 0) return this._miss('cooldown', weapon);

    if (weapon.ammo <= 0) {
      this._emit('onEmpty', { weapon, index: this.currentIndex });
      if (weapon.reserveAmmo > 0) this.reload();
      return this._miss('empty', weapon);
    }

    // _resolveShotTransform fills _V_ORIGIN and _V_DIR in place and returns
    // them — no allocations.
    this._resolveShotTransform(context);
    const origin = _V_ORIGIN;
    const direction = _V_DIR;
    const scene = context.scene ?? this.scene;
    const targets = context.targets ?? this.targets;
    const hits = [];

    if (!weapon.infiniteAmmo) weapon.ammo -= 1;
    weapon.cooldownRemaining = 1 / Math.max(weapon.fireRate, 0.001);

    this._spawnMuzzleFlash(origin, direction, weapon, context, scene);

    if (weapon.penetrate && context.penetrate !== false) {
      for (const payload of this._firePenetrating(origin, direction, weapon, { ...context, scene, targets })) {
        hits.push(payload);
      }
    } else if (weapon.projectile && this.projectilesEnabled && context.projectile !== false) {
      this._spawnProjectile(origin, direction, weapon, { ...context, scene, targets });
    } else {
      for (let i = 0; i < weapon.pellets; i += 1) {
        // pelletDirection is one of the module scratch vectors (_V_SPREAD or
        // _V_CONE). It is fully recomputed inside the helper each iteration,
        // consumed by the raycast + payload build below, and then reused next
        // iteration. We never need to retain the previous iteration's value.
        const pelletDirection = weapon.cone
          ? this._coneDirection(direction, weapon.spreadAngle ?? 0.2)
          : this._spreadDirection(direction, weapon.spread);
        const dragonHit = this._hitDragonManager(origin, pelletDirection, weapon, context.dragons, weapon.range);
        const hit = dragonHit ?? this._raycastHit(origin, pelletDirection, weapon.range, targets, context.ignore);
        // _V_END holds the tracer end-point. We compute it into scratch then
        // clone once for the onTracer callback (Effects.tracer retains the
        // vector across multiple frames, so it must be a fresh allocation).
        if (hit) {
          const payload = dragonHit
            ? this._buildDragonHitPayload(dragonHit, weapon, pelletDirection, origin, context)
            : this._buildHitPayload(hit, weapon, pelletDirection, origin, context);
          hits.push(payload);
          this._emit('onHit', payload);
          // payload.point is already a fresh Vector3 (cloned in
          // _buildHitPayload); copy into scratch for the tracer below.
          if (payload.point) {
            _V_END.copy(payload.point);
          } else {
            _V_END.copy(origin).addScaledVector(pelletDirection, weapon.range);
          }
        } else {
          _V_END.copy(origin).addScaledVector(pelletDirection, weapon.range);
        }
        // onTracer is UNSAFE-to-share: Effects.tracer stores origin/end
        // across multiple frames. So we clone once per tracer (was 2
        // allocations: origin.clone() + new endPoint; still 2 here, but the
        // 5+ vectors in the hit-payload path no longer leak into the tracer).
        this._emit('onTracer', {
          weapon,
          origin: origin.clone(),
          end: _V_END.clone(),
          color: weapon.tracerColor ?? weapon.flashColor ?? 0xffe08a,
        });
      }
    }

    // onFire payload: the receivers (Game.js, networking) read origin/direction
    // immediately and don't retain them, but to keep the public contract
    // identical we still clone for callers. These two clones could be removed
    // in a future pass if we verify no consumer retains them.
    const payload = {
      weapon,
      index: this.currentIndex,
      ammo: weapon.ammo,
      reserveAmmo: weapon.reserveAmmo,
      origin: origin.clone(),
      direction: direction.clone(),
      hits,
    };

    this._emit('onFire', payload);
    this._emit('onAmmoChange', payload);
    this.lastFireResult = { fired: true, ...payload };
    return this.lastFireResult;
  }

  reload() {
    const weapon = this.currentWeapon;
    if (!weapon) return false;
    if (weapon.isReloading || weapon.ammo >= weapon.clipSize || weapon.reserveAmmo <= 0) return false;

    weapon.isReloading = true;
    weapon.reloadRemaining = Math.max(0, weapon.reloadTime);
    this._emit('onReloadStart', { weapon, index: this.currentIndex });

    if (weapon.reloadRemaining === 0) {
      this._completeReload(weapon);
    }

    return true;
  }

  switchWeapon(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.inventory.length) {
      return false;
    }

    if (index === this.currentIndex) return true;

    const previousIndex = this.currentIndex;
    this.currentIndex = index;
    this._emit('onWeaponSwitch', {
      previousIndex,
      index,
      weapon: this.currentWeapon,
    });
    return true;
  }

  setTargets(targets) {
    this.targets = targets ?? [];
  }

  scaleDamage(factor) {
    for (const weapon of this.inventory) {
      weapon.damage *= factor;
    }
  }

  addAmmo(weaponName, amount) {
    const weapon = this.inventory.find((entry) => entry.name === weaponName);
    if (!weapon) return false;

    weapon.reserveAmmo += Math.max(0, amount || 0);
    this._emit('onAmmoChange', {
      weapon,
      index: this.inventory.indexOf(weapon),
      ammo: weapon.ammo,
      reserveAmmo: weapon.reserveAmmo,
    });
    return true;
  }

  _completeReload(weapon) {
    const needed = weapon.clipSize - weapon.ammo;
    const loaded = Math.min(needed, weapon.reserveAmmo);

    weapon.ammo += loaded;
    weapon.reserveAmmo -= loaded;
    weapon.isReloading = false;
    weapon.reloadRemaining = 0;

    const payload = {
      weapon,
      index: this.inventory.indexOf(weapon),
      ammo: weapon.ammo,
      reserveAmmo: weapon.reserveAmmo,
      loaded,
    };
    this._emit('onReloadComplete', payload);
    this._emit('onAmmoChange', payload);
  }

  // Fills _V_ORIGIN and _V_DIR in place. Returns them (caller reads from the
  // module scratch directly).
  _resolveShotTransform(context) {
    const camera = context.camera ?? this.camera;

    if (context.origin) {
      _V_ORIGIN.copy(context.origin);
    } else if (camera?.getWorldPosition) {
      camera.getWorldPosition(_V_ORIGIN);
    } else {
      _V_ORIGIN.set(0, 0, 0);
    }

    if (context.direction) {
      _V_DIR.copy(context.direction).normalize();
    } else if (camera?.getWorldDirection) {
      camera.getWorldDirection(_V_DIR).normalize();
    } else {
      _V_DIR.set(0, 0, -1);
    }

    return { origin: _V_ORIGIN, direction: _V_DIR };
  }

  // Returns a scratch Vector3 (_V_SPREAD) — caller must consume immediately.
  _spreadDirection(direction, spread) {
    if (!spread) {
      return _V_SPREAD.copy(direction);
    }

    _V_RIGHT.crossVectors(direction, UP);
    if (_V_RIGHT.lengthSq() < 0.0001) {
      _V_RIGHT.set(1, 0, 0);
    } else {
      _V_RIGHT.normalize();
    }

    _V_UPAX.crossVectors(_V_RIGHT, direction).normalize();

    const x = (Math.random() - 0.5) * spread;
    const y = (Math.random() - 0.5) * spread;
    return _V_SPREAD
      .copy(direction)
      .addScaledVector(_V_RIGHT, x)
      .addScaledVector(_V_UPAX, y)
      .normalize();
  }

  // Returns a scratch Vector3 (_V_CONE) — caller must consume immediately.
  _coneDirection(direction, halfAngle) {
    _V_RIGHT.crossVectors(direction, UP);
    if (_V_RIGHT.lengthSq() < 0.0001) {
      _V_RIGHT.set(1, 0, 0);
    } else {
      _V_RIGHT.normalize();
    }

    _V_UPAX.crossVectors(_V_RIGHT, direction).normalize();

    // Uniform sample inside the cone disc so pellets fan out evenly.
    const theta = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * Math.tan(halfAngle);
    const x = Math.cos(theta) * radius;
    const y = Math.sin(theta) * radius;

    return _V_CONE
      .copy(direction)
      .addScaledVector(_V_RIGHT, x)
      .addScaledVector(_V_UPAX, y)
      .normalize();
  }

  _raycastHit(origin, direction, range, targets, ignore) {
    const objects = this._normalizeTargets(targets).filter((target) => target !== ignore);
    if (objects.length === 0) return null;

    this.raycaster.set(origin, direction);
    this.raycaster.far = range;

    const hits = this.raycaster.intersectObjects(objects, true);
    return hits.find((hit) => hit.object !== ignore && !this._isChildOf(hit.object, ignore)) ?? null;
  }

  _buildHitPayload(hit, weapon, direction, origin, context) {
    // hit.point is the raycaster's internal Vector3, which gets reused on the
    // next .intersectObjects call. We must clone it. Same for direction/origin
    // which are module scratch — onHit consumers (Effects.impact) read them
    // synchronously, but we keep the clone to preserve the public contract
    // (other consumers may store them).
    return {
      weapon,
      index: this.currentIndex,
      target: hit.object,
      hit,
      point: hit.point.clone(),
      normal: hit.face?.normal?.clone() ?? null,
      distance: hit.distance,
      damage: weapon.damage,
      direction: direction.clone(),
      origin: origin.clone(),
      context,
    };
  }

  _hitDragonManager(origin, direction, weapon, dragons, range = weapon.range) {
    if (typeof dragons?.hitByRay !== 'function') return null;

    this.raycaster.set(origin, direction);
    this.raycaster.far = range;
    return dragons.hitByRay(this.raycaster, weapon.damage);
  }

  _buildDragonHitPayload(hit, weapon, direction, origin, context) {
    return {
      weapon,
      index: this.currentIndex,
      target: hit.dragon?.mesh ?? hit.dragon ?? null,
      dragon: hit.dragon,
      hit,
      point: hit.point?.clone?.() ?? null,
      normal: null,
      distance: hit.distance ?? null,
      damage: weapon.damage,
      killed: Boolean(hit.killed),
      health: hit.health,
      direction: direction.clone(),
      origin: origin.clone(),
      context,
    };
  }

  _firePenetrating(origin, direction, weapon, context) {
    const range = weapon.range;
    let maxDistance = range;
    // beamEnd is a single allocation per shot — Effects.beam stores it across
    // frames (similar to tracer).
    _V_BEAMEND.copy(origin).addScaledVector(direction, range);

    const world = context.world;
    if (world?.raycastBlock) {
      const worldHit = world.raycastBlock(origin, direction, range);
      if (worldHit) {
        maxDistance = worldHit.distance;
        if (worldHit.point) {
          _V_BEAMEND.copy(worldHit.point);
        } else {
          _V_BEAMEND.copy(origin).addScaledVector(direction, worldHit.distance);
        }
      }
    }

    const hits = [];
    const dragons = context.dragons;
    if (typeof dragons?.hitAllByRay === 'function') {
      this.raycaster.set(origin, direction);
      this.raycaster.near = 0;
      this.raycaster.far = maxDistance;
      for (const dragonHit of dragons.hitAllByRay(this.raycaster, weapon.damage)) {
        const payload = this._buildDragonHitPayload(dragonHit, weapon, direction, origin, context);
        hits.push(payload);
        this._emit('onHit', payload);
      }
    }

    // onBeam consumer (Effects.beam) retains origin/end → clone both, once.
    this._emit('onBeam', {
      weapon,
      origin: origin.clone(),
      end: _V_BEAMEND.clone(),
      color: weapon.flashColor ?? 0x54d2ff,
    });

    return hits;
  }

  _spawnMuzzleFlash(origin, direction, weapon, context, sceneOverride) {
    const scene = sceneOverride ?? context.scene ?? this.scene;
    const ttl = context.flashDuration ?? 0.055;
    // payload origin/direction clones preserved for callback contract.
    const payload = { weapon, origin: origin.clone(), direction: direction.clone(), ttl };

    if (scene?.add) {
      const color = weapon.flashColor ?? 0xffcc66;
      // No PointLight here: adding/removing lights forces Three to recompile
      // every material (a big FPS hitch when firing). The emissive glow mesh
      // alone reads as a muzzle flash.
      const pooled = _acquireFlashMesh();
      let glow;
      let isPooled;
      if (pooled) {
        glow = pooled;
        isPooled = true;
      } else {
        // Pool exhausted: allocate a one-off flash so the in-flight pooled
        // flashes finish their fades undisturbed.
        glow = new THREE.Mesh(
          new THREE.SphereGeometry(0.08, 8, 8),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.95,
            depthWrite: false,
          }),
        );
        isPooled = false;
      }
      glow.material.color.set(color);
      glow.material.opacity = 0.95;
      glow.material.transparent = true;
      glow.material.depthWrite = false;
      glow.scale.setScalar(1);
      _V_FLASHPOS.copy(origin).addScaledVector(direction, context.muzzleDistance ?? 0.7);
      glow.position.copy(_V_FLASHPOS);
      scene.add(glow);
      this.muzzleFlashes.push({ object: glow, material: glow.material, scene, ttl, maxTtl: ttl, pooled: isPooled });
      payload.object = glow;
    }

    this._emit('onMuzzleFlash', payload);
  }

  _spawnProjectile(origin, direction, weapon, context) {
    const scene = context.scene;
    const speed = weapon.projectileSpeed ?? 48;
    // The position / previousPosition / velocity Vector3s travel with the
    // projectile object for its whole lifetime (multiple frames), so they
    // MUST be fresh allocations — they cannot share module scratch.
    // Compute the start offset into a scratch first, then build the three
    // per-projectile Vector3s from it (down from 4 clones to 3 fresh).
    _V_TMP1.copy(origin).addScaledVector(direction, 0.8);
    const projectile = {
      weapon,
      position: _V_TMP1.clone(),
      previousPosition: _V_TMP1.clone(),
      velocity: direction.clone().multiplyScalar(speed),
      gravity: weapon.gravity ?? 0,
      remainingRange: weapon.range,
      targets: context.targets,
      dragons: context.dragons,
      world: context.world,
      ignore: context.ignore,
      scene,
      object: null,
      pooledMesh: false,
    };

    if (scene?.add) {
      const meshResult = this._createProjectileMesh(weapon);
      projectile.object = meshResult.mesh;
      projectile.pooledMesh = meshResult.pooled;
      projectile.object.position.copy(projectile.position);
      scene.add(projectile.object);
    }

    this.projectiles.push(projectile);
    this._emit('onProjectileSpawn', { weapon, projectile });
  }

  // Returns { mesh, pooled }. Pooled meshes get their material colour reset
  // and must NOT have their geometry disposed.
  _createProjectileMesh(weapon) {
    if (weapon.id === 'dagger' || weapon.projectileShape === 'dagger') {
      const group = new THREE.Group();
      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.05, 0.34),
        new THREE.MeshStandardMaterial({ color: 0xd7dee7, metalness: 0.8, roughness: 0.3, flatShading: true }),
      );
      blade.position.z = -0.1;
      const handle = new THREE.Mesh(
        new THREE.BoxGeometry(0.045, 0.045, 0.12),
        new THREE.MeshStandardMaterial({ color: 0x4a342a, flatShading: true }),
      );
      handle.position.z = 0.12;
      group.add(blade, handle);
      group.frustumCulled = false;
      return { mesh: group, pooled: false };
    }

    // Try the pool first; pooled meshes share _PROJ_GEOM and scale per-call.
    const pooled = _acquireProjectileMesh();
    if (pooled) {
      const targetRadius = weapon.projectileRadius ?? 0.1;
      // _PROJ_GEOM is built at radius 0.12; rescale so visual radius matches.
      const scale = targetRadius / 0.12;
      pooled.scale.setScalar(scale);
      pooled.quaternion.identity();
      pooled.material.color.set(weapon.flashColor ?? 0x54d2ff);
      pooled.material.opacity = 1;
      pooled.material.transparent = false;
      return { mesh: pooled, pooled: true };
    }

    // Pool exhausted — fall back to fresh allocation.
    const geometry = new THREE.SphereGeometry(weapon.projectileRadius ?? 0.1, 10, 10);
    const material = new THREE.MeshBasicMaterial({ color: weapon.flashColor ?? 0x54d2ff });
    const mesh = new THREE.Mesh(geometry, material);
    return { mesh, pooled: false };
  }

  _updateMuzzleFlashes(delta) {
    for (let i = this.muzzleFlashes.length - 1; i >= 0; i -= 1) {
      const flash = this.muzzleFlashes[i];
      flash.ttl -= delta;

      if (flash.material) {
        flash.material.opacity = Math.max(0, flash.ttl / flash.maxTtl);
      }

      if (flash.ttl <= 0) {
        flash.scene?.remove?.(flash.object);
        if (flash.pooled) {
          // Pooled flash: do NOT dispose the shared geometry. Return the mesh
          // (and its private material, which stays attached) to the pool.
          _releaseFlashMesh(flash.object);
        } else {
          flash.object?.traverse?.((child) => {
            child.geometry?.dispose?.();
            child.material?.dispose?.();
          });
        }
        this.muzzleFlashes.splice(i, 1);
      }
    }
  }

  _updateProjectiles(delta) {
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const projectile = this.projectiles[i];

      if (projectile.gravity) {
        projectile.velocity.y -= projectile.gravity * delta;
      }

      const step = this._scratchStep.copy(projectile.velocity).multiplyScalar(delta);
      const distance = step.length();
      projectile.previousPosition.copy(projectile.position);
      projectile.position.add(step);
      projectile.remainingRange -= distance;

      const direction = this._scratchProjDir.copy(projectile.velocity);
      if (direction.lengthSq() > 0) direction.normalize();

      const dragonHit = this._hitDragonManager(
        projectile.previousPosition,
        direction,
        projectile.weapon,
        projectile.dragons,
        distance,
      );
      const hit = dragonHit ?? this._raycastHit(
        projectile.previousPosition,
        direction,
        distance,
        projectile.targets,
        projectile.ignore,
      );

      let worldHit = null;
      if (!hit && typeof projectile.world?.raycastBlock === 'function') {
        worldHit = projectile.world.raycastBlock(projectile.previousPosition, direction, distance);
      }

      if (projectile.object) {
        projectile.object.position.copy(projectile.position);
        if (direction.lengthSq() > 0) {
          projectile.object.quaternion.setFromUnitVectors(PROJECTILE_FORWARD, direction);
        }
      }

      if (hit) {
        const payload = dragonHit
          ? this._buildDragonHitPayload(dragonHit, projectile.weapon, direction, projectile.previousPosition, { projectile })
          : this._buildHitPayload(hit, projectile.weapon, direction, projectile.previousPosition, { projectile });
        this._emit('onHit', payload);
        this._emit('onProjectileImpact', { ...payload, projectile });
        this._removeProjectile(i);
      } else if (worldHit) {
        this._emit('onProjectileImpact', { weapon: projectile.weapon, projectile, point: worldHit.point ?? projectile.position.clone() });
        this._removeProjectile(i);
      } else if (projectile.remainingRange <= 0 || projectile.position.y < -4) {
        this._emit('onProjectileExpire', { weapon: projectile.weapon, projectile });
        this._removeProjectile(i);
      }
    }
  }

  _removeProjectile(index) {
    const projectile = this.projectiles[index];
    projectile.scene?.remove?.(projectile.object);
    if (projectile.pooledMesh) {
      // Pooled projectile: skip dispose (shared _PROJ_GEOM, reused material).
      _releaseProjectileMesh(projectile.object);
    } else {
      projectile.object?.traverse?.((child) => {
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
        else child.material?.dispose?.();
      });
    }
    this.projectiles.splice(index, 1);
  }

  _normalizeTargets(targets) {
    if (!targets) return [];
    return Array.isArray(targets) ? targets : [targets];
  }

  _isChildOf(object, parent) {
    if (!object || !parent) return false;
    let current = object.parent;
    while (current) {
      if (current === parent) return true;
      current = current.parent;
    }
    return false;
  }

  _miss(reason, weapon = null) {
    this.lastFireResult = { fired: false, reason, weapon };
    return false;
  }

  _emit(name, payload) {
    const callback = this.callbacks[name];
    if (typeof callback === 'function') {
      callback(payload);
    }
  }
}

export default Weapons;
