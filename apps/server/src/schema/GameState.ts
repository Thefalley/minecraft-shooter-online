import { Schema, type, MapSchema } from "@colyseus/schema";
import { VoxelPlayer } from "./VoxelPlayer.js";
import { WorldState } from "./WorldState.js";
import { EnemyState } from "./EnemyState.js";
import { DragonState } from "./DragonState.js";
import { FireballState } from "./FireballState.js";

/**
 * Root authoritative state for a single Voxel-Dragons room.
 *
 * `phase` mirrors the {@link RoomPhase} union from `@mvp/shared`:
 *   "lobby" — waiting for the host to start the run.
 *   "playing" — wave in progress, enemies spawning, edits accepted.
 *   "shop"   — between-waves break; players spend coins, `shopEndsAt` is set.
 *   "dead"   — all players down, run over.
 */
export class GameState extends Schema {
  @type("string") roomCode: string = "";
  @type("uint32") tick: number = 0;

  /** "lobby" | "playing" | "shop" | "dead" */
  @type("string") phase: string = "lobby";

  @type("uint16") wave: number = 0;
  @type("uint16") totalWaves: number = 10;

  /** Date.now() timestamp at which the shop phase auto-closes. 0 outside shop. */
  @type("uint64") shopEndsAt: number = 0;

  @type({ map: VoxelPlayer }) players = new MapSchema<VoxelPlayer>();
  @type(WorldState) world = new WorldState();
  @type({ map: EnemyState }) enemies = new MapSchema<EnemyState>();
  @type({ map: DragonState }) dragons = new MapSchema<DragonState>();
  @type({ map: FireballState }) fireballs = new MapSchema<FireballState>();
}
