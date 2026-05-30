import { Schema, type } from "@colyseus/schema";

export class Player extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "";
  @type("number") x: number = 0;
  @type("number") y: number = 1;
  @type("number") z: number = 0;
  @type("number") rotationY: number = 0;
  @type("number") health: number = 100;
  @type("boolean") alive: boolean = true;
  @type("boolean") connected: boolean = true;
}
