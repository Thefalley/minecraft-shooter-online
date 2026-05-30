import * as THREE from 'three';

const DEFAULT_SKY = 0x8fc9ff;
const DEFAULT_FOG_NEAR = 80;
const DEFAULT_FOG_FAR = 340;

const TMP_COLOR = new THREE.Color();
const TMP_VECTOR = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Module-level pools.
//
// Per-effect 'new THREE.XGeometry' / 'new THREE.MeshBasicMaterial' / 'new
// THREE.BufferGeometry' on every shot was the dominant source of GC churn
// while multiple players were firing automatic weapons. Everything below
// makes those calls shared.
// ---------------------------------------------------------------------------

// Shared geometries. Meshes use these via mesh.scale.* to take on whatever
// per-effect size they need; the underlying buffers are never re-uploaded.
const _SPHERE_LO = new THREE.SphereGeometry(1, 6, 6);     // impact / tracer
const _SPHERE_HI = new THREE.SphereGeometry(1, 14, 10);   // explosion core
const _PLANE_1 = new THREE.PlaneGeometry(1, 1);            // slashMark
const _RING_1 = new THREE.RingGeometry(0.5, 1, 24);        // shockwave
_RING_1.rotateX(-Math.PI / 2);                              // bake flat orientation
const _CYL_1 = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true); // beam

// Material pool for STATIC-opacity uses keyed by colour+blending+opacityBucket.
// Effects with smooth opacity fades can't share a material safely (one effect
// writing opacity stomps the other on the same frame), so they allocate their
// own — see `_acquireFadingMaterial` for the small ring of those.
const _materialPool = new Map();
function _materialKey(color, blending, opacity, side, depthTest) {
  // Bucket opacity to 0.05 to limit pool growth.
  const bucket = Math.round(opacity * 20) / 20;
  return `${color}|${blending}|${bucket}|${side}|${depthTest ? 1 : 0}`;
}
function getEffectMaterial(color, blending = THREE.NormalBlending, opacity = 1, options = {}) {
  const side = options.side ?? THREE.FrontSide;
  const depthTest = options.depthTest !== false;
  const key = _materialKey(color, blending, opacity, side, depthTest);
  let m = _materialPool.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: Math.round(opacity * 20) / 20,
      depthWrite: false,
      depthTest,
      side,
      blending,
    });
    _materialPool.set(key, m);
  }
  return m;
}

// Fading material pool: small ring per key. Effects that need smooth opacity
// animation rotate through these so they (mostly) don't fight each other for
// a single shared material. If the ring is exhausted simultaneously, the
// older effect's last frames may have their opacity overwritten — visually
// indistinguishable in practice given how brief the fades are.
const _FADING_RING = 8;
const _fadingMaterialPool = new Map(); // key -> { ring: Material[], cursor: number }
function _acquireFadingMaterial(color, blending, baseOpacity, options = {}) {
  const side = options.side ?? THREE.FrontSide;
  const depthTest = options.depthTest !== false;
  const map = options.map ?? null;
  // Texture-bearing materials don't share — their map identity is part of the
  // material. We DO still pool by (color,blending,side,depthTest) when the
  // map matches (slashMark always uses the same single texture).
  const mapId = map ? map.uuid : 'nomap';
  const key = `fade|${color}|${blending}|${side}|${depthTest ? 1 : 0}|${mapId}`;
  let entry = _fadingMaterialPool.get(key);
  if (!entry) {
    entry = { ring: [], cursor: 0 };
    _fadingMaterialPool.set(key, entry);
  }
  if (entry.ring.length < _FADING_RING) {
    const m = new THREE.MeshBasicMaterial({
      color,
      map,
      transparent: true,
      opacity: baseOpacity,
      depthWrite: false,
      depthTest,
      side,
      blending,
    });
    entry.ring.push(m);
    return m;
  }
  const m = entry.ring[entry.cursor];
  entry.cursor = (entry.cursor + 1) % entry.ring.length;
  m.opacity = baseOpacity;
  return m;
}

