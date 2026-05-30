import { Schema, type } from "@colyseus/schema";

/**
 * Authoritative state for a single enemy. The discriminator is `kind`
 * (one of "skeleton" | "zombie" | "witch") — the simulation in
 * `systems/EnemyAI.ts` dispatches on it.
 *
 * `flags` is reserved for cheap booleans (slow tint, lifted by tornado, etc.)
 * packed by the systems that need them. Bit 0 = slowed, Bit 1 = lifted.
 */
export class EnemyState extends Schema {
  @type("string") id: string = "";
  /** "skeleton" | "zombie" | "witch" */
  @type("string") kind: string = "zombie";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") z: number = 0;
  @type("number") rotationY: number = 0;
  @type("number") health: number = 100;
  @type("number") maxHealth: number = 100;
  @type("uint8") flags: number = 0;
}
