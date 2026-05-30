import { Schema, type } from "@colyseus/schema";

/**
 * Projectile launched by a dragon. Lives are in seconds; the simulation
 * decrements `life` each tick and despawns at <= 0.
 */
export class FireballState extends Schema {
  @type("string") id: string = "";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") z: number = 0;
  @type("number") vx: number = 0;
  @type("number") vy: number = 0;
  @type("number") vz: number = 0;
  @type("string") ownerId: string = "";
  @type("number") damage: number = 0;
  @type("number") life: number = 3.25;
}
