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
    this._scratchOrigin = new THREE.Vector3();
    this._scratchDirection = new THREE.Vector3();
    this._scratchRight = new THREE.Vector3();
    this._scratchUp = new THREE.Vector3();
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

    const { origin, direction } = this._resolveShotTransform(context);
    const scene = context.scene ?? this.scene;
    const targets = context.targets ?? this.targets;
    const hits = [];

    if (!weapon.infiniteAmmo) weapon.ammo -= 1;
    weapon.cooldownRemaining = 1 / Math.max(weapon.fireRate, 0.001);

    this._spawnMuzzleFlash(origin, direction, weapon, { ...context, scene });

    if (weapon.penetrate && context.penetrate !== false) {
      for (const payload of this._firePenetrating(origin, direction, weapon, { ...context, scene, targets })) {
        hits.push(payload);
      }
    } else if (weapon.projectile && this.projectilesEnabled && context.projectile !== false) {
      this._spawnProjectile(origin, direction, weapon, { ...context, scene, targets });
    } else {
      for (let i = 0; i < weapon.pellets; i += 1) {
        const pelletDirection = weapon.cone
          ? this._coneDirection(direction, weapon.spreadAngle ?? 0.2)
          : this._spreadDirection(direction, weapon.spread);
        const dragonHit = this._hitDragonManager(origin, pelletDirection, weapon, context.dragons, weapon.range);
        const hit = dragonHit ?? this._raycastHit(origin, pelletDirection, weapon.range, targets, context.ignore);
        let endPoint;
        if (hit) {
          const payload = dragonHit
            ? this._buildDragonHitPayload(dragonHit, weapon, pelletDirection, origin, context)
            : this._buildHitPayload(hit, weapon, pelletDirection, origin, context);
          hits.push(payload);
          this._emit('onHit', payload);
          endPoint = payload.point?.clone?.() ?? origin.clone().addScaledVector(pelletDirection, weapon.range);
        } else {
          endPoint = origin.clone().addScaledVector(pelletDirection, weapon.range);
        }
        this._emit('onTracer', {
          weapon,
          origin: origin.clone(),
          end: endPoint,
          color: weapon.tracerColor ?? weapon.flashColor ?? 0xffe08a,
        });
      }
    }

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

  _resolveShotTransform(context) {
    const camera = context.camera ?? this.camera;
    const origin = this._scratchOrigin;
    const direction = this._scratchDirection;

    if (context.origin) {
      origin.copy(context.origin);
    } else if (camera?.getWorldPosition) {
      camera.getWorldPosition(origin);
    } else {
      origin.set(0, 0, 0);
    }

    if (context.direction) {
      direction.copy(context.direction).normalize();
    } else if (camera?.getWorldDirection) {
      camera.getWorldDirection(direction).normalize();
    } else {
      direction.set(0, 0, -1);
    }

    return {
      origin: origin.clone(),
      direction: direction.clone(),
    };
  }

  _spreadDirection(direction, spread) {
    if (!spread) return direction.clone();

    this._scratchRight.crossVectors(direction, UP);
    if (this._scratchRight.lengthSq() < 0.0001) {
      this._scratchRight.set(1, 0, 0);
    } else {
      this._scratchRight.normalize();
    }

    this._scratchUp.crossVectors(this._scratchRight, direction).normalize();

    const x = (Math.random() - 0.5) * spread;
    const y = (Math.random() - 0.5) * spread;
    return direction
      .clone()
      .addScaledVector(this._scratchRight, x)
      .addScaledVector(this._scratchUp, y)
      .normalize();
  }

  _coneDirection(direction, halfAngle) {
    this._scratchRight.crossVectors(direction, UP);
    if (this._scratchRight.lengthSq() < 0.0001) {
      this._scratchRight.set(1, 0, 0);
    } else {
      this._scratchRight.normalize();
    }

    this._scratchUp.crossVectors(this._scratchRight, direction).normalize();

    // Uniform sample inside the cone disc so pellets fan out evenly.
    const theta = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * Math.tan(halfAngle);
    const x = Math.cos(theta) * radius;
    const y = Math.sin(theta) * radius;

    return direction
      .clone()
      .addScaledVector(this._scratchRight, x)
      .addScaledVector(this._scratchUp, y)
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
    let beamEnd = origin.clone().addScaledVector(direction, range);

    const world = context.world;
    if (world?.raycastBlock) {
      const worldHit = world.raycastBlock(origin, direction, range);
      if (worldHit) {
        maxDistance = worldHit.distance;
        beamEnd = (worldHit.point?.clone?.() ?? origin.clone().addScaledVector(direction, worldHit.distance));
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

    this._emit('onBeam', {
      weapon,
      origin: origin.clone(),
      end: beamEnd,
      color: weapon.flashColor ?? 0x54d2ff,
    });

    return hits;
  }

  _spawnMuzzleFlash(origin, direction, weapon, context) {
    const scene = context.scene;
    const ttl = context.flashDuration ?? 0.055;
    const payload = { weapon, origin: origin.clone(), direction: direction.clone(), ttl };

    if (scene?.add) {
      const color = weapon.flashColor ?? 0xffcc66;
      // No PointLight here: adding/removing lights forces Three to recompile
      // every material (a big FPS hitch when firing). The emissive glow mesh
      // alone reads as a muzzle flash.
      const geometry = new THREE.SphereGeometry(0.08, 8, 8);
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      });
      const glow = new THREE.Mesh(geometry, material);
      glow.position.copy(origin).addScaledVector(direction, context.muzzleDistance ?? 0.7);
      scene.add(glow);
      this.muzzleFlashes.push({ object: glow, material, scene, ttl, maxTtl: ttl });
      payload.object = glow;
    }

    this._emit('onMuzzleFlash', payload);
  }

  _spawnProjectile(origin, direction, weapon, context) {
    const scene = context.scene;
    const speed = weapon.projectileSpeed ?? 48;
    const start = origin.clone().addScaledVector(direction, 0.8);
    const projectile = {
      weapon,
      position: start.clone(),
      previousPosition: start.clone(),
      velocity: direction.clone().multiplyScalar(speed),
      gravity: weapon.gravity ?? 0,
      remainingRange: weapon.range,
      targets: context.targets,
      dragons: context.dragons,
      world: context.world,
      ignore: context.ignore,
      scene,
      object: null,
    };

    if (scene?.add) {
      projectile.object = this._createProjectileMesh(weapon);
      projectile.object.position.copy(projectile.position);
      scene.add(projectile.object);
    }

    this.projectiles.push(projectile);
    this._emit('onProjectileSpawn', { weapon, projectile });
  }

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
      return group;
    }

    const geometry = new THREE.SphereGeometry(weapon.projectileRadius ?? 0.1, 10, 10);
    const material = new THREE.MeshBasicMaterial({ color: weapon.flashColor ?? 0x54d2ff });
    return new THREE.Mesh(geometry, material);
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
        flash.object?.traverse?.((child) => {
          child.geometry?.dispose?.();
          child.material?.dispose?.();
        });
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
    projectile.object?.traverse?.((child) => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
      else child.material?.dispose?.();
    });
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
