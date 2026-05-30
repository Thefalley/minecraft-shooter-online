import { Room, Client } from "@colyseus/core";
import {
  BLOCK_INTERACTION_RANGE,
  DEFAULT_WAVE_COUNT,
  GAME_ROOM_NAME,
  MAX_PLAYERS_PER_ROOM,
  PLAYER_DEFAULT_HEALTH,
  PLAYER_MAX_DELTA,
  PLAYER_SPAWN_Y,
  PLAYER_SPEED,
  ServerMessage,
  SHOP_DURATION_MS,
  TICK_INTERVAL_MS,
  VoxelClientMessage,
  VoxelServerMessage,
  WORLD_DEPTH,
  WORLD_HALF_SIZE,
  WORLD_MAX_HEIGHT,
  WORLD_WATER_LEVEL,
  WORLD_WIDTH,
} from "@mvp/shared";
import { GameState } from "../schema/GameState.js";
import { VoxelPlayer } from "../schema/VoxelPlayer.js";
import {
  type AIContext,
  type EnemyEventOut,
  tickSkeleton,
  tickWitch,
  tickZombie,
} from "../systems/EnemyAI.js";
import { mulberry32, pickSeed } from "../systems/WorldSeed.js";
import { generateRoomCode } from "../utils/roomCode.js";
import { isValidName, sanitizeName } from "../utils/validators.js";

interface JoinOpts {
  name?: string;
  code?: string;
  create?: boolean;
}

/** Input frame buffered per session and applied at tick. */
interface BufferedInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  rotationY: number;
  pitch: number;
  seq: number;
  receivedAt: number;
}

interface IncomingInput {
  forward?: unknown;
  backward?: unknown;
  left?: unknown;
  right?: unknown;
  jump?: unknown;
  rotationY?: unknown;
  pitch?: unknown;
  seq?: unknown;
}

interface IncomingWorldEdit {
  x?: unknown;
  y?: unknown;
  z?: unknown;
  t?: unknown;
}

interface IncomingSlotSelect {
  index?: unknown;
}

interface IncomingCharacterSelect {
  characterId?: unknown;
}

interface IncomingPing {
  t?: unknown;
}

interface IncomingShopBuy {
  itemId?: unknown;
}

interface IncomingWeaponFire {
  origin?: unknown;
  direction?: unknown;
  seq?: unknown;
}

// We forward the legacy lobby/landing handshake using the existing
// `ServerMessage` enum from `@mvp/shared`. The voxel-specific stream of
// messages uses {@link VoxelServerMessage}.

export class GameRoom extends Room<GameState> {
  /** Latest input frame per session id. Drained each tick. */
  private latestInputs = new Map<string, BufferedInput>();

  /** Spawn angle counter so concurrent joiners don't overlap. */
  private spawnAngle = 0;

  /** Deterministic RNG. Re-seeded in `onCreate`. */
  private rand: () => number = mulberry32(0);

  maxClients = MAX_PLAYERS_PER_ROOM;

  async onCreate(options: JoinOpts): Promise<void> {
    this.setState(new GameState());

    // Pick a fresh seed and snapshot the world dimensions.
    const seed = pickSeed();
    this.rand = mulberry32(seed);
    this.state.world.seed = seed;
    this.state.world.width = WORLD_WIDTH;
    this.state.world.depth = WORLD_DEPTH;
    this.state.world.maxHeight = WORLD_MAX_HEIGHT;
    this.state.world.waterLevel = WORLD_WATER_LEVEL;
    this.state.totalWaves = DEFAULT_WAVE_COUNT;

    // Generate or accept a room code.
    const wantedCode = (options.code ?? "").toUpperCase();
    const code = wantedCode || generateRoomCode();
    this.state.roomCode = code;
    this.roomId = `room-${code}`;
    this.setMetadata({ roomCode: code });

    this.setPatchRate(1000 / 20); // 20 Hz state patches
    this.setSimulationInterval(() => this.update(), TICK_INTERVAL_MS);

    this.registerMessageHandlers();

    console.log(
      `[GameRoom] created roomCode=${code} roomId=${this.roomId} seed=${seed}`,
    );
  }

