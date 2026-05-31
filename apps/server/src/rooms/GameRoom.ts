import { Room, Client } from "@colyseus/core";
import {
  BLOCK_INTERACTION_RANGE,
  BOSS_BALANCE,
  COINS_BALANCE,
  DEFAULT_WAVE_COUNT,
  DRAGON_BALANCE,
  FIREBALL_COLLISION_RADIUS,
  GAME_ROOM_NAME,
  LAG_COMPENSATION_WINDOW_MS,
  LobbyClientMessage,
  LobbyServerMessage,
  MAX_PLAYERS_PER_ROOM,
  METEOR_BALANCE,
  PLAYER_DEFAULT_HEALTH,
  PLAYER_MAX_DELTA,
  PLAYER_SPAWN_Y,
  PLAYER_SPEED,
  PROJECTILE_LIFETIME_S,
  ServerMessage,
  SHOP_DURATION_MS,
  TICK_INTERVAL_MS,
  VoxelClientMessage,
  VoxelServerMessage,
  WEAPON_BALANCE,
  WORLD_DEPTH,
  WORLD_HALF_SIZE,
  WORLD_MAX_HEIGHT,
  WORLD_WATER_LEVEL,
  WORLD_WIDTH,
} from "@mvp/shared";
import { debugLog, clearDebugLog } from "../debugLog.js";
import { FireballState } from "../schema/FireballState.js";
import { GameState } from "../schema/GameState.js";
import { VoxelPlayer } from "../schema/VoxelPlayer.js";
import {
  type AIContext,
  type EnemyEventOut,
  tickSkeleton,
  tickWitch,
  tickZombie,
} from "../systems/EnemyAI.js";
import {
  allocFireballId,
  isBossWave,
  isCinematicWave,
  isFinalWave,
  isWaveCleared,
  spawnWave,
} from "../systems/WaveDirector.js";
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
  slotIndex?: unknown;
  spreadSeed?: unknown;
  clientTime?: unknown;
}

/**
 * Slot-index → weapon balance entry. Mirrors the order used by the duck's
 * default loadout in apps/game/src/game/Inventory.js (`GUN_SLOTS`):
 *   0 pistol, 1 shotgun, 2 rifle, 3 blaster, 4 dagger.
 * Other character loadouts (sword/katana/spells) don't fire ranged weapons via
 * the WeaponFire intent, so any slot they expose maps to `null` here. We keep
 * a defensive default so a malformed slotIndex doesn't crash the room.
 */
const WEAPON_FOR_SLOT: ReadonlyArray<{
  id: string;
  damage: number;
  range: number;
  pellets: number;
} | null> = [
  // 0 — pistol
  {
    id: "pistol",
    damage: WEAPON_BALANCE.pistol.damage,
    range: WEAPON_BALANCE.pistol.range,
    pellets: WEAPON_BALANCE.pistol.pellets,
  },
  // 1 — shotgun
  {
    id: "shotgun",
    damage: WEAPON_BALANCE.shotgun.damage,
    range: WEAPON_BALANCE.shotgun.range,
    pellets: WEAPON_BALANCE.shotgun.pellets,
  },
  // 2 — rifle
  {
    id: "rifle",
    damage: WEAPON_BALANCE.rifle.damage,
    range: WEAPON_BALANCE.rifle.range,
    pellets: WEAPON_BALANCE.rifle.pellets,
  },
  // 3 — blaster (penetrating)
  {
    id: "blaster",
    damage: WEAPON_BALANCE.blaster.damage,
    range: WEAPON_BALANCE.blaster.range,
    pellets: WEAPON_BALANCE.blaster.pellets,
  },
  // 4 — dagger (projectile, but server uses hitscan resolve)
  {
    id: "dagger",
    damage: WEAPON_BALANCE.dagger.damage,
    range: WEAPON_BALANCE.dagger.range,
    pellets: WEAPON_BALANCE.dagger.pellets,
  },
];

/**
 * Sample row in the lag-compensation ring buffer. Captures every entity's
 * authoritative position so a fire intent dated `t` can be resolved against
 * "what the shooter actually saw".
 */
interface HistorySample {
  /** Date.now() at which this row was captured. */
  t: number;
  enemies: Map<string, { x: number; y: number; z: number }>;
  dragons: Map<string, { x: number; y: number; z: number }>;
  players: Map<string, { x: number; y: number; z: number }>;
}

/** Snapshot one entry every ~50ms. */
const HISTORY_SAMPLE_INTERVAL_MS = 50;
/** Maximum number of entries kept (≥ LAG_COMPENSATION_WINDOW_MS / interval). */
const HISTORY_MAX_SAMPLES = Math.ceil(
  LAG_COMPENSATION_WINDOW_MS / HISTORY_SAMPLE_INTERVAL_MS,
) + 1;
/** Reject fire intents whose clientTime is older than this. */
const MAX_FIRE_INTENT_AGE_MS = 500;

/** Bounding sphere radii used for hitscan against enemies/dragons/players. */
const ENEMY_HIT_RADIUS = 0.9;
const DRAGON_HIT_RADIUS = 2.0;
const PLAYER_HIT_RADIUS = 0.75;
const ENEMY_HIT_CENTER_Y = 1.0; // torso offset above feet
const DRAGON_HIT_CENTER_Y = 0.0; // dragon Y already at body center
const PLAYER_HIT_CENTER_Y = 1.0;

interface IncomingLobbyStart {
  countdownMs?: unknown;
}

interface IncomingLobbyHostKick {
  sessionId?: unknown;
}

/** Character ids accepted by the lobby's CharacterSelect handler. */
const ALLOWED_CHARACTERS: ReadonlySet<string> = new Set([
  "duck",
  "knight",
  "hunter",
  "samurai",
  "mage",
]);

