export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function rand(min = 0, max = 1) {
  return lerp(min, max, Math.random());
}

export function hashNoise(x = 0, z = 0, seed = 1337) {
  let h = Math.imul(Math.floor(x), 374761393)
    ^ Math.imul(Math.floor(z), 668265263)
    ^ Math.imul(Math.floor(seed), 1442695041);

  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

export const BALANCE = deepFreeze({
  colors: {
    sky: 0x8fc7ff,
    fog: 0x8fc7ff,
    sun: 0xfff0c5,
    hemisphereSky: 0xcfe8ff,
    hemisphereGround: 0x31451e,
    grass: 0x58a548,
    dirt: 0x8b5a2b,
    stone: 0x7b7f86,
    water: 0x2f8ed8,
    dragonBody: 0x3e6f45,
    dragonBelly: 0x8aa36a,
    dragonWing: 0x2d5538,
    dragonHorn: 0xd8d0a8,
    dragonFire: 0xff6b1a,
    dragonFireEmissive: 0xff3400,
  },

  world: {
    blockSize: 1,
    width: 80,
    depth: 80,
    maxHeight: 22,
    waterLevel: 6,
    seed: 1337,
    terrain: {
      broadScale: 18,
      detailScale: 7,
      broadAmplitude: 10,
      detailAmplitude: 4,
      surfaceBias: 0.45,
    },
    interactionRange: 8,
    fogNear: 80,
    fogFar: 340,
  },

  player: {
    height: 1.75,
    radius: 0.35,
    moveSpeed: 7,
    sprintMultiplier: 1.5,
    jumpSpeed: 8,
    gravity: 24,
    groundY: 0,
    mouseSensitivity: 0.0022,
    maxHealth: 100,
    maxShield: 100,
    shieldRegenPercent: 2,
    ammo: 30,
    maxAmmo: 30,
    spawnYOffset: 2.2,
  },

  weapons: [
    {
      id: 'rifle',
      name: 'Rifle',
      damage: 22,
      range: 90,
      fireRate: 8,
      clipSize: 30,
      reserveAmmo: 0,
      reloadTime: 1.4,
      pellets: 1,
      spread: 0.008,
      automatic: true,
      projectile: false,
      flashColor: 0xffd166,
    },
    {
      id: 'shotgun',
      name: 'Shotgun',
      damage: 9,
      range: 22,
      fireRate: 1.2,
      clipSize: 8,
      reserveAmmo: 8,
      reloadTime: 1.85,
      pellets: 8,
      spread: 0.09,
      cone: true,
      spreadAngle: 0.22,
      automatic: false,
      projectile: false,
      flashColor: 0xff9f1c,
    },
    {
      id: 'blaster',
      name: 'Blaster',
      damage: 150,
      range: 140,
      fireRate: 0.2,
      clipSize: 1,
      reserveAmmo: 2,
      reloadTime: 2.2,
      pellets: 1,
      spread: 0,
      automatic: true,
      projectile: false,
      penetrate: true,
      flashColor: 0x54d2ff,
    },
    {
      id: 'pistol',
      name: 'Pistola',
      damage: 12,
      range: 70,
      fireRate: 4, // half the rifle's cadence
      clipSize: 12,
      reserveAmmo: 0,
      reloadTime: 1.0,
      pellets: 1,
      spread: 0.02,
      automatic: true,
      projectile: false,
      infiniteAmmo: true,
      flashColor: 0xfff0a0,
    },
    {
      id: 'dagger',
      name: 'Daga',
      damage: 26,
      range: 70,
      fireRate: 2.4,
      clipSize: 99,
      reserveAmmo: 999,
      reloadTime: 1.0,
      pellets: 1,
      spread: 0.012,
      automatic: false,
      projectile: true,
      projectileSpeed: 36,
      projectileRadius: 0.12,
      gravity: 24, // gives the thrown dagger its arc/drop
      flashColor: 0xcfd6df,
    },
  ],

  zombies: {
    health: 30,
    speed: 3.4,
    damage: 8,
    attackRange: 2.3,
    attackCooldown: 1.1,
    spawnRadiusMin: 14,
    spawnRadiusMax: 24,
  },

  sword: {
    damage: 40, // one-shots a zombie (30 hp)
    range: 4.2,
    cooldown: 1.0, // seconds between slashes
    arcCos: 0.3, // frontal cone (~72 degrees half-angle)
    // Charged attacks (hold left click as the knight).
    sweepCharge: 1.5, // seconds to charge the blue giant sweep
    aoeCharge: 4.0, // seconds to charge the white-aura circular AoE
    sweepRange: 9, // reach of the giant sweep
    sweepArcCos: -0.25, // very wide frontal arc
    sweepDamageMult: 2, // double a normal slash
    aoeRadius: 18, // radius of the circular area attack (greatly increased)
    aoeDamageMult: 4, // big damage
  },

  katana: {
    damage: 28, // less than the sword (40)
    cooldown: 0.9,
    range: 4.2,
    arcCos: 0.3,
    buffDamageMult: 2, // basic attacks hit much harder while buffed
    buffCooldown: 0.35, // and much faster
    buffDuration: 10,
    parryWindow: 0.5, // you must be attacked within this window to trigger the buff
    parryRadius: 5.5,
    parryKnockback: 4,
    dashMaxCharge: 3.0,
    dashSpeed: 42,
    dashMinLength: 5,
    dashMaxLength: 12,
    dashMinWidth: 2,
    dashMaxWidth: 4,
    dashMinDamage: 60,
    dashMaxDamage: 180,
  },

  bomb: {
    startCount: 2,
    waveRefill: 2, // extra bombs granted at the shop wave
    fuse: 1.5, // seconds before it blows
    radius: 7.5, // small enough that only a dash escapes it
    damage: 70, // to enemies
    playerDamage: 50, // to the hunter if caught in the blast
  },

  aerial: {
    duration: 2.0, // seconds in the top-down view (invulnerable)
    slashDuration: 0.5, // burst of slashes afterwards
    radius: 4, // circle radius around the player
    damage: 80, // dealt to enemies inside the circle
    cooldown: 30,
  },

  guard: {
    duration: 0.8, // seconds the guard stays up
    cooldown: 1.25, // before it can be raised again
    reflectDamage: 100, // a reflected fireball one-shots the dragon
  },

  dash: {
    distance: 8, // blocks travelled
    speed: 38, // blocks per second
    cooldown: 5, // seconds between dashes
  },

  mage: {
    health: 25,
    mana: 225, // stored as the shield
    nukeRegenLock: 10, // seconds mana can't regen after a nuke
    skills: {
      fireball: { cost: 5, cd: 0, speed: 16, radius: 2.6, damage: 34, life: 4 },
      thunder: { cost: 40, cd: 10, delay: 1.5, radius: 2, damage: 130 },
      tornado: { cost: 70, cd: 10, ahead: 5, radius: 4, duration: 4, tickRate: 0.5, tickDamage: 3 }, // total 24 < 30 zombie hp
      blizzard: { cost: 60, cd: 10, speed: 9, radius: 5, damage: 24, slowFactor: 0.5, slowDuration: 5, life: 5 },
      nuke: { cost: 225, cd: 10, radius: 38, damage: 9999 },
    },
  },

  progression: {
    waveCount: 10, // total waves in a run
    shopWave: 5, // the shop opens before this wave
    // Reserve ammo granted when reaching the shop wave (only useful to the duck).
    waveAmmo: { Rifle: 60, Shotgun: 16, Blaster: 3 },
  },

  slash: {
    zombieSize: 1.6,
    dragonSize: 3.4,
  },

  skeletons: {
    health: 22, // less than a zombie (30); the fire tornado (24 total) kills them
    speed: 3.0,
    shootRange: 18,
    keepMin: 9, // retreat when the player is closer than this
    keepMax: 15, // follow when the player is farther than this
    shootCooldown: 2.0,
    arrowSpeed: 24,
    arrowDamage: 6,
    reflectDamage: 30, // a guard-reflected arrow one-shots its shooter
  },

  witches: {
    health: 26,
    speed: 3.0,
    keepMin: 12, // keeps a bit more distance than the skeleton (9)
    keepMax: 19,
    throwRange: 22,
    throwCooldown: 2.4,
    potionSpeed: 14,
    healRadius: 6, // 50% larger explosion
    healAmount: 28, // double the heal
  },

  coins: {
    zombie: 2,
    skeleton: 3,
    witch: 4,
    dragon: 5,
  },

  // After this long without damaging any enemy, every enemy glows red for a
  // while so you can find them. Resets the moment you land a hit.
  threat: {
    idleSeconds: 10,
    highlightSeconds: 5,
    color: 0xff2020,
  },

  // Campaign mode (vs the default "waves" mode). The duck starts with only the
  // pistol, plays 20 waves, shops every 5, and ground mobs have a head hitbox
  // that pays bonus coins on a killing headshot.
  campaign: {
    waveCount: 20,
    shopEvery: 5,
    headshotDamageMult: 2,
    headshotBonusCoins: 4,
    startWeapons: ['pistol'],
    // Guns sold in the campaign shop (the same arsenal as waves mode).
    shopWeapons: [
      { id: 'rifle', name: 'Rifle', cost: 28 },
      { id: 'shotgun', name: 'Shotgun', cost: 22 },
      { id: 'blaster', name: 'Blaster', cost: 46 },
    ],
    // Reserve ammo granted when a gun is bought.
    weaponAmmo: { Rifle: 90, Shotgun: 24, Blaster: 6 },
  },

  // Wave-5 miniboss (waves mode only): a big red dragon that cycles attacks.
  boss: {
    wave: 5,
    enemyScale: 0.5,   // fewer regular enemies on the boss wave
    health: 900,
    scale: 1.9,        // model size multiplier
    color: 0xb01818,
    fire: 0xff3a10,
    // Big ground ball -> a burning circle that hurts per second for a while.
    ground: { speed: 17, damage: 10, count: 2, zoneRadius: 4.2, zoneDps: 22, zoneTtl: 5, tickRate: 0.5 },
    // Fast little bolts with slight auto-aim.
    homing: { speed: 30, damage: 9, count: 5, turn: 2.2, life: 3, radius: 0.7 },
    // Machine-gun: many tiny fast bullets, only dodgeable behind cover.
    machinegun: { speed: 46, damage: 4, burst: 22, interval: 0.06, spread: 0.07, life: 2.2, radius: 0.45 },
    attackEvery: [1.6, 2.6], // random gap (min,max) between attack patterns
  },

  // Wave-10 cutscene (waves mode only): a meteor smashes the castle into a
  // crater, then the player respawns somewhere random on the cratered map.
  meteor: {
    wave: 10,
    height: 95,       // meteor start altitude
    fallTime: 1.8,    // seconds to impact
    flashTime: 0.9,   // white-out duration that hides the map swap
    craterRadius: 18, // covers the castle + plateau
  },

  shop: {
    items: [
      { id: 'damage', name: '+25% Daño', emoji: '⚔️', cost: 18 },
      { id: 'speed', name: '+15% Velocidad', emoji: '👟', cost: 14 },
      { id: 'health', name: '+40 Vida máx', emoji: '❤️', cost: 14 },
      { id: 'shield', name: '+25 Escudo máx', emoji: '🛡️', cost: 12 },
    ],
  },

  dragons: {
    count: 3,
    spawnRadius: 34,
    spawnRadiusStep: 5,
    minAltitude: 13,
    maxAltitude: 22,
    health: 100,
    fireballDamage: 14,
    fireballSpeed: 24,
    fireballLife: 3.25,
    fireballCollisionRadius: 1.15,
    attackRangeBase: 52,
    attackCooldownMin: 1.35,
    attackCooldownMax: 3.2,
    baseSpeed: 0.24,
    speedStep: 0.035,
    baseAggression: 0.58,
    aggressionStep: 0.13,
    orbitPressure: 0.35,
    bobAmplitude: 1.6,
    bobSpeed: 2.5,
    wingFlapSpeed: 12,
    wingFlapAmplitude: 0.55,
  },
});

export default BALANCE;