// Particle BufferGeometry ring. Each entry owns Float32Arrays for position
// and color sized for up to 64 vertices. _spawnBurst writes into them and
// flips needsUpdate. If all 8 are still mid-burst we fall back to allocating
// a fresh geometry/arrays — dropping the effect would be worse than the
// occasional GC.
const _PARTICLE_RING_SIZE = 8;
const _PARTICLE_CAP = 64;
const _particleRing = [];
let _particleRingCursor = 0;
let _particleRingInUse = 0;
function _acquireParticleGeometry(count) {
  if (count > _PARTICLE_CAP || _particleRingInUse >= _PARTICLE_RING_SIZE) {
    // Allocate fresh, mark as un-pooled. Caller must dispose normally.
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return { geometry, positions, colors, pooled: false, slot: -1 };
  }
  // Find a free slot.
  let slot = _particleRingCursor;
  for (let i = 0; i < _PARTICLE_RING_SIZE; i += 1) {
    const candidate = (_particleRingCursor + i) % _PARTICLE_RING_SIZE;
    if (!_particleRing[candidate] || !_particleRing[candidate].inUse) {
      slot = candidate;
      break;
    }
  }
  _particleRingCursor = (slot + 1) % _PARTICLE_RING_SIZE;

  let entry = _particleRing[slot];
  if (!entry) {
    const positions = new Float32Array(_PARTICLE_CAP * 3);
    const colors = new Float32Array(_PARTICLE_CAP * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    entry = { geometry, positions, colors, inUse: false };
    _particleRing[slot] = entry;
  }
  entry.inUse = true;
  _particleRingInUse += 1;
  // Trim draw range to actual particle count so the leftover capacity isn't
  // rendered as junk vertices from the previous burst.
  entry.geometry.setDrawRange(0, count);
  return { geometry: entry.geometry, positions: entry.positions, colors: entry.colors, pooled: true, slot };
}
function _releaseParticleGeometry(slot) {
  if (slot < 0) return;
  const entry = _particleRing[slot];
  if (!entry || !entry.inUse) return;
  entry.inUse = false;
  _particleRingInUse -= 1;
}

// Scratch quaternions/vectors lifted out of hot paths (slashMark, _spawnBurst).
const _SCRATCH_Q = new THREE.Quaternion();
const _SCRATCH_AXIS_Z = new THREE.Vector3(0, 0, 1);
const _SCRATCH_Q_CAM = new THREE.Quaternion();
const _SCRATCH_UP = new THREE.Vector3(0, 1, 0);
const _SCRATCH_DIR = new THREE.Vector3();
const _SCRATCH_JITTER = new THREE.Vector3();
const _SCRATCH_WHITE = new THREE.Color(0xffffff);
const _SCRATCH_AXIS = new THREE.Vector3();

function resolvePosition(position) {
  if (position?.isVector3) return position.clone();
  if (position?.position?.isVector3) return position.position.clone();
  if (typeof position?.x === 'number' && typeof position?.y === 'number' && typeof position?.z === 'number') {
    return new THREE.Vector3(position.x, position.y, position.z);
  }
  return new THREE.Vector3();
}

// Writes a uniformly-distributed unit direction into target without
// allocating. Returns target for chaining.
function randomDirectionInto(target) {
  const theta = Math.random() * Math.PI * 2;
  const y = Math.random() * 2 - 1;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  target.set(Math.cos(theta) * radius, y, Math.sin(theta) * radius);
  return target;
}

function disposeObject(object) {
  object?.traverse?.((child) => {
    // Skip dispose on shared resources — that would tear them out from under
    // every other effect using them.
    if (!child._pooledGeometry) child.geometry?.dispose?.();
    const skipMat = child._pooledMaterial;
    if (!skipMat) {
      if (Array.isArray(child.material)) {
        child.material.forEach((material) => material.dispose?.());
      } else {
        child.material?.dispose?.();
      }
    }
  });
}

export class Effects {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.effects = [];
    this.lights = [];
    // Fixed pool of point lights kept in the scene the whole time. Reusing them
    // (instead of add/remove) keeps the light count constant so Three never
    // recompiles every material mid-game — that recompile was the FPS hitch.
    this.lightPool = [];
    this.lightCursor = 0;
    if (scene) {
      for (let i = 0; i < 6; i += 1) {
        const light = new THREE.PointLight(0xffffff, 0, 10);
        light.visible = false;
        scene.add(light);
        this.lightPool.push({ object: light, age: 0, ttl: 0, baseIntensity: 0, active: false });
      }
    }
    this.lastShakeOffset = new THREE.Vector3();
    this.shake = {
      time: 0,
      duration: 0,
      intensity: 0,
    };

    this.options = {
      skyColor: options.skyColor ?? DEFAULT_SKY,
      fogNear: options.fogNear ?? DEFAULT_FOG_NEAR,
      fogFar: options.fogFar ?? DEFAULT_FOG_FAR,
    };

    this.effectCap = 90;
  }

  // Allow the caller (e.g. multiplayer match start) to dial the concurrent
  // effect cap down when many players are firing automatic weapons.
  setEffectCap(n) {
    if (typeof n === 'number' && n > 0) {
      this.effectCap = Math.floor(n);
    }
  }

  impact(position, color = 0xffd166) {
    const origin = resolvePosition(position);

    this._spawnBurst({
      position: origin,
      color,
      count: 18,
      ttl: 0.42,
      size: 0.08,
      opacity: 0.95,
      speed: [3.5, 8],
      gravity: -8,
      drag: 2.3,
    });

    this._addLight(origin, color, 1.4, 4.5, 0.09);
    this._addShake(0.035, 0.08);
  }

  explosion(position) {
    const origin = resolvePosition(position);

    this._spawnBurst({
      position: origin,
      color: 0xff7a1a,
      count: 54,
      ttl: 0.72,
      size: 0.16,
      opacity: 1,
      speed: [5, 15],
      gravity: -4,
      drag: 1.35,
    });

    this._spawnBurst({
      position: origin,
      color: 0x4f514d,
      count: 36,
      ttl: 1.45,
      size: 0.34,
      opacity: 0.48,
      speed: [1.2, 6],
      gravity: 1.9,
      drag: 0.75,
      liftBias: 0.65,
    });

    this._spawnExpandingSphere(origin, 0xff5f16, 0.35, 4.2, 0.32);
    this._addLight(origin, 0xff7a1a, 8, 18, 0.45);
    this._addShake(0.28, 0.42);
  }

  tracer(start, end, color = 0xffe08a, speed = 110, radius = 0.08) {
    if (!this.scene) return;

    const from = resolvePosition(start);
    const to = resolvePosition(end);
    const axis = to.clone().sub(from);
    const distance = axis.length();
    if (distance < 0.001) return;
    const dir = axis.clone().normalize();

    // Tracer opacity is constant for its whole life — safe to share material.
    const material = getEffectMaterial(color, THREE.AdditiveBlending, 0.95);
    const mesh = new THREE.Mesh(_SPHERE_LO, material);
    mesh.scale.setScalar(radius);
    mesh.position.copy(from);
    mesh.frustumCulled = false;
    mesh._pooledGeometry = true;
    mesh._pooledMaterial = true;
    this.scene.add(mesh);

    const travelTime = Math.max(0.03, distance / speed);
    const effect = {
      object: mesh,
      age: 0,
      ttl: travelTime,
      update: (delta) => {
        effect.age += delta;
        const traveled = speed * effect.age;
        if (traveled >= distance) {
          mesh.position.copy(to);
          return false;
        }
        mesh.position.copy(from).addScaledVector(dir, traveled);
        return true;
      },
    };

    this.effects.push(effect);
  }

  // A white slash mark that pops over a struck enemy, facing the camera and
  // rotated at a random angle. Used by the sword and the hunter's daggers.
  slashMark(position, size = 1.6, color = 0xffffff) {
    if (!this.scene) return;

    const pos = resolvePosition(position);
    // Opacity fades smoothly — needs a non-shared material so two slashMarks
    // don't write opacity on the same frame. Pulled from the small fading ring.
    const material = _acquireFadingMaterial(color, THREE.AdditiveBlending, 1, {
      depthTest: false,
      map: this._getSlashTexture(),
    });
    const mesh = new THREE.Mesh(_PLANE_1, material);
    mesh.position.copy(pos);
    mesh.scale.setScalar(size);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1000;
    mesh._pooledGeometry = true;
    mesh._pooledMaterial = true; // pooled (fading ring) — don't dispose
    this.scene.add(mesh);

    const camera = this.camera;
    const roll = Math.random() * Math.PI * 2;
    // Reuse the scratch quaternion for the roll; multiply it onto camQuat in update.
    const rollQuat = new THREE.Quaternion().setFromAxisAngle(_SCRATCH_AXIS_Z, roll);
    const ttl = 0.6;
    const effect = {
      object: mesh,
      age: 0,
      ttl,
      update: (delta) => {
        effect.age += delta;
        const progress = THREE.MathUtils.clamp(effect.age / ttl, 0, 1);
        if (camera) {
          camera.getWorldQuaternion(_SCRATCH_Q_CAM);
          mesh.quaternion.copy(_SCRATCH_Q_CAM).multiply(rollQuat);
        }
        // The original scaled by 1 + progress * 0.35 around base size. We
        // bake the size into the base so the curve is still size*(1+...).
        mesh.scale.setScalar(size * (1 + progress * 0.35));
        material.opacity = 1 - progress * progress;
        return progress < 1;
      },
    };

    this.effects.push(effect);
  }

  shockwave(center, radius = 9, color = 0xffffff) {
    if (!this.scene) return;

    const pos = resolvePosition(center);
    // Animated opacity → fading pool.
    const material = _acquireFadingMaterial(color, THREE.AdditiveBlending, 0.75, {
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(_RING_1, material);
    mesh.position.copy(pos);
    mesh.frustumCulled = false;
    mesh._pooledGeometry = true;
    mesh._pooledMaterial = true;
    this.scene.add(mesh);

    const ttl = 0.5;
    const effect = {
      object: mesh,
      age: 0,
      ttl,
      update: (delta) => {
        effect.age += delta;
        const progress = THREE.MathUtils.clamp(effect.age / ttl, 0, 1);
        mesh.scale.setScalar(0.6 + progress * radius * 1.2);
        material.opacity = 0.75 * (1 - progress);
        return progress < 1;
      },
    };

    this.effects.push(effect);
    this._addLight(pos, color, 4, radius * 1.4, ttl);
  }

  _getSlashTexture() {
    if (this._slashTexture) return this._slashTexture;

    const dim = 128;
    const canvas = document.createElement('canvas');
    canvas.width = dim;
    canvas.height = dim;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, dim, dim);
    ctx.lineCap = 'round';

    // A tapered, slightly curved white slash stroke.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.moveTo(22, 100);
    ctx.quadraticCurveTo(70, 26, 108, 44);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(26, 96);
    ctx.quadraticCurveTo(70, 32, 104, 46);
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    this._slashTexture = texture;
    return texture;
  }

  beam(start, end, color = 0x54d2ff) {
    if (!this.scene) return;

    const from = resolvePosition(start);
    const to = resolvePosition(end);
    const axis = to.clone().sub(from);
    const length = axis.length();
    if (length < 0.001) return;

    // Animated opacity → fading pool. Geometry is unit cylinder scaled to fit.
    const material = _acquireFadingMaterial(color, THREE.AdditiveBlending, 0.9);
    const mesh = new THREE.Mesh(_CYL_1, material);
    // Original radius was 0.07, length varies. Scale unit cylinder accordingly.
    mesh.scale.set(0.07, length, 0.07);
    mesh.position.copy(from).addScaledVector(axis, 0.5);
    _SCRATCH_AXIS.copy(axis).normalize();
    mesh.quaternion.setFromUnitVectors(_SCRATCH_UP, _SCRATCH_AXIS);
    mesh.frustumCulled = false;
    mesh._pooledGeometry = true;
    mesh._pooledMaterial = true;
    this.scene.add(mesh);

    const ttl = 0.16;
    const effect = {
      object: mesh,
      age: 0,
      ttl,
      update: (delta) => {
        effect.age += delta;
        const progress = THREE.MathUtils.clamp(effect.age / ttl, 0, 1);
        material.opacity = 0.9 * (1 - progress);
        return progress < 1;
      },
    };

    this.effects.push(effect);
    this._addLight(to, color, 4, 9, 0.18);
  }

  update(delta) {
    const dt = Math.max(0, Math.min(delta || 0, 0.08));

    for (let i = this.effects.length - 1; i >= 0; i -= 1) {
      const effect = this.effects[i];
      const alive = effect.update(dt);
      if (!alive) {
        this.scene?.remove?.(effect.object);
        // Effect-specific release hooks run BEFORE generic dispose so the
        // particle ring slot is freed even when dispose skips pooled geo.
        effect.onRelease?.();
        disposeObject(effect.object);
        this.effects.splice(i, 1);
      }
    }

    for (const entry of this.lightPool) {
      if (!entry.active) continue;
      entry.age += dt;
      const progress = THREE.MathUtils.clamp(entry.age / entry.ttl, 0, 1);
      entry.object.intensity = entry.baseIntensity * (1 - progress);
      if (progress >= 1) {
        entry.object.intensity = 0;
        entry.object.visible = false;
        entry.active = false;
      }
    }

    if (this.shake.time > 0) {
      this.shake.time = Math.max(0, this.shake.time - dt);
    }
  }

  applyCameraShake(camera) {
    if (!camera?.position) return;

    if (this.lastShakeOffset.lengthSq() > 0) {
      camera.position.sub(this.lastShakeOffset);
      this.lastShakeOffset.set(0, 0, 0);
    }

    if (this.shake.time <= 0 || this.shake.duration <= 0 || this.shake.intensity <= 0) return;

    const fade = this.shake.time / this.shake.duration;
    const amount = this.shake.intensity * fade * fade;
    this.lastShakeOffset.set(
      (Math.random() - 0.5) * amount,
      (Math.random() - 0.5) * amount,
      (Math.random() - 0.5) * amount * 0.45,
    );
    camera.position.add(this.lastShakeOffset);
  }

  setSky(color = this.options.skyColor) {
    if (!this.scene) return null;
    this.scene.background = new THREE.Color(color);
    return this.scene.background;
  }

  setFog(color = this.options.skyColor, near = this.options.fogNear, far = this.options.fogFar) {
    if (!this.scene) return null;
    this.scene.fog = new THREE.Fog(color, near, far);
    return this.scene.fog;
  }

  addDefaultLighting() {
    if (!this.scene) return null;

    const group = new THREE.Group();
    group.name = 'EffectsLighting';

    const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x31451e, 1.5);
    const sun = new THREE.DirectionalLight(0xfff0c5, 2.4);
    sun.position.set(70, 120, 50);
    sun.castShadow = true;
    sun.shadow.camera.left = -90;
    sun.shadow.camera.right = 90;
    sun.shadow.camera.top = 90;
    sun.shadow.camera.bottom = -90;

    group.add(hemi, sun);
    this.scene.add(group);
    return group;
  }

  configureEnvironment(options = {}) {
    const skyColor = options.skyColor ?? this.options.skyColor;
    this.setSky(skyColor);
    this.setFog(skyColor, options.fogNear ?? this.options.fogNear, options.fogFar ?? this.options.fogFar);
    if (options.lighting !== false) {
      return this.addDefaultLighting();
    }
    return null;
  }

  dispose() {
    if (this.lastShakeOffset.lengthSq() > 0) {
      this.lastShakeOffset.set(0, 0, 0);
    }

    for (const effect of this.effects) {
      this.scene?.remove?.(effect.object);
      effect.onRelease?.();
      disposeObject(effect.object);
    }
    this.effects.length = 0;

    for (const entry of this.lightPool) {
      this.scene?.remove?.(entry.object);
    }
    this.lightPool.length = 0;
  }

  _spawnBurst(config) {
    if (this.effects.length > this.effectCap) return; // safety cap to avoid GC spikes on heavy multi-hits

    const handle = _acquireParticleGeometry(config.count);
    const positions = handle.positions;
    const colors = handle.colors;
    const velocities = [];
    const baseColor = TMP_COLOR.set(config.color);
    const liftBias = config.liftBias ?? 0;

    for (let i = 0; i < config.count; i += 1) {
      const index = i * 3;
      // Jitter: scratch vector reused, scaled in place. No clone().
      randomDirectionInto(_SCRATCH_JITTER).multiplyScalar(Math.random() * 0.08);
      positions[index] = config.position.x + _SCRATCH_JITTER.x;
      positions[index + 1] = config.position.y + _SCRATCH_JITTER.y;
      positions[index + 2] = config.position.z + _SCRATCH_JITTER.z;

      // Each particle's velocity vector needs to be retained per-particle, so
      // we still allocate one Vector3 per particle for the velocity array.
      // That's much smaller than the previous per-burst overhead.
      const dirX = (Math.random() * 2 - 1);
      const dirY = (Math.random() * 2 - 1) + liftBias;
      const dirZ = (Math.random() * 2 - 1);
      // Renormalise without allocations.
      _SCRATCH_DIR.set(dirX, dirY, dirZ);
      if (_SCRATCH_DIR.lengthSq() < 1e-6) _SCRATCH_DIR.set(0, 1, 0);
      _SCRATCH_DIR.normalize();
      const speed = THREE.MathUtils.lerp(config.speed[0], config.speed[1], Math.random());
      velocities.push(new THREE.Vector3(
        _SCRATCH_DIR.x * speed,
        _SCRATCH_DIR.y * speed,
        _SCRATCH_DIR.z * speed,
      ));

      // Mix base colour with white using TMP_COLOR / scratch — no per-particle
      // Color allocations.
      const mix = Math.random() * 0.18;
      colors[index]     = baseColor.r + (_SCRATCH_WHITE.r - baseColor.r) * mix;
      colors[index + 1] = baseColor.g + (_SCRATCH_WHITE.g - baseColor.g) * mix;
      colors[index + 2] = baseColor.b + (_SCRATCH_WHITE.b - baseColor.b) * mix;
    }

    const geometry = handle.geometry;
    geometry.getAttribute('position').needsUpdate = true;
    geometry.getAttribute('color').needsUpdate = true;
    if (handle.pooled) {
      // Limit how much of the shared buffer is drawn this burst.
      geometry.setDrawRange(0, config.count);
    }

    // PointsMaterial has per-burst animated opacity AND size, plus the
    // vertexColors flag. Pooling these would need (color,blending) plus
    // independent opacity/size per burst, which defeats sharing. We allocate
    // it fresh — geometry is the bigger win.
    const material = new THREE.PointsMaterial({
      size: config.size,
      vertexColors: true,
      transparent: true,
      opacity: config.opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points._pooledGeometry = handle.pooled;
    points._pooledMaterial = false;
    this.scene?.add?.(points);

    const slot = handle.slot;
    const pooled = handle.pooled;
    const effect = {
      object: points,
      age: 0,
      ttl: config.ttl,
      update: (delta) => {
        effect.age += delta;
        const progress = THREE.MathUtils.clamp(effect.age / effect.ttl, 0, 1);
        const attr = geometry.getAttribute('position');

        for (let i = 0; i < velocities.length; i += 1) {
          const index = i * 3;
          const velocity = velocities[i];
          velocity.y += config.gravity * delta;
          velocity.multiplyScalar(Math.exp(-config.drag * delta));
          attr.array[index] += velocity.x * delta;
          attr.array[index + 1] += velocity.y * delta;
          attr.array[index + 2] += velocity.z * delta;
        }

        attr.needsUpdate = true;
        material.opacity = config.opacity * (1 - progress);
        material.size = config.size * (1 + progress * 1.4);
        return progress < 1;
      },
      onRelease: pooled ? () => _releaseParticleGeometry(slot) : null,
    };

    this.effects.push(effect);
  }

  _spawnExpandingSphere(position, color, startScale, endScale, ttl) {
    // The explosion sphere uses _SPHERE_HI scaled per-frame for the expanding
    // animation. Opacity fades, so the material comes from the fading pool.
    const material = _acquireFadingMaterial(color, THREE.AdditiveBlending, 0.6);
    const mesh = new THREE.Mesh(_SPHERE_HI, material);
    mesh.position.copy(position);
    mesh.scale.setScalar(startScale);
    mesh._pooledGeometry = true;
    mesh._pooledMaterial = true;
    this.scene?.add?.(mesh);

    const effect = {
      object: mesh,
      age: 0,
      ttl,
      update: (delta) => {
        effect.age += delta;
        const progress = THREE.MathUtils.clamp(effect.age / effect.ttl, 0, 1);
        mesh.scale.setScalar(THREE.MathUtils.lerp(startScale, endScale, progress));
        material.opacity = 0.6 * (1 - progress);
        return progress < 1;
      },
    };

    this.effects.push(effect);
  }

  _addLight(position, color, intensity, distance, ttl) {
    if (this.lightPool.length === 0) return;
    const entry = this.lightPool[this.lightCursor];
    this.lightCursor = (this.lightCursor + 1) % this.lightPool.length;
    entry.object.color.set(color);
    entry.object.distance = distance;
    entry.object.position.copy(position);
    entry.object.intensity = intensity;
    entry.object.visible = true;
    entry.age = 0;
    entry.ttl = ttl;
    entry.baseIntensity = intensity;
    entry.active = true;
  }

  _addShake(intensity, duration) {
    this.shake.intensity = Math.max(this.shake.intensity, intensity);
    this.shake.duration = Math.max(this.shake.duration, duration);
    this.shake.time = Math.max(this.shake.time, duration);
  }
}

export default Effects;
