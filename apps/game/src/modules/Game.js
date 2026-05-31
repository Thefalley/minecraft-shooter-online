import * as THREE from 'three';
import { World } from './World.js';
import { Player } from './Player.js';
import { Weapons } from './Weapons.js';
import { DragonManager } from './DragonManager.js';
import { ZombieManager } from './ZombieManager.js';
import { SkeletonManager } from './SkeletonManager.js';
import { WitchManager } from './WitchManager.js';
import { Input } from './Input.js';
import { HUD } from './HUD.js';
import { Effects } from './Effects.js';
import { GameAudio } from './Audio.js';
import { Inventory } from './Inventory.js';
import { CHARACTERS } from './Characters.js';
import { buildViewmodel, disposeViewmodel } from './Viewmodels.js';
import { Shop } from './Shop.js';
import { MageController } from './MageController.js';
import { BALANCE } from './GameBalance.js';
import { WorldSync } from '../networking/WorldSync.js';
import { EnemySync } from '../networking/EnemySync.js';

export class Game {
  constructor(root, options = {}) {
    // Init debug ring buffer BEFORE any subsystem (EnemySync, WorldSync,
    // …) so their enable() events land in the ring. Idempotent — keeps
    // an existing instance if Game is recreated.
    if (typeof window !== 'undefined' && !window.__voxelDebug) {
      window.__voxelDebug = {
        enabled: new URLSearchParams(window.location.search).get('debug') === '1',
        ring: [],
        push(category, payload) {
          if (this.ring.length >= 500) this.ring.shift();
          this.ring.push({ t: Date.now(), category, payload });
          if (this.enabled) console.debug(`[vox:${category}]`, payload);
        },
        dump() {
          const g = window.__voxelGame;
          const bridge = g?.network?.getBridge?.();
          const state = bridge?.getRoomState?.();
          return {
            time: new Date().toISOString(),
            session: bridge?.getSelfSessionId?.() ?? null,
            phase: state?.phase ?? null,
            wave: state?.wave ?? g?.wave ?? null,
            playerPos: g?.player?.position
              ? { x: g.player.position.x, y: g.player.position.y, z: g.player.position.z }
              : null,
            worldSeed: g?.world?.options?.seed ?? null,
            counts: {
              statePlayers: state?.players?.size ?? null,
              stateEnemies: state?.enemies?.size ?? null,
              stateDragons: state?.dragons?.size ?? null,
              stateWorldDeltas: state?.world?.deltas?.size ?? null,
              localZombies: g?.zombies?.zombies?.length ?? null,
              serverZombies: g?.zombies?._serverEntities?.size ?? null,
              localSkeletons: g?.skeletons?.skeletons?.length ?? null,
              serverSkeletons: g?.skeletons?._serverEntities?.size ?? null,
              localDragons: g?.dragons?.dragons?.length ?? null,
              serverDragons: g?.dragons?._serverEntities?.size ?? null,
            },
            authority: {
              zombies: g?.zombies?._authority ?? null,
              skeletons: g?.skeletons?._authority ?? null,
              witches: g?.witches?._authority ?? null,
              dragons: g?.dragons?._authority ?? null,
            },
            enemySync: { created: !!g?._enemySync, enabled: !!g?._enemySync?._enabled },
            worldSync: { created: !!g?._worldSync, enabled: !!g?._worldSync?._enabled },
            ring: this.ring.slice(-50),
          };
        },
      };
    }
    if (typeof window !== 'undefined' && window.__voxelDebug) {
      window.__voxelDebug.push('game:ctor', { hasNetwork: !!(options?.network) });
    }

    this.root = root;
    this.character = options.character ?? CHARACTERS[0];
    this.onExit = options.onExit ?? null;
    this.network = options?.network ?? null;
    this.clock = new THREE.Clock();
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // Cap at 1.5 on high-DPI displays: ~30% fewer pixels to shade with barely
    // any perceived quality loss for low-poly voxel art. Major fill-rate win
    // for integrated GPUs and laptops.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.root.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 900);
    this.activeCamera = this.camera;
    this.aerialCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 900);
    this.aerialCamera.up.set(0, 0, -1); // north stays up in the top-down view
    this.input = new Input({ target: this.renderer.domElement });
    this.audio = new GameAudio();
    this.effects = new Effects(this.scene);
    this.effects.camera = this.camera; // for camera-facing slash marks
    this.inventory = new Inventory(this.character);
    // Pre-allocated input action names for hotbar slots to avoid template
    // literal allocs in the per-frame loop.
    this._weaponKeys = ["weapon1","weapon2","weapon3","weapon4","weapon5","weapon6","weapon7","weapon8"];
    this.world = new World(BALANCE.world);
    this.player = new Player(this.camera, {
      ...BALANCE.player,
      maxHealth: this.character.health,
      maxShield: this.character.shield,
      moveSpeed: BALANCE.player.moveSpeed * (this.character.speedMult ?? 1),
    });
    this.player.setPosition(...this.world.getSpawnPoint().toArray());

