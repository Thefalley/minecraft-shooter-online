import {
  BOSS_BALANCE,
  DRAGON_BALANCE,
  ENEMY_BALANCE,
  METEOR_BALANCE,
  PROGRESSION_BALANCE,
} from "@mvp/shared";
import { DragonState } from "../schema/DragonState.js";
import { EnemyState } from "../schema/EnemyState.js";
import type { GameState } from "../schema/GameState.js";

/**
 * Hard caps on the number of entities the server is willing to spawn in one
 * wave. The Phase 4 stress test showed Render Free comfortably handling
 * ~30 entities at 20 Hz; we cap there to stay inside that envelope.
 */
export const MAX_ENEMIES_PER_WAVE = 30;
export const MAX_DRAGONS_PER_WAVE = 3;

/**
 * Per-wave roster derived deterministically from the wave number.
 *
 * Looked up from {@link WAVE_ROSTERS} first; if the wave index is past the
 * table or no entry exists, falls back to a scaling formula that mirrors
 * the upstream single-player feel.
 */
export interface WaveRoster {
  zombies: number;
  skeletons: number;
  witches: number;
  dragons: number;
}

/**
 * Hand-tuned roster for waves 1..10. Lives here (server-only) rather than
 * `@mvp/shared` so client bundles don't need to know about it.
 */
const WAVE_ROSTERS: ReadonlyArray<WaveRoster> = [
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
];

export function rosterForWave(wave: number): WaveRoster {
  const w = Math.max(1, Math.trunc(wave));

  if (w - 1 < WAVE_ROSTERS.length) {
    const entry = WAVE_ROSTERS[w - 1];
    if (entry) return clampRoster(entry);
  }

  // Deterministic fallback scaling for waves past the table.
  const zombies = 3 + (w - 1) * 2;
  const skeletons = Math.max(0, w - 1);
  const witches = w >= 3 ? Math.floor((w - 1) / 2) : 0;
  const dragons = w >= 4 ? 1 + Math.floor((w - 4) / 3) : 0;

  return clampRoster({ zombies, skeletons, witches, dragons });
}

function clampRoster(r: WaveRoster): WaveRoster {
  // Total enemies budget (zombies+skeletons+witches) capped at
  // MAX_ENEMIES_PER_WAVE; dragons capped separately.
  let zombies = Math.max(0, r.zombies | 0);
  let skeletons = Math.max(0, r.skeletons | 0);
  let witches = Math.max(0, r.witches | 0);
  let dragons = Math.min(MAX_DRAGONS_PER_WAVE, Math.max(0, r.dragons | 0));

  let total = zombies + skeletons + witches;
  while (total > MAX_ENEMIES_PER_WAVE) {
    // Trim the largest bucket first to keep variety.
    if (zombies >= skeletons && zombies >= witches) zombies--;
    else if (skeletons >= witches) skeletons--;
    else witches--;
    total = zombies + skeletons + witches;
  }
  return { zombies, skeletons, witches, dragons };
}

/**
 * Allocate a new unique enemy id. Monotonically increasing across the room
 * lifetime so a despawn+respawn never collides.
 */
let nextEnemySeq = 1;
let nextDragonSeq = 1;
let nextFireballSeq = 1;
export function allocEnemyId(): string {
  return `e${nextEnemySeq++}`;
}
export function allocDragonId(): string {
  return `d${nextDragonSeq++}`;
}
export function allocFireballId(): string {
  return `f${nextFireballSeq++}`;
}

/**
 * Spawn every entity in the requested roster into `state`. The caller is
 * responsible for broadcasting the wave start; Colyseus schema sync handles
 * per-entity propagation.
 *
 * Returns the list of ids spawned (useful for tests / logging).
 */
export interface SpawnedIds {
  enemies: string[];
  dragons: string[];
}

export function spawnWave(
  state: GameState,
  wave: number,
  rand: () => number,
): SpawnedIds {
  // Wave 10 is a scripted cinematic; the room broadcasts the meteor and the
  // crater deltas, then spawns nothing. The caller (GameRoom) handles the
  // cinematic transition; if someone routes through spawnWave directly we
  // bail without touching state.
  if (isCinematicWave(wave)) {
    return { enemies: [], dragons: [] };
  }

  const roster = rosterForWave(wave);
  const enemies: string[] = [];
  const dragons: string[] = [];

  // Wave-5 miniboss: cut the regular roster by BOSS_BALANCE.enemyScale and
  // suppress the normal dragons (we spawn the boss in their place).
  const isBoss = isBossWave(wave);
  const scale = isBoss ? BOSS_BALANCE.enemyScale : 1;
  const zombiesN = Math.ceil(roster.zombies * scale);
  const skeletonsN = Math.ceil(roster.skeletons * scale);
  const witchesN = Math.ceil(roster.witches * scale);
  const dragonsN = isBoss ? 0 : roster.dragons;

  // Ring radius for enemies: 12..20 around origin.
  const ringMin = ENEMY_BALANCE.zombies.spawnRadiusMin ?? 14;
  const ringMax = ENEMY_BALANCE.zombies.spawnRadiusMax ?? 24;

  for (let i = 0; i < zombiesN; i++) {
    const e = makeEnemy("zombie", rand, ringMin, ringMax);
    state.enemies.set(e.id, e);
    enemies.push(e.id);
  }
  for (let i = 0; i < skeletonsN; i++) {
    const e = makeEnemy("skeleton", rand, ringMin, ringMax);
    state.enemies.set(e.id, e);
    enemies.push(e.id);
  }
  for (let i = 0; i < witchesN; i++) {
    const e = makeEnemy("witch", rand, ringMin, ringMax);
    state.enemies.set(e.id, e);
    enemies.push(e.id);
  }

  for (let i = 0; i < dragonsN; i++) {
    const d = makeDragon(rand, i);
    state.dragons.set(d.id, d);
    dragons.push(d.id);
  }

  if (isBoss) {
    const boss = makeBoss(rand);
    state.dragons.set(boss.id, boss);
    dragons.push(boss.id);
  }

  return { enemies, dragons };
}

