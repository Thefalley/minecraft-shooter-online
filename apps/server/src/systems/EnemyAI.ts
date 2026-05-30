import { BLOCK_INTERACTION_RANGE } from "@mvp/shared";
import type { EnemyState } from "../schema/EnemyState.js";

/**
 * Minimal authoritative AI for skeleton/zombie/witch enemies.
 *
 * The full client-side managers (apps/game/src/modules/{Skeleton,Zombie,Witch}Manager.js)
 * do physics, raycasts and visual effects. Server-side we only need:
 *
 *   1. Move toward the nearest alive player (with simple kiting for ranged
 *      units).
 *   2. Decide when to attack / shoot / throw.
 *   3. Emit an {@link EnemyEventOut} for the room to broadcast.
 *
 * No pathfinding, no voxel collision (Phase 3). `blockAt` is consulted only
 * for naive step-up / falling so enemies don't sink into the ground when the
 * voxel collider lands.
 */

export interface AIPlayerView {
  x: number;
  y: number;
  z: number;
  alive: boolean;
}

export interface AIContext {
  players: Iterable<AIPlayerView>;
  /** Returns 0 for empty cells. */
  blockAt(x: number, y: number, z: number): number;
}

export type EnemyEventOut =
  | { kind: "shoot"; target: [number, number, number] }
  | { kind: "throw"; target: [number, number, number] }
  | { kind: "attack" };

// Per-kind tuning lifted from the upstream client managers.
// Skeleton — kiting archer.
const SKELETON_SPEED = 3.0;
const SKELETON_KEEP_MIN = 9;
const SKELETON_KEEP_MAX = 15;
const SKELETON_SHOOT_RANGE = 18;
const SKELETON_SHOOT_COOLDOWN = 2.0;

// Zombie — melee shambler.
const ZOMBIE_SPEED = 3.4;
const ZOMBIE_ATTACK_RANGE = 2.3;
const ZOMBIE_ATTACK_COOLDOWN = 1.1;

// Witch — kiting support that lobs healing potions.
const WITCH_SPEED = 3.0;
const WITCH_KEEP_MIN = 12;
const WITCH_KEEP_MAX = 19;
const WITCH_THROW_RANGE = 22;
const WITCH_THROW_COOLDOWN = 2.4;

const MAX_STEP_UP = 1.1; // voxel step-up allowance (zombies).

/**
 * Per-enemy mutable cooldown state. Stored in a WeakMap so we never leak when
 * an EnemyState is despawned and garbage-collected.
 */
interface AICooldown {
  shootTimer: number;
  attackTimer: number;
  throwTimer: number;
}

const cooldowns = new WeakMap<EnemyState, AICooldown>();
function getCooldown(e: EnemyState): AICooldown {
  let c = cooldowns.get(e);
  if (!c) {
    c = { shootTimer: 0.8, attackTimer: 0.6, throwTimer: 1.0 };
    cooldowns.set(e, c);
  }
  return c;
}

/** Find the nearest alive player. Returns null when nobody is alive. */
function nearestAlivePlayer(
  e: EnemyState,
  players: Iterable<AIPlayerView>,
): AIPlayerView | null {
  let best: AIPlayerView | null = null;
  let bestDistSq = Infinity;
  for (const p of players) {
    if (!p.alive) continue;
    const dx = p.x - e.x;
    const dz = p.z - e.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestDistSq) {
      bestDistSq = d2;
      best = p;
    }
  }
  return best;
}

/**
 * Step `e` toward `target` along the XZ plane.
 *
 * `direction` is +1 to follow, -1 to retreat. Refuses to move into a block
 * taller than {@link MAX_STEP_UP} (matches the upstream zombie kiting code).
 */
function stepTowards(
  e: EnemyState,
  target: AIPlayerView,
  speed: number,
  dt: number,
  direction: number,
  ctx: AIContext,
): void {
  let dx = target.x - e.x;
  let dz = target.z - e.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-4) return;
  dx /= dist;
  dz /= dist;

  // Face the player regardless of motion.
  e.rotationY = Math.atan2(dx, dz);

  const stepX = dx * speed * dt * direction;
  const stepZ = dz * speed * dt * direction;
  const nx = e.x + stepX;
  const nz = e.z + stepZ;

  // Refuse to walk into a wall taller than MAX_STEP_UP.
  // blockAt returns 0 for empty; for now we sample at feet+1 and feet+2.
  const head = ctx.blockAt(Math.floor(nx), Math.floor(e.y + MAX_STEP_UP), Math.floor(nz));
  if (head !== 0) return;

  e.x = nx;
  e.z = nz;
}