    // Multiplayer: bind the local world to the server's authoritative one.
    // Server's WorldSeed event will trigger a regenerate so every peer
    // starts from the same procedural base, then mining/placement go through
    // the network. Singleplayer skips this entirely — no-op when no network.
    if (this.network && typeof this.network.getBridge === 'function') {
      const bridge = this.network.getBridge();
      if (bridge) {
        this._worldSync = new WorldSync(this.world, bridge, {
          onWorldRebuilt: () => {
            // Multiplayer: trust the server's authoritative player position
            // (PLAYER_SPAWN_Y = 1) instead of the client's terrain-aware
            // getSpawnPoint() which puts the player at Y≈9. Without this
            // the local player floats 8 units above the ground and never
            // sees server-broadcast enemies (which live at Y=1).
            if (!this.player || typeof this.player.setPosition !== 'function') return;
            const selfId = bridge.getSelfSessionId?.();
            const state = bridge.getRoomState?.();
            const me = selfId ? state?.players?.get?.(selfId) : null;
            if (me && Number.isFinite(me.x) && Number.isFinite(me.y) && Number.isFinite(me.z)) {
              this.player.setPosition(me.x, me.y, me.z);
              if (typeof window !== 'undefined' && window.__voxelDebug) {
                window.__voxelDebug.push('player:spawn:server', { x: me.x, y: me.y, z: me.z });
              }
            } else {
              this.player.setPosition(...this.world.getSpawnPoint().toArray());
              if (typeof window !== 'undefined' && window.__voxelDebug) {
                window.__voxelDebug.push('player:spawn:fallback', { reason: 'no server pos' });
              }
            }
          },
        });
        this._worldSync.enable();
      }
    }
    this.weapons = new Weapons({
      camera: this.camera,
      scene: this.scene,
      weapons: BALANCE.weapons,
      callbacks: {
        onHit: (hit) => {
          if (hit.weapon?.id === 'dagger' && hit.point) {
            // Daggers leave the same slash mark as the sword.
            this.effects.slashMark(hit.point, hit.dragon ? BALANCE.slash.dragonSize : BALANCE.slash.zombieSize);
          } else if (hit.point) {
            this.effects.impact(hit.point, hit.weapon?.flashColor ?? 0xffd166);
          }
          if (hit.killed) {
            this.effects.explosion(hit.point);
            this.audio.explosion();
          }
        },
        onProjectileImpact: (hit) => {
          if (hit.point) this.effects.impact(hit.point, hit.weapon?.flashColor ?? 0xcfd6df);
        },
        onBeam: (beam) => {
          this.effects.beam(beam.origin, beam.end, beam.color);
        },
        onTracer: (tracer) => {
          this.effects.tracer(tracer.origin, tracer.end, tracer.color);
        }
      }
    });
    const bounds = {
      minX: -BALANCE.world.width / 2 + 2,
      maxX: BALANCE.world.width / 2 - 2,
      minZ: -BALANCE.world.depth / 2 + 2,
      maxZ: BALANCE.world.depth / 2 - 2,
    };
    this.dragons = new DragonManager(this.scene, {
      count: 0,
      camera: this.camera,
      world: this.world,
      bounds,
      reflectDamage: BALANCE.guard.reflectDamage,
    });
    this.zombies = new ZombieManager(this.scene, {
      bounds,
      camera: this.camera,
      health: BALANCE.zombies.health,
      speed: BALANCE.zombies.speed,
      damage: BALANCE.zombies.damage,
      attackRange: BALANCE.zombies.attackRange,
      attackCooldown: BALANCE.zombies.attackCooldown,
      spawnRadiusMin: BALANCE.zombies.spawnRadiusMin,
      spawnRadiusMax: BALANCE.zombies.spawnRadiusMax,
    });
    this.skeletons = new SkeletonManager(this.scene, { bounds, world: this.world, ...BALANCE.skeletons });
    this.witches = new WitchManager(this.scene, { bounds, world: this.world, ...BALANCE.witches });

    // Multiplayer: route every enemy from server-broadcast state instead of
    // local AI. EnemySync.enable() flips authority on all four managers and
    // subscribes to the bridge's enemySpawn / enemyState / enemyDespawn /
    // dragonFireball events. Singleplayer skips this entirely.
    if (this.network && typeof this.network.getBridge === 'function') {
      const enemyBridge = this.network.getBridge();
      if (enemyBridge) {
        this._enemySync = new EnemySync({
          bridge: enemyBridge,
          zombies: this.zombies,
          skeletons: this.skeletons,
          witches: this.witches,
          dragons: this.dragons,
        });
        this._enemySync.enable();
      }
    }

    // Aggregator that fans hits/effects out to every enemy manager.
    const managers = [this.dragons, this.zombies, this.skeletons, this.witches];
    const lists = () => [this.dragons.dragons, this.zombies.zombies, this.skeletons.skeletons, this.witches.witches];
    this.enemies = {
      managers,
      hitMelee: (o, d, r, dmg, arc) => managers.flatMap((m) => m.hitMelee(o, d, r, dmg, arc)),
      hitBox: (o, f, ri, l, hw, dmg) => managers.flatMap((m) => m.hitBox(o, f, ri, l, hw, dmg)),
      knockback: (c, r, f) => managers.forEach((m) => m.knockback(c, r, f, this.world)),
      slow: (c, r, fac, dur) => managers.forEach((m) => m.slow(c, r, fac, dur)),
      tornadoPull: (c, r, e) => { this.zombies.tornadoPull(c, r, e); this.skeletons.tornadoPull(c, r, e); this.witches.tornadoPull(c, r, e); },
      heal: (c, r, amount) => managers.forEach((m) => m.heal(c, r, amount)),
      hitAllByRay: (ray, dmg) => managers.flatMap((m) => m.hitAllByRay(ray, dmg)),
      hitByRay: (ray, dmg) => {
        let best = null;
        let bestMgr = null;
        for (const m of managers) {
          const peek = m.peekRay(ray);
          if (peek && (!best || peek.distance < best.distance)) { best = peek; bestMgr = m; }
        }
        return best ? bestMgr.applyRayHit(best, dmg) : null;
      },
      anyNear: (pos, radius) => lists().some((list) => list.some((e) => !e.dead && pos.distanceTo(e.mesh.position) < radius)),
      aliveCount: () => managers.reduce((sum, m) => sum + m.getAliveCount(), 0),
    };
    this.enemyTargets = this.enemies; // weapons use hitByRay/hitAllByRay

    // Witches lob healing potions at the nearest wounded monster.
    this.witches.healTargetProvider = (pos) => this.findHealTarget(pos);

    this.hud = new HUD(this.root);
    this.started = false;
    this.state = 'playing'; // 'playing' | 'shop' | 'dead'
    this.wave = 0;
    this.meleeCooldown = 0;
    this.guardCooldown = 0;
    this.dashCooldown = 0;
    this.swordCharging = false;
    this.swordCharge = 0;
    this.viewmodel = null;

    // Hunter hotbar abilities.
    this.bombs = [];
    this.aerialActive = false;
    this.aerialTimer = 0;
    this.aerialCooldown = 0;
    this.slashTimer = 0;
    this.aerialCenter = new THREE.Vector3();
    this.aerialCircle = null;

    // Run progression / economy.
    this.coins = 0;
    this.hasRevive = true; // the heart; consumed on first death
    this.buffs = { damage: 0, speed: 0, health: 0, shield: 0 };
    this.meleeDamage = this.character.loadout === 'katana' ? BALANCE.katana.damage : BALANCE.sword.damage;

    // Samurai parry-buff + dash state.
    this.samuraiBuffActive = false;
    this.samuraiBuffTimer = 0;
    this.parryWindowTimer = 0; // open window in which an attack triggers the buff
    this.samuraiDashCharging = false;
    this.samuraiDashCharge = 0;
    this.samuraiAwaitRelease = false;
    this.altPrevHeld = false;

    // Mage spells.
    this.mage = this.character.loadout === 'spells'
      ? new MageController({
          scene: this.scene, effects: this.effects, world: this.world,
          enemies: this.enemies, player: this.player,
          camera: this.camera, audio: this.audio, hud: this.hud,
        })
      : null;
    this.shop = null;
    this.shopDone = false;
    this.victory = false;
    this.deathTimer = 0;

