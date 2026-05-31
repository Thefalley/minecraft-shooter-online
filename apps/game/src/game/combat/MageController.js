import * as THREE from 'three';
import { BALANCE } from '../../core/config/GameBalance.js';

const ANY_DIR = new THREE.Vector3(1, 0, 0); // hitMelee with arcCos -1 ignores direction

// The mage's five elemental skills. Each costs mana (the player's shield) and
// (except the fireball) has a cooldown.
export class MageController {
  constructor(deps) {
    this.scene = deps.scene;
    this.effects = deps.effects;
    this.world = deps.world;
    this.enemies = deps.enemies;
    this.player = deps.player;
    this.camera = deps.camera;
    this.audio = deps.audio;
    this.hud = deps.hud;

    this.projectiles = [];
    this.thunders = [];
    this.tornadoes = [];
    this.cooldowns = {};
    this.regenLockTimer = 0;
  }

  getCooldown(id) {
    return this.cooldowns[id] ?? 0;
  }

  origin() {
    return this.camera.getWorldPosition(new THREE.Vector3());
  }

  direction() {
    return this.camera.getWorldDirection(new THREE.Vector3());
  }

  tryCast(id) {
    const cfg = BALANCE.mage.skills[id];
    if (!cfg) return false;
    if ((this.cooldowns[id] ?? 0) > 0) return false;
    if (this.player.shield < cfg.cost) {
      this.hud.showMessage('Maná insuficiente', 800);
      return false;
    }
    this.player.shield -= cfg.cost;
    this.cooldowns[id] = cfg.cd;

    switch (id) {
      case 'fireball': this.castFireball(cfg); break;
      case 'thunder': this.castThunder(cfg); break;
      case 'tornado': this.castTornado(cfg); break;
      case 'blizzard': this.castBlizzard(cfg); break;
      case 'nuke': this.castNuke(cfg); break;
      default: break;
    }
    return true;
  }