  static async onAuth(_token: string, options: JoinOpts): Promise<boolean> {
    if (!isValidName(options.name)) {
      throw new Error("INVALID_NAME");
    }
    return true;
  }

  onJoin(client: Client, options: JoinOpts): void {
    const name = sanitizeName(options.name ?? "Player");

    if (this.state.players.size >= MAX_PLAYERS_PER_ROOM) {
      client.send(ServerMessage.Error, { code: "ROOM_FULL", message: "Sala llena" });
      client.leave(1000);
      return;
    }

    const player = new VoxelPlayer();
    player.id = client.sessionId;
    player.name = name;

    // Spawn on a circle around origin so concurrent joiners don't overlap.
    const angle = (this.spawnAngle += Math.PI / 4);
    const radius = 3;
    player.x = Math.cos(angle) * radius;
    player.z = Math.sin(angle) * radius;
    player.y = PLAYER_SPAWN_Y;
    player.rotationY = angle + Math.PI;
    player.health = PLAYER_DEFAULT_HEALTH;
    player.maxHealth = PLAYER_DEFAULT_HEALTH;
    player.alive = true;
    player.connected = true;
    this.state.players.set(client.sessionId, player);

    // Legacy welcome handshake, kept so the existing landing flow stays alive.
    client.send(ServerMessage.Welcome, {
      selfId: client.sessionId,
      roomCode: this.state.roomCode,
    });

    // Phase 1 voxel handshake: send seed + dimensions + all known deltas so
    // a late joiner can rebuild the current world by regenerating from the
    // seed and replaying the deltas.
    client.send(VoxelServerMessage.WorldSeed, {
      seed: this.state.world.seed,
      width: this.state.world.width,
      depth: this.state.world.depth,
      maxHeight: this.state.world.maxHeight,
      waterLevel: this.state.world.waterLevel,
      deltas: this.serializeDeltas(),
    });

    this.broadcast(
      ServerMessage.PlayerJoined,
      { id: client.sessionId, name },
      { except: client },
    );

    console.log(
      `[GameRoom ${this.state.roomCode}] +join ${name} (${client.sessionId}) total=${this.state.players.size}`,
    );
  }

  async onLeave(client: Client, consented: boolean): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    player.connected = false;

    if (consented) {
      this.removePlayer(client.sessionId);
      return;
    }

