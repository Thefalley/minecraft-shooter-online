import { Schema, type } from "@colyseus/schema";

/**
 * Authoritative per-player snapshot for the Voxel-Dragons game.
 *
 * Replaces the original {@link Player} schema. Fields are exposed as Colyseus
 * primitives so clients can patch incrementally without bespoke serialization.
 * The original `Player` is kept on disk only as a compatibility checkpoint —
 * `GameState` now references this class instead.
 */
export class VoxelPlayer extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "";
  /** Selected character id. Defaults to "duck" (one of CharacterId). */
  @type("string") characterId: string = "duck";

  // Transform.
  @type("number") x: number = 0;
  @type("number") y: number = 1;
  @type("number") z: number = 0;
  @type("number") rotationY: number = 0;
  @type("number") pitch: number = 0;

  // Velocity. Stored so the client can extrapolate between patches.
  @type("number") vx: number = 0;
  @type("number") vy: number = 0;
  @type("number") vz: number = 0;

  // Combat stats.
  @type("number") health: number = 100;
  @type("number") maxHealth: number = 100;
  @type("number") shield: number = 0;
  @type("number") maxShield: number = 0;
  @type("number") ammo: number = 0;
  @type("number") reserveAmmo: number = 0;
  @type("number") coins: number = 0;

  // Loadout / progression.
  @type("uint8") selectedSlotIndex: number = 0;
  @type("uint16") wave: number = 1;

  // Status flags.
  @type("boolean") alive: boolean = true;
  @type("boolean") connected: boolean = true;
  @type("boolean") isGrounded: boolean = true;
  @type("boolean") isReloading: boolean = false;
  @type("boolean") guardActive: boolean = false;
  @type("boolean") readyForNextWave: boolean = false;
}
