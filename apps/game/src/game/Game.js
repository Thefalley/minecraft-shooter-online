import * as THREE from 'three';
import { World } from '../engine/World.js';
import { Player } from './Player.js';
import { Weapons } from './combat/Weapons.js';
import { DragonManager } from './enemies/DragonManager.js';
import { ZombieManager } from './enemies/ZombieManager.js';
import { SkeletonManager } from './enemies/SkeletonManager.js';
import { WitchManager } from './enemies/WitchManager.js';
import { createEnemyAggregator } from './enemies/EnemyAggregator.js';
import { Profiler, profilerEnabledByDefault } from '../dev/Profiler.js';
import { installProfileExporter } from '../dev/profileExporter.js';
import { NetworkMetrics } from '../dev/NetworkMetrics.js';
import { HUD } from '../ui/HUD.js';
import { Effects } from '../engine/Effects.js';
import { Inventory } from './Inventory.js';
import { CHARACTERS } from '../content/characters/Characters.js';
import { MAPS } from '../content/maps/index.js';
import { buildViewmodel, disposeViewmodel } from '../engine/Viewmodels.js';
import { Shop } from '../ui/Shop.js';
import { getIcon } from '../ui/Icons.js';
import { MageController } from './combat/MageController.js';
import { BALANCE } from '../core/config/GameBalance.js';
import { WorldSync } from '../networking/WorldSync.js';
import { EnemySync } from '../networking/EnemySync.js';

export class Game {
  constructor(root, options = {}) {
    // Init debug ring buffer BEFORE any subsystem (EnemySync, WorldSync, …)
    // so their enable() events land in the ring.
    if (typeof window !== 'undefined' && !window.__voxelDebug) {
      window.__voxelDebug = {
        enabled: new URLSearchParams(window.location.search).get('debug') === '1',
        ring: [],
        push(category, payload) {
          // 2000-entry ring (~100 s of 20 Hz network noise) — large enough
          // that diagnostic queries don't lose a kill event between
          // server-broadcast and the test's evaluate roundtrip.
          if (this.ring.length >= 2000) this.ring.shift();
          this.ring.push({ t: Date.now(), category, payload });
          if (this.enabled) console.debug(`[vox:${category}]`, payload);
        },
        dump() {
          const g = window.__voxelGame;
          const bridge = g?.network?.getBridge?.();
          const state = bridge?.getRoomState?.();
          // NetworkMetrics surface — RTT ring + last fetched server stats.
          // We read off the live Game instance so an agent can call
          // window.__voxelDebug.dump() from the console without setup.
          const netStats = (typeof g?._networkMetrics?.getStats === 'function')
            ? g._networkMetrics.getStats()
            : null;
          const serverStats = (typeof g?._networkMetrics?.getLastServerStats === 'function')
            ? g._networkMetrics.getLastServerStats()
            : null;
          // Client-side per-frame snapshot from the existing Profiler. Lets
          // dump() show FPS + frame-time alongside server tick rate.
          const profSnap = (typeof g?.profiler?.snapshot === 'function')
            ? g.profiler.snapshot()
            : null;
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
            // Client-side render perf snapshot (FPS + frame time). Mirrors
            // what the Profiler HUD shows on screen when L is pressed.
            client: profSnap ? {
              fps: +profSnap.fps.toFixed(1),
              frameMsAvg: +profSnap.frame.avg.toFixed(2),
              frameMsP95: +profSnap.frame.p95.toFixed(2),
              frameMsMax: +profSnap.frame.max.toFixed(2),
            } : null,
            // Bridge ping/pong RTT ring.
            network: netStats,
            // Most recent /debug/rooms/<code>/stats payload (refreshed at
            // 0.2 Hz to avoid hammering Render's free tier).
            server: serverStats,
            ring: this.ring.slice(-50),
          };
        },
      };
    }
    if (typeof window !== 'undefined' && window.__voxelDebug) {
      window.__voxelDebug.push('game:ctor', { hasNetwork: !!(options?.network), mode: options?.mode });
    }

    this.root = root;
    this.character = options.character ?? CHARACTERS[0];
    this.map = options.map ?? MAPS[0];
    this.onExit = options.onExit ?? null;
    this.network = options.network ?? null;
    // Network performance sampler. Always on in MP (covers the whole
    // production session); off in singleplayer unless ?debug=1 forces it
    // (no network → nothing useful to sample, but we keep the surface live
    // so a tester can flip ?debug=1 without code changes). Started in
    // start() once the bridge handshake has resolved.
    this._networkMetrics = null;
    if (this.network && typeof this.network.getBridge === 'function') {
      const _nmBridge = this.network.getBridge();
      if (_nmBridge) {
        this._networkMetrics = new NetworkMetrics({
          bridge: _nmBridge,
          onDebug: (cat, payload) => {
            // Mirror server stats fetches into the ring so log-equivalence
            // tests can correlate ("server agreed we have N enemies").
            if (typeof window !== 'undefined' && window.__voxelDebug) {
              window.__voxelDebug.push(cat, payload);
            }
          },
        });
      }
    } else if (
      typeof window !== 'undefined' &&
      typeof URLSearchParams === 'function' &&
      new URLSearchParams(window.location.search).get('debug') === '1'
    ) {
      // SP + ?debug=1: keep the field defined but no bridge → no sampling.
      // The getter shape on __voxelDebug stays stable for harness scripts.
    }
    // 'waves' (pick character + map) or 'campaign' (story rules in BALANCE.campaign).
    this.mode = options.mode ?? 'waves';
    this.campaign = options.campaign ?? null;
    this.isCampaign = this.mode === 'campaign';
    this.waveCount = this.isCampaign ? BALANCE.campaign.waveCount : BALANCE.progression.waveCount;
    this.headshotDamageMult = this.isCampaign ? BALANCE.campaign.headshotDamageMult : 1;

