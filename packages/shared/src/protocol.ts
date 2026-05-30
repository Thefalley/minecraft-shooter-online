import type {
  BlockType,
  CharacterId,
  DragonSnapshot,
  EnemySnapshot,
  FireballSnapshot,
  ServerErrorCode,
  ShopOffer,
  WorldDelta,
} from "./types";

export const ClientMessage = {
  Input: "client:input",
  Chat: "client:chat",
} as const;
export type ClientMessageName = (typeof ClientMessage)[keyof typeof ClientMessage];

export const ServerMessage = {
  Error: "server:error",
  PlayerJoined: "server:playerJoined",
  PlayerLeft: "server:playerLeft",
  Welcome: "server:welcome",
} as const;
export type ServerMessageName = (typeof ServerMessage)[keyof typeof ServerMessage];

export interface ErrorPayload {
  code: ServerErrorCode;
  message: string;
}

export interface WelcomePayload {
  selfId: string;
  roomCode: string;
}

export interface PlayerJoinedPayload {
  id: string;
  name: string;
}

export interface PlayerLeftPayload {
  id: string;
  name: string;
}

// Phase 1 — voxel multiplayer protocol
export const VoxelClientMessage = {
  Input: "vp:input", // 20 Hz pump
  WorldMine: "vp:world:mine", // intent
  WorldPlace: "vp:world:place", // intent
  WeaponFire: "vp:weapon:fire", // intent
  WeaponReload: "vp:weapon:reload",
  AbilityUse: "vp:ability:use",
  CharacterSelect: "vp:character:select",
  SlotSelect: "vp:slot:select",
  ShopBuy: "vp:shop:buy",
  ReadyNextWave: "vp:wave:ready",
  Ping: "vp:ping",
} as const;
export type VoxelClientMessageName =
  (typeof VoxelClientMessage)[keyof typeof VoxelClientMessage];

export const VoxelServerMessage = {
  WorldSeed: "vs:world:seed",
  WorldDelta: "vs:world:delta",
  WorldDeltaBatch: "vs:world:deltaBatch",
  EnemySpawn: "vs:enemy:spawn",
  EnemyDespawn: "vs:enemy:despawn",
  EnemyEvent: "vs:enemy:event", // shoot arrow, throw potion, attack
  DragonFireball: "vs:dragon:fireball",
  WeaponHit: "vs:weapon:hit",
  WeaponMiss: "vs:weapon:miss",
  WeaponReloadComplete: "vs:weapon:reloadDone",
  AmmoChange: "vs:ammo",
  Damage: "vs:damage",
  PlayerDeath: "vs:player:death",
  PlayerRespawn: "vs:player:respawn",
  WaveStart: "vs:wave:start",
  WaveEnd: "vs:wave:end",
  ShopOpen: "vs:shop:open",
  ShopClose: "vs:shop:close",
  ShopApplied: "vs:shop:applied",
  CoinsChange: "vs:coins",
  Pong: "vs:pong",
} as const;
export type VoxelServerMessageName =
  (typeof VoxelServerMessage)[keyof typeof VoxelServerMessage];

// Payloads — every field counted in design notes
export interface WorldSeedPayload {
  seed: number;
  width: number;
  depth: number;
  maxHeight: number;
  waterLevel: number;
  /** Initial deltas already applied (for late joiners) */
  deltas: WorldDelta[];
}
export interface WorldDeltaPayload extends WorldDelta {
  /** Sequence number for ordering */
  seq: number;
  /** Source sessionId, null for server-initiated */
  by: string | null;
}
export interface WorldDeltaBatchPayload {
  baseSeq: number;
  deltas: WorldDelta[];
}

export interface WeaponFireIntent {
  seq: number;
  /** index into Player.inventory.slots */
  slotIndex: number;
  origin: [number, number, number];
  direction: [number, number, number];
  /** PRNG seed for spread reproducibility */
  spreadSeed: number;
  /** Performance.now() at the moment client fired */
  clientTime: number;
}
export interface WeaponHitPayload {
  /** Echo of the client's seq */
  seq: number;
  shotId: string;
  hits: Array<{
    /** "player:sessionId" or "enemy:id" or "dragon:id" */
    targetId: string;
    damage: number;
    point: [number, number, number];
  }>;
}
export interface WeaponMissPayload {
  seq: number;
  shotId: string;
}

export interface AbilityUsePayload {
  seq: number;
  ability: "dash" | "guard" | "spell" | "bomb";
  /** Optional aim direction */
  direction?: [number, number, number];
}

export interface EnemySpawnPayload {
  enemies: EnemySnapshot[];
}
export interface EnemyEventPayload {
  enemyId: string;
  event: "attack" | "shoot" | "throw" | "die";
  target?: [number, number, number];
}
export interface DragonFireballPayload {
  fireball: FireballSnapshot;
  /** "spawn" | "despawn" | "reflect" */
  kind: "spawn" | "despawn" | "reflect";
}

export interface AmmoChangePayload {
  slotIndex: number;
  ammo: number;
  reserveAmmo: number;
}

export interface DamagePayload {
  /** "player:sessionId" or "enemy:id" or "dragon:id" */
  victimId: string;
  amount: number;
  /** new HP after damage */
  hp: number;
  /** new shield after damage */
  shield: number;
}

export interface WaveStartPayload {
  wave: number;
  totalWaves: number;
}
export interface ShopOpenPayload {
  endsAt: number;
  offers: ShopOffer[];
}
export interface CoinsChangePayload {
  sessionId: string;
  coins: number;
}
export interface PingPayload {
  t: number;
}
export interface PongPayload {
  t: number;
  serverT: number;
}

export interface CharacterSelectPayload {
  characterId: CharacterId;
}
export interface SlotSelectPayload {
  slotIndex: number;
}
export interface ShopBuyPayload {
  offerId: string;
}
