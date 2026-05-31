// Ported from apps/game/src/modules/GameBalance.js (BALANCE constant).
// Values are kept identical to the source-of-truth single-player game so
// that the multiplayer server can author authoritative behaviour with the
// same tuning. Do not invent new fields here — only port what exists.

export const PLAYER_BALANCE = {
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
} as const;

export const WEAPON_BALANCE = {
  rifle: {
    id: "rifle",
    name: "Rifle",
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
  shotgun: {
    id: "shotgun",
    name: "Shotgun",
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
  blaster: {
    id: "blaster",
    name: "Blaster",
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
  pistol: {
    id: "pistol",
    name: "Pistola",
    damage: 12,
    range: 70,
    // half the rifle's cadence
    fireRate: 4,
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
  dagger: {
    id: "dagger",
    name: "Daga",
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
    // gives the thrown dagger its arc/drop
    gravity: 24,
    flashColor: 0xcfd6df,
  },
} as const;

export const ENEMY_BALANCE = {
  zombies: {
    health: 30,
    speed: 3.4,
    damage: 8,
    attackRange: 2.3,
    attackCooldown: 1.1,
    spawnRadiusMin: 14,
    spawnRadiusMax: 24,
  },
  skeletons: {
    // less than a zombie (30); the fire tornado (24 total) kills them
    health: 22,
    speed: 3.0,
    shootRange: 18,
    // retreat when the player is closer than this
    keepMin: 9,
    // follow when the player is farther than this
    keepMax: 15,
    shootCooldown: 2.0,
    arrowSpeed: 24,
    arrowDamage: 6,
    // a guard-reflected arrow one-shots its shooter
    reflectDamage: 30,
  },
  witches: {
    health: 26,
    speed: 3.0,
    // keeps a bit more distance than the skeleton (9)
    keepMin: 12,
    keepMax: 19,
    throwRange: 22,
    throwCooldown: 2.4,
    potionSpeed: 14,
    // 50% larger explosion
    healRadius: 6,
    // double the heal
    healAmount: 28,
  },
} as const;

export const DRAGON_BALANCE = {
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
} as const;

/**
 * Wave-5 miniboss: a single red dragon with a far bigger HP pool that cycles
 * through three attack patterns (ground balls, homing bolts, machine-gun
 * burst). Mirrors BALANCE.boss in apps/game/src/core/config/GameBalance.js
 * so the server can author the boss authoritatively.
 */
export const BOSS_BALANCE = {
  wave: 5,
  enemyScale: 0.5,
  health: 900,
  scale: 1.9,
  color: 0xb01818,
  fire: 0xff3a10,
  orbitRadius: 15,
  altitude: 17.5,
  ground: {
    speed: 17,
    damage: 10,
    count: 2,
    zoneRadius: 4.2,
    zoneDps: 22,
    zoneTtl: 5,
    tickRate: 0.5,
  },
  homing: {
    speed: 30,
    damage: 9,
    count: 5,
    turn: 2.2,
    life: 3,
    radius: 0.7,
  },
  machinegun: {
    speed: 46,
    damage: 4,
    burst: 22,
    interval: 0.06,
    spread: 0.07,
    life: 2.2,
    radius: 0.45,
  },
  attackEvery: [1.6, 2.6] as const,
} as const;

/**
 * Wave-10 cutscene: a meteor smashes the castle into a crater. Used by both
 * the singleplayer flow and the multiplayer server (which broadcasts a
 * cinematic flag so every client plays the same animation at the same time).
 */
export const METEOR_BALANCE = {
  wave: 10,
  height: 95,
  fallTime: 1.8,
  flashTime: 0.9,
  craterRadius: 18,
  /** Total seconds the cinematic locks the room in. fall + flash + small buffer. */
  duration: 3.0,
} as const;

export const WORLD_BALANCE = {
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
} as const;

export const SHOP_BALANCE = {
  items: [
    { id: "damage", name: "+25% Daño", emoji: "⚔️", cost: 18 },
    { id: "speed", name: "+15% Velocidad", emoji: "👟", cost: 14 },
    { id: "health", name: "+40 Vida máx", emoji: "❤️", cost: 14 },
    { id: "shield", name: "+25 Escudo máx", emoji: "🛡️", cost: 12 },
  ],
} as const;

export const PROGRESSION_BALANCE = {
  // total waves in a run
  waveCount: 10,
  // the shop opens before this wave
  shopWave: 5,
  // Reserve ammo granted when reaching the shop wave (only useful to the duck).
  waveAmmo: { Rifle: 60, Shotgun: 16, Blaster: 3 },
} as const;

// Class- and ability-specific tuning ported verbatim from BALANCE.
export const SWORD_BALANCE = {
  // one-shots a zombie (30 hp)
  damage: 40,
  range: 4.2,
  // seconds between slashes
  cooldown: 1.0,
  // frontal cone (~72 degrees half-angle)
  arcCos: 0.3,
  // Charged attacks (hold left click as the knight).
  // seconds to charge the blue giant sweep
  sweepCharge: 1.5,
  // seconds to charge the white-aura circular AoE
  aoeCharge: 4.0,
  // reach of the giant sweep
  sweepRange: 9,
  // very wide frontal arc
  sweepArcCos: -0.25,
  // double a normal slash
  sweepDamageMult: 2,
  // radius of the circular area attack (greatly increased)
  aoeRadius: 18,
  // big damage
  aoeDamageMult: 4,
} as const;

export const KATANA_BALANCE = {
  // less than the sword (40)
  damage: 28,
  cooldown: 0.9,
  range: 4.2,
  arcCos: 0.3,
  // basic attacks hit much harder while buffed
  buffDamageMult: 2,
  // and much faster
  buffCooldown: 0.35,
  buffDuration: 10,
  // you must be attacked within this window to trigger the buff
  parryWindow: 0.5,
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
} as const;

export const BOMB_BALANCE = {
  startCount: 2,
  // extra bombs granted at the shop wave
  waveRefill: 2,
  // seconds before it blows
  fuse: 1.5,
  // small enough that only a dash escapes it
  radius: 7.5,
  // to enemies
  damage: 70,
  // to the hunter if caught in the blast
  playerDamage: 50,
} as const;

export const AERIAL_BALANCE = {
  // seconds in the top-down view (invulnerable)
  duration: 2.0,
  // burst of slashes afterwards
  slashDuration: 0.5,
  // circle radius around the player
  radius: 4,
  // dealt to enemies inside the circle
  damage: 80,
  cooldown: 30,
} as const;

export const GUARD_BALANCE = {
  // seconds the guard stays up
  duration: 0.8,
  // before it can be raised again
  cooldown: 1.25,
  // a reflected fireball one-shots the dragon
  reflectDamage: 100,
} as const;

export const DASH_BALANCE = {
  // blocks travelled
  distance: 8,
  // blocks per second
  speed: 38,
  // seconds between dashes
  cooldown: 5,
} as const;

export const MAGE_BALANCE = {
  health: 25,
  // stored as the shield
  mana: 225,
  // seconds mana can't regen after a nuke
  nukeRegenLock: 10,
  skills: {
    fireball: { cost: 5, cd: 0, speed: 16, radius: 2.6, damage: 34, life: 4 },
    thunder: { cost: 40, cd: 10, delay: 1.5, radius: 2, damage: 130 },
    // total 24 < 30 zombie hp
    tornado: {
      cost: 70,
      cd: 10,
      ahead: 5,
      radius: 4,
      duration: 4,
      tickRate: 0.5,
      tickDamage: 3,
    },
    blizzard: {
      cost: 60,
      cd: 10,
      speed: 9,
      radius: 5,
      damage: 24,
      slowFactor: 0.5,
      slowDuration: 5,
      life: 5,
    },
    nuke: { cost: 225, cd: 10, radius: 38, damage: 9999 },
  },
} as const;

export const COINS_BALANCE = {
  zombie: 2,
  skeleton: 3,
  witch: 4,
  dragon: 5,
} as const;

export const SLASH_BALANCE = {
  zombieSize: 1.6,
  dragonSize: 3.4,
} as const;

/**
 * Per-wave enemy rosters used by the server WaveDirector. Append-only so
 * older clients that don't know about this field keep working. If a wave
 * index is past the array length, the WaveDirector falls back to its
 * deterministic scaling formula.
 *
 * Counts are total budgets; the WaveDirector also enforces
 * MAX_ENEMIES_PER_WAVE (30) and MAX_DRAGONS_PER_WAVE (3) caps.
 */
export const WAVE_BALANCE = {
  rosters: [
    // wave 1 — easy intro
    { zombies: 3, skeletons: 1, witches: 0, dragons: 0 },
    // wave 2
    { zombies: 4, skeletons: 2, witches: 0, dragons: 0 },
    // wave 3
    { zombies: 5, skeletons: 2, witches: 1, dragons: 0 },
    // wave 4 — first dragon
    { zombies: 5, skeletons: 3, witches: 1, dragons: 1 },
    // wave 5
    { zombies: 6, skeletons: 3, witches: 2, dragons: 1 },
    // wave 6
    { zombies: 7, skeletons: 4, witches: 2, dragons: 1 },
    // wave 7 — second dragon
    { zombies: 8, skeletons: 4, witches: 3, dragons: 2 },
    // wave 8
    { zombies: 9, skeletons: 5, witches: 3, dragons: 2 },
    // wave 9
    { zombies: 10, skeletons: 5, witches: 4, dragons: 2 },
    // wave 10 — final
    { zombies: 12, skeletons: 6, witches: 4, dragons: 3 },
  ],
} as const;