/** Default countdown when host does not provide one. */
const DEFAULT_START_COUNTDOWN_MS = 3000;
/** Hard ceiling on host-supplied countdowns. */
const MAX_START_COUNTDOWN_MS = 10000;

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

  /**
   * Absolute Date.now() at which the room should transition lobby → playing.
   * `0` means no countdown is in flight. Set by {@link handleLobbyStart} and
   * cleared on transition or on host disconnect.
   */
  private _pendingStartAt = 0;

  /**
   * Per-dragon cooldown until the next fireball spawn (seconds). We use a
   * Map keyed by the dragon id so the dragon schema stays lean and we avoid
   * leaking memory: entries are wiped in {@link clearWaveEntities}.
   */
  private dragonFireCooldown = new Map<string, number>();

  /**
   * Per-dragon orbit phase (radians). Mirrors how the single-player dragon
   * sweeps a circle around the origin; persisted between ticks so dragons
   * don't snap.
   */
  private dragonOrbitPhase = new Map<string, number>();

  /**
   * Per-boss AI state. The wave-5 miniboss runs a different cycle than the
   * regular dragons (ground balls, homing bolts, machine-gun burst); we keep
   * a separate map so the schema stays lean and so we can lazily seed the
   * timer when a boss first appears.
   */
  private bossState = new Map<
    string,
    {
      attackTimer: number;
      lastAttack: "ground" | "homing" | "machinegun" | null;
      burstLeft: number;
      burstInterval: number;
    }
  >();

  /**
   * If the room is mid-cinematic, this is the Date.now() at which the
   * scripted phase ends. 0 means we are not in a cinematic. While set, the
   * normal wave-progression / spawn loop is suppressed.
   */
  private cinematicEndsAt = 0;
  private cinematicWave = 0;

  /**
   * Live boss projectiles (ground balls, homing bolts, machine-gun bullets).
   * Not synced via Colyseus schema — the client renders them from the
   * `boss:*` EnemyEvent broadcasts. Damage stays authoritative: each tick we
   * advance these and test against player hitboxes.
   */
  private bossProjectiles: {
    kind: "ground" | "homing" | "bullet";
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    /** Cached ground impact altitude for `ground` balls. */
    targetY: number;
    life: number;
    damage: number;
    radius: number;
    /** Only used by `homing`: per-second turn-toward-player rate. */
    turn: number;
    speed: number;
  }[] = [];

  /**
   * Active boss-laid fire zones (left behind after a ground ball lands). They
   * deal damage in pulses and time out after {@link BOSS_BALANCE.ground.zoneTtl}
   * seconds.
   */
  private bossFireZones: {
    x: number;
    y: number;
    z: number;
    radius: number;
    dps: number;
    ttl: number;
    age: number;
    /** Time until the next damage pulse fires. */
    nextTick: number;
    tickRate: number;
  }[] = [];

  /**
   * Cached player views, refreshed once per tick. Hands a stable array to
   * the AI ticks so they don't re-walk the MapSchema per-enemy.
   */
  private playerViewsCache: { x: number; y: number; z: number; alive: boolean }[] = [];

  /**
   * Lag-compensation ring buffer. Holds up to
   * {@link HISTORY_MAX_SAMPLES} authoritative position snapshots (newest last).
   * Refreshed every {@link HISTORY_SAMPLE_INTERVAL_MS}. The buffer is consulted
   * by {@link handleWeaponFire} to rewind world state to the moment the shooter
   * actually saw the world (clientTime − estimatedLag).
   */
  private history: HistorySample[] = [];
  private lastHistorySampleAt = 0;

  /** Monotonic shot id for WeaponHit / WeaponMiss broadcasts. */
  private nextShotSeq = 1;

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

    // Promote the first connected player to host. We check existing players
    // (before the new one is inserted) so a missing host triggers promotion.
    const hasHost = this.hasHost();
    if (!hasHost) {
      player.isHost = true;
    }

    this.state.players.set(client.sessionId, player);

    if (!hasHost) {
      this.broadcast(LobbyServerMessage.HostChange, {
        hostSessionId: client.sessionId,
      });
    }

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

    // Late joiners: if the room is already past 'lobby', tell the new client
    // immediately so its WaitingRoom doesn't hang. Without this, the bridge
    // never receives a PhaseChange and the UI stays stuck on the host.
    if (this.state.phase !== "lobby") {
      client.send(LobbyServerMessage.PhaseChange, {
        from: this.state.phase,
        to: this.state.phase,
        at: Date.now(),
      });
    }

    // Mirror the current host so the new client paints the crown correctly.
    const hostEntry = this.findHost();
    if (hostEntry) {
      client.send(LobbyServerMessage.HostChange, {
        hostSessionId: hostEntry.sessionId,
      });
    }

    console.log(
      `[GameRoom ${this.state.roomCode}] +join ${name} (${client.sessionId}) total=${this.state.players.size}`,
    );
  }

  /** Returns the {sessionId, player} of the current host, or null. */
  private findHost(): { sessionId: string; player: VoxelPlayer } | null {
    let result: { sessionId: string; player: VoxelPlayer } | null = null;
    this.state.players.forEach((p, sid) => {
      if (!result && p.isHost) result = { sessionId: sid, player: p };
    });
    return result;
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
    clearDebugLog(this.state.roomCode);
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

    // Phase 2 — lobby handlers (host, character select, start countdown, kick).
    this.onMessage(LobbyClientMessage.CharacterSelect, (client, raw) =>
      this.handleCharacterSelect(client, raw as IncomingCharacterSelect),
    );
    this.onMessage(LobbyClientMessage.Start, (client, raw) =>
      this.handleLobbyStart(client, raw as IncomingLobbyStart),
    );
    this.onMessage(LobbyClientMessage.HostKick, (client, raw) =>
      this.handleHostKick(client, raw as IncomingLobbyHostKick),
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
   * Lag-compensated weapon fire pipeline.
   *
   *   1. Validate slotIndex, origin/direction, clientTime freshness.
   *   2. Estimate the shooter's lag (server_now − clientTime, clamped to the
   *      compensation window) and rewind world state to that instant by
   *      picking the closest historical sample.
   *   3. Sphere-cast against every enemy/dragon/player in that snapshot;
   *      pick the closest hit inside the weapon's range.
   *   4. Broadcast WeaponHit (with damage) or WeaponMiss back to all
   *      clients so they can play impact effects / flashes on the right id.
   *      Damage / death / coins are routed through {@link applyDamage}, which
   *      already emits vs:damage and vs:coins on its own.
   *
   * Ranged enemy projectiles (witch/skeleton/dragon) are handled elsewhere.
   * This handler is the player-fired hitscan path only.
   */
  private handleWeaponFire(
    client: Client,
    raw: IncomingWeaponFire,
  ): void {
    const shooter = this.state.players.get(client.sessionId);
    if (!shooter || !shooter.alive || !shooter.connected) return;
    if (this.state.phase !== "playing") return;
    if (!raw || typeof raw !== "object") return;

    const seq = typeof raw.seq === "number" ? raw.seq : 0;
    const shotId = `s${this.nextShotSeq++}`;

    // ── slotIndex → weapon entry ───────────────────────────────────────────
    const slotIndex = toInt(raw.slotIndex);
    if (slotIndex === null || slotIndex < 0 || slotIndex >= WEAPON_FOR_SLOT.length) {
      client.send(VoxelServerMessage.WeaponMiss, { seq, shotId });
      return;
    }
    const weapon = WEAPON_FOR_SLOT[slotIndex];
    if (!weapon) {
      client.send(VoxelServerMessage.WeaponMiss, { seq, shotId });
      return;
    }

    // ── origin / direction sanity ──────────────────────────────────────────
    const origin = toVec3(raw.origin);
    const direction = toVec3(raw.direction);
    if (!origin || !direction) {
      client.send(VoxelServerMessage.WeaponMiss, { seq, shotId });
      return;
    }
    // Normalize direction (reject zero-length).
    const dirLen = Math.hypot(direction[0], direction[1], direction[2]);
    if (dirLen < 1e-4) {
      client.send(VoxelServerMessage.WeaponMiss, { seq, shotId });
      return;
    }
    const ndx = direction[0] / dirLen;
    const ndy = direction[1] / dirLen;
    const ndz = direction[2] / dirLen;

    // Reject shots whose origin is wildly far from the shooter's authoritative
    // position. This is a cheap cheat-guard, not a precise eye-position check.
    const oDx = origin[0] - shooter.x;
    const oDy = origin[1] - shooter.y;
    const oDz = origin[2] - shooter.z;
    if (oDx * oDx + oDy * oDy + oDz * oDz > 9 * 9) {
      client.send(VoxelServerMessage.WeaponMiss, { seq, shotId });
      return;
    }

    // ── clientTime freshness ───────────────────────────────────────────────
    const clientTime =
      typeof raw.clientTime === "number" && Number.isFinite(raw.clientTime)
        ? raw.clientTime
        : 0;
    const now = Date.now();
    if (clientTime > 0 && now - clientTime > MAX_FIRE_INTENT_AGE_MS) {
      // Stale intent — most likely the client paused or the socket queued.
      client.send(VoxelServerMessage.WeaponMiss, { seq, shotId });
      return;
    }

    // ── lag compensation ───────────────────────────────────────────────────
    // estimatedLag := server_now − clientTime, clamped to the window.
    let estimatedLag = clientTime > 0 ? now - clientTime : 0;
    if (estimatedLag < 0) estimatedLag = 0;
    if (estimatedLag > LAG_COMPENSATION_WINDOW_MS) {
      estimatedLag = LAG_COMPENSATION_WINDOW_MS;
    }
    const targetTime = now - estimatedLag;
    const snapshot = this.pickHistorySample(targetTime);

    // ── raycast against the rewound snapshot ───────────────────────────────
    const hit = this.resolveWeaponHit(
      origin,
      [ndx, ndy, ndz],
      weapon.range,
      snapshot,
      client.sessionId,
    );

    if (!hit) {
      this.broadcast(VoxelServerMessage.WeaponMiss, { seq, shotId });
      return;
    }

    // Apply damage. applyDamage already broadcasts vs:damage on non-killing
    // hits, vs:enemyDespawn + vs:coins on kills.
    this.applyDamage(hit.targetId, weapon.damage, client.sessionId);

    this.broadcast(VoxelServerMessage.WeaponHit, {
      seq,
      shotId,
      hits: [
        {
          targetId: hit.targetId,
          damage: weapon.damage,
          point: hit.point,
        },
      ],
    });
  }

  /**
   * Sphere-cast the shooter's ray against every enemy / dragon / player in
   * the historical snapshot, returning the closest hit inside `range`.
   *
   * The snapshot is optional — if no history is available yet we fall back to
   * the live state. Players don't get friendly-fired (shooter excluded).
   * Dead entities (no longer in live state) are filtered out so a stale
   * history sample can't re-kill a despawned target.
   */
  private resolveWeaponHit(
    origin: [number, number, number],
    direction: [number, number, number],
    range: number,
    snapshot: HistorySample | null,
    shooterSessionId: string,
  ): { targetId: string; point: [number, number, number] } | null {
    const enemies = snapshot ? snapshot.enemies : this.mapEnemyPositions();
    const dragons = snapshot ? snapshot.dragons : this.mapDragonPositions();
    const players = snapshot ? snapshot.players : this.mapPlayerPositions();

    let bestT = Infinity;
    let bestTarget: string | null = null;
    let bestPoint: [number, number, number] | null = null;

    const check = (
      id: string,
      cx: number,
      cy: number,
      cz: number,
      radius: number,
      prefix: "enemy" | "dragon" | "player",
    ): void => {
      const t = raySphereT(origin, direction, [cx, cy, cz], radius);
      if (t === null) return;
      if (t > range) return;
      if (t >= bestT) return;
      bestT = t;
      bestTarget = `${prefix}:${id}`;
      bestPoint = [
        origin[0] + direction[0] * t,
        origin[1] + direction[1] * t,
        origin[2] + direction[2] * t,
      ];
    };

    enemies.forEach((pos, id) => {
      if (!this.state.enemies.has(id)) return;
      check(id, pos.x, pos.y + ENEMY_HIT_CENTER_Y, pos.z, ENEMY_HIT_RADIUS, "enemy");
    });
    dragons.forEach((pos, id) => {
      if (!this.state.dragons.has(id)) return;
      check(id, pos.x, pos.y + DRAGON_HIT_CENTER_Y, pos.z, DRAGON_HIT_RADIUS, "dragon");
    });
    players.forEach((pos, sid) => {
      if (sid === shooterSessionId) return;
      const live = this.state.players.get(sid);
      if (!live || !live.alive || !live.connected) return;
      check(sid, pos.x, pos.y + PLAYER_HIT_CENTER_Y, pos.z, PLAYER_HIT_RADIUS, "player");
    });

    if (!bestTarget || !bestPoint) return null;
    return { targetId: bestTarget, point: bestPoint };
  }

  /** Snapshot live enemy positions when history isn't usable yet. */
  private mapEnemyPositions(): Map<string, { x: number; y: number; z: number }> {
    const out = new Map<string, { x: number; y: number; z: number }>();
    this.state.enemies.forEach((e, id) => out.set(id, { x: e.x, y: e.y, z: e.z }));
    return out;
  }
  /** Snapshot live dragon positions when history isn't usable yet. */
  private mapDragonPositions(): Map<string, { x: number; y: number; z: number }> {
    const out = new Map<string, { x: number; y: number; z: number }>();
    this.state.dragons.forEach((d, id) => out.set(id, { x: d.x, y: d.y, z: d.z }));
    return out;
  }
  /** Snapshot live player positions, filtering disconnected / dead ones. */
  private mapPlayerPositions(): Map<string, { x: number; y: number; z: number }> {
    const out = new Map<string, { x: number; y: number; z: number }>();
    this.state.players.forEach((p, sid) => {
      if (!p.alive || !p.connected) return;
      out.set(sid, { x: p.x, y: p.y, z: p.z });
    });
    return out;
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
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (this.state.phase !== "lobby") {
      client.send(ServerMessage.Error, {
        code: "PHASE_LOCKED",
        message: "Solo puedes cambiar de personaje en la sala de espera.",
      });
      return;
    }

    const id = typeof raw.characterId === "string" ? raw.characterId : "";
    if (!ALLOWED_CHARACTERS.has(id)) {
      client.send(ServerMessage.Error, {
        code: "INVALID_CHARACTER",
        message: `Personaje no válido: ${id}`,
      });
      return;
    }

    player.characterId = id;
  }

  private handleLobbyStart(
    client: Client,
    raw: IncomingLobbyStart,
  ): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (!player.isHost) {
      client.send(ServerMessage.Error, {
        code: "NOT_HOST",
        message: "Solo el anfitrión puede iniciar la partida.",
      });
      return;
    }

    if (this.state.phase !== "lobby") {
      client.send(ServerMessage.Error, {
        code: "PHASE_LOCKED",
        message: "La partida ya ha comenzado.",
      });
      return;
    }

    let countdownMs = DEFAULT_START_COUNTDOWN_MS;
    if (raw && typeof raw === "object" && typeof raw.countdownMs === "number" &&
      Number.isFinite(raw.countdownMs)
    ) {
      countdownMs = Math.max(
        0,
        Math.min(MAX_START_COUNTDOWN_MS, Math.trunc(raw.countdownMs)),
      );
    }

    const startsAt = Date.now() + countdownMs;
    this._pendingStartAt = startsAt;
    this.broadcast(LobbyServerMessage.StartCountdown, { startsAt });
  }

  private handleHostKick(
    client: Client,
    raw: IncomingLobbyHostKick,
  ): void {
    const requester = this.state.players.get(client.sessionId);
    if (!requester) return;

    if (!requester.isHost) {
      client.send(ServerMessage.Error, {
        code: "NOT_HOST",
        message: "Solo el anfitrión puede expulsar jugadores.",
      });
      return;
    }

    if (this.state.phase !== "lobby") {
      client.send(ServerMessage.Error, {
        code: "PHASE_LOCKED",
        message: "Solo puedes expulsar antes de iniciar la partida.",
      });
      return;
    }

    const targetSessionId =
      raw && typeof raw === "object" && typeof raw.sessionId === "string"
        ? raw.sessionId
        : "";
    if (!targetSessionId || targetSessionId === client.sessionId) return;

    const target = this.clients.find((c) => c.sessionId === targetSessionId);
    if (!target) return;

    target.send(ServerMessage.Error, {
      code: "KICKED",
      message: "Has sido expulsado de la sala.",
    });
    target.leave(1000);
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

    // Lobby countdown — fires regardless of phase so we still observe the
    // gate when a stale countdown lingers, but only actually transitions if
    // we're still in the lobby phase.
    if (
      this._pendingStartAt !== 0 &&
      Date.now() >= this._pendingStartAt &&
      this.state.phase === "lobby"
    ) {
      this.transitionPhase("lobby", "playing");
    }

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
      // Refresh the player views cache once per tick — AI ticks read it many
      // times (once per enemy/dragon) but the player set rarely changes.
      this.refreshPlayerViewsCache();
      this.tickEnemies(dt);
      this.tickDragons(dt);
      this.tickFireballs(dt);
      this.tickBossProjectiles(dt);
      this.tickBossFireZones(dt);
      // Mid-cinematic? When the timer expires, transition out and either spawn
      // the next wave or end the run. While in flight, we still tick the
      // boss-projectile cleanup above (in case wave 5 spilled into wave 10).
      if (this.cinematicEndsAt !== 0 && Date.now() >= this.cinematicEndsAt) {
        this.endCinematicWave();
      } else {
        this.checkWaveProgression();
      }
    }
    // Lag-compensation buffer: capture a snapshot at most every
    // HISTORY_SAMPLE_INTERVAL_MS. Done last so the snapshot reflects the
    // post-tick authoritative state.
    this.maybeSampleHistory();
  }

  /**
   * Push a historical snapshot of enemy / dragon / player positions onto the
   * ring buffer if enough time has elapsed since the last sample. We only
   * record the fields raycast resolution actually needs.
   */
  private maybeSampleHistory(): void {
    const now = Date.now();
    if (now - this.lastHistorySampleAt < HISTORY_SAMPLE_INTERVAL_MS) return;
    this.lastHistorySampleAt = now;

    const enemies = new Map<string, { x: number; y: number; z: number }>();
    this.state.enemies.forEach((e, id) => {
      enemies.set(id, { x: e.x, y: e.y, z: e.z });
    });
    const dragons = new Map<string, { x: number; y: number; z: number }>();
    this.state.dragons.forEach((d, id) => {
      dragons.set(id, { x: d.x, y: d.y, z: d.z });
    });
    const players = new Map<string, { x: number; y: number; z: number }>();
    this.state.players.forEach((p, sid) => {
      if (!p.alive || !p.connected) return;
      players.set(sid, { x: p.x, y: p.y, z: p.z });
    });

    this.history.push({ t: now, enemies, dragons, players });
    while (this.history.length > HISTORY_MAX_SAMPLES) this.history.shift();
  }

  /**
   * Pick the historical sample closest to (and not after) `targetTime`. Falls
   * back to the newest sample when the buffer is empty or the requested time
   * is in the future. Returns null only when no samples exist.
   */
  private pickHistorySample(targetTime: number): HistorySample | null {
    if (this.history.length === 0) return null;
    // Walk newest → oldest so the first one ≤ targetTime wins.
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const sample = this.history[i];
      if (sample.t <= targetTime) return sample;
    }
    // Requested time is older than every sample — use the oldest we have.
    return this.history[0];
  }

  /** Rebuild {@link playerViewsCache} from the current MapSchema. */
  private refreshPlayerViewsCache(): void {
    const out: { x: number; y: number; z: number; alive: boolean }[] = [];
    this.state.players.forEach((p) => {
      out.push({
        x: p.x,
        y: p.y,
        z: p.z,
        alive: p.alive && p.connected,
      });
    });
    this.playerViewsCache = out;
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

      // Stamp the seq the client already recorded against its prediction
      // ring buffer so the client can find the matching local snapshot on
      // reconciliation (Phase 2 CSP fix).
      player.seq = input.seq;

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
      players: this.playerViewsCache,
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
          enemyId: enemy.id,
          event: ev.kind,
          ...("target" in ev ? { target: ev.target } : {}),
        });
      }
    });
  }

  /**
   * Minimal dragon AI: orbit the origin at altitude, lob a fireball at the
   * nearest alive player every {@link DRAGON_BALANCE.attackCooldownMin}..max
   * seconds. Numeric ops only — no Vector3 allocation per tick.
   *
   * The wave-5 miniboss (dragon with `boss=true`) takes a different code path
   * ({@link tickBossDragon}) and cycles ground / homing / machine-gun
   * attacks instead of lobbing normal fireballs.
   */
  private tickDragons(dt: number): void {
    if (this.state.dragons.size === 0) return;

    const players = this.playerViewsCache;
    const minAlt = DRAGON_BALANCE.minAltitude ?? 13;
    const maxAlt = DRAGON_BALANCE.maxAltitude ?? 22;
    const baseR = DRAGON_BALANCE.spawnRadius ?? 34;
    const cooldownMin = DRAGON_BALANCE.attackCooldownMin ?? 1.35;
    const cooldownMax = DRAGON_BALANCE.attackCooldownMax ?? 3.2;

    this.state.dragons.forEach((dragon, id) => {
      if (dragon.boss) {
        this.tickBossDragon(dragon, id, dt, players);
        return;
      }
      // Update orbit phase: ω = baseSpeed + aggression scaling.
      const omega =
        (DRAGON_BALANCE.baseSpeed ?? 0.24) +
        dragon.aggression * (DRAGON_BALANCE.orbitPressure ?? 0.35);
      const phase = (this.dragonOrbitPhase.get(id) ?? 0) + omega * dt;
      this.dragonOrbitPhase.set(id, phase);

      const radius = baseR;
      const cx = Math.cos(phase) * radius;
      const cz = Math.sin(phase) * radius;
      dragon.x = cx;
      dragon.z = cz;

      // Gentle bob between minAlt..maxAlt.
      const bobT = (this.state.tick / 20) * (DRAGON_BALANCE.bobSpeed ?? 2.5);
      const bobAmp = DRAGON_BALANCE.bobAmplitude ?? 1.6;
      const baseY = (minAlt + maxAlt) * 0.5;
      dragon.y = baseY + Math.sin(bobT) * bobAmp;

      // Face the orbit tangent (toward where the dragon is flying next).
      dragon.rotationY = Math.atan2(-Math.sin(phase), Math.cos(phase));

      // Fireball cooldown.
      let cd = this.dragonFireCooldown.get(id);
      if (cd === undefined) {
        cd = cooldownMin + this.rand() * Math.max(0, cooldownMax - cooldownMin);
        this.dragonFireCooldown.set(id, cd);
      }
      cd -= dt;
      if (cd > 0) {
        this.dragonFireCooldown.set(id, cd);
        return;
      }

      // Pick a target — nearest alive player.
      let target: { x: number; y: number; z: number } | null = null;
      let bestDistSq = Infinity;
      for (const p of players) {
        if (!p.alive) continue;
        const dx = p.x - dragon.x;
        const dy = p.y - dragon.y;
        const dz = p.z - dragon.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          target = { x: p.x, y: p.y, z: p.z };
        }
      }

      // Reset cooldown for next shot.
      this.dragonFireCooldown.set(
        id,
        cooldownMin + this.rand() * Math.max(0, cooldownMax - cooldownMin),
      );

      if (!target) return;

      // Aim the fireball toward the player's torso.
      const aimX = target.x - dragon.x;
      const aimY = target.y + 1.3 - dragon.y;
      const aimZ = target.z - dragon.z;
      const len = Math.hypot(aimX, aimY, aimZ);
      if (len < 1e-4) return;
      const speed = DRAGON_BALANCE.fireballSpeed ?? 24;

      const fb = new FireballState();
      fb.id = allocFireballId();
      fb.x = dragon.x;
      fb.y = dragon.y;
      fb.z = dragon.z;
      fb.vx = (aimX / len) * speed;
      fb.vy = (aimY / len) * speed;
      fb.vz = (aimZ / len) * speed;
      fb.ownerId = dragon.id;
      fb.damage = DRAGON_BALANCE.fireballDamage ?? 14;
      fb.life = DRAGON_BALANCE.fireballLife ?? PROJECTILE_LIFETIME_S;
      this.state.fireballs.set(fb.id, fb);

      this.broadcast(VoxelServerMessage.DragonFireball, {
        fireball: {
          id: fb.id,
          x: fb.x,
          y: fb.y,
          z: fb.z,
          vx: fb.vx,
          vy: fb.vy,
          vz: fb.vz,
          ownerId: fb.ownerId,
          damage: fb.damage,
        },
        kind: "spawn",
      });
    });
  }

  /**
   * Wave-5 miniboss tick. Orbits at {@link BOSS_BALANCE.orbitRadius} and runs
   * an authoritative attack cycle:
   *   1. ground — slow fireballs that scorch zone hazards on landing.
   *   2. homing — fast curving bolts.
   *   3. machinegun — a tight burst of small bullets.
   *
   * For all three the server broadcasts an {@link VoxelServerMessage.EnemyEvent}
   * (`boss:ground` / `boss:homing` / `boss:bullet`) so every client paints the
   * same projectile trail. Damage stays authoritative — see
   * {@link tickBossProjectiles}. Fire zones from `ground` impacts are
   * simulated server-side too and broadcast as a "boss:zone" tick event.
   */
  private tickBossDragon(
    dragon: import("../schema/DragonState.js").DragonState,
    id: string,
    dt: number,
    players: { x: number; y: number; z: number; alive: boolean }[],
  ): void {
    // Orbit the centre at a fixed radius; faster than a regular dragon.
    const omega = 0.55;
    const phase = (this.dragonOrbitPhase.get(id) ?? 0) + omega * dt;
    this.dragonOrbitPhase.set(id, phase);
    const radius = BOSS_BALANCE.orbitRadius;
    dragon.x = Math.cos(phase) * radius;
    dragon.z = Math.sin(phase) * radius;

    // Slight altitude bob.
    const bobT = (this.state.tick / 20) * 2.5;
    dragon.y = BOSS_BALANCE.altitude + Math.sin(bobT) * 1.2;
    dragon.rotationY = Math.atan2(-Math.sin(phase), Math.cos(phase));

    let st = this.bossState.get(id);
    if (!st) {
      st = {
        attackTimer: 2.0,
        lastAttack: null,
        burstLeft: 0,
        burstInterval: 0,
      };
      this.bossState.set(id, st);
    }

    // Machine-gun burst — fire one bullet per sub-interval until exhausted.
    // Skips the normal attack-timer countdown.
    if (st.burstLeft > 0) {
      st.burstInterval -= dt;
      if (st.burstInterval <= 0) {
        this.fireBossBullet(dragon, players);
        st.burstLeft -= 1;
        st.burstInterval = BOSS_BALANCE.machinegun.interval;
      }
      return;
    }

    st.attackTimer -= dt;
    if (st.attackTimer > 0) return;

    // Choose any attack except the one we just used so it stays varied.
    const choices: ("ground" | "homing" | "machinegun")[] = [];
    for (const k of ["ground", "homing", "machinegun"] as const) {
      if (k !== st.lastAttack) choices.push(k);
    }
    const attack = choices[Math.floor(this.rand() * choices.length)] ?? "homing";
    st.lastAttack = attack;
    const [lo, hi] = BOSS_BALANCE.attackEvery;
    st.attackTimer = lo + this.rand() * Math.max(0, hi - lo);

    if (attack === "ground") {
      for (let i = 0; i < BOSS_BALANCE.ground.count; i += 1) {
        this.fireBossGround(dragon, players, i);
      }
    } else if (attack === "homing") {
      for (let i = 0; i < BOSS_BALANCE.homing.count; i += 1) {
        this.fireBossHoming(dragon, players);
      }
    } else {
      st.burstLeft = BOSS_BALANCE.machinegun.burst;
      st.burstInterval = 0;
    }
  }

  /**
   * Advance fireballs, decrement life, and despawn on player hit or expiry.
   * Player damage applied directly to {@link VoxelPlayer.health}; the Phase 5
   * hit pipeline will route this through a Damage broadcast.
   */
  private tickFireballs(dt: number): void {
    if (this.state.fireballs.size === 0) return;

    const radius = FIREBALL_COLLISION_RADIUS;
    const radiusSq = radius * radius;
    const expired: string[] = [];

    this.state.fireballs.forEach((fb, id) => {
      fb.x += fb.vx * dt;
      fb.y += fb.vy * dt;
      fb.z += fb.vz * dt;
      fb.life -= dt;

      if (fb.life <= 0) {
        expired.push(id);
        return;
      }

      // Player collision — torso center at y+1.0.
      let hit = false;
      this.state.players.forEach((p) => {
        if (hit) return;
        if (!p.alive || !p.connected) return;
        const dx = p.x - fb.x;
        const dy = p.y + 1.0 - fb.y;
        const dz = p.z - fb.z;
        if (dx * dx + dy * dy + dz * dz <= radiusSq) {
          hit = true;
          const dmg = fb.damage;
          // Shield first, then health.
          let remain = dmg;
          if (p.shield > 0) {
            const absorbed = Math.min(p.shield, remain);
            p.shield -= absorbed;
            remain -= absorbed;
          }
          if (remain > 0) p.health = Math.max(0, p.health - remain);
          if (p.health <= 0 && p.alive) {
            p.alive = false;
            this.broadcast(VoxelServerMessage.PlayerDeath, {
              sessionId: p.id,
            });
          } else {
            this.broadcast(VoxelServerMessage.Damage, {
              victimId: `player:${p.id}`,
              amount: dmg,
              hp: p.health,
              shield: p.shield,
            });
          }
        }
      });

      if (hit) expired.push(id);
    });

    for (const id of expired) {
      const fb = this.state.fireballs.get(id);
      if (fb) {
        this.broadcast(VoxelServerMessage.DragonFireball, {
          fireball: {
            id: fb.id,
            x: fb.x,
            y: fb.y,
            z: fb.z,
            vx: fb.vx,
            vy: fb.vy,
            vz: fb.vz,
            ownerId: fb.ownerId,
            damage: fb.damage,
          },
          kind: "despawn",
        });
      }
      this.state.fireballs.delete(id);
    }
  }

  // ── Wave-5 miniboss authoritative attacks ──────────────────────────────────
  //
  // Each attack spawns one or more server-side projectiles in
  // {@link bossProjectiles} (NOT synced via Colyseus), and broadcasts an
  // EnemyEvent so every client paints the same projectile. Damage is dealt
  // when the server-side projectile collides with a player or terrain.

  private nearestAlivePlayer(
    origin: { x: number; y: number; z: number },
    players: { x: number; y: number; z: number; alive: boolean }[],
  ): { x: number; y: number; z: number } | null {
    let best: { x: number; y: number; z: number } | null = null;
    let bestDistSq = Infinity;
    for (const p of players) {
      if (!p.alive) continue;
      const dx = p.x - origin.x;
      const dy = p.y - origin.y;
      const dz = p.z - origin.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        best = { x: p.x, y: p.y, z: p.z };
      }
    }
    return best;
  }

  private fireBossGround(
    dragon: import("../schema/DragonState.js").DragonState,
    players: { x: number; y: number; z: number; alive: boolean }[],
    i: number,
  ): void {
    const target = this.nearestAlivePlayer({ x: dragon.x, y: dragon.y, z: dragon.z }, players);
    if (!target) return;
    const cfg = BOSS_BALANCE.ground;
    const tx = target.x + (this.rand() - 0.5) * 5 + i * 1.6;
    const tz = target.z + (this.rand() - 0.5) * 5;
    // The server doesn't know terrain height (Phase 3 lands the procedural
    // base). Default to PLAYER_SPAWN_Y like every other entity height.
    const ty = PLAYER_SPAWN_Y - 0.5;
    const dx = tx - dragon.x;
    const dy = ty - dragon.y;
    const dz = tz - dragon.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    const speed = cfg.speed;
    const vx = (dx / len) * speed;
    const vy = (dy / len) * speed;
    const vz = (dz / len) * speed;
    this.bossProjectiles.push({
      kind: "ground",
      x: dragon.x,
      y: dragon.y,
      z: dragon.z,
      vx,
      vy,
      vz,
      targetY: ty,
      life: 5,
      damage: cfg.damage,
      radius: 1.3,
      turn: 0,
      speed,
    });
    this.broadcast(VoxelServerMessage.EnemyEvent, {
      enemyId: dragon.id,
      event: "boss:ground",
      origin: [dragon.x, dragon.y, dragon.z],
      target: [tx, ty, tz],
    });
  }

  private fireBossHoming(
    dragon: import("../schema/DragonState.js").DragonState,
    players: { x: number; y: number; z: number; alive: boolean }[],
  ): void {
    const target = this.nearestAlivePlayer({ x: dragon.x, y: dragon.y, z: dragon.z }, players);
    if (!target) return;
    const cfg = BOSS_BALANCE.homing;
    let dx = target.x - dragon.x;
    let dy = target.y + 1.2 - dragon.y;
    let dz = target.z - dragon.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    dx /= len; dy /= len; dz /= len;
    // Spread.
    dx += (this.rand() - 0.5) * 0.25;
    dy += (this.rand() - 0.5) * 0.15;
    dz += (this.rand() - 0.5) * 0.25;
    const l2 = Math.hypot(dx, dy, dz) || 1;
    dx /= l2; dy /= l2; dz /= l2;
    const speed = cfg.speed;
    this.bossProjectiles.push({
      kind: "homing",
      x: dragon.x,
      y: dragon.y,
      z: dragon.z,
      vx: dx * speed,
      vy: dy * speed,
      vz: dz * speed,
      targetY: 0,
      life: cfg.life,
      damage: cfg.damage,
      radius: cfg.radius,
      turn: cfg.turn,
      speed,
    });
    this.broadcast(VoxelServerMessage.EnemyEvent, {
      enemyId: dragon.id,
      event: "boss:homing",
      origin: [dragon.x, dragon.y, dragon.z],
      target: [target.x, target.y + 1.2, target.z],
    });
  }

  private fireBossBullet(
    dragon: import("../schema/DragonState.js").DragonState,
    players: { x: number; y: number; z: number; alive: boolean }[],
  ): void {
    const target = this.nearestAlivePlayer({ x: dragon.x, y: dragon.y, z: dragon.z }, players);
    if (!target) return;
    const cfg = BOSS_BALANCE.machinegun;
    let dx = target.x - dragon.x;
    let dy = target.y + 1.2 - dragon.y;
    let dz = target.z - dragon.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    dx /= len; dy /= len; dz /= len;
    dx += (this.rand() - 0.5) * cfg.spread;
    dy += (this.rand() - 0.5) * cfg.spread;
    dz += (this.rand() - 0.5) * cfg.spread;
    const l2 = Math.hypot(dx, dy, dz) || 1;
    dx /= l2; dy /= l2; dz /= l2;
    const speed = cfg.speed;
    this.bossProjectiles.push({
      kind: "bullet",
      x: dragon.x,
      y: dragon.y,
      z: dragon.z,
      vx: dx * speed,
      vy: dy * speed,
      vz: dz * speed,
      targetY: 0,
      life: cfg.life,
      damage: cfg.damage,
      radius: cfg.radius,
      turn: 0,
      speed,
    });
    this.broadcast(VoxelServerMessage.EnemyEvent, {
      enemyId: dragon.id,
      event: "boss:bullet",
      origin: [dragon.x, dragon.y, dragon.z],
      target: [target.x, target.y + 1.2, target.z],
    });
  }

  /**
   * Step every active boss projectile, check collisions, spawn fire zones on
   * ground impacts, and resolve damage server-side. Damage on hit is sent
   * through the regular {@link VoxelServerMessage.Damage} broadcast so the
   * HUD reacts the same as a fireball hit.
   */
  private tickBossProjectiles(dt: number): void {
    if (this.bossProjectiles.length === 0) return;
    const players = this.state.players;
    // Walk back-to-front so splices don't shuffle the index.
    for (let i = this.bossProjectiles.length - 1; i >= 0; i -= 1) {
      const p = this.bossProjectiles[i];
      p.life -= dt;

      if (p.kind === "homing") {
        // Bias velocity toward the nearest alive player.
        let targetX = 0;
        let targetY = 0;
        let targetZ = 0;
        let haveTarget = false;
        let bestD = Infinity;
        players.forEach((pl) => {
          if (!pl.alive || !pl.connected) return;
          const dx = pl.x - p.x;
          const dy = pl.y + 1.2 - p.y;
          const dz = pl.z - p.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < bestD) {
            bestD = d2;
            targetX = pl.x;
            targetY = pl.y + 1.2;
            targetZ = pl.z;
            haveTarget = true;
          }
        });
        if (haveTarget) {
          const dx = targetX - p.x;
          const dy = targetY - p.y;
          const dz = targetZ - p.z;
          const len = Math.hypot(dx, dy, dz) || 1;
          const desiredVx = (dx / len) * p.speed;
          const desiredVy = (dy / len) * p.speed;
          const desiredVz = (dz / len) * p.speed;
          const a = Math.min(1, dt * p.turn);
          p.vx = p.vx + (desiredVx - p.vx) * a;
          p.vy = p.vy + (desiredVy - p.vy) * a;
          p.vz = p.vz + (desiredVz - p.vz) * a;
        }
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      let hit = false;
      // Player hit test.
      players.forEach((pl) => {
        if (hit) return;
        if (!pl.alive || !pl.connected) return;
        const dx = pl.x - p.x;
        const dy = pl.y + 1.0 - p.y;
        const dz = pl.z - p.z;
        const r = p.radius + 0.6;
        if (dx * dx + dy * dy + dz * dz <= r * r) {
          hit = true;
          this.dealBossDamage(pl, p.damage);
        }
      });

      const groundHit = p.kind === "ground" && p.y <= p.targetY;
      if (groundHit) {
        this.spawnBossFireZone(p.x, p.targetY, p.z);
      }

      if (hit || groundHit || p.life <= 0 || p.y < -4) {
        this.bossProjectiles.splice(i, 1);
      }
    }
  }

  private dealBossDamage(pl: VoxelPlayer, dmg: number): void {
    let remain = dmg;
    if (pl.shield > 0) {
      const absorbed = Math.min(pl.shield, remain);
      pl.shield -= absorbed;
      remain -= absorbed;
    }
    if (remain > 0) pl.health = Math.max(0, pl.health - remain);
    if (pl.health <= 0 && pl.alive) {
      pl.alive = false;
      this.broadcast(VoxelServerMessage.PlayerDeath, { sessionId: pl.id });
    } else {
      this.broadcast(VoxelServerMessage.Damage, {
        victimId: `player:${pl.id}`,
        amount: dmg,
        hp: pl.health,
        shield: pl.shield,
      });
    }
  }

  private spawnBossFireZone(x: number, y: number, z: number): void {
    const cfg = BOSS_BALANCE.ground;
    this.bossFireZones.push({
      x,
      y,
      z,
      radius: cfg.zoneRadius,
      dps: cfg.zoneDps,
      ttl: cfg.zoneTtl,
      age: 0,
      nextTick: cfg.tickRate,
      tickRate: cfg.tickRate,
    });
    this.broadcast(VoxelServerMessage.EnemyEvent, {
      enemyId: "boss",
      event: "boss:ground",
      origin: [x, y, z],
      target: [x, y, z],
    });
  }

  private tickBossFireZones(dt: number): void {
    if (this.bossFireZones.length === 0) return;
    const players = this.state.players;
    for (let i = this.bossFireZones.length - 1; i >= 0; i -= 1) {
      const z = this.bossFireZones[i];
      z.age += dt;
      z.nextTick -= dt;
      if (z.nextTick <= 0) {
        // Pulse damage everyone standing inside.
        const r2 = z.radius * z.radius;
        const pulse = z.dps * z.tickRate;
        players.forEach((pl) => {
          if (!pl.alive || !pl.connected) return;
          const dx = pl.x - z.x;
          const dz = pl.z - z.z;
          if (dx * dx + dz * dz <= r2) this.dealBossDamage(pl, pulse);
        });
        z.nextTick = z.tickRate;
      }
      if (z.age >= z.ttl) this.bossFireZones.splice(i, 1);
    }
  }

  /**
   * If the current wave is cleared, advance to the next wave or end the run.
   * Only fires while `phase === 'playing'`. Skips entirely while a cinematic
   * is in flight ({@link cinematicEndsAt} != 0) — the tick loop handles the
   * cinematic exit explicitly.
   */
  private checkWaveProgression(): void {
    if (this.state.phase !== "playing") return;
    if (this.cinematicEndsAt !== 0) return;
    if (!isWaveCleared(this.state)) return;

    // Wave just finished. If this was the last wave, broadcast WaveEnd and
    // end the run; otherwise spawn the next wave.
    if (isFinalWave(this.state.wave)) {
      this.state.phase = "dead";
      this.broadcast(VoxelServerMessage.WaveEnd, {
        wave: this.state.wave,
        runComplete: true,
        victory: true,
      });
      return;
    }

    const next = (this.state.wave + 1) & 0xffff;
    this.state.wave = next;
    this.broadcastWaveStart(next);
    this.spawnCurrentWave();
  }

  /**
   * Broadcast a {@link VoxelServerMessage.WaveStart} payload, decorating it
   * with `boss` / `cinematic` flags so clients know to render the special
   * wave intros (miniboss toast on wave 5, meteor cinematic on wave 10).
   */
  private broadcastWaveStart(wave: number): void {
    const payload: {
      wave: number;
      totalWaves: number;
      boss?: boolean;
      cinematic?: boolean;
    } = {
      wave,
      totalWaves: this.state.totalWaves,
    };
    if (isBossWave(wave)) payload.boss = true;
    if (isCinematicWave(wave)) payload.cinematic = true;
    this.broadcast(VoxelServerMessage.WaveStart, payload);
  }

  /**
   * Spawn enemies for `state.wave` and broadcast an EnemySpawn snapshot. For
   * the cinematic wave (10 by default), instead of spawning enemies we trigger
   * the meteor scene: a WaveCinematic broadcast, world deltas for the crater,
   * and a timer that flips the room back to normal wave play after
   * {@link METEOR_BALANCE.duration} seconds.
   */
  private spawnCurrentWave(): void {
    const wave = this.state.wave || 1;

    if (isCinematicWave(wave)) {
      this.startCinematicWave(wave);
      return;
    }

    const ids = spawnWave(this.state, wave, this.rand);

    // Optional EnemySpawn snapshot — clients receive enemies via schema sync,
    // but the explicit message lets them trigger spawn FX in one batch.
    const snapshots: {
      id: string;
      kind: string;
      x: number;
      y: number;
      z: number;
      rotationY: number;
      health: number;
      maxHealth: number;
      flags: number;
    }[] = [];
    for (const id of ids.enemies) {
      const e = this.state.enemies.get(id);
      if (!e) continue;
      snapshots.push({
        id: e.id,
        kind: e.kind,
        x: e.x,
        y: e.y,
        z: e.z,
        rotationY: e.rotationY,
        health: e.health,
        maxHealth: e.maxHealth,
        flags: e.flags,
      });
    }
    if (snapshots.length > 0) {
      this.broadcast(VoxelServerMessage.EnemySpawn, { enemies: snapshots });
    }

    console.log(
      `[GameRoom ${this.state.roomCode}] wave=${wave} spawned enemies=${ids.enemies.length} dragons=${ids.dragons.length}`,
    );
    debugLog(this.state.roomCode, "wave:start", {
      wave,
      enemies: ids.enemies.length,
      dragons: ids.dragons.length,
    });
    for (const snap of snapshots) {
      debugLog(this.state.roomCode, "enemy:spawn", {
        id: snap.id,
        kind: snap.kind,
        x: snap.x,
        y: snap.y,
        z: snap.z,
      });
    }
  }

  /**
   * Enter wave-10 meteor cinematic. Clears any lingering enemies / boss
   * projectiles, broadcasts a {@link VoxelServerMessage.WaveCinematic}, and
   * carves a crater (world deltas broadcast through the existing WorldDelta
   * channel). The room stays in 'playing' phase so EnemySync etc. keep
   * receiving updates; {@link update} flips back to normal play once
   * {@link cinematicEndsAt} elapses.
   */
  private startCinematicWave(wave: number): void {
    // Clear any leftover state so the next "real" wave starts clean.
    this.state.enemies.clear();
    this.state.dragons.clear();
    this.state.fireballs.clear();
    this.dragonFireCooldown.clear();
    this.dragonOrbitPhase.clear();
    this.bossState.clear();
    this.bossProjectiles.length = 0;
    this.bossFireZones.length = 0;

    this.cinematicWave = wave;
    this.cinematicEndsAt = Date.now() + Math.max(500, METEOR_BALANCE.duration * 1000);

    this.broadcast(VoxelServerMessage.WaveCinematic, {
      wave,
      kind: "meteor",
      duration: METEOR_BALANCE.duration,
    });

    // Carve the crater. Each affected cell is broadcast as a WorldDelta so
    // every client converges on the same map state. The math mirrors
    // World.carveCrater (apps/game/src/engine/World.js).
    this.carveServerCrater(0, 0, METEOR_BALANCE.craterRadius);

    console.log(
      `[GameRoom ${this.state.roomCode}] wave=${wave} cinematic=meteor duration=${METEOR_BALANCE.duration}s`,
    );
    debugLog(this.state.roomCode, "wave:cinematic", {
      wave,
      kind: "meteor",
    });
  }

  /**
   * Server-side crater dig. Walks every cell within `radius` and marks it as
   * removed in the world delta map, broadcasting a WorldDelta for each. The
   * client's World.carveCrater also rebuilds terrain in a bowl shape; the
   * server is content with "the column is gone" because the procedural base
   * (Phase 3) will land later and the dimples are the visual touch.
   */
  private carveServerCrater(cx: number, cz: number, radius: number): void {
    const r2 = radius * radius;
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        if (dx * dx + dz * dz > r2) continue;
        const x = cx + dx;
        const z = cz + dz;
        // Wipe the whole column up to the water level + a little margin so
        // the crater is visible regardless of what the procedural base laid
        // down underneath.
        const top = (this.state.world.waterLevel ?? 6) + 4;
        for (let y = 0; y <= top; y += 1) {
          const key = `${x},${y},${z}`;
          if (this.state.world.deltas.get(key) === 0) continue;
          this.state.world.deltas.set(key, 0);
          this.state.world.deltaSeq = (this.state.world.deltaSeq + 1) >>> 0;
          this.broadcast(VoxelServerMessage.WorldDelta, {
            op: "mine",
            x,
            y,
            z,
            t: 0,
            seq: this.state.world.deltaSeq,
            by: null,
          });
        }
      }
    }
  }

  /**
   * Called from {@link update} once {@link cinematicEndsAt} elapses. Treats
   * the cinematic wave as "cleared" and either ends the run (if it was the
   * final wave) or advances to the next.
   */
  private endCinematicWave(): void {
    const wave = this.cinematicWave;
    this.cinematicEndsAt = 0;
    this.cinematicWave = 0;

    if (isFinalWave(wave)) {
      this.state.phase = "dead";
      this.broadcast(VoxelServerMessage.WaveEnd, {
        wave,
        runComplete: true,
        victory: true,
      });
      return;
    }

    const next = (wave + 1) & 0xffff;
    this.state.wave = next;
    this.broadcastWaveStart(next);
    this.spawnCurrentWave();
  }

  /**
   * Apply damage to an enemy or dragon and award coins on kill. Exposed so
   * the parallel WeaponFire hit-pipeline agent can call into it.
   *
   * @param targetId - "enemy:<id>" or "dragon:<id>" form.
   * @param damage   - positive integer.
   * @param attackerSessionId - optional, awarded coins on kill.
   * @returns true if the target was killed by this hit.
   */
  applyDamage(
    targetId: string,
    damage: number,
    attackerSessionId?: string,
  ): boolean {
    if (typeof damage !== "number" || !Number.isFinite(damage) || damage <= 0) {
      return false;
    }

    if (targetId.startsWith("enemy:")) {
      const id = targetId.slice("enemy:".length);
      return this.damageEnemy(id, damage, attackerSessionId);
    }
    if (targetId.startsWith("dragon:")) {
      const id = targetId.slice("dragon:".length);
      return this.damageDragon(id, damage, attackerSessionId);
    }
    return false;
  }

  private damageEnemy(
    id: string,
    damage: number,
    attackerSessionId?: string,
  ): boolean {
    const e = this.state.enemies.get(id);
    if (!e) return false;
    e.health = Math.max(0, e.health - damage);
    if (e.health > 0) {
      this.broadcast(VoxelServerMessage.Damage, {
        victimId: `enemy:${id}`,
        amount: damage,
        hp: e.health,
        shield: 0,
      });
      return false;
    }
    // Killed.
    this.state.enemies.delete(id);
    this.broadcast(VoxelServerMessage.EnemyDespawn, { enemyId: id });
    debugLog(this.state.roomCode, "enemy:despawn", { id, reason: "killed", by: attackerSessionId ?? null });
    this.awardCoins(attackerSessionId, coinsForKind(e.kind));
    return true;
  }

  private damageDragon(
    id: string,
    damage: number,
    attackerSessionId?: string,
  ): boolean {
    const d = this.state.dragons.get(id);
    if (!d) return false;
    d.health = Math.max(0, d.health - damage);
    if (d.health > 0) {
      this.broadcast(VoxelServerMessage.Damage, {
        victimId: `dragon:${id}`,
        amount: damage,
        hp: d.health,
        shield: 0,
      });
      return false;
    }
    // Killed.
    this.state.dragons.delete(id);
    this.dragonFireCooldown.delete(id);
    this.dragonOrbitPhase.delete(id);
    this.bossState.delete(id);
    this.broadcast(VoxelServerMessage.EnemyDespawn, { enemyId: id });
    this.awardCoins(attackerSessionId, COINS_BALANCE.dragon ?? 5);
    return true;
  }

  private awardCoins(sessionId: string | undefined, amount: number): void {
    if (!sessionId || amount <= 0) return;
    const player = this.state.players.get(sessionId);
    if (!player) return;
    player.coins = (player.coins | 0) + amount;
    this.broadcast(VoxelServerMessage.CoinsChange, {
      sessionId,
      coins: player.coins,
    });
  }

  /**
   * Tear down every transient entity from the previous wave. Called on a
   * fresh playing transition so a re-started run doesn't inherit ghosts.
   */
  private clearWaveEntities(): void {
    this.state.enemies.clear();
    this.state.dragons.clear();
    this.state.fireballs.clear();
    this.dragonFireCooldown.clear();
    this.dragonOrbitPhase.clear();
    this.bossState.clear();
    this.bossProjectiles.length = 0;
    this.bossFireZones.length = 0;
    this.cinematicEndsAt = 0;
    this.cinematicWave = 0;
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
    this.broadcastWaveStart(this.state.wave);
    // If the shop-end path lands on the cinematic wave (e.g. 9 → 10), still
    // route through spawnCurrentWave so the meteor cinematic actually fires.
    if (isCinematicWave(this.state.wave)) {
      this.spawnCurrentWave();
    }
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
    const wasHost = player.isHost;
    this.state.players.delete(sessionId);
    this.latestInputs.delete(sessionId);
    this.broadcast(ServerMessage.PlayerLeft, { id: sessionId, name: player.name });

    if (wasHost) {
      this.reassignHost();
      // A pending countdown belongs to the (now gone) host — cancel it so the
      // new host explicitly starts the next attempt.
      if (this._pendingStartAt !== 0 && this.state.phase === "lobby") {
        this._pendingStartAt = 0;
        this.broadcast(LobbyServerMessage.StartCountdown, { startsAt: 0 });
      }
    }

    console.log(
      `[GameRoom ${this.state.roomCode}] -leave ${player.name} total=${this.state.players.size}`,
    );
  }

  /**
   * Pick the next connected player as host and broadcast {@link
   * LobbyServerMessage.HostChange}. Walks players in MapSchema iteration
   * order, which on Colyseus is the insertion order — so the longest-staying
   * connected player wins.
   */
  private reassignHost(): void {
    let nextHostId: string | null = null;
    this.state.players.forEach((p, id) => {
      if (nextHostId !== null) return;
      if (p.connected) nextHostId = id;
    });
    if (nextHostId === null) return;
    const next = this.state.players.get(nextHostId);
    if (!next) return;
    next.isHost = true;
    this.broadcast(LobbyServerMessage.HostChange, {
      hostSessionId: nextHostId,
    });
  }

  /**
   * Return true if any current player already has `isHost === true`. Used
   * by {@link onJoin} to decide whether the joiner should be promoted.
   */
  private hasHost(): boolean {
    let found = false;
    this.state.players.forEach((p) => {
      if (p.isHost) found = true;
    });
    return found;
  }

  /**
   * Update {@link GameState.phase} and broadcast {@link
   * LobbyServerMessage.PhaseChange}. On `lobby → playing` we reset
   * `readyForNextWave`, set `wave = 1`, and clear any pending countdown.
   * Enemy spawn lands in Phase 4.
   */
  private transitionPhase(from: string, to: string): void {
    this.state.phase = to;
    this.broadcast(LobbyServerMessage.PhaseChange, {
      from,
      to,
      at: Date.now(),
    });

    if (from === "lobby" && to === "playing") {
      this.state.players.forEach((p) => {
        p.readyForNextWave = false;
      });
      this.state.wave = 1;
      this._pendingStartAt = 0;
      // Reset any leftover entities (e.g. host re-started after a dead run)
      // and spawn wave 1.
      this.clearWaveEntities();
      this.broadcastWaveStart(1);
      this.spawnCurrentWave();
    }
  }
}

function toInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}

/**
 * Validate and coerce a `[x,y,z]` triple incoming from the wire. Accepts both
 * the protocol's tuple shape and a fall-back `{x,y,z}` object. Returns null on
 * any non-finite component.
 */
function toVec3(v: unknown): [number, number, number] | null {
  if (Array.isArray(v) && v.length >= 3) {
    const x = Number(v[0]);
    const y = Number(v[1]);
    const z = Number(v[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }
    return [x, y, z];
  }
  if (v && typeof v === "object") {
    const o = v as { x?: unknown; y?: unknown; z?: unknown };
    const x = Number(o.x);
    const y = Number(o.y);
    const z = Number(o.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }
    return [x, y, z];
  }
  return null;
}

/**
 * Ray-sphere intersection: returns the distance from `origin` along the
 * (unit-length) `dir` to the nearest hit, or `null` if no hit. Used by the
 * WeaponFire pipeline as a cheap bounding-sphere collider. The first
 * intersection in front of the origin wins; if the origin is inside the
 * sphere we return 0.
 */
function raySphereT(
  origin: [number, number, number],
  dir: [number, number, number],
  center: [number, number, number],
  radius: number,
): number | null {
  const ox = origin[0] - center[0];
  const oy = origin[1] - center[1];
  const oz = origin[2] - center[2];
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c > 0 && b > 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const t1 = -b - sqrtDisc;
  if (t1 >= 0) return t1;
  const t2 = -b + sqrtDisc;
  if (t2 >= 0) return 0; // origin inside the sphere
  return null;
}

function coinsForKind(kind: string): number {
  if (kind === "zombie") return COINS_BALANCE.zombie ?? 2;
  if (kind === "skeleton") return COINS_BALANCE.skeleton ?? 3;
  if (kind === "witch") return COINS_BALANCE.witch ?? 4;
  return 1;
}

export { GAME_ROOM_NAME };