    // The player cannot leave the map (invisible barrier at the edges).
    this.playerBounds = {
      minX: -BALANCE.world.width / 2 + 1,
      maxX: BALANCE.world.width / 2 - 1,
      minZ: -BALANCE.world.depth / 2 + 1,
      maxZ: BALANCE.world.depth / 2 - 1,
    };

    this.targetOutline = this.createTargetOutline();

    this.scene.add(this.world);
    this.scene.add(this.player.object);
    this.scene.add(this.targetOutline);
    this.addBoundaryBarrier();
    this.setupScene();
    this.bindEvents();
    this.onSelectionChanged();
    // Singleplayer bootstraps wave 1 here. Multiplayer leaves it to the
    // server's WaveDirector — calling startNextWave() in MP would clear the
    // server-broadcast enemies (via clearZombies()) and replace them with
    // local-AI zombies that can't move because authority is 'server'.
    if (!this.network) {
      this.startNextWave();
    } else {
      this.wave = 1;
    }
  }

  grantWaveAmmo() {
    for (const [name, amount] of Object.entries(BALANCE.progression.waveAmmo)) {
      this.weapons.addAmmo(name, amount);
    }
  }

  grantWaveBombs() {
    const bombSlot = this.inventory.slots.find((slot) => slot.abilityId === 'bomb');
    if (bombSlot) bombSlot.count = (bombSlot.count ?? 0) + BALANCE.bomb.waveRefill;
  }

  addBoundaryBarrier() {
    const { minX, maxX, minZ, maxZ } = this.playerBounds;
    const width = maxX - minX;
    const depth = maxZ - minZ;
    const geometry = new THREE.BoxGeometry(width, 60, depth);
    const material = new THREE.MeshBasicMaterial({
      color: 0x6fc3ff,
      transparent: true,
      opacity: 0.08,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const barrier = new THREE.Mesh(geometry, material);
    barrier.position.set((minX + maxX) / 2, 18, (minZ + maxZ) / 2);
    this.scene.add(barrier);
  }

  startNextWave() {
    this.wave += 1;

    // The shop opens once, right before the configured wave, and that is also
    // where you are handed reserve ammo for the guns.
    if (this.wave === BALANCE.progression.shopWave && !this.shopDone) {
      this.grantWaveAmmo();
      this.grantWaveBombs();
      this.openShop();
    }

    // Lots of zombies (increasing), fewer skeletons, fewer witches, fewest dragons.
    const w = this.wave;
    this.zombies.spawnWave(2 + w, this.player, this.world);
    this.skeletons.spawnWave(Math.ceil(w * 0.6), this.player, this.world);
    this.witches.spawnWave(Math.floor(w * 0.35), this.player, this.world);
    this.dragons.spawnWave(Math.max(1, Math.ceil(w * 0.3)));
    this.hud.showMessage(`Oleada ${this.wave}`, 1500);
  }

  setupScene() {
    this.scene.background = new THREE.Color(BALANCE.colors.sky);
    this.scene.fog = new THREE.Fog(BALANCE.colors.sky, 80, 340);
    const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x31451e, 1.5);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff0c5, 2.4);
    sun.position.set(70, 120, 50);
    sun.castShadow = true;
    sun.shadow.camera.left = -90;
    sun.shadow.camera.right = 90;
    sun.shadow.camera.top = 90;
    sun.shadow.camera.bottom = -90;
    this.scene.add(sun);
  }

  bindEvents() {
    window.addEventListener('resize', () => this.resize());
    this.renderer.domElement.addEventListener('click', () => {
      this.audio.unlock();
      this.input.requestPointerLock();
      this.started = true;
    });
    this.renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  start() {
    this.renderer.setAnimationLoop(() => this.tick());
    if (typeof window !== 'undefined') {
      window.__voxelGame = this;
      window.__voxelDebug?.push?.('game:start', { network: !!this.network });
    }
  }

  tick() {
    const rawDelta = this.clock.getDelta();
    const delta = Math.min(rawDelta, 0.05);
    if (rawDelta > 0) {
      const instant = 1 / rawDelta;
      this.fps = this.fps ? this.fps + (instant - this.fps) * 0.1 : instant; // smoothed
    }

    // Death screen: everything is frozen; return to the menu after 3 seconds.
    if (this.state === 'dead') {
      this.deathTimer -= delta;
      if (this.deathTimer <= 0) {
        this.exitToMenu();
        return;
      }
      this.renderer.render(this.scene, this.camera);
      this.input.update();
      return;
    }

    // Shop is open: the run is paused while buffs are purchased.
    if (this.state === 'shop') {
      this.renderer.render(this.scene, this.camera);
      this.input.update();
      return;
    }

    // Hunter aerial view: top-down, the player is frozen and invulnerable while
    // the world keeps running, then a slash burst resolves it.
    if (this.aerialActive) {
      this.aerialTimer -= delta;
      // The player can still move (attacks/abilities are disabled); the camera
      // and the circle follow them from above.
      this.player.update(delta, this.input, this.world);
      this.clampPlayerToBounds();
      this.aerialCenter.copy(this.player.object.position);
      if (this.aerialCircle) {
        this.aerialCircle.position.copy(this.aerialCenter);
        this.aerialCircle.position.y += 0.12;
      }
      this.world.update(delta);
      this.dragons.update(delta, this.player, this.scene);
      this.zombies.update(delta, this.player, this.world);
      this.skeletons.update(delta, this.player, this.world);
      this.witches.update(delta, this.player, this.world);
      this.handleZombieEvents();
      this.handleSkeletonArrows();
      this.handleWitchPotions();
      this.handleDragonFireballs(delta);
      this.updateBombs(delta);
      this.weapons.update(delta);
      this.effects.update(delta);
      this.updateAerialCamera();
      if (this.aerialTimer <= 0) this.endAerial();
      this.renderHud();
      this.renderer.render(this.scene, this.activeCamera);
      this.input.update();
      return;
    }

    this.meleeCooldown = Math.max(0, this.meleeCooldown - delta);
    this.guardCooldown = Math.max(0, this.guardCooldown - delta);
    this.dashCooldown = Math.max(0, this.dashCooldown - delta);
    this.aerialCooldown = Math.max(0, this.aerialCooldown - delta);
    this.player.updateGuard(delta);
    this.updateSamuraiState(delta);

    if (this.input.consume('reload')) {
      this.weapons.reload();
      this.audio.reload();
    }
    if (this.input.consume('interact')) {
      this.inventory.toggleOpen();
    }
    if (this.input.consume('weaponNext')) {
      this.inventory.next();
      this.onSelectionChanged();
    }
    if (this.input.consume('weaponPrev')) {
      this.inventory.previous();
      this.onSelectionChanged();
    }
    // Pre-built once in the constructor to skip the per-tick template-literal
    // alloc (~480 strings/sec/player at 8 slots × 60 Hz before this change).
    const weaponKeys = this._weaponKeys;
    const slotCount = Math.min(this.inventory.slots.length, weaponKeys.length);
    for (let i = 0; i < slotCount; i += 1) {
      if (this.input.consume(weaponKeys[i])) {
        this.inventory.select(i);
        this.onSelectionChanged();
      }
    }
    // Right click and the F key both trigger the character's secondary action.
    const altQueued = this.input.consume('alternate');
    if (this.character.ability === 'samurai') {
      this.handleSamuraiSecondary(delta);
    } else if (altQueued) {
      this.useSecondaryAction();
    }
    // Debug: P clears the round's enemies, jumping to the next wave. Once the
    // run is won, P instead drops you into a training ground of static zombies.
    if (this.input.consume('debugSkipWave')) {
      if (this.victory) {
        this.enterTrainingGround();
      } else {
        this.dragons.clearDragons();
        this.zombies.clearZombies();
        this.skeletons.clearSkeletons();
        this.witches.clearWitches();
      }
    }

    // Player.update() must run FIRST in multiplayer too, because it now
    // performs look() (mouse → camera rotation) before its authority guard.
    // Without this, the camera wouldn't rotate in MP and the cmd built below
    // would carry a stale rotationY.
    this.player.update(delta, this.input, this.world);

    if (this.network && this.player && typeof this.player.buildInputCommand === 'function') {
      // Now reads the freshly-rotated camera so the server sees what the
      // player is actually looking at this tick.
      const cmd = this.player.buildInputCommand(this.input, delta);
      this.network.pushInput(cmd);
      // CSP: Player.update() early-returns inside its authority guard when
      // networkAuthority='server', so we drive the movement pipeline here.
      // The server snapshot reconciles via applyServerSnapshot() when it
      // arrives.
      if (typeof this.player.applyInput === 'function' && this.player.networkAuthority === 'server') {
        this.player.applyInput(cmd, delta, this.world);
        if (typeof this.player.recordSnapshot === 'function') {
          this.player.recordSnapshot(cmd);
        }
      }
    }
    this.clampPlayerToBounds();
    this.world.update(delta);
    if (this.mage) this.mage.update(delta); // before enemies so the tornado can lift them
    this.dragons.update(delta, this.player, this.scene);
    this.zombies.update(delta, this.player, this.world);
    this.skeletons.update(delta, this.player, this.world);
    this.witches.update(delta, this.player, this.world);
    this.handleZombieEvents();
    this.handleSkeletonArrows();
    this.handleWitchPotions();

    // Coins are earned by killing enemies.
    this.coins += this.dragons.consumeKills() * BALANCE.coins.dragon
      + this.zombies.consumeKills() * BALANCE.coins.zombie
      + this.skeletons.consumeKills() * BALANCE.coins.skeleton
      + this.witches.consumeKills() * BALANCE.coins.witch;

    if (!this.victory && this.enemies.aliveCount() === 0) {
      this.advanceWave();
    }
    this.weapons.update(delta);
    this.updateBombs(delta);
    this.updateSlashPhase(delta);
    this.effects.update(delta);

    // Left click and the E key both attack / use the selected item.
    const attackClicked = this.input.consume('attack');
    const attacking = this.input.pointerLocked && (this.input.isDown('Mouse0') || this.input.isDown('KeyE'));
    const attackSlot = this.inventory.selectedSlot;
    if (attackSlot?.kind === 'melee' && this.character.loadout === 'katana') {
      // Samurai katana: simple slash (faster/stronger while buffed).
      if (attacking) this.meleeAttack();
    } else if (attackSlot?.kind === 'melee') {
      // Knight sword: hold to charge a stronger attack, release to swing.
      if (attacking) {
        this.swordCharging = true;
        this.swordCharge += delta;
      } else if (this.swordCharging) {
        this.releaseSwordAttack(this.swordCharge);
        this.swordCharging = false;
        this.swordCharge = 0;
      }
      this.updateSwordChargeVisual();
    } else if (attackSlot?.kind === 'weapon') {
      if (attacking) this.handleFire();
    } else if (attackSlot?.kind === 'ability') {
      if (this.input.pointerLocked && attackClicked) this.useAbility(attackSlot);
    } else if (attackSlot?.kind === 'block') {
      if (this.input.pointerLocked && attackClicked) this.mineTargetBlock();
    }

    this.handleDragonFireballs(delta);

    if (!this.player.isAlive) {
      this.handlePlayerDeath();
    }

    this.updateTargetOutline();
    this.effects.applyCameraShake(this.camera);
    this.renderHud();

    this.network?.tickFrame?.(performance.now());
    this.renderer.render(this.scene, this.activeCamera);
    this.input.update();
  }

  renderHud() {
    // Samurai katana icon reflects whether the blade is drawn (buff active).
    if (this.character.loadout === 'katana' && this.inventory.slots[0]) {
      this.inventory.slots[0].icon = this.samuraiBuffActive ? 'katana-drawn' : 'katana-sheathed';
    }
    const selectedSlot = this.inventory.selectedSlot;
    const isMelee = selectedSlot?.kind === 'melee';
    const weaponId = selectedSlot?.kind === 'weapon' ? this.weapons.currentWeapon?.id : null;
    const isGun = Boolean(weaponId) && weaponId !== 'dagger';
    const ammoState = this.weapons.getAmmoState(true);
    const infiniteAmmo = this.weapons.currentWeapon?.infiniteAmmo;
    this.hud.update({
      health: this.player.health,
      maxHealth: this.player.maxHealth,
      shield: this.player.shield,
      maxShield: this.player.maxShield,
      shieldLabel: this.character.manaName ? 'Maná' : 'Escudo',
      ammo: ammoState,
      // Only the duck's guns show ammo (clip / reserve). Sword and dagger hide it.
      ammoText: isGun ? (infiniteAmmo ? '∞' : `${ammoState.ammo} / ${ammoState.reserveAmmo}`) : '',
      weapon: isMelee ? selectedSlot.label : (selectedSlot?.kind === 'ability' ? selectedSlot.label : this.weapons.getCurrentWeaponName()),
      dragons: this.dragons.getAliveCount(),
      dragonsTotal: this.dragons.dragons.length,
      zombies: this.zombies.getAliveCount(),
      skeletons: this.skeletons.getAliveCount(),
      witches: this.witches.getAliveCount(),
      coins: this.coins,
      revive: this.hasRevive,
      guard: this.player.guardActive,
      wave: this.wave,
      waveCount: BALANCE.progression.waveCount,
      fps: this.fps,
      inventory: this.inventory.snapshot(),
      locked: this.input.pointerLocked
    });
  }

  clampPlayerToBounds() {
    const pos = this.player.object.position;
    pos.x = THREE.MathUtils.clamp(pos.x, this.playerBounds.minX, this.playerBounds.maxX);
    pos.z = THREE.MathUtils.clamp(pos.z, this.playerBounds.minZ, this.playerBounds.maxZ);
  }

  advanceWave() {
    // In multiplayer the server is the wave director — the client cannot
    // unilaterally jump waves. Bail out so we don't clear/spawn local AI
    // entities on top of the server-broadcast roster.
    if (this.network) return;
    if (this.wave >= BALANCE.progression.waveCount) {
      this.triggerVictory();
      return;
    }
    this.startNextWave();
  }

  triggerVictory() {
    this.victory = true;
    this.hud.showMessage('¡Has ganado! 🎉 Pulsa P para el campo de entrenamiento', 8000);
  }

  enterTrainingGround() {
    this.dragons.clearDragons();
    this.skeletons.clearSkeletons();
    this.witches.clearWitches();

    // Flat arena, then place the player and the practice targets.
    this.world.generateFlat(5);
    const top = this.world.flatTop ?? 5;
    this.player.revive();
    this.player.setPosition(0, top + 2, 16);
    this.player.cameraHolder.rotation.y = 0; // face the rows (-Z)
    this.player.pitchHolder.rotation.x = 0;

    this.zombies.spawnTrainingGround(this.player, this.world);
    this.hud.showMessage('Campo de entrenamiento', 2000);
  }

  handlePlayerDeath() {
    if (this.hasRevive) {
      // First death: the heart greys out and you respawn normally.
      this.hasRevive = false;
      this.respawnPlayer();
    } else {
      // Second death: game over.
      this.triggerGameOver();
    }
  }

  triggerGameOver() {
    this.state = 'dead';
    this.deathTimer = 3;
    this.hud.showDeathScreen();
    this.input.exitPointerLock();
  }

  exitToMenu() {
    if (this._exited) return;
    this._exited = true;
    this.dispose();
    this.onExit?.();
  }

  openShop() {
    this.state = 'shop';
    this.input.exitPointerLock();
    this.shop = new Shop(this.root, {
      items: BALANCE.shop.items,
      getCoins: () => this.coins,
      getOwned: (id) => this.buffs[id] ?? 0,
      onBuy: (item) => this.buyBuff(item),
      onClose: () => this.closeShop(),
    });
  }

  closeShop() {
    this.shop?.hide?.();
    this.shop = null;
    this.shopDone = true;
    this.state = 'playing';
  }

  buyBuff(item) {
    if (this.coins < item.cost) return false;
    this.coins -= item.cost;
    this.buffs[item.id] = (this.buffs[item.id] ?? 0) + 1;
    this.applyBuff(item.id);
    return true;
  }

  applyBuff(id) {
    switch (id) {
      case 'damage':
        this.weapons.scaleDamage(1.25);
        this.meleeDamage *= 1.25;
        break;
      case 'speed':
        this.player.config.moveSpeed *= 1.15;
        break;
      case 'health':
        this.player.maxHealth += 40;
        this.player.health = Math.min(this.player.maxHealth, this.player.health + 40);
        break;
      case 'shield':
        this.player.maxShield += 25;
        this.player.shield = Math.min(this.player.maxShield, this.player.shield + 25);
        break;
      default:
        break;
    }
  }

  handleFire() {
    const fired = this.weapons.fire({
      scene: this.scene,
      world: this.world,
      dragons: this.enemyTargets,
      effects: this.effects,
      camera: this.camera
    });
    if (fired) {
      this.audio.shoot(this.weapons.getCurrentWeaponName());
    }
  }

  applyMeleeHits(groundHits, dragonHits, color = 0xffffff, sizeMult = 1) {
    for (const hit of groundHits) {
      this.effects.slashMark(hit.position, BALANCE.slash.zombieSize * sizeMult, color);
      if (hit.killed) {
        this.effects.explosion(hit.position);
        this.audio.explosion();
      }
    }
    for (const hit of dragonHits) {
      this.effects.slashMark(hit.position, BALANCE.slash.dragonSize * sizeMult, color);
      if (hit.killed) {
        this.effects.explosion(hit.position);
        this.audio.explosion();
      }
    }
  }

  meleeAttack() {
    if (this.meleeCooldown > 0) return;

    const katana = this.character.loadout === 'katana';
    const buffed = katana && this.samuraiBuffActive;
    this.meleeCooldown = katana
      ? (buffed ? BALANCE.katana.buffCooldown : BALANCE.katana.cooldown)
      : BALANCE.sword.cooldown;
    const range = katana ? BALANCE.katana.range : BALANCE.sword.range;
    const arcCos = katana ? BALANCE.katana.arcCos : BALANCE.sword.arcCos;
    const damage = buffed ? this.meleeDamage * BALANCE.katana.buffDamageMult : this.meleeDamage;
    const color = buffed ? 0xff6a3c : 0xffffff;
    const sizeMult = buffed ? 1.25 : 1;

    const origin = this.getCameraWorldPosition();
    const direction = this.getLookDirection();
    const groundHits = [
      ...this.zombies.hitMelee(origin, direction, range, damage, arcCos),
      ...this.skeletons.hitMelee(origin, direction, range, damage, arcCos),
    ];
    const dragonHits = this.dragons.hitMelee(origin, direction, range, damage, arcCos);
    this.applyMeleeHits(groundHits, dragonHits, color, sizeMult);
  }

  getForwardHorizontal() {
    const yaw = this.player.cameraHolder.rotation.y;
    return new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  }

  updateSamuraiState(delta) {
    // Open parry window: invulnerable until it closes; a hit during it triggers the buff.
    if (this.parryWindowTimer > 0) {
      this.parryWindowTimer -= delta;
      if (this.parryWindowTimer <= 0) {
        this.parryWindowTimer = 0;
        this.player.invulnerable = false;
      }
    }
    if (this.samuraiBuffActive) {
      this.samuraiBuffTimer -= delta;
      if (this.samuraiBuffTimer <= 0) {
        this.samuraiBuffActive = false;
        this.samuraiBuffTimer = 0;
        this.updateViewmodel(); // re-sheathe when the buff expires
      }
    }
  }

  handleSamuraiSecondary(delta) {
    const altHeld = this.input.pointerLocked && (this.input.isDown('Mouse2') || this.input.isDown('KeyF'));
    const altPressed = altHeld && !this.altPrevHeld;
    const altReleased = !altHeld && this.altPrevHeld;

    if (!this.samuraiBuffActive) {
      if (altPressed) {
        this.samuraiParry(); // opens the window; the buff only triggers if hit
        this.samuraiAwaitRelease = true;
      }
    } else if (this.samuraiAwaitRelease) {
      if (altReleased) this.samuraiAwaitRelease = false;
    } else if (altHeld) {
      this.samuraiDashCharging = true;
      this.samuraiDashCharge = Math.min(this.samuraiDashCharge + delta, BALANCE.katana.dashMaxCharge);
      // At max charge it fires whether or not the button is still held.
      if (this.samuraiDashCharge >= BALANCE.katana.dashMaxCharge) {
        this.samuraiDash(this.samuraiDashCharge);
        this.samuraiDashCharging = false;
        this.samuraiDashCharge = 0;
        this.samuraiAwaitRelease = true;
      }
    } else if (this.samuraiDashCharging) {
      this.samuraiDash(this.samuraiDashCharge);
      this.samuraiDashCharging = false;
      this.samuraiDashCharge = 0;
    }

    this.altPrevHeld = altHeld;
  }

  // Opens the parry window. No buff yet — an enemy must connect within it.
  samuraiParry() {
    if (this.samuraiBuffActive) return;
    this.parryWindowTimer = BALANCE.katana.parryWindow;
    this.player.invulnerable = true;
    this.effects.impact(this.player.object.position, 0x9fd0ff);
    this.audio.reload();
  }

  // Called when an attack lands during the parry window.
  samuraiParrySuccess() {
    if (this.samuraiBuffActive) return;
    this.samuraiBuffActive = true;
    this.samuraiBuffTimer = BALANCE.katana.buffDuration;

    const center = this.player.object.position;
    this.enemies.knockback(center, BALANCE.katana.parryRadius, BALANCE.katana.parryKnockback);

    this.effects.shockwave(center.clone(), BALANCE.katana.parryRadius, 0x9fd0ff);
    this.audio.explosion();
    this.hud.showMessage('¡Parry! Ataques potenciados 10s', 1500);
    this.updateViewmodel(); // unsheathe the katana
  }

  samuraiDash(charge) {
    const k = BALANCE.katana;
    const t = Math.min(charge / k.dashMaxCharge, 1);
    const length = THREE.MathUtils.lerp(k.dashMinLength, k.dashMaxLength, t);
    const halfWidth = THREE.MathUtils.lerp(k.dashMinWidth, k.dashMaxWidth, t) / 2;
    const damage = THREE.MathUtils.lerp(k.dashMinDamage, k.dashMaxDamage, t);

    const origin = this.player.object.position.clone();
    const forward = this.getForwardHorizontal();
    const right = new THREE.Vector3(forward.z, 0, -forward.x);

    // Dash forward (stops at walls via the player's collision).
    this.player.lastMoveDir.copy(forward);
    this.player.startDash(length, k.dashSpeed);

    this.enemies.hitBox(origin, forward, right, length, halfWidth, damage);

    const slashes = Math.round(length * 4);
    for (let i = 0; i < slashes; i += 1) {
      const along = (i / slashes) * length + (Math.random() - 0.5);
      const side = (Math.random() - 0.5) * 2 * halfWidth;
      const pos = origin.clone()
        .addScaledVector(forward, Math.max(0, along))
        .addScaledVector(right, side);
      pos.y += 0.6 + Math.random() * 1.8;
      this.effects.slashMark(pos, 1.4 + Math.random() * 0.9, 0xffffff);
    }
    this.audio.explosion();

    // The strike consumes the buff.
    this.samuraiBuffActive = false;
    this.samuraiBuffTimer = 0;
    this.updateViewmodel(); // re-sheathe
  }

  releaseSwordAttack(charge) {
    if (charge >= BALANCE.sword.aoeCharge) {
      this.circularAoe();
    } else if (charge >= BALANCE.sword.sweepCharge) {
      this.giantSweep();
    } else {
      this.meleeAttack();
    }
  }

  giantSweep() {
    const origin = this.getCameraWorldPosition();
    const direction = this.getLookDirection();
    const { sweepRange, sweepArcCos, sweepDamageMult } = BALANCE.sword;
    const damage = this.meleeDamage * sweepDamageMult;

    const groundHits = [
      ...this.zombies.hitMelee(origin, direction, sweepRange, damage, sweepArcCos),
      ...this.skeletons.hitMelee(origin, direction, sweepRange, damage, sweepArcCos),
    ];
    const dragonHits = this.dragons.hitMelee(origin, direction, sweepRange, damage, sweepArcCos);
    this.applyMeleeHits(groundHits, dragonHits, 0x4aa0ff, 1.4);

    // Big blue slash in the look direction.
    const center = this.player.object.position.clone();
    center.y += this.player.config.height * 0.6;
    center.addScaledVector(direction, sweepRange * 0.4);
    this.effects.slashMark(center, sweepRange, 0x4aa0ff);
    this.audio.explosion();
  }

  circularAoe() {
    const origin = this.getCameraWorldPosition();
    const direction = this.getLookDirection();
    const { aoeRadius, aoeDamageMult } = BALANCE.sword;
    const damage = this.meleeDamage * aoeDamageMult;

    // arcCos of -1 makes the hit ignore direction (full 360° circle).
    const groundHits = [
      ...this.zombies.hitMelee(origin, direction, aoeRadius, damage, -1),
      ...this.skeletons.hitMelee(origin, direction, aoeRadius, damage, -1),
    ];
    const dragonHits = this.dragons.hitMelee(origin, direction, aoeRadius, damage, -1);
    this.applyMeleeHits(groundHits, dragonHits, 0xffffff, 1.2);

    const center = this.player.object.position.clone();
    center.y += 0.2;
    this.effects.shockwave(center, aoeRadius, 0xffffff);
    this.audio.explosion();
  }

  updateSwordChargeVisual() {
    if (!this.viewmodel) return;
    let emissive = 0x000000;
    let intensity = 0;
    if (this.swordCharging) {
      if (this.swordCharge >= BALANCE.sword.aoeCharge) {
        emissive = 0xffffff;
        intensity = 1.6;
      } else if (this.swordCharge >= BALANCE.sword.sweepCharge) {
        emissive = 0x2a6bff;
        intensity = 1.3;
      }
    }
    this.viewmodel.traverse((child) => {
      if (child.material?.emissive) {
        child.material.emissive.setHex(emissive);
        child.material.emissiveIntensity = intensity;
      }
    });
  }

  activateGuard() {
    if (this.guardCooldown > 0 || this.player.guardActive) return;
    this.player.activateGuard(BALANCE.guard.duration);
    this.guardCooldown = BALANCE.guard.duration + BALANCE.guard.cooldown;
    this.effects.impact(this.player.object.position, 0x9fe8ff);
  }

  handleZombieEvents() {
    for (const event of this.zombies.consumeEvents()) {
      if (event.type === 'attack') {
        // A hit during the samurai parry window triggers the buff (no damage).
        if (this.parryWindowTimer > 0 && !this.samuraiBuffActive) {
          this.samuraiParrySuccess();
          continue;
        }
        if (this.player.invulnerable) continue;
        this.player.damage(event.damage);
        this.hud.flashDamage();
        this.audio.damage();
      } else if (event.type === 'parry') {
        this.effects.impact(event.position, 0x9fe8ff);
      }
    }
  }

  onSelectionChanged() {
    this.syncSelectedWeapon();
    this.updateViewmodel();
  }

  syncSelectedWeapon() {
    const slot = this.inventory.selectedSlot;
    if (slot?.kind === 'weapon') {
      this.weapons.switchWeapon(slot.weaponIndex);
    }
  }

  updateViewmodel() {
    if (this.viewmodel) {
      this.camera.remove(this.viewmodel);
      disposeViewmodel(this.viewmodel);
      this.viewmodel = null;
    }

    const slot = this.inventory.selectedSlot;
    let kind = null;
    if (slot?.kind === 'melee') {
      kind = slot.model || 'sword';
      if (kind === 'katana' && this.samuraiBuffActive) kind = 'katana-drawn';
    } else if (slot?.kind === 'weapon') {
      const label = (slot.label ?? '').toLowerCase();
      if (label.includes('rifle')) kind = 'rifle';
      else if (label.includes('shotgun')) kind = 'shotgun';
      else if (label.includes('blaster')) kind = 'blaster';
      else if (label.includes('pistola')) kind = 'pistol';
      else if (label.includes('daga')) kind = 'dagger';
    }

    const model = kind ? buildViewmodel(kind) : null;
    if (model) {
      this.camera.add(model);
      this.viewmodel = model;
    }
  }

  useSecondaryAction() {
    switch (this.character.ability) {
      case 'guard':
        this.activateGuard();
        break;
      case 'dash':
        this.activateDash();
        break;
      default:
        this.placeSelectedBlock();
        break;
    }
  }

  activateDash() {
    if (this.dashCooldown > 0) return;
    if (this.player.startDash(BALANCE.dash.distance, BALANCE.dash.speed)) {
      this.dashCooldown = BALANCE.dash.cooldown;
      this.effects.impact(this.player.object.position, 0xbfe0ff);
    }
  }

  useAbility(slot) {
    if (slot.abilityId === 'bomb') {
      if ((slot.count ?? 0) > 0) {
        this.placeBomb();
        slot.count -= 1;
      }
    } else if (slot.abilityId === 'aerial') {
      this.activateAerial();
    } else if (this.mage && BALANCE.mage.skills[slot.abilityId]) {
      this.mage.tryCast(slot.abilityId);
    }
  }

  placeBomb() {
    const pos = this.player.object.position.clone();
    pos.y += 0.4;
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.6 }),
    );
    const fuse = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.26, 6),
      new THREE.MeshBasicMaterial({ color: 0xff4040 }),
    );
    fuse.position.y = 0.4;
    group.add(body, fuse);
    group.position.copy(pos);
    this.scene.add(group);
    this.bombs.push({ position: pos, timer: BALANCE.bomb.fuse, mesh: group, blink: 0 });
    this.audio.reload();
  }

  updateBombs(delta) {
    for (let i = this.bombs.length - 1; i >= 0; i -= 1) {
      const bomb = this.bombs[i];
      bomb.timer -= delta;
      bomb.blink += delta;
      const fuse = bomb.mesh.children[1];
      const rate = Math.max(0.05, bomb.timer * 0.22);
      fuse.material.color.setHex(Math.sin(bomb.blink / rate) > 0 ? 0xff2020 : 0xffd060);
      bomb.mesh.scale.setScalar(1 + Math.sin(bomb.blink * 14) * 0.06);

      if (bomb.timer <= 0) {
        this.explodeBomb(bomb);
        this.scene.remove(bomb.mesh);
        bomb.mesh.traverse((child) => {
          child.geometry?.dispose?.();
          child.material?.dispose?.();
        });
        this.bombs.splice(i, 1);
      }
    }
  }

  explodeBomb(bomb) {
    const { radius, damage, playerDamage } = BALANCE.bomb;
    const center = bomb.position;
    this.effects.explosion(center);
    this.audio.explosion();

    const dir = new THREE.Vector3(1, 0, 0);
    this.enemies.hitMelee(center, dir, radius, damage, -1);

    if (this.player.object.position.distanceTo(center) <= radius) {
      this.player.damage(playerDamage);
      if (!this.player.invulnerable) {
        this.hud.flashDamage();
        this.audio.damage();
      }
    }
  }

  activateAerial() {
    if (this.aerialActive || this.aerialCooldown > 0) return;
    this.aerialActive = true;
    this.aerialTimer = BALANCE.aerial.duration;
    this.aerialCenter.copy(this.player.object.position);
    this.player.invulnerable = true;
    // Screen-aligned movement: the aerial camera is north-up (-Z), so WASD maps
    // to screen directions (W = toward the top of the screen).
    this.player.movementYaw = 0;
    this.activeCamera = this.aerialCamera;
    this.showAerialCircle();
  }

  showAerialCircle() {
    this.removeAerialCircle();
    const geometry = new THREE.CircleGeometry(BALANCE.aerial.radius, 48);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: 0x66ccff,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.aerialCircle = new THREE.Mesh(geometry, material);
    this.aerialCircle.position.copy(this.aerialCenter);
    this.aerialCircle.position.y += 0.12;
    this.scene.add(this.aerialCircle);
  }

  removeAerialCircle() {
    if (this.aerialCircle) {
      this.scene.remove(this.aerialCircle);
      this.aerialCircle.geometry.dispose();
      this.aerialCircle.material.dispose();
      this.aerialCircle = null;
    }
  }

  updateAerialCamera() {
    const c = this.aerialCenter;
    this.aerialCamera.position.set(c.x, c.y + 28, c.z);
    this.aerialCamera.lookAt(c.x, c.y, c.z);
    this.aerialCamera.updateMatrixWorld();
  }

  endAerial() {
    this.aerialActive = false;
    this.activeCamera = this.camera;
    this.player.invulnerable = false;
    this.player.movementYaw = null; // restore facing-relative movement
    this.aerialCooldown = BALANCE.aerial.cooldown;
    this.removeAerialCircle();

    const dir = new THREE.Vector3(1, 0, 0);
    this.enemies.hitMelee(this.aerialCenter, dir, BALANCE.aerial.radius, BALANCE.aerial.damage, -1);
    this.audio.explosion();
    this.slashTimer = BALANCE.aerial.slashDuration;
  }

  updateSlashPhase(delta) {
    if (this.slashTimer <= 0) return;
    this.slashTimer -= delta;
    for (let i = 0; i < 3; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * BALANCE.aerial.radius;
      const pos = new THREE.Vector3(
        this.aerialCenter.x + Math.cos(angle) * r,
        this.aerialCenter.y + 0.6 + Math.random() * 1.8,
        this.aerialCenter.z + Math.sin(angle) * r,
      );
      this.effects.slashMark(pos, 1.4 + Math.random() * 0.9, 0xffffff);
    }
  }

  mineTargetBlock() {
    if (!this.character.canPlaceBlocks) return;
    const hit = this.world.raycastBlock(this.getCameraWorldPosition(), this.getLookDirection(), BALANCE.world.interactionRange);
    if (!hit || hit.type === 'water') return;
    if (this.world.removeBlock(hit)) {
      this.inventory.addBlock(hit.type);
      this.effects.impact(hit.point, 0xffffff);
    }
  }

  placeSelectedBlock() {
    if (!this.character.canPlaceBlocks) return;
    if (!this.inventory.canPlaceSelected()) return;
    const hit = this.world.raycastBlock(this.getCameraWorldPosition(), this.getLookDirection(), BALANCE.world.interactionRange);
    if (!hit) return;
    const type = this.inventory.selectedSlot.type;
    if (this.world.addBlock(hit, type)) {
      this.inventory.consumeSelectedBlock();
      this.effects.impact(hit.point, this.inventory.selectedSlot.color);
    }
  }

  respawnPlayer() {
    this.player.revive();
    this.player.setPosition(...this.world.getSpawnPoint().toArray());
    this.samuraiBuffActive = false;
    this.samuraiBuffTimer = 0;
    this.parryWindowTimer = 0;
    this.samuraiDashCharging = false;
    this.samuraiDashCharge = 0;
    this.updateViewmodel();
    this.hud.flashDamage();
    this.hud.showMessage('Has reaparecido', 1200);
  }

  handleDragonFireballs() {
    for (const ball of this.dragons.consumeImpacts()) {
      this.effects.explosion(ball.position);
      this.audio.explosion();
      if (ball.hitPlayer && ball.damage > 0) {
        if (this.parryWindowTimer > 0 && !this.samuraiBuffActive) {
          this.samuraiParrySuccess();
          continue;
        }
        if (this.player.invulnerable) continue;
        this.player.damage(ball.damage);
        this.hud.flashDamage();
        this.audio.damage();
      }
    }
  }

  handleSkeletonArrows() {
    for (const arrow of this.skeletons.consumeImpacts()) {
      this.effects.impact(arrow.position, 0xe8e6dc);
      if (arrow.hitPlayer && arrow.damage > 0) {
        if (this.parryWindowTimer > 0 && !this.samuraiBuffActive) {
          this.samuraiParrySuccess();
          continue;
        }
        if (this.player.invulnerable) continue;
        this.player.damage(arrow.damage);
        this.hud.flashDamage();
        this.audio.damage();
      }
    }
  }

  // Nearest wounded monster for a witch to throw a healing potion at.
  findHealTarget(pos) {
    let best = null;
    let bestDist = this.witches.throwRange;
    for (const list of [this.zombies.zombies, this.skeletons.skeletons, this.witches.witches, this.dragons.dragons]) {
      for (const e of list) {
        if (e.dead || e.dummy || e.health >= e.maxHealth) continue;
        const d = pos.distanceTo(e.mesh.position);
        if (d < bestDist) { bestDist = d; best = e.mesh.position; }
      }
    }
    return best ? best.clone() : null;
  }

  handleWitchPotions() {
    for (const event of this.witches.consumeEvents()) {
      if (event.type !== 'heal') continue;
      this.enemies.heal(event.position, event.radius, event.amount);
      this.effects.shockwave(event.position.clone(), event.radius, 0x66ff9c);
      this.effects.impact(event.position, 0x9cffc0);
    }
  }

  getLookDirection() {
    return this.camera.getWorldDirection(new THREE.Vector3());
  }

  getCameraWorldPosition() {
    return this.camera.getWorldPosition(new THREE.Vector3());
  }

  createTargetOutline() {
    const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.03, 1.03, 1.03));
    const material = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    const outline = new THREE.LineSegments(geometry, material);
    outline.visible = false;
    return outline;
  }

  updateTargetOutline() {
    const hit = this.world.raycastBlock(this.getCameraWorldPosition(), this.getLookDirection(), BALANCE.world.interactionRange);
    if (!hit || hit.type === 'water') {
      this.targetOutline.visible = false;
      return;
    }
    this.targetOutline.visible = true;
    this.targetOutline.position.set(hit.position.x + 0.5, hit.position.y + 0.5, hit.position.z + 0.5);
  }

  resize() {
    const aspect = window.innerWidth / window.innerHeight;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.aerialCamera.aspect = aspect;
    this.aerialCamera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this._worldSync?.disable?.();
    this._worldSync = null;
    this._enemySync?.disable?.();
    this._enemySync = null;
    this.input.dispose?.();
    this.hud.destroy?.();
    this.shop?.hide?.();
    this.removeAerialCircle();
    this.mage?.dispose?.();
    for (const bomb of this.bombs) this.scene.remove(bomb.mesh);
    this.bombs.length = 0;
    this.dragons.dispose?.();
    this.zombies.dispose?.();
    this.skeletons.dispose?.();
    this.witches.dispose?.();
    this.world.dispose?.();
    if (this.viewmodel) {
      this.camera.remove(this.viewmodel);
      disposeViewmodel(this.viewmodel);
      this.viewmodel = null;
    }
    this.renderer.domElement.remove();
    this.renderer.dispose?.();
  }
}
