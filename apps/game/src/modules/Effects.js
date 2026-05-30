import * as THREE from 'three';

const DEFAULT_SKY = 0x8fc9ff;
const DEFAULT_FOG_NEAR = 80;
const DEFAULT_FOG_FAR = 340;

const TMP_COLOR = new THREE.Color();
const TMP_VECTOR = new THREE.Vector3();

function resolvePosition(position) {
  if (position?.isVector3) return position.clone();
  if (position?.position?.isVector3) return position.position.clone();
  if (typeof position?.x === 'number' && typeof position?.y === 'number' && typeof position?.z === 'number') {
    return new THREE.Vector3(position.x, position.y, position.z);
  }
  return new THREE.Vector3();
}

function randomDirection() {
  const theta = Math.random() * Math.PI * 2;
  const y = Math.random() * 2 - 1;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  return TMP_VECTOR.set(Math.cos(theta) * radius, y, Math.sin(theta) * radius).clone();
}

function disposeObject(object) {
  object?.traverse?.((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) {
      child.material.forEach((material) => material.dispose?.());
    } else {
      child.material?.dispose?.();
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

    const geometry = new THREE.SphereGeometry(radius, 6, 6);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(from);
    mesh.frustumCulled = false;
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
    const material = new THREE.MeshBasicMaterial({
      map: this._getSlashTexture(),
      color,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
    mesh.position.copy(pos);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1000;
    this.scene.add(mesh);

    const camera = this.camera;
    const roll = Math.random() * Math.PI * 2;
    const rollQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll);
    const camQuat = new THREE.Quaternion();
    const ttl = 0.6;
    const effect = {
      object: mesh,
      age: 0,
      ttl,
      update: (delta) => {
        effect.age += delta;
        const progress = THREE.MathUtils.clamp(effect.age / ttl, 0, 1);
        if (camera) {
          camera.getWorldQuaternion(camQuat);
          mesh.quaternion.copy(camQuat).multiply(rollQuat);
        }
        mesh.scale.setScalar(1 + progress * 0.35);
        material.opacity = 1 - progress * progress;
        return progress < 1;
      },
    };

    this.effects.push(effect);
  }

  shockwave(center, radius = 9, color = 0xffffff) {
    if (!this.scene) return;

    const pos = resolvePosition(center);
    const geometry = new THREE.RingGeometry(0.6, 1, 44);
    geometry.rotateX(-Math.PI / 2); // lay flat on the ground
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(pos);
    mesh.frustumCulled = false;
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

    const geometry = new THREE.CylinderGeometry(0.07, 0.07, length, 8, 1, true);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(from).addScaledVector(axis, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize());
    mesh.frustumCulled = false;
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
      disposeObject(effect.object);
    }
    this.effects.length = 0;

    for (const entry of this.lightPool) {
      this.scene?.remove?.(entry.object);
    }
    this.lightPool.length = 0;
  }

  _spawnBurst(config) {
    if (this.effects.length > 90) return; // safety cap to avoid GC spikes on heavy multi-hits
    const positions = new Float32Array(config.count * 3);
    const colors = new Float32Array(config.count * 3);
    const velocities = [];
    const baseColor = TMP_COLOR.set(config.color);
    const liftBias = config.liftBias ?? 0;

    for (let i = 0; i < config.count; i += 1) {
      const index = i * 3;
      const jitter = randomDirection().multiplyScalar(Math.random() * 0.08);
      positions[index] = config.position.x + jitter.x;
      positions[index + 1] = config.position.y + jitter.y;
      positions[index + 2] = config.position.z + jitter.z;

      const direction = randomDirection();
      direction.y += liftBias;
      direction.normalize();
      const speed = THREE.MathUtils.lerp(config.speed[0], config.speed[1], Math.random());
      velocities.push(direction.multiplyScalar(speed));

      const color = baseColor.clone().lerp(new THREE.Color(0xffffff), Math.random() * 0.18);
      colors[index] = color.r;
      colors[index + 1] = color.g;
      colors[index + 2] = color.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

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
    this.scene?.add?.(points);

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
    };

    this.effects.push(effect);
  }

  _spawnExpandingSphere(position, color, startScale, endScale, ttl) {
    const geometry = new THREE.SphereGeometry(1, 14, 10);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.scale.setScalar(startScale);
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