/** Skeleton: kite the player, shoot arrows when in `SHOOT_RANGE`. */
export function tickSkeleton(
  e: EnemyState,
  ctx: AIContext,
  dt: number,
  rand: () => number,
): EnemyEventOut | null {
  void rand;
  const cd = getCooldown(e);
  cd.shootTimer = Math.max(0, cd.shootTimer - dt);

  const target = nearestAlivePlayer(e, ctx.players);
  if (!target) return null;

  const dist = Math.hypot(target.x - e.x, target.z - e.z);
  if (dist > SKELETON_KEEP_MAX) {
    stepTowards(e, target, SKELETON_SPEED, dt, +1, ctx);
  } else if (dist < SKELETON_KEEP_MIN) {
    stepTowards(e, target, SKELETON_SPEED, dt, -1, ctx);
  } else {
    // Face the player even when standing still.
    const dx = target.x - e.x;
    const dz = target.z - e.z;
    if (dx * dx + dz * dz > 1e-8) e.rotationY = Math.atan2(dx, dz);
  }

  if (dist <= SKELETON_SHOOT_RANGE && cd.shootTimer <= 0) {
    cd.shootTimer = SKELETON_SHOOT_COOLDOWN;
    // Aim at the torso (y + 1.3) per upstream SkeletonManager.shootArrow.
    return { kind: "shoot", target: [target.x, target.y + 1.3, target.z] };
  }
  return null;
}

/**
 * Zombie: chase and melee at `ZOMBIE_ATTACK_RANGE`. Defensive cap at
 * {@link BLOCK_INTERACTION_RANGE} so a desync can't make a zombie reach a
 * player from across the map.
 */
export function tickZombie(
  e: EnemyState,
  ctx: AIContext,
  dt: number,
  rand: () => number,
): EnemyEventOut | null {
  void rand;
  const cd = getCooldown(e);
  cd.attackTimer = Math.max(0, cd.attackTimer - dt);

  const target = nearestAlivePlayer(e, ctx.players);
  if (!target) return null;

  const dist = Math.hypot(target.x - e.x, target.z - e.z);
  if (dist > ZOMBIE_ATTACK_RANGE) {
    stepTowards(e, target, ZOMBIE_SPEED, dt, +1, ctx);
    return null;
  }

  if (dist > BLOCK_INTERACTION_RANGE) return null;

  if (cd.attackTimer <= 0) {
    cd.attackTimer = ZOMBIE_ATTACK_COOLDOWN;
    return { kind: "attack" };
  }
  return null;
}

/** Witch: kite the player further than skeletons, lob potions at nearest ally. */
export function tickWitch(
  e: EnemyState,
  ctx: AIContext,
  dt: number,
  rand: () => number,
): EnemyEventOut | null {
  void rand;
  const cd = getCooldown(e);
  cd.throwTimer = Math.max(0, cd.throwTimer - dt);

  const target = nearestAlivePlayer(e, ctx.players);
  if (!target) return null;

  const dist = Math.hypot(target.x - e.x, target.z - e.z);
  if (dist > WITCH_KEEP_MAX) {
    stepTowards(e, target, WITCH_SPEED, dt, +1, ctx);
  } else if (dist < WITCH_KEEP_MIN) {
    stepTowards(e, target, WITCH_SPEED, dt, -1, ctx);
  } else {
    const dx = target.x - e.x;
    const dz = target.z - e.z;
    if (dx * dx + dz * dz > 1e-8) e.rotationY = Math.atan2(dx, dz);
  }

  if (dist <= WITCH_THROW_RANGE && cd.throwTimer <= 0) {
    cd.throwTimer = WITCH_THROW_COOLDOWN;
    return { kind: "throw", target: [target.x, target.y + 1.3, target.z] };
  }
  return null;
}