function makeEnemy(
  kind: "zombie" | "skeleton" | "witch",
  rand: () => number,
  ringMin: number,
  ringMax: number,
): EnemyState {
  const e = new EnemyState();
  e.id = allocEnemyId();
  e.kind = kind;

  const angle = rand() * Math.PI * 2;
  const radius = ringMin + rand() * Math.max(0, ringMax - ringMin);
  e.x = Math.cos(angle) * radius;
  e.z = Math.sin(angle) * radius;
  e.y = 1;
  e.rotationY = angle + Math.PI;

  const stats = healthFor(kind);
  e.health = stats;
  e.maxHealth = stats;
  e.flags = 0;
  return e;
}

function healthFor(kind: "zombie" | "skeleton" | "witch"): number {
  if (kind === "zombie") return ENEMY_BALANCE.zombies.health;
  if (kind === "skeleton") return ENEMY_BALANCE.skeletons.health;
  return ENEMY_BALANCE.witches.health;
}

function makeDragon(rand: () => number, index: number): DragonState {
  const d = new DragonState();
  d.id = allocDragonId();

  const baseR = DRAGON_BALANCE.spawnRadius ?? 34;
  const step = DRAGON_BALANCE.spawnRadiusStep ?? 5;
  const radius = baseR + index * step;
  const angle = rand() * Math.PI * 2;
  const minAlt = DRAGON_BALANCE.minAltitude ?? 13;
  const maxAlt = DRAGON_BALANCE.maxAltitude ?? 22;

  d.x = Math.cos(angle) * radius;
  d.z = Math.sin(angle) * radius;
  d.y = minAlt + rand() * Math.max(0, maxAlt - minAlt);
  d.rotationY = angle + Math.PI;

  d.health = DRAGON_BALANCE.health;
  d.maxHealth = DRAGON_BALANCE.health;
  d.aggression =
    (DRAGON_BALANCE.baseAggression ?? 0.5) +
    index * (DRAGON_BALANCE.aggressionStep ?? 0.1);
  d.flags = 0;
  d.boss = false;
  return d;
}

/**
 * Wave-5 miniboss. A single red dragon with a giant HP pool that orbits the
 * map at a fixed radius and cycles attack patterns. The aggression value is
 * pegged near max so any leftover orbital fireballs (none, in practice) ramp
 * up faster than a regular dragon would.
 */
function makeBoss(rand: () => number): DragonState {
  const d = new DragonState();
  d.id = allocDragonId();

  const angle = rand() * Math.PI * 2;
  d.x = Math.cos(angle) * BOSS_BALANCE.orbitRadius;
  d.z = Math.sin(angle) * BOSS_BALANCE.orbitRadius;
  d.y = BOSS_BALANCE.altitude;
  d.rotationY = angle + Math.PI;

  d.health = BOSS_BALANCE.health;
  d.maxHealth = BOSS_BALANCE.health;
  d.aggression = 0.95;
  d.flags = 0;
  d.boss = true;
  return d;
}

/** True if `wave` is the boss wave (wave 5 by default). */
export function isBossWave(wave: number): boolean {
  return Math.trunc(wave) === BOSS_BALANCE.wave;
}

/** True if `wave` is a scripted cinematic wave (wave 10 by default). */
export function isCinematicWave(wave: number): boolean {
  return Math.trunc(wave) === METEOR_BALANCE.wave;
}

/** Reset the id allocators. Useful for tests. Not called in production. */
export function _resetWaveDirector(): void {
  nextEnemySeq = 1;
  nextDragonSeq = 1;
  nextFireballSeq = 1;
}

/** True if the wave is cleared: no enemies and no dragons remain. */
export function isWaveCleared(state: GameState): boolean {
  return state.enemies.size === 0 && state.dragons.size === 0;
}

/** True if `wave` is the final wave in the progression. */
export function isFinalWave(wave: number): boolean {
  return wave >= (PROGRESSION_BALANCE.waveCount ?? 10);
}
