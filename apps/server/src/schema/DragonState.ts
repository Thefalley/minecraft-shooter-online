import { Schema, type } from "@colyseus/schema";

/**
 * Authoritative state for a boss dragon. Dragons launch fireballs (see
 * {@link FireballState}). `aggression` (0..1) lets the AI bias between
 * patrol and pursuit.
 */
export class DragonState extends Schema {
  @type("string") id: string = "";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") z: number = 0;
  @type("number") rotationY: number = 0;
  @type("number") health: number = 100;
  @type("number") maxHealth: number = 100;
  @type("number") aggression: number = 0.5;
  @type("uint8") flags: number = 0;
}
