import { Room, Client } from "@colyseus/core";
import {
  ClientMessage,
  GAME_ROOM_NAME,
  MAX_PLAYERS_PER_ROOM,
  PLAYER_DEFAULT_HEALTH,
  PLAYER_MAX_DELTA,
  PLAYER_SPAWN_Y,
  PLAYER_SPEED,
  ServerMessage,
  TICK_INTERVAL_MS,
  WORLD_HALF_SIZE,
  type ErrorPayload,
  type PlayerInput,
  type PlayerJoinedPayload,
  type PlayerLeftPayload,
  type WelcomePayload,
} from "@mvp/shared";
import { GameState } from "../schema/GameState.js";
import { Player } from "../schema/Player.js";
import { generateRoomCode } from "../utils/roomCode.js";
import { isValidName, sanitizeName } from "../utils/validators.js";

interface JoinOpts {
  name?: string;
  code?: string;
  create?: boolean;
}

interface BufferedInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  rotationY: number;
  seq: number;
  receivedAt: number;
}

export class GameRoom extends Room<GameState> {
  // Server keeps the latest input per client (sessionId)
  private latestInputs = new Map<string, BufferedInput>();
  private spawnAngle = 0;

  maxClients = MAX_PLAYERS_PER_ROOM;

  async onCreate(options: JoinOpts) {
    this.setState(new GameState());

    // Generate or accept a room code
    const wantedCode = (options.code ?? "").toUpperCase();
    const code = wantedCode || generateRoomCode();
    this.state.roomCode = code;
    this.roomId = `room-${code}`;
    this.setMetadata({ roomCode: code });

    this.setPatchRate(1000 / 20); // 20 Hz state patches
    this.setSimulationInterval(() => this.update(), TICK_INTERVAL_MS);

    this.onMessage(ClientMessage.Input, (client, input: PlayerInput) => {
      this.handleInput(client, input);
    });

    console.log(`[GameRoom] created roomCode=${code} roomId=${this.roomId}`);
  }

  static onAuth(_token: string, options: JoinOpts) {
    if (!isValidName(options.name)) {
      throw new Error("INVALID_NAME");
    }
    return true;
  }

  onJoin(client: Client, options: JoinOpts) {
    const name = sanitizeName(options.name ?? "Player");

    if (this.state.players.size >= MAX_PLAYERS_PER_ROOM) {
      const payload: ErrorPayload = { code: "ROOM_FULL", message: "Sala llena" };
      client.send(ServerMessage.Error, payload);
      client.leave(1000);
      return;
    }

    const player = new Player();
    player.id = client.sessionId;
    player.name = name;
    // Spawn on a circle around origin so players don't overlap
    const angle = (this.spawnAngle += Math.PI / 4);
    const radius = 3;
    player.x = Math.cos(angle) * radius;
    player.z = Math.sin(angle) * radius;
    player.y = PLAYER_SPAWN_Y;
    player.rotationY = angle + Math.PI;
    player.health = PLAYER_DEFAULT_HEALTH;
    player.alive = true;
    player.connected = true;
    this.state.players.set(client.sessionId, player);

    const welcome: WelcomePayload = {
      selfId: client.sessionId,
      roomCode: this.state.roomCode,
    };
    client.send(ServerMessage.Welcome, welcome);

    const joined: PlayerJoinedPayload = { id: client.sessionId, name };
    this.broadcast(ServerMessage.PlayerJoined, joined, { except: client });

    console.log(`[GameRoom ${this.state.roomCode}] +join ${name} (${client.sessionId}) total=${this.state.players.size}`);
  }

  async onLeave(client: Client, consented: boolean) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    player.connected = false;

    if (consented) {
      this.removePlayer(client.sessionId);
      return;
    }

    // Allow short reconnect window
    try {
      await this.allowReconnection(client, 10);
      player.connected = true;
      console.log(`[GameRoom ${this.state.roomCode}] reconnected ${player.name}`);
    } catch {
      this.removePlayer(client.sessionId);
    }
  }

  private removePlayer(sessionId: string) {
    const player = this.state.players.get(sessionId);
    if (!player) return;
    const left: PlayerLeftPayload = { id: sessionId, name: player.name };
    this.state.players.delete(sessionId);
    this.latestInputs.delete(sessionId);
    this.broadcast(ServerMessage.PlayerLeft, left);
    console.log(`[GameRoom ${this.state.roomCode}] -leave ${player.name} total=${this.state.players.size}`);
  }

  private handleInput(client: Client, input: PlayerInput) {
    if (!input || typeof input !== "object") return;
    const sanitized: BufferedInput = {
      forward: !!input.forward,
      backward: !!input.backward,
      left: !!input.left,
      right: !!input.right,
      rotationY: typeof input.rotationY === "number" && Number.isFinite(input.rotationY) ? input.rotationY : 0,
      seq: typeof input.seq === "number" ? input.seq : 0,
      receivedAt: Date.now(),
    };
    this.latestInputs.set(client.sessionId, sanitized);
  }

  private update() {
    this.state.tick++;
    const dt = TICK_INTERVAL_MS / 1000;

    this.state.players.forEach((player, sessionId) => {
      if (!player.alive || !player.connected) return;
      const input = this.latestInputs.get(sessionId);
      if (!input) return;

      // Compute movement direction in player local frame, then rotate by yaw
      let mx = 0;
      let mz = 0;
      if (input.forward) mz -= 1;
      if (input.backward) mz += 1;
      if (input.left) mx -= 1;
      if (input.right) mx += 1;
      if (mx === 0 && mz === 0) {
        player.rotationY = input.rotationY;
        return;
      }
      const len = Math.hypot(mx, mz);
      mx /= len;
      mz /= len;

      const cos = Math.cos(input.rotationY);
      const sin = Math.sin(input.rotationY);
      const worldX = mx * cos - mz * sin;
      const worldZ = mx * sin + mz * cos;

      let dx = worldX * PLAYER_SPEED * dt;
      let dz = worldZ * PLAYER_SPEED * dt;

      // Clamp per-tick delta (defensive)
      const deltaLen = Math.hypot(dx, dz);
      if (deltaLen > PLAYER_MAX_DELTA) {
        const scale = PLAYER_MAX_DELTA / deltaLen;
        dx *= scale;
        dz *= scale;
      }

      let nx = player.x + dx;
      let nz = player.z + dz;

      // World bounds
      if (nx > WORLD_HALF_SIZE) nx = WORLD_HALF_SIZE;
      if (nx < -WORLD_HALF_SIZE) nx = -WORLD_HALF_SIZE;
      if (nz > WORLD_HALF_SIZE) nz = WORLD_HALF_SIZE;
      if (nz < -WORLD_HALF_SIZE) nz = -WORLD_HALF_SIZE;

      player.x = nx;
      player.z = nz;
      player.y = PLAYER_SPAWN_Y;
      player.rotationY = input.rotationY;
    });
  }

  onDispose() {
    console.log(`[GameRoom ${this.state.roomCode}] disposed`);
  }
}

export { GAME_ROOM_NAME };