    // Allow a short reconnect window.
    try {
      await this.allowReconnection(client, 10);
      player.connected = true;
      console.log(
        `[GameRoom ${this.state.roomCode}] reconnected ${player.name}`,
      );
    } catch {
      this.removePlayer(client.sessionId);
    }
  }

  onDispose(): void {
    console.log(`[GameRoom ${this.state.roomCode}] disposed`);
  }

  // -------------------------------------------------------------------------
  // Message handlers
  // -------------------------------------------------------------------------

  private registerMessageHandlers(): void {
    this.onMessage(VoxelClientMessage.Input, (client, raw) =>
      this.handleInput(client, raw as IncomingInput),
    );
    this.onMessage(VoxelClientMessage.WorldMine, (client, raw) =>
      this.handleWorldEdit(client, raw as IncomingWorldEdit, "mine"),
    );
    this.onMessage(VoxelClientMessage.WorldPlace, (client, raw) =>
      this.handleWorldEdit(client, raw as IncomingWorldEdit, "place"),
    );
    this.onMessage(VoxelClientMessage.WeaponFire, (client, raw) =>
      this.handleWeaponFire(client, raw as IncomingWeaponFire),
    );
    this.onMessage(VoxelClientMessage.WeaponReload, (client) =>
      this.handleWeaponReload(client),
    );
    this.onMessage(VoxelClientMessage.AbilityUse, (client) =>
      this.handleAbilityUse(client),
    );
    this.onMessage(VoxelClientMessage.SlotSelect, (client, raw) =>
      this.handleSlotSelect(client, raw as IncomingSlotSelect),
    );
    this.onMessage(VoxelClientMessage.CharacterSelect, (client, raw) =>
      this.handleCharacterSelect(client, raw as IncomingCharacterSelect),
    );
    this.onMessage(VoxelClientMessage.ReadyNextWave, (client) =>
      this.handleReadyNextWave(client),
    );
    this.onMessage(VoxelClientMessage.ShopBuy, (client, raw) =>
      this.handleShopBuy(client, raw as IncomingShopBuy),
    );
    this.onMessage(VoxelClientMessage.Ping, (client, raw) =>
      this.handlePing(client, raw as IncomingPing),
    );
  }

  private handleInput(client: Client, input: IncomingInput): void {
    if (!input || typeof input !== "object") return;
    const sanitized: BufferedInput = {
      forward: !!input.forward,
      backward: !!input.backward,
      left: !!input.left,
      right: !!input.right,
      jump: !!input.jump,
      rotationY:
        typeof input.rotationY === "number" && Number.isFinite(input.rotationY)
          ? input.rotationY
          : 0,
      pitch:
        typeof input.pitch === "number" && Number.isFinite(input.pitch)
          ? input.pitch
          : 0,
      seq: typeof input.seq === "number" ? input.seq : 0,
      receivedAt: Date.now(),
    };
    this.latestInputs.set(client.sessionId, sanitized);
  }

  private handleWorldEdit(
    client: Client,
    raw: IncomingWorldEdit,
    op: "mine" | "place",
  ): void {
    if (!raw || typeof raw !== "object") return;
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const x = toInt(raw.x);
    const y = toInt(raw.y);
    const z = toInt(raw.z);
    if (x === null || y === null || z === null) return;

    // Distance validation: the player's eye is roughly y+1, but a generous
    // sphere from feet covers viewmodel offsets.
    const dx = x + 0.5 - player.x;
    const dy = y + 0.5 - player.y;
    const dz = z + 0.5 - player.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > BLOCK_INTERACTION_RANGE + 1) return;

    // Vertical bounds: clamp to the world's max height.
    if (y < 0 || y >= this.state.world.maxHeight) return;

    const key = `${x},${y},${z}`;
    const current = this.state.world.deltas.get(key);

    if (op === "mine") {
      // Must be a non-empty cell. We can't see procedural base here, so we
      // only reject if the delta map already says "removed" (0). Phase 3 will
      // consult the procedural seed too.
      if (current === 0) return;
      this.state.world.deltas.set(key, 0);
    } else {
      const t = toInt(raw.t);
      if (t === null || t < 1 || t > 7) return;
      // Cell must currently be empty: either the delta map says removed, or
      // we trust the procedural base; we accept either. To prevent stomping
      // an already-placed block, refuse if a non-zero delta exists.
      if (typeof current === "number" && current !== 0) return;
      this.state.world.deltas.set(key, t);
    }

    this.state.world.deltaSeq = (this.state.world.deltaSeq + 1) >>> 0;
    this.broadcast(VoxelServerMessage.WorldDelta, {
      op,
      x,
      y,
      z,
      t: op === "place" ? toInt(raw.t) : 0,
      seq: this.state.world.deltaSeq,
      by: client.sessionId,
    });
  }

  /**
   * Stub. Phase 5 lands lag-compensated ray resolution; for now we always
   * answer with a Miss so the client UX keeps animating.
   */
  private handleWeaponFire(
    client: Client,
    raw: IncomingWeaponFire,
  ): void {
    if (!raw || typeof raw !== "object") return;
    const seq = typeof raw.seq === "number" ? raw.seq : 0;
    client.send(VoxelServerMessage.WeaponMiss, { seq });
  }

  /** Stub. Phase 4 will manage ammo / cooldowns server-side. */
  private handleWeaponReload(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    // No-op for Phase 1: just echo the completion so the HUD finishes its
    // animation locally.
    client.send(VoxelServerMessage.WeaponReloadComplete, {
      ammo: player.ammo,
      reserveAmmo: player.reserveAmmo,
    });
  }

  /** Stub. Phase 4 / 5 will route ability effects. */
  private handleAbilityUse(_client: Client): void {
    // intentionally empty
  }

  private handleSlotSelect(client: Client, raw: IncomingSlotSelect): void {
    if (!raw || typeof raw !== "object") return;
    const idx = toInt(raw.index);
    if (idx === null || idx < 0 || idx > 9) return;
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    player.selectedSlotIndex = idx;
  }

  private handleCharacterSelect(
    client: Client,
    raw: IncomingCharacterSelect,
  ): void {
    if (!raw || typeof raw !== "object") return;
    if (this.state.phase !== "lobby") return;
    const id = typeof raw.characterId === "string" ? raw.characterId : "";
    if (!id) return;
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    player.characterId = id;
  }

  private handleReadyNextWave(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    player.readyForNextWave = true;

    // Advance if everyone alive is ready, or the shop timer expired.
    let allReady = true;
    let alive = 0;
    this.state.players.forEach((p) => {
      if (!p.alive || !p.connected) return;
      alive += 1;
      if (!p.readyForNextWave) allReady = false;
    });

    const expired =
      this.state.shopEndsAt !== 0 && Date.now() >= this.state.shopEndsAt;

    if ((allReady && alive > 0) || expired) {
      this.advanceToNextWave();
    }
  }

  /** Stub. Real shop lives in Phase 4. */
  private handleShopBuy(_client: Client, _raw: IncomingShopBuy): void {
    // intentionally empty
  }

  private handlePing(client: Client, raw: IncomingPing): void {
    const t =
      raw && typeof raw === "object" && typeof raw.t === "number" ? raw.t : 0;
    client.send(VoxelServerMessage.Pong, { t, serverT: Date.now() });
  }

  // -------------------------------------------------------------------------
  // Tick loop
  // -------------------------------------------------------------------------

  private update(): void {
    this.state.tick = (this.state.tick + 1) >>> 0;
    const dt = TICK_INTERVAL_MS / 1000;

    // Auto-close the shop when the timer expires (advance even if no player
    // sent ReadyNextWave).
    if (
      this.state.phase === "shop" &&
      this.state.shopEndsAt !== 0 &&
      Date.now() >= this.state.shopEndsAt
    ) {
      this.advanceToNextWave();
    }

    if (this.state.phase === "playing") {
      this.tickPlayers(dt);
      this.tickEnemies(dt);
      this.tickFireballs(dt);
    }
  }

  private tickPlayers(dt: number): void {
    this.state.players.forEach((player, sessionId) => {
      if (!player.alive || !player.connected) return;
      const input = this.latestInputs.get(sessionId);
      if (!input) return;

      // Compute movement direction in player local frame, then rotate by yaw.
      let mx = 0;
      let mz = 0;
      if (input.forward) mz -= 1;
      if (input.backward) mz += 1;
      if (input.left) mx -= 1;
      if (input.right) mx += 1;

      if (mx === 0 && mz === 0) {
        player.rotationY = input.rotationY;
        player.pitch = input.pitch;
        player.vx = 0;
        player.vz = 0;
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

      // Per-tick delta clamp (defensive).
      const deltaLen = Math.hypot(dx, dz);
      if (deltaLen > PLAYER_MAX_DELTA) {
        const scale = PLAYER_MAX_DELTA / deltaLen;
        dx *= scale;
        dz *= scale;
      }

      let nx = player.x + dx;
      let nz = player.z + dz;

      // Phase 1: no voxel collisions server-side. Clamp to the legacy square
      // world so the player can't wander to infinity while Phase 3 lands.
      if (nx > WORLD_HALF_SIZE) nx = WORLD_HALF_SIZE;
      if (nx < -WORLD_HALF_SIZE) nx = -WORLD_HALF_SIZE;
      if (nz > WORLD_HALF_SIZE) nz = WORLD_HALF_SIZE;
      if (nz < -WORLD_HALF_SIZE) nz = -WORLD_HALF_SIZE;

      player.x = nx;
      player.z = nz;
      player.y = PLAYER_SPAWN_Y;
      player.rotationY = input.rotationY;
      player.pitch = input.pitch;
      // Surface velocity so clients can extrapolate between patches.
      player.vx = dx / dt;
      player.vz = dz / dt;
      player.vy = 0;
    });
  }

  private tickEnemies(dt: number): void {
    if (this.state.enemies.size === 0) return;

    const ctx: AIContext = {
      players: this.iterPlayerViews(),
      blockAt: (x, y, z) => this.blockAt(x, y, z),
    };

    this.state.enemies.forEach((enemy) => {
      let ev: EnemyEventOut | null = null;
      switch (enemy.kind) {
        case "skeleton":
          ev = tickSkeleton(enemy, ctx, dt, this.rand);
          break;
        case "zombie":
          ev = tickZombie(enemy, ctx, dt, this.rand);
          break;
        case "witch":
          ev = tickWitch(enemy, ctx, dt, this.rand);
          break;
        default:
          break;
      }

      if (ev) {
        this.broadcast(VoxelServerMessage.EnemyEvent, {
          id: enemy.id,
          kind: ev.kind,
          ...("target" in ev ? { target: ev.target } : {}),
        });
      }
    });
  }

  /** Dragon fireballs. Phase 1 only decrements `life` and despawns. */
  private tickFireballs(dt: number): void {
    if (this.state.fireballs.size === 0) return;

    const expired: string[] = [];
    this.state.fireballs.forEach((fb, id) => {
      fb.x += fb.vx * dt;
      fb.y += fb.vy * dt;
      fb.z += fb.vz * dt;
      fb.life -= dt;
      if (fb.life <= 0) expired.push(id);
    });
    for (const id of expired) {
      this.state.fireballs.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private iterPlayerViews(): Iterable<{
    x: number;
    y: number;
    z: number;
    alive: boolean;
  }> {
    const list: { x: number; y: number; z: number; alive: boolean }[] = [];
    this.state.players.forEach((p) => {
      list.push({ x: p.x, y: p.y, z: p.z, alive: p.alive && p.connected });
    });
    return list;
  }

  /**
   * Sample the voxel grid. Only consults the delta map for now. Procedural
   * base will land in Phase 3 — until then, "unknown" cells return 0 (empty)
   * which is a safe default for AI step-up logic.
   */
  private blockAt(x: number, y: number, z: number): number {
    const v = this.state.world.deltas.get(`${x},${y},${z}`);
    return typeof v === "number" ? v : 0;
  }

  private serializeDeltas(): { x: number; y: number; z: number; t: number }[] {
    const out: { x: number; y: number; z: number; t: number }[] = [];
    this.state.world.deltas.forEach((value, key) => {
      const parts = key.split(",");
      if (parts.length !== 3) return;
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      const z = Number(parts[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return;
      }
      out.push({ x, y, z, t: value });
    });
    return out;
  }

  private advanceToNextWave(): void {
    this.state.wave = (this.state.wave + 1) & 0xffff;
    this.state.shopEndsAt = 0;
    this.state.players.forEach((p) => {
      p.readyForNextWave = false;
    });

    if (this.state.wave > this.state.totalWaves) {
      this.state.phase = "dead";
      this.broadcast(VoxelServerMessage.WaveEnd, {
        wave: this.state.totalWaves,
        runComplete: true,
      });
      return;
    }

    this.state.phase = "playing";
    this.broadcast(VoxelServerMessage.WaveStart, {
      wave: this.state.wave,
      totalWaves: this.state.totalWaves,
    });
  }

  /**
   * Open the between-waves shop. Currently invoked from the wave system that
   * lands in Phase 4 — kept here so the broadcast surface is already locked
   * in.
   */
  protected openShop(): void {
    this.state.phase = "shop";
    this.state.shopEndsAt = Date.now() + SHOP_DURATION_MS;
    this.broadcast(VoxelServerMessage.ShopOpen, {
      endsAt: this.state.shopEndsAt,
    });
  }

  private removePlayer(sessionId: string): void {
    const player = this.state.players.get(sessionId);
    if (!player) return;
    this.state.players.delete(sessionId);
    this.latestInputs.delete(sessionId);
    this.broadcast(ServerMessage.PlayerLeft, { id: sessionId, name: player.name });
    console.log(
      `[GameRoom ${this.state.roomCode}] -leave ${player.name} total=${this.state.players.size}`,
    );
  }
}

function toInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}

export { GAME_ROOM_NAME };