    // All host I/O is provided by the injected platform (renderer, loop, clock,
    // viewport, input, audio). The game core never touches the browser directly.
    this.platform = options.platform;
    this.clock = this.platform.clock;
    this.renderer = this.platform.renderer;
    this.input = this.platform.input;
    this.audio = this.platform.audio;
    const viewport = this.platform.viewport;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, viewport.width / viewport.height, 0.1, 900);
    this.activeCamera = this.camera;
    this.aerialCamera = new THREE.PerspectiveCamera(60, viewport.width / viewport.height, 0.1, 900);
    this.aerialCamera.up.set(0, 0, -1); // north stays up in the top-down view
    this.cineCamera = new THREE.PerspectiveCamera(74, viewport.width / viewport.height, 0.1, 900);
    this.effects = new Effects(this.scene);
    this.effects.camera = this.camera; // for camera-facing slash marks
    this.inventory = new Inventory(
      this.character,
      this.isCampaign ? { startWeapons: BALANCE.campaign.startWeapons } : {},
    );
    this.world = new World({
      ...BALANCE.world,
      ...(this.map.dimensions ?? {}),
      map: this.map,
      extraBlocks: this.map.extraBlocks,
    });
    this.player = new Player(this.camera, {
      ...BALANCE.player,
      maxHealth: this.character.health,
      maxShield: this.character.shield,
      moveSpeed: BALANCE.player.moveSpeed * (this.character.speedMult ?? 1),
    });
    this.player.setPosition(...this.world.getSpawnPoint().toArray());

    // Multiplayer: bind the local world to the server's authoritative one.
    // Server's WorldSeed event triggers a regenerate so every peer starts
    // from the same procedural base, then mining/placement go through the
    // network. Singleplayer skips this entirely.
    if (this.network && typeof this.network.getBridge === 'function') {
      const bridge = this.network.getBridge();
      if (bridge) {
        this._worldSync = new WorldSync(this.world, bridge, {
          onWorldRebuilt: () => {
            if (!this.player || typeof this.player.setPosition !== 'function') return;
            // The default getSpawnPoint() drops players AT (0,0,0) which on
            // the meadow map is INSIDE the central castle (walls of stone
            // around them, south gate is the only way out). The user can't
            // see the enemies that spawn around the castle's outside walls
            // because the walls block line of sight. In MP we pick a spot
            // OUTSIDE the castle so the player lands on open grass with the
            // castle visible north of them. Every client regenerates the
            // same procedural world from the server's seed, so every client
            // lands at the same spot.
            const safeX = 0;
            const safeZ = 18; // ~10 blocks south of the south gate (castleHalf=8)
            const surfaceY = (typeof this.world.getSurfaceY === 'function')
              ? this.world.getSurfaceY(safeX, safeZ)
              : null;
            const sy = (Number.isFinite(surfaceY) ? surfaceY : 8) + 2.2;
            this.player.setPosition(safeX + 0.5, sy, safeZ + 0.5);
            if (typeof window !== 'undefined' && window.__voxelDebug) {
              window.__voxelDebug.push('player:spawn:mp', {
                x: safeX + 0.5, y: sy, z: safeZ + 0.5,
                surfaceY,
              });
            }
          },
        });
        this._worldSync.enable();
      }
    }

    // Multiplayer wiring for Weapons: when the bridge is up, fire() emits
    // a vp:weapon:fire intent and the local raycast becomes purely visual
    // (every enemy manager is in server authority, so the local hit doesn't
    // mutate HP — the authoritative kill arrives via state schema diffs).
    const weaponsNetwork =
      this.network && typeof this.network.getBridge === 'function'
        ? this.network.getBridge()
        : null;
    const weaponsSlotIndexProvider = () => this.inventory?.selectedIndex ?? -1;

    this.weapons = new Weapons({
      camera: this.camera,
      scene: this.scene,
      weapons: BALANCE.weapons,
      network: weaponsNetwork,
      slotIndexProvider: weaponsSlotIndexProvider,
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
          // Campaign: a killing headshot on a ground mob pays bonus coins.
          if (this.isCampaign && hit.headshot && hit.killed && !hit.dragon) {
            this.coins += BALANCE.campaign.headshotBonusCoins;
            if (hit.point) this.hud.showMessage('¡Headshot! +' + BALANCE.campaign.headshotBonusCoins + ' 🪙', 700);
          }
        },
        onProjectileImpact: (hit) => {
          if (hit.point) this.effects.impact(hit.point, hit.weapon?.flashColor ?? 0xcfd6df);
        },
        onBeam: (beam) => {
          // The blaster's penetrating laser is the only beam emitter.
          this.effects.beam(beam.origin, beam.end, beam.color, { mega: true });
        },
        onTracer: (tracer) => {
          this.effects.tracer(tracer.origin, tracer.end, tracer.color);
        }
      }
    });
    // Enemy/player bounds follow the active world's footprint (custom maps can
    // be larger than the built-in ones).
    const worldWidth = this.world.options.width;
    const worldDepth = this.world.options.depth;
    const bounds = {
      minX: -worldWidth / 2 + 2,
      maxX: worldWidth / 2 - 2,
      minZ: -worldDepth / 2 + 2,
      maxZ: worldDepth / 2 - 2,
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
      world: this.world,
      camera: this.camera,
      health: BALANCE.zombies.health,
      speed: BALANCE.zombies.speed,
      damage: BALANCE.zombies.damage,
      attackRange: BALANCE.zombies.attackRange,
      attackCooldown: BALANCE.zombies.attackCooldown,
      spawnRadiusMin: BALANCE.zombies.spawnRadiusMin,
      spawnRadiusMax: BALANCE.zombies.spawnRadiusMax,
      headshotDamageMult: this.headshotDamageMult,
    });
    this.skeletons = new SkeletonManager(this.scene, { bounds, world: this.world, ...BALANCE.skeletons, headshotDamageMult: this.headshotDamageMult });
    this.witches = new WitchManager(this.scene, { bounds, world: this.world, ...BALANCE.witches, headshotDamageMult: this.headshotDamageMult });

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
          // Fire the same "killed" cinematic (explosion + sound) on every
          // client when the server confirms a despawn — not only the
          // shooter, whose local raycast no longer mutates HP in MP.
          onKill: (pos, id, kind) => {
            this.effects?.explosion?.(pos);
            this.audio?.explosion?.();
            window.__voxelDebug?.push?.('enemy:kill:client', { id, kind, x: pos.x, y: pos.y, z: pos.z });
          },
        });
        this._enemySync.enable();

        // Wave-event hooks. Singleplayer triggers these inline from
        // startNextWave(); in multiplayer the server is authoritative so we
        // listen for the broadcast and react locally (toast + meteor).
        this._netUnsubs = this._netUnsubs ?? [];
        const onWaveStart = (p) => {
          if (!p) return;
          // Mirror this.wave so the HUD reflects the server's wave.
          if (Number.isFinite(p.wave)) this.wave = p.wave;
          // Wave-5 miniboss toast — matches singleplayer copy.
          if (p.boss === true && this.hud?.showMessage) {
            this.hud.showMessage('☠ MINIBOSS: Dragón Rojo', 2600);
          } else if (p.cinematic !== true && Number.isFinite(p.wave) && this.hud?.showMessage) {
            // Plain wave toast for every non-cinematic wave.
            this.hud.showMessage(`Oleada ${p.wave}`, 1500);
          }
        };
        const onWaveCinematic = (p) => {
          if (!p) return;
          if (p.kind === 'meteor' && typeof this.startMeteorCinematic === 'function') {
            // Reuse the singleplayer cutscene. It freezes input, plays the
            // meteor fall + flash + crater, then drops back into 'playing'.
            // The server has already broadcast the WorldDelta crater so the
            // local terrain is being carved as the white-out covers it.
            try { this.startMeteorCinematic({ network: true }); }
            catch (err) { console.warn('[Game] startMeteorCinematic failed', err); }
          }
        };
        try { this._netUnsubs.push(enemyBridge.on('waveStart', onWaveStart)); } catch { /* ignore */ }
        try { this._netUnsubs.push(enemyBridge.on('waveCinematic', onWaveCinematic)); } catch { /* ignore */ }

        // Remote-tracer broadcast. The server re-broadcasts every accepted
        // WeaponFire intent to every connected client so non-shooters can
        // render a tracer / muzzle flash for the shot. The shooter dedupes
        // by sessionId — their local Weapons.js already emitted onTracer.
        const onWeaponFired = (p) => {
          if (!p || !this.effects || !Array.isArray(p.origin) || !Array.isArray(p.direction)) return;
          // Dedupe local echo — the shooter already drew their own tracer.
          const selfSessionId = enemyBridge.getSelfSessionId?.();
          if (p.shooterSessionId && selfSessionId && p.shooterSessionId === selfSessionId) return;

          // Resolve weapon entry → tracer color. Prefer the explicit `slot`
          // id from the payload; fall back to slotIndex mapping if absent.
          let weapon = null;
          const weapons = Array.isArray(BALANCE?.weapons) ? BALANCE.weapons : [];
          if (typeof p.slot === 'string') {
            weapon = weapons.find((w) => w && w.id === p.slot) ?? null;
          }
          if (!weapon && Number.isInteger(p.slotIndex)) {
            // Server slot order: 0 pistol, 1 shotgun, 2 rifle, 3 blaster, 4 dagger.
            const ID_BY_SLOT = ['pistol', 'shotgun', 'rifle', 'blaster', 'dagger'];
            const id = ID_BY_SLOT[p.slotIndex];
            if (id) weapon = weapons.find((w) => w && w.id === id) ?? null;
          }
          const color = weapon?.tracerColor ?? weapon?.flashColor ?? 0xffe08a;
          const range = Number.isFinite(weapon?.range) ? weapon.range : 50;

          const ox = +p.origin[0], oy = +p.origin[1], oz = +p.origin[2];
          const dx = +p.direction[0], dy = +p.direction[1], dz = +p.direction[2];
          if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)) return;
          if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return;
          // Normalize direction defensively (server already does, but be safe).
          const dlen = Math.hypot(dx, dy, dz);
          if (dlen < 1e-4) return;
          const nx = dx / dlen, ny = dy / dlen, nz = dz / dlen;
          const originVec = new THREE.Vector3(ox, oy, oz);
          const endVec = new THREE.Vector3(ox + nx * range, oy + ny * range, oz + nz * range);
          try { this.effects.tracer(originVec, endVec, color); } catch { /* swallow */ }
        };
        try { this._netUnsubs.push(enemyBridge.on('weaponFired', onWeaponFired)); } catch { /* ignore */ }
      }
    }

    // The uniform enemy contract (see enemies/EnemyAggregator.js): weapons and
    // the mage act on every enemy type through this single object.
    this.enemies = createEnemyAggregator({
      dragons: this.dragons,
      zombies: this.zombies,
      skeletons: this.skeletons,
      witches: this.witches,
      world: this.world,
    });
    // Any damage dealt through the aggregator (guns, bombs, aerial, mage spells)
    // resets the "no-hit" threat timer. Melee resets it via applyMeleeHits.
    for (const method of ['hitMelee', 'hitBox', 'hitByRay', 'hitAllByRay']) {
      const original = this.enemies[method];
      this.enemies[method] = (...args) => {
        const result = original(...args);
        if (Array.isArray(result) ? result.length : result) this.registerEnemyHit();
        return result;
      };
    }
    this.enemyTargets = this.enemies; // weapons use hitByRay/hitAllByRay

    // Witches lob healing potions at the nearest wounded monster.
    this.witches.healTargetProvider = (pos) => this.findHealTarget(pos);

    this.hud = new HUD(this.root);
    // Per-frame profiler (off unless ?profile / L / persisted). See dev/Profiler.
    this.profiler = new Profiler({ enabled: profilerEnabledByDefault() });
    // While the overlay is on, stream snapshots to the dev server (profiling/)
    // so they can be analyzed from a conversation. See dev/profileExporter.
    this._uninstallExporter = installProfileExporter(this.profiler, () => ({
      map: this.map.id,
      character: this.character.id,
      wave: this.wave,
      enemies: {
        dragons: this.dragons.getAliveCount(),
        zombies: this.zombies.getAliveCount(),
        skeletons: this.skeletons.getAliveCount(),
        witches: this.witches.getAliveCount(),
      },
    }));
    this.started = false;
    this.state = 'playing'; // 'playing' | 'shop' | 'dead'
    this.wave = 0;
    this.meleeCooldown = 0;
    this.guardCooldown = 0;
    this.dashCooldown = 0;
    this.swordCharging = false;
    this.swordCharge = 0;
    // "No-hit" threat marker: after a stretch without damaging any enemy, every
    // enemy glows red for a few seconds; landing a hit clears it.
    this.timeSinceHit = 0;
    this.threatTimer = 0;
    this.enemiesHighlighted = false;
    this.viewmodel = null;
    this.viewmodelBasePos = new THREE.Vector3();
    this.viewmodelBaseRot = new THREE.Vector3();
    // Recoil: a transient pitch kick + viewmodel kickback that springs back each
    // frame so it never permanently drifts the aim. Swing: a one-shot melee arc.
    this.recoil = { pitch: 0, kickZ: 0, roll: 0 };
    this._recoilAppliedPitch = 0;
    this.swing = { active: false, time: 0, duration: 0.32, amount: 0, style: 'slash' };
    // Blaster charge-up: zoom in + blue tint, then snap back and fire the laser.
    this.blasterCharging = false;
    this.blasterChargeTime = 0;
    this.blasterChargeDuration = 0.45;
    this.blasterFovBase = this.camera.fov;
    this.blasterFovZoom = 46;

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
    // Samurai second-ability + drawn-dash cooldowns and the travelling X cuts.
    this.knockbackCd = 0;
    this.xSlashCd = 0;
    this.samuraiDashCd = 0;
    this.samuraiSlashes = [];
    this.timeSlowTimer = 0;
    this.timeSlowFactor = 0.35;

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
    // 5s visible countdown between waves (skipped when P force-advances).
    this.waveCountdown = null;
    this.waveCountdownTotal = 5;

    // The player cannot leave the map (invisible barrier at the edges).
    this.playerBounds = {
      minX: -worldWidth / 2 + 1,
      maxX: worldWidth / 2 - 1,
      minZ: -worldDepth / 2 + 1,
      maxZ: worldDepth / 2 - 1,
    };

    this.targetOutline = this.createTargetOutline();

    this.scene.add(this.world);
    this.scene.add(this.player.object);
    this.scene.add(this.targetOutline);
    this.addBoundaryBarrier();
    this.setupScene();
    this.bindEvents();
    this.onSelectionChanged();
    // The first wave is spawned in start(), right after the shader pre-warm.
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
    // Tall enough to wall in the full build of tall imported maps.
    const height = Math.max(60, this.world.options.maxHeight + 12);
    const geometry = new THREE.BoxGeometry(width, height, depth);
    const material = new THREE.MeshBasicMaterial({
      color: 0x6fc3ff,
      transparent: true,
      opacity: 0.08,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const barrier = new THREE.Mesh(geometry, material);
    barrier.position.set((minX + maxX) / 2, height / 2 - 12, (minZ + maxZ) / 2);
    this.scene.add(barrier);
  }

  startNextWave() {
    this.wave += 1;

    // Waves mode: the shop opens once before the configured wave, handing over
    // reserve ammo. Campaign: it opens before every Nth wave (you buy weapons).
    if (this.isCampaign) {
      if (this.wave % BALANCE.campaign.shopEvery === 0) this.openShop(); // before waves 5,10,15,20
    } else if (this.wave === BALANCE.progression.shopWave && !this.shopDone) {
      this.grantWaveAmmo();
      this.grantWaveBombs();
      this.openShop();
    }

    // Waves mode wave 10: the meteor cutscene plays first; enemies spawn when it
    // ends (after the map has become a crater and the player has respawned).
    if (!this.isCampaign && this.wave === BALANCE.meteor.wave) {
      this.startMeteorCinematic();
      return;
    }

    this.spawnWaveEnemies(this.wave);
  }

  spawnWaveEnemies(w) {
    // Lots of zombies (increasing), fewer skeletons/witches, fewest dragons.
    // Waves mode wave 5: the red miniboss appears and the rest is lighter.
    const bossWave = !this.isCampaign && w === BALANCE.boss.wave;
    const scale = bossWave ? BALANCE.boss.enemyScale : 1;
    this.zombies.spawnWave(Math.ceil((2 + w) * scale), this.player, this.world);
    this.skeletons.spawnWave(Math.ceil(w * 0.6 * scale), this.player, this.world);
    this.witches.spawnWave(Math.floor(w * 0.35 * scale), this.player, this.world);
    if (bossWave) {
      this.dragons.spawnWave(0); // clear regular dragons...
      this.dragons.spawnBoss(this.player, BALANCE.boss); // ...and bring the miniboss
      this.hud.showMessage('☠ MINIBOSS: Dragón Rojo', 2600);
    } else {
      this.dragons.spawnWave(Math.max(1, Math.ceil(w * 0.3)));
      this.hud.showMessage(`Oleada ${w}`, 1500);
    }
  }

  // --- wave-10 meteor cutscene ----------------------------------------------
  //
  // In SINGLEPLAYER this is called from startNextWave() when wave === 10. In
  // MULTIPLAYER the server broadcasts a 'waveCinematic' event and the bridge
  // listener (see constructor) calls this with { network: true } so we know
  // to defer crater carving and player respawn to the server.
  startMeteorCinematic(opts = {}) {
    this.state = 'cinematic';
    this.cancelBlasterCharge?.();
    const cfg = BALANCE.meteor;
    this._meteorNetwork = !!opts.network;
    // The castle sits at the map centre; its gate faces +Z. Park a dedicated
    // cinematic camera outside the gate, looking back at the castle, so the
    // meteor streaks down into frame and explodes on it. Switching the active
    // camera (rather than moving the player rig) keeps the player untouched
    // for the random respawn afterwards.
    const top = (this.world.options.waterLevel ?? 7) + 4; // ~castle wall height
    this.meteorTarget = new THREE.Vector3(0, top, 0);
    this.cineCamera.aspect = this.camera.aspect;
    this.cineCamera.position.set(2, top + 7, 44);
    this.cineCamera.up.set(0, 1, 0);
    this.cineCamera.lookAt(0, top + 1, 0);
    this.cineCamera.updateProjectionMatrix();
    this.cineCamera.updateMatrixWorld(true);
    this.activeCamera = this.cineCamera;

    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(3.4, 0),
      new THREE.MeshStandardMaterial({ color: 0x3a2a22, emissive: 0xff5a18, emissiveIntensity: 1.4, flatShading: true }),
    );
    mesh.position.set(0, cfg.height, 0);
    this.scene.add(mesh);
    this.meteor = { mesh, phase: 'fall', t: 0, start: mesh.position.clone(), target: this.meteorTarget.clone(), trail: 0 };
    this.hud.showMessage('☄ ¡METEORITO!', 1600);
  }

  updateMeteor(delta) {
    const m = this.meteor;
    if (!m) return;
    const cfg = BALANCE.meteor;
    if (m.phase === 'fall') {
      m.t += delta;
      const k = Math.min(1, m.t / cfg.fallTime);
      m.mesh.position.lerpVectors(m.start, m.target, k * k); // accelerate downward
      m.mesh.rotation.x += delta * 4;
      m.mesh.rotation.z += delta * 3;
      m.trail -= delta;
      if (m.trail <= 0) { m.trail = 0.04; this.effects.impact(m.mesh.position, 0xff7a1a); }
      this.effects._addShake(0.02 + k * k * 0.12, 0.12);
      if (k >= 1) this.meteorImpact();
    } else if (m.phase === 'flash') {
      m.t += delta;
      if (m.t >= cfg.flashTime) this.endMeteorCinematic();
    }
  }

  meteorImpact() {
    const m = this.meteor;
    this.effects.bigFlash(m.target.clone());
    this.effects.explosion(m.target.clone());
    this.audio.explosion();
    this.hud.whiteout(BALANCE.meteor.flashTime * 1000);
    // Swap the map: the castle becomes a crater (hidden by the white-out).
    // In multiplayer every client carves locally with the same parameters;
    // the world geometry is deterministic from the seed so every client ends
    // up with the same crater. We do NOT route the carve through WorldSync's
    // emitMineIntent because that would flood the server with thousands of
    // edits — and the local edits are stamped with `false` in the third
    // arg of setBlock so WorldSync's patched mutators see only carveCrater's
    // direct setBlock calls (which bypass the network emitter).
    this.world.carveCrater(0, 0, BALANCE.meteor.craterRadius);
    this.scene.remove(m.mesh);
    m.mesh.geometry.dispose();
    m.mesh.material.dispose();
    m.mesh = null;
    m.phase = 'flash';
    m.t = 0;
  }

  endMeteorCinematic() {
    this.meteor = null;
    this.activeCamera = this.camera; // back to the first-person view
    // Multiplayer: the server is authoritative for player position and the
    // wave roster; do not respawn locally or spawn enemies. We just hand
    // input back to the player; the next playerSnapshot will reposition us
    // and EnemySync will populate any enemies the server spawns next.
    if (this._meteorNetwork) {
      this._meteorNetwork = false;
      this.state = 'playing';
      return;
    }
    // Drop the player somewhere random on the new cratered map.
    const spawn = this.world.getRandomSpawnPoint();
    this.player.setPosition(spawn.x, spawn.y, spawn.z);
    this.player.velocity.set(0, 0, 0);
    this.state = 'playing';
    this.spawnWaveEnemies(this.wave);
  }

  setupScene() {
    // The active map can recolour the sky, fog and lighting (see modules/maps).
    const env = this.map?.environment ?? {};
    const sky = env.sky ?? BALANCE.colors.sky;
    const fog = env.fog ?? { color: sky, near: 80, far: 340 };
    const hemiCfg = env.hemisphere ?? { sky: 0xcfe8ff, ground: 0x31451e, intensity: 1.5 };
    const sunCfg = env.sun ?? { color: 0xfff0c5, intensity: 2.4 };

    this.scene.background = new THREE.Color(sky);
    this.scene.fog = new THREE.Fog(fog.color ?? sky, fog.near ?? 80, fog.far ?? 340);
    const hemi = new THREE.HemisphereLight(hemiCfg.sky, hemiCfg.ground, hemiCfg.intensity);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(sunCfg.color, sunCfg.intensity);
    sun.position.set(70, 120, 50);
    sun.castShadow = true;
    // Cover the whole footprint with the sun's shadow frustum (custom imported
    // maps can be far larger than the built-in ones); bump the shadow map
    // resolution to keep shadows crisp over the bigger area.
    const shadowHalf = Math.max(90, this.world.options.width / 2, this.world.options.depth / 2);
    sun.shadow.camera.left = -shadowHalf;
    sun.shadow.camera.right = shadowHalf;
    sun.shadow.camera.top = shadowHalf;
    sun.shadow.camera.bottom = -shadowHalf;
    sun.shadow.camera.far = shadowHalf * 3 + 200;
    const shadowRes = shadowHalf > 120 ? 2048 : 1024;
    sun.shadow.mapSize.set(shadowRes, shadowRes);
    this.scene.add(sun);
  }

  bindEvents() {
    this.platform.viewport.onResize(() => this.resize());
    this.renderer.domElement.addEventListener('click', () => {
      this.audio.unlock();
      this.input.requestPointerLock();
      this.started = true;
    });
    this.renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  // Dev-only: park a fixed camera at `pos` looking at `target` (arrays [x,y,z])
  // and freeze gameplay, for deterministic screenshots. See the __voxel hook.
  setSpectator(pos, target) {
    this.started = true;
    this._spectator = pos
      ? { pos: new THREE.Vector3().fromArray(pos), target: new THREE.Vector3().fromArray(target ?? [0, 0, 0]) }
      : null;
  }

  start() {
    // Prewarm in MP would call spawnWave() which clears the pool — wiping
    // the server-backfilled entities EnemySync just pushed in. Skip it.
    if (!this.network) {
      this.prewarmShaders();
      this.startNextWave();
    } else {
      // Server is the wave director. Seed this.wave for HUD/UI only.
      this.wave = 1;
    }
    // Network metrics sampler: bridge handshake is resolved by the time
    // start() runs (see MultiplayerCoordinator.start), so this is safe.
    // Idempotent if start() is called twice for any reason.
    try { this._networkMetrics?.startSampling?.(); } catch { /* ignore */ }
    this.platform.loop.start(() => this.tick());
    if (typeof window !== 'undefined') {
      window.__voxelGame = this;
      if (window.__voxelDebug) {
        window.__voxelDebug.push('game:start', { network: !!this.network, mode: this.mode });
      }
    }
  }

  // Compile every shader up front so the first rendered frames don't stall on
  // GPU shader compilation (the ~110ms wave-1 hitch seen in profiling). We spawn
  // one of each enemy type so all their materials compile now, precompile the
  // whole scene, then clear the probes before the real first wave spawns. The
  // shared per-manager materials persist, so later spawns reuse the compiled
  // programs. (Transient effect materials are created on demand and not covered.)
  prewarmShaders() {
    if (!this.platform.renderer.prewarm) return;
    this.dragons.spawnWave(1);
    this.zombies.spawnWave(1, this.player, this.world);
    this.skeletons.spawnWave(1, this.player, this.world);
    this.witches.spawnWave(1, this.player, this.world);
    this.platform.renderer.prewarm(this.scene, this.camera);
    this.dragons.clearDragons();
    this.zombies.clearZombies();
    this.skeletons.clearSkeletons();
    this.witches.clearWitches();
  }

  tick() {
    const p = this.profiler;
    p.beginFrame();
    const rawDelta = this.clock.getDelta();
    let delta = Math.min(rawDelta, 0.05);
    if (rawDelta > 0) {
      const instant = 1 / rawDelta;
      this.fps = this.fps ? this.fps + (instant - this.fps) * 0.1 : instant; // smoothed
    }
    // The samurai's drawn technique briefly slows gameplay for drama.
    if (this.timeSlowTimer > 0) delta *= this.timeSlowFactor;

    // Dev-only spectator: a fixed camera for screenshots (set via the __voxel
    // debug hook). Freezes gameplay, keeps water animating, and just renders.
    if (this._spectator) {
      this.world.update(delta);
      this.activeCamera = this.camera;
      this.camera.position.copy(this._spectator.pos);
      this.camera.lookAt(this._spectator.target);
      this.renderer.render(this.scene, this.camera);
      this.input.update();
      return;
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

    // Meteor cutscene: the player is frozen while the meteor falls, the map turns
    // into a crater, then play resumes (handled inside updateMeteor).
    if (this.state === 'cinematic') {
      this.updateMeteor(delta);
      this.world.update(delta);
      this.effects.update(delta);
      this.effects.applyCameraShake(this.activeCamera);
      this.renderHud();
      this.renderer.render(this.scene, this.activeCamera);
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
      this._pumpMPInput();
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
    this.knockbackCd = Math.max(0, this.knockbackCd - delta);
    this.xSlashCd = Math.max(0, this.xSlashCd - delta);
    this.samuraiDashCd = Math.max(0, this.samuraiDashCd - delta);
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
    for (let i = 1; i <= this.inventory.slots.length; i += 1) {
      if (this.input.consume(`weapon${i}`)) {
        this.inventory.select(i - 1);
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
    // In multiplayer the server is the wave director — clearing the local
    // managers here would wipe the server-pushed visuals while the server
    // keeps the enemies alive in its state. So we just ignore P entirely in
    // MP; the host can use the lobby/ReadyNextWave path if we add a UI for it.
    if (this.input.consume('debugSkipWave') && !this.network) {
      if (this.victory) {
        this.enterTrainingGround();
      } else {
        this.dragons.clearDragons();
        this.zombies.clearZombies();
        this.skeletons.clearSkeletons();
        this.witches.clearWitches();
        this.waveCountdown = null; // P skips the countdown
        this.advanceWave();
      }
    }

    p.begin('player');
    this.undoRecoil(); // strip last frame's recoil tilt before mouse-look
    this.player.update(delta, this.input, this.world);
    this.clampPlayerToBounds();
    this.animateViewmodel(delta);
    if (this.character.loadout === 'guns') this.updateBlasterCharge(delta);
    else if (this.character.ability === 'samurai') this.updateTimeSlow(rawDelta);
    this.updateSamuraiSlashes(delta);
    // Multiplayer: pump the player's current input + rotation to the server
    // every frame so its authoritative position tracks the real player. Without
    // this, the server thinks the player is still at spawn and the AI chases a
    // ghost; the user's bullets miss because origin is far from server view.
    this._pumpMPInput();
    p.end();
    p.begin('world');
    this.world.update(delta);
    p.end();
    if (this.mage) { p.begin('mage'); this.mage.update(delta); p.end(); } // before enemies so the tornado can lift them
    p.begin('dragons');
    this.dragons.update(delta, this.player, this.scene);
    p.end();
    p.begin('zombies');
    this.zombies.update(delta, this.player, this.world);
    p.end();
    p.begin('skeletons');
    this.skeletons.update(delta, this.player, this.world);
    p.end();
    p.begin('witches');
    this.witches.update(delta, this.player, this.world);
    p.end();

    p.begin('enemyEvents');
    this.handleZombieEvents();
    this.handleSkeletonArrows();
    this.handleWitchPotions();

    // Coins are earned by killing enemies.
    this.coins += this.dragons.consumeKills() * BALANCE.coins.dragon
      + this.zombies.consumeKills() * BALANCE.coins.zombie
      + this.skeletons.consumeKills() * BALANCE.coins.skeleton
      + this.witches.consumeKills() * BALANCE.coins.witch;

    // Between waves: a visible 5s countdown, then the next wave. The final wave
    // goes straight to victory (no next wave to count down to). In MP the
    // server's checkWaveProgression already handles this — running it here
    // too would race the server and stack countdowns on a stale local view.
    if (!this.victory && this.state === 'playing' && !this.network) {
      if (this.enemies.aliveCount() === 0) {
        if (this.wave >= this.waveCount) {
          this.advanceWave();
        } else {
          if (this.waveCountdown == null) this.waveCountdown = this.waveCountdownTotal;
          this.waveCountdown -= delta;
          if (this.waveCountdown <= 0) {
            this.waveCountdown = null;
            this.advanceWave();
          }
        }
      } else {
        this.waveCountdown = null;
      }
    }
    p.end();
    p.begin('weapons');
    this.weapons.update(delta);
    this.updateBombs(delta);
    this.updateSlashPhase(delta);
    p.end();
    p.begin('effects');
    this.effects.update(delta);
    p.end();

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

    this.updateThreatHighlight(delta);
    this.updateTargetOutline();
    this.effects.applyCameraShake(this.camera);
    this.applyVisualMutes();
    p.begin('hud');
    this.renderHud();
    p.end();

    p.begin('render');
    if (!(p.enabled && p.isMuted('render'))) this.renderer.render(this.scene, this.activeCamera);
    p.end();
    this.input.update();
    p.endFrame();
  }

  // Profiler "visual mute": hide a phase's output (Enter in the overlay) while
  // its simulation keeps running. Only takes effect while the profiler is on,
  // so closing it (L) always restores every visual.
  applyVisualMutes() {
    const p = this.profiler;
    const off = (label) => p.enabled && p.isMuted(label);
    this.world.visible = !off('world');
    this.dragons.group.visible = !off('dragons');
    this.zombies.group.visible = !off('zombies');
    this.skeletons.group.visible = !off('skeletons');
    this.witches.group.visible = !off('witches');
    this.effects.setVisible(!off('effects'));
    if (this.hud?.root) this.hud.root.style.visibility = off('hud') ? 'hidden' : 'visible';
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
      waveCount: this.waveCount,
      fps: this.fps,
      countdown: this.waveCountdown,
      inventory: this.inventory.snapshot(),
      locked: this.input.pointerLocked
    });
  }

  /**
   * Send one vp:input frame to the server with the current WASD state and
   * camera rotation. The NetworkBridge's InputPump throttles to 20 Hz and
   * only actually sends on changes, so calling this every visual frame is
   * cheap. Returns silently in singleplayer.
   *
   * Why this is in Game and not Player: the upstream Player has zero
   * networking surface — keeping it untouched. The translation between
   * Input.keys state and the server's protocol shape is composition,
   * not movement logic.
   */
  _pumpMPInput() {
    if (!this.network) return;
    const inp = this.input;
    if (!inp) return;
    const keys = inp.keys || inp.pressed || inp.down || {};
    const k = (...names) => {
      for (const n of names) {
        if (inp[n]) return true;
        if (keys instanceof Set && keys.has(n)) return true;
        if (keys && keys[n]) return true;
      }
      return false;
    };
    const cmd = {
      forward: k('KeyW', 'w', 'forward', 'moveForward'),
      backward: k('KeyS', 's', 'backward', 'moveBackward'),
      left: k('KeyA', 'a', 'left', 'moveLeft'),
      right: k('KeyD', 'd', 'right', 'moveRight'),
      jump: k('Space', ' ', 'space', 'jump'),
      // Sprint matters for server-side speed: BALANCE.player.sprintMultiplier
      // is 1.5×; if we omit this flag the server runs at base speed while the
      // client visual sprints, and the player visibly outruns the server's
      // stored position — AI then chases a ghost a few units behind.
      sprint: k('ShiftLeft', 'ShiftRight', 'shift', 'sprint'),
      rotationY: this.player?.cameraHolder?.rotation?.y ?? 0,
      pitch: this.player?.pitchHolder?.rotation?.x ?? 0,
      seq: (this._inputSeq = (this._inputSeq ?? 0) + 1),
    };
    try {
      if (typeof this.network.pushInput === 'function') {
        this.network.pushInput(cmd);
      } else if (typeof this.network.getBridge === 'function') {
        this.network.getBridge()?.pushInput?.(cmd);
      }
    } catch (err) {
      if (typeof window !== 'undefined' && window.__voxelDebug) {
        window.__voxelDebug.push('mp:input:error', { err: String(err) });
      }
    }
    // Trace: when any directional key flips, drop a single ring entry so we
    // can verify the pump actually fires under real play (the diagnostic
    // harness reads __voxelDebug.ring). This is gated on a transition so
    // we don't blow up the buffer.
    if (typeof window !== 'undefined' && window.__voxelDebug) {
      const sig = `${cmd.forward}|${cmd.backward}|${cmd.left}|${cmd.right}|${cmd.jump}|${cmd.sprint}`;
      if (sig !== this._lastPumpSig) {
        this._lastPumpSig = sig;
        window.__voxelDebug.push('mp:input:cmd', {
          forward: cmd.forward, backward: cmd.backward, left: cmd.left,
          right: cmd.right, jump: cmd.jump, sprint: cmd.sprint,
          rotationY: +cmd.rotationY.toFixed(2),
          seq: cmd.seq,
        });
      }
    }
  }

  clampPlayerToBounds() {
    const pos = this.player.object.position;
    pos.x = THREE.MathUtils.clamp(pos.x, this.playerBounds.minX, this.playerBounds.maxX);
    pos.z = THREE.MathUtils.clamp(pos.z, this.playerBounds.minZ, this.playerBounds.maxZ);
  }

  advanceWave() {
    // In multiplayer the server's WaveDirector is the source of truth — the
    // client cannot unilaterally jump waves or it would clear/spawn local
    // entities on top of the server-broadcast roster.
    if (this.network) return;
    if (this.wave >= this.waveCount) {
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
    this.cancelBlasterCharge();
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
    this.cancelBlasterCharge();
    this.state = 'shop';
    this.input.exitPointerLock();
    this.shop = new Shop(this.root, {
      title: `Tienda · Oleada ${this.wave}`,
      items: this.buildShopItems(),
      getCoins: () => this.coins,
      getOwned: (id) => this.shopOwned(id),
      onBuy: (item) => this.buyShopItem(item),
      onClose: () => this.closeShop(),
    });
  }

  // Buffs (both modes) plus, in campaign, the wave-mode guns (bought once).
  buildShopItems() {
    const buffs = BALANCE.shop.items.map((item) => ({ ...item, kind: 'buff' }));
    if (!this.isCampaign) return buffs;
    const icons = { rifle: 'rifle-bullet', shotgun: 'shotgun-shell', blaster: 'blue-laser' };
    const weapons = BALANCE.campaign.shopWeapons.map((w) => ({
      ...w, kind: 'weapon', max: 1, iconUrl: getIcon(icons[w.id]),
    }));
    return [...weapons, ...buffs];
  }

  shopOwned(id) {
    if (this.inventory.hasWeapon?.(id)) return 1;
    return this.buffs[id] ?? 0;
  }

  buyShopItem(item) {
    if (this.coins < item.cost) return false;
    if (item.kind === 'weapon') {
      if (this.inventory.hasWeapon(item.id)) return false;
      this.coins -= item.cost;
      this.inventory.unlockWeapon(item.id);
      const ammo = BALANCE.campaign.weaponAmmo[item.name];
      if (ammo) this.weapons.addAmmo(item.name, ammo);
      return true;
    }
    return this.buyBuff(item);
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
    // The blaster doesn't fire instantly: it charges (zoom + blue tint) first.
    if (this.weapons.currentWeapon?.id === 'blaster') {
      this.startBlasterCharge();
      return;
    }
    const fired = this.weapons.fire({
      scene: this.scene,
      world: this.world,
      dragons: this.enemyTargets,
      effects: this.effects,
      camera: this.camera
    });
    if (fired) {
      this.addRecoil(this.weapons.currentWeapon?.id);
      this.audio.shoot(this.weapons.getCurrentWeaponName());
    }
  }

  // --- viewmodel animation (recoil / swing) ---------------------------------
  addRecoil(weaponId) {
    const presets = {
      rifle: { pitch: 0.013, kickZ: 0.05, roll: 0.012 },
      shotgun: { pitch: 0.055, kickZ: 0.16, roll: 0.03 },
      blaster: { pitch: 0.07, kickZ: 0.22, roll: 0 },
      pistol: { pitch: 0.022, kickZ: 0.06, roll: 0.016 },
      dagger: { pitch: 0.012, kickZ: 0.04, roll: 0.02 },
    };
    const pre = presets[weaponId] ?? presets.rifle;
    this.recoil.pitch += pre.pitch;
    this.recoil.kickZ += pre.kickZ;
    this.recoil.roll += (Math.random() - 0.5) * 2 * pre.roll;
  }

  triggerSwing(amount = 1, style = 'slash') {
    this.swing.active = true;
    this.swing.time = 0;
    this.swing.amount = amount;
    this.swing.style = style;
    this.swing.duration = style === 'power' ? 0.5 : 0.32;
  }

  undoRecoil() {
    if (this._recoilAppliedPitch) {
      this.player.pitchHolder.rotation.x -= this._recoilAppliedPitch;
      this._recoilAppliedPitch = 0;
    }
  }

  // Recoil springs back to rest, the melee swing arcs once, and the result is
  // composed onto the viewmodel's recorded rest pose.
  animateViewmodel(delta) {
    this.recoil.pitch *= Math.exp(-13 * delta);
    this.recoil.kickZ *= Math.exp(-11 * delta);
    this.recoil.roll *= Math.exp(-13 * delta);
    if (this.recoil.pitch < 0.0003) this.recoil.pitch = 0;
    if (Math.abs(this.recoil.kickZ) < 0.001) this.recoil.kickZ = 0;
    if (Math.abs(this.recoil.roll) < 0.0003) this.recoil.roll = 0;

    // Negative pitch tilts the view up (the recoil kick).
    this._recoilAppliedPitch = -this.recoil.pitch;
    this.player.pitchHolder.rotation.x += this._recoilAppliedPitch;

    if (this.swing.active) {
      this.swing.time += delta;
      if (this.swing.time >= this.swing.duration) this.swing.active = false;
    }

    const vm = this.viewmodel;
    if (!vm) return;

    let px = this.viewmodelBasePos.x;
    let py = this.viewmodelBasePos.y;
    let pz = this.viewmodelBasePos.z + this.recoil.kickZ;
    let rx = this.viewmodelBaseRot.x + this.recoil.pitch * 1.6;
    let ry = this.viewmodelBaseRot.y;
    let rz = this.viewmodelBaseRot.z + this.recoil.roll;

    if (this.swing.active) {
      const t = Math.min(this.swing.time / this.swing.duration, 1);
      const a = this.swing.amount;
      if (this.swing.style === 'power') {
        // Knockback technique: wind right + back (charge), then drive left.
        if (t < 0.4) {
          const w = t / 0.4;
          ry += -1.0 * w * a;
          pz += 0.18 * w * a;
          rz += -0.35 * w * a;
        } else {
          const s = (t - 0.4) / 0.6;
          const arc = Math.sin(s * Math.PI / 2);
          ry += (-1.0 + 3.0 * arc) * a;
          pz += (0.18 - 0.45 * arc) * a;
          px += -0.28 * arc * a;
          rz += (-0.35 + 0.8 * arc) * a;
        }
      } else {
        // Basic horizontal slash: right -> left -> back to rest (mostly yaw).
        const arc = Math.sin(t * Math.PI);
        ry += 1.8 * arc * a;
        px += -0.22 * arc * a;
        rz += 0.45 * arc * a;
        rx += 0.12 * arc * a;
        pz += -0.1 * arc * a;
      }
    }

    vm.position.set(px, py, pz);
    vm.rotation.set(rx, ry, rz);
  }

  // --- blaster charge-up ----------------------------------------------------
  startBlasterCharge() {
    if (this.blasterCharging) return;
    const weapon = this.weapons.currentWeapon;
    if (!weapon || weapon.cooldownRemaining > 0 || weapon.isReloading) return;
    if (weapon.ammo <= 0) {
      this.weapons.fire({ scene: this.scene, world: this.world, dragons: this.enemyTargets, camera: this.camera });
      return;
    }
    this.blasterCharging = true;
    this.blasterChargeTime = 0;
    this.audio.reload(); // charging whirr stand-in
  }

  updateBlasterCharge(delta) {
    if (this.blasterCharging && this.weapons.currentWeapon?.id !== 'blaster') {
      this.cancelBlasterCharge();
    }
    if (!this.blasterCharging) {
      if (Math.abs(this.camera.fov - this.blasterFovBase) > 0.05) {
        this.camera.fov += (this.blasterFovBase - this.camera.fov) * Math.min(1, delta * 16);
        this.camera.updateProjectionMatrix();
      }
      return;
    }
    this.blasterChargeTime += delta;
    const t = Math.min(this.blasterChargeTime / this.blasterChargeDuration, 1);
    this.camera.fov = THREE.MathUtils.lerp(this.blasterFovBase, this.blasterFovZoom, t * t);
    this.camera.updateProjectionMatrix();
    this.hud.setTint(t * 0.55);
    if (t >= 1) this.fireBlaster();
  }

  fireBlaster() {
    this.blasterCharging = false;
    this.blasterChargeTime = 0;
    this.hud.setTint(0);
    const fired = this.weapons.fire({
      scene: this.scene, world: this.world, dragons: this.enemyTargets, effects: this.effects, camera: this.camera,
    });
    if (fired) {
      this.addRecoil('blaster');
      this.audio.shoot('Blaster');
    }
  }

  cancelBlasterCharge() {
    if (!this.blasterCharging) return;
    this.blasterCharging = false;
    this.blasterChargeTime = 0;
    this.hud.setTint(0);
    this.camera.fov = this.blasterFovBase;
    this.camera.updateProjectionMatrix();
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
    if (groundHits.length || dragonHits.length) this.registerEnemyHit();
  }

  // --- "no-hit" threat marker -----------------------------------------------
  registerEnemyHit() {
    this.timeSinceHit = 0;
    this.threatTimer = 0;
    if (this.enemiesHighlighted) this.setEnemiesHighlighted(false);
  }

  setEnemiesHighlighted(on) {
    if (this.enemiesHighlighted === on) return;
    this.enemiesHighlighted = on;
    for (const manager of this.enemies.managers) manager.setHighlighted?.(on, BALANCE.threat.color);
  }

  updateThreatHighlight(delta) {
    if (this.threatTimer > 0) {
      this.threatTimer -= delta;
      if (this.threatTimer <= 0) { this.setEnemiesHighlighted(false); this.timeSinceHit = 0; }
      return;
    }
    this.timeSinceHit += delta;
    if (this.timeSinceHit >= BALANCE.threat.idleSeconds) {
      this.setEnemiesHighlighted(true);
      this.threatTimer = BALANCE.threat.highlightSeconds;
    }
  }

  meleeAttack() {
    if (this.meleeCooldown > 0) return;
    this.triggerSwing();

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
      ...this.witches.hitMelee(origin, direction, range, damage, arcCos),
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

  handleSamuraiSecondary() {
    const altHeld = this.input.pointerLocked && (this.input.isDown('Mouse2') || this.input.isDown('KeyF'));
    const altPressed = altHeld && !this.altPrevHeld;

    if (!this.samuraiBuffActive) {
      // Sheathed: parry to unsheathe (the buff triggers if an attack lands).
      if (altPressed) this.samuraiParry();
    } else if (altPressed && this.samuraiDashCd <= 0) {
      // Drawn: instant full-power dash on a 3s cooldown; stays unsheathed.
      this.samuraiDashMax();
      this.samuraiDashCd = 3;
    }

    this.altPrevHeld = altHeld;
  }

  // Full-power dash (no charging) that does NOT consume the unsheathe buff.
  samuraiDashMax() {
    this.triggerSwing(1.3);
    const k = BALANCE.katana;
    const length = k.dashMaxLength;
    const halfWidth = k.dashMaxWidth / 2;
    const damage = k.dashMaxDamage;

    const origin = this.player.object.position.clone();
    const forward = this.getForwardHorizontal();
    const right = new THREE.Vector3(forward.z, 0, -forward.x);

    this.player.lastMoveDir.copy(forward);
    this.player.startDash(length, k.dashSpeed);
    this.enemies.hitBox(origin, forward, right, length, halfWidth, damage);

    const slashes = Math.round(length * 4);
    for (let i = 0; i < slashes; i += 1) {
      const along = (i / slashes) * length + (Math.random() - 0.5);
      const side = (Math.random() - 0.5) * 2 * halfWidth;
      const pos = origin.clone().addScaledVector(forward, Math.max(0, along)).addScaledVector(right, side);
      pos.y += 0.6 + Math.random() * 1.8;
      this.effects.slashMark(pos, 1.4 + Math.random() * 0.9, 0xffffff);
    }
    this.audio.explosion();
  }

  // The samurai's second ability (Técnica slot): knockback strike when sheathed,
  // or the time-slow X cuts when drawn.
  samuraiSpecial() {
    if (this.samuraiBuffActive) this.samuraiXSlash();
    else this.samuraiKnockbackStrike();
  }

  // Sheathed: a heavy frontal blow that knocks enemies back. Low damage (just
  // enough to kill skeletons). 6s cooldown.
  samuraiKnockbackStrike() {
    if (this.knockbackCd > 0) return;
    this.knockbackCd = 6;
    this.triggerSwing(1.2, 'power'); // wind up right-and-back, then strike left

    const origin = this.getCameraWorldPosition();
    const direction = this.getLookDirection();
    const range = 6;
    const damage = 24; // kills skeletons (22), not zombies (30) or witches (26)
    const groundHits = [
      ...this.zombies.hitMelee(origin, direction, range, damage, 0.1),
      ...this.skeletons.hitMelee(origin, direction, range, damage, 0.1),
      ...this.witches.hitMelee(origin, direction, range, damage, 0.1),
    ];
    const dragonHits = this.dragons.hitMelee(origin, direction, range, damage, 0.1);
    this.applyMeleeHits(groundHits, dragonHits, 0xffd166, 1.3);

    const center = this.player.object.position.clone();
    this.enemies.knockback(center, range, 5);
    this.effects.shockwave(center, range, 0xffd166);
    this.audio.explosion();
  }

  // Drawn: 0.3s time-slow (blue + zoom), then two forward-travelling X cuts.
  // High damage, 30s cooldown, and it re-sheathes you.
  samuraiXSlash() {
    if (this.xSlashCd > 0) return;
    this.xSlashCd = 30;
    this.samuraiBuffActive = false; // re-sheathe
    this.samuraiBuffTimer = 0;
    this.updateViewmodel();
    this.timeSlowTimer = 0.3;
    this.spawnXSlash();
    this.audio.explosion();
  }

  spawnXSlash() {
    const forward = this.getForwardHorizontal();
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({
      color: 0xbfe0ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    for (const angle of [Math.PI / 4, -Math.PI / 4]) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(1, 7), material);
      bar.rotation.z = angle;
      group.add(bar);
    }
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), forward);
    const start = this.player.object.position.clone().addScaledVector(forward, 1.5);
    start.y = this.player.object.position.y + 1.4;
    group.position.copy(start);
    group.frustumCulled = false;
    this.scene.add(group);

    this.samuraiSlashes.push({ group, forward, right, position: start.clone(), speed: 3, traveled: 0, maxTravel: 16, damage: 200 });
  }

  updateSamuraiSlashes(delta) {
    for (let i = this.samuraiSlashes.length - 1; i >= 0; i -= 1) {
      const s = this.samuraiSlashes[i];
      const step = s.speed * delta;
      s.position.addScaledVector(s.forward, step);
      s.traveled += step;
      s.group.position.copy(s.position);

      const hits = this.enemies.hitBox(s.position, s.forward, s.right, 1, 2.5, s.damage);
      for (const hit of hits) this.effects.slashMark(hit.position, 2.2, 0xbfe0ff);

      if (s.traveled >= s.maxTravel) {
        this.scene.remove(s.group);
        s.group.traverse((c) => { c.geometry?.dispose?.(); if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose?.()); else c.material?.dispose?.(); });
        this.samuraiSlashes.splice(i, 1);
      }
    }
  }

  updateTimeSlow(rawDelta) {
    if (this.timeSlowTimer <= 0) return;
    this.timeSlowTimer -= rawDelta;
    const p = THREE.MathUtils.clamp(1 - this.timeSlowTimer / 0.3, 0, 1);
    const wave = Math.sin(p * Math.PI); // 0 -> 1 -> 0: zoom/tint in then out
    this.camera.fov = THREE.MathUtils.lerp(this.blasterFovBase, 52, wave);
    this.camera.updateProjectionMatrix();
    this.hud.setTint(0.4 * wave);
    if (this.timeSlowTimer <= 0) {
      this.timeSlowTimer = 0;
      this.camera.fov = this.blasterFovBase;
      this.camera.updateProjectionMatrix();
      this.hud.setTint(0);
    }
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
    this.triggerSwing(1.3);
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
    this.triggerSwing(1.4);
    const origin = this.getCameraWorldPosition();
    const direction = this.getLookDirection();
    const { sweepRange, sweepArcCos, sweepDamageMult } = BALANCE.sword;
    const damage = this.meleeDamage * sweepDamageMult;

    const groundHits = [
      ...this.zombies.hitMelee(origin, direction, sweepRange, damage, sweepArcCos),
      ...this.skeletons.hitMelee(origin, direction, sweepRange, damage, sweepArcCos),
      ...this.witches.hitMelee(origin, direction, sweepRange, damage, sweepArcCos),
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
    this.triggerSwing(1.5);
    const origin = this.getCameraWorldPosition();
    const direction = this.getLookDirection();
    const { aoeRadius, aoeDamageMult } = BALANCE.sword;
    const damage = this.meleeDamage * aoeDamageMult;

    // arcCos of -1 makes the hit ignore direction (full 360° circle).
    const groundHits = [
      ...this.zombies.hitMelee(origin, direction, aoeRadius, damage, -1),
      ...this.skeletons.hitMelee(origin, direction, aoeRadius, damage, -1),
      ...this.witches.hitMelee(origin, direction, aoeRadius, damage, -1),
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
    } else if (slot?.kind === 'ability') {
      // The samurai holds the katana for the Técnica slot too.
      if (slot.abilityId === 'samuraiSpecial') kind = this.samuraiBuffActive ? 'katana-drawn' : 'katana';
    }

    const sleeveByLoadout = { guns: 0xffd166, sword: 0x9aa6b2, dagger: 0x3f6b3a, katana: 0xb33636, spells: 0x6a3fb5 };
    const model = kind ? buildViewmodel(kind, { sleeve: sleeveByLoadout[this.character.loadout] ?? 0x6d6d6d }) : null;
    if (model) {
      this.camera.add(model);
      this.viewmodel = model;
      // Record the rest pose so recoil/swing offsets are relative to it.
      this.viewmodelBasePos.copy(model.position);
      this.viewmodelBaseRot.set(model.rotation.x, model.rotation.y, model.rotation.z);
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
    } else if (slot.abilityId === 'samuraiSpecial') {
      this.samuraiSpecial();
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
    this.cancelBlasterCharge();
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
      // Effect depends on the impact kind: small bullets/bolts spark, fire-zone
      // ticks have no impact effect (the burning circle is already drawn), and
      // everything else (fireballs, the boss ground ball) explodes.
      if (ball.kind === 'spark') {
        this.effects.impact(ball.position, 0xff5a2a);
      } else if (ball.kind !== 'fire') {
        this.effects.explosion(ball.position);
        this.audio.explosion();
      }
      if (ball.hitPlayer && ball.damage > 0) {
        // Fire-zone ticks can't be parried/reflected; you must leave the fire.
        if (ball.kind !== 'fire' && this.parryWindowTimer > 0 && !this.samuraiBuffActive) {
          this.samuraiParrySuccess();
          continue;
        }
        if (this.player.invulnerable) continue;
        this.player.damage(ball.damage);
        this.hud.flashDamage();
        if (ball.kind !== 'fire') this.audio.damage();
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
    const vp = this.platform.viewport;
    const aspect = vp.width / vp.height;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.aerialCamera.aspect = aspect;
    this.aerialCamera.updateProjectionMatrix();
    this.renderer.setSize(vp.width, vp.height);
  }

  dispose() {
    this.platform.loop.stop();
    // Multiplayer teardown: unsubscribe from server-driven events before any
    // manager goes away, so an in-flight enemySpawn doesn't try to push into
    // a disposed pool.
    try { this._enemySync?.disable?.(); } catch { /* ignore */ }
    try { this._worldSync?.disable?.(); } catch { /* ignore */ }
    try { this._networkMetrics?.stopSampling?.(); } catch { /* ignore */ }
    this._networkMetrics = null;
    // Drop the bridge waveStart / waveCinematic listeners installed in the
    // constructor.
    if (Array.isArray(this._netUnsubs)) {
      for (const off of this._netUnsubs) { try { off?.(); } catch { /* ignore */ } }
      this._netUnsubs.length = 0;
    }
    this._enemySync = null;
    this._worldSync = null;
    if (typeof window !== 'undefined' && window.__voxelGame === this) {
      window.__voxelGame = null;
    }
    this._uninstallExporter?.();
    this.profiler.dispose?.();
    this.hud.destroy?.();
    this.shop?.hide?.();
    this.removeAerialCircle();
    this.mage?.dispose?.();
    for (const bomb of this.bombs) this.scene.remove(bomb.mesh);
    this.bombs.length = 0;
    for (const s of this.samuraiSlashes) this.scene.remove(s.group);
    this.samuraiSlashes.length = 0;
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
    this.platform.dispose();
  }
}