  // --- 1. Slow fire projectile, like the dragon's ---------------------------
  castFireball(cfg) {
    const origin = this.origin();
    const dir = this.direction();
    const start = origin.clone().addScaledVector(dir, 1.2);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.45, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xff6b1a, emissive: 0xff3400, emissiveIntensity: 1.5, flatShading: true }),
    );
    mesh.position.copy(start);
    this.scene.add(mesh);
    this.projectiles.push({
      type: 'fire', position: start, velocity: dir.clone().multiplyScalar(cfg.speed),
      mesh, life: cfg.life, radius: cfg.radius, damage: cfg.damage, hitRadius: 1.3,
    });
    this.audio.shoot('blaster');
  }

  // --- 4. Slow ice ball that slows on impact --------------------------------
  castBlizzard(cfg) {
    const origin = this.origin();
    const dir = this.direction();
    const start = origin.clone().addScaledVector(dir, 1.2);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xaee3ff, emissive: 0x2a6bdf, emissiveIntensity: 0.8, flatShading: true }),
    );
    mesh.position.copy(start);
    this.scene.add(mesh);
    this.projectiles.push({
      type: 'ice', position: start, velocity: dir.clone().multiplyScalar(cfg.speed),
      mesh, life: cfg.life, radius: cfg.radius, damage: cfg.damage, hitRadius: 1.6,
      slowFactor: cfg.slowFactor, slowDuration: cfg.slowDuration,
    });
  }

  // --- 2. Delayed thunder strike at the aimed ground ------------------------
  castThunder(cfg) {
    const target = this.aimGround();
    const geometry = new THREE.CircleGeometry(cfg.radius, 32);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
    const circle = new THREE.Mesh(geometry, material);
    circle.position.copy(target);
    circle.position.y += 0.1;
    this.scene.add(circle);
    this.thunders.push({ position: target.clone(), timer: cfg.delay, radius: cfg.radius, damage: cfg.damage, circle });
  }

  aimGround() {
    const origin = this.origin();
    const dir = this.direction();
    const hit = this.world?.raycastBlock?.(origin, dir, 90);
    if (hit?.point) return hit.point.clone();
    return origin.clone().addScaledVector(dir, 24);
  }

  // --- 3. Fire tornado: crowd control that lifts + burns ---------------------
  castTornado(cfg) {
    const origin = this.origin();
    const dir = this.direction();
    dir.y = 0;
    if (dir.lengthSq() < 0.0001) dir.set(0, 0, -1);
    dir.normalize();
    const center = origin.clone().addScaledVector(dir, cfg.ahead);
    const groundY = this.world?.getGroundHeight?.(center.x, center.z) ?? center.y;
    center.y = groundY;

    const geometry = new THREE.CylinderGeometry(cfg.radius * 0.9, 0.6, 8, 14, 1, true);
    const material = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(center.x, center.y + 4, center.z);
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    this.tornadoes.push({
      position: center, timer: cfg.duration, tickTimer: 0, tickRate: cfg.tickRate,
      tickDamage: cfg.tickDamage, radius: cfg.radius, mesh, elapsed: 0,
    });
    this.audio.explosion();
  }

  // --- 5. Nuke: huge AoE, then mana can't regen for a while -----------------
  castNuke(cfg) {
    const center = this.player.object.position.clone();
    this.enemies.hitMelee(center, ANY_DIR, cfg.radius, cfg.damage, -1);
    this.effects.explosion(center);
    this.effects.shockwave(center.clone(), cfg.radius, 0xff5030);
    this.effects.shockwave(center.clone(), cfg.radius * 0.6, 0xffd060);
    this.audio.explosion();
    this.hud.flashDamage();
    this.hud.showMessage('☢ NUKE — sin regeneración de maná 10s', 2000);
    this.player.shieldRegenLocked = true;
    this.regenLockTimer = BALANCE.mage.nukeRegenLock;
  }

  // --- update loop ----------------------------------------------------------
  update(delta) {
    for (const id of Object.keys(this.cooldowns)) {
      if (this.cooldowns[id] > 0) this.cooldowns[id] = Math.max(0, this.cooldowns[id] - delta);
    }
    if (this.regenLockTimer > 0) {
      this.regenLockTimer -= delta;
      if (this.regenLockTimer <= 0) {
        this.regenLockTimer = 0;
        this.player.shieldRegenLocked = false;
      }
    }
    this.updateProjectiles(delta);
    this.updateThunders(delta);
    this.updateTornadoes(delta);
  }

  updateProjectiles(delta) {
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const p = this.projectiles[i];
      p.position.addScaledVector(p.velocity, delta);
      p.life -= delta;
      p.mesh.position.copy(p.position);
      p.mesh.rotation.x += delta * 4;
      p.mesh.rotation.y += delta * 3;

      const done = this._solid(p.position) || this.enemies.anyNear(p.position, p.hitRadius) || p.life <= 0 || p.position.y < -4;
      if (done) {
        this.impact(p);
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        this.projectiles.splice(i, 1);
      }
    }
  }

  impact(p) {
    if (p.type === 'fire') {
      this.effects.explosion(p.position);
      this.audio.explosion();
      this.enemies.hitMelee(p.position, ANY_DIR, p.radius, p.damage, -1);
    } else if (p.type === 'ice') {
      this.effects.shockwave(p.position.clone(), p.radius, 0x8fd3ff);
      this.effects.impact(p.position, 0xaee3ff);
      this.enemies.hitMelee(p.position, ANY_DIR, p.radius, p.damage, -1);
      this.enemies.slow(p.position, p.radius, p.slowFactor, p.slowDuration);
    }
  }

  updateThunders(delta) {
    for (let i = this.thunders.length - 1; i >= 0; i -= 1) {
      const t = this.thunders[i];
      t.timer -= delta;
      t.circle.material.opacity = 0.35 + (Math.sin(t.timer * 22) * 0.5 + 0.5) * 0.4;
      if (t.timer <= 0) {
        const top = t.position.clone();
        top.y += 32;
        this.effects.beam(top, t.position, 0xbfe0ff);
        this.effects.explosion(t.position);
        this.audio.explosion();
        this.enemies.hitMelee(t.position, ANY_DIR, t.radius, t.damage, -1);
        this.scene.remove(t.circle);
        t.circle.geometry.dispose();
        t.circle.material.dispose();
        this.thunders.splice(i, 1);
      }
    }
  }

  updateTornadoes(delta) {
    for (let i = this.tornadoes.length - 1; i >= 0; i -= 1) {
      const t = this.tornadoes[i];
      t.timer -= delta;
      t.elapsed += delta;
      t.tickTimer -= delta;
      t.mesh.rotation.y += delta * 8;

      this.enemies.tornadoPull(t.position, t.radius, t.elapsed);

      if (t.tickTimer <= 0) {
        t.tickTimer = t.tickRate;
        this.enemies.hitMelee(t.position, ANY_DIR, t.radius, t.tickDamage, -1);
        this.effects.impact(t.position.clone().setY(t.position.y + 2), 0xff7a1a);
      }

      if (t.timer <= 0) {
        this.scene.remove(t.mesh);
        t.mesh.geometry.dispose();
        t.mesh.material.dispose();
        this.tornadoes.splice(i, 1);
      }
    }
  }

  _solid(pos) {
    if (!this.world?.getBlock) return false;
    const type = this.world.getBlock(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    return Boolean(type) && type !== 'water';
  }

  dispose() {
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    for (const t of this.thunders) this.scene.remove(t.circle);
    for (const t of this.tornadoes) this.scene.remove(t.mesh);
    this.projectiles.length = 0;
    this.thunders.length = 0;
    this.tornadoes.length = 0;
  }
}

export default MageController;
