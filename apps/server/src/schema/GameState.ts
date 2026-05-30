import { Schema, type, MapSchema } from "@colyseus/schema";
import { Player } from "./Player.js";

export class GameState extends Schema {
  @type("string") roomCode: string = "";
  @type("number") tick: number = 0;
  @type({ map: Player }) players = new MapSchema<Player>();
}
