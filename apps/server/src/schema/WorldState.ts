import { Schema, type, MapSchema } from "@colyseus/schema";

/**
 * Authoritative voxel world state.
 *
 * The base terrain is procedurally generated from `seed` on both server and
 * client (Phase 3 lands the actual generator). Players may mine or place
 * blocks; each modification is stored as a delta keyed by "x,y,z".
 *
 * Delta value semantics:
 *   - `0` means the cell has been removed (mined).
 *   - Any other value `1..7` is a placed-block id (see BlockType in shared).
 *
 * Late joiners regenerate the base from `seed` then apply every delta in the
 * map. The order doesn't matter because each cell stores the latest state.
 */
export class WorldState extends Schema {
  @type("uint32") seed: number = 0;
  @type("uint16") width: number = 64;
  @type("uint16") depth: number = 64;
  @type("uint8") maxHeight: number = 20;
  @type("uint8") waterLevel: number = 6;

  /**
   * Edits made by players. Key = "x,y,z". Value: 0 = removed,
   * otherwise BLOCK_TO_ID (1..7) for placed blocks.
   *
   * Clients regenerate the base world from `seed` then apply deltas in order.
   */
  @type({ map: "uint8" }) deltas = new MapSchema<number>();

  /** Monotonic sequence used by `WorldDelta` broadcasts so clients can dedupe. */
  @type("uint32") deltaSeq: number = 0;
}
