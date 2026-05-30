export interface PlayerInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  /** Yaw in radians */
  rotationY: number;
  seq: number;
}

export interface PlayerSnapshot {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  rotationY: number;
  health: number;
  alive: boolean;
  connected: boolean;
}

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "disconnected";

export interface CreateRoomOptions {
  name: string;
}

export interface JoinRoomOptions {
  name: string;
  code: string;
}

export type ServerErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "INVALID_NAME"
  | "INVALID_CODE"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

// Voxel block types — keep aligned with apps/game/src/modules/BlockTextures.js
export type BlockType =
  | "grass"
  | "dirt"
  | "stone"
  | "sand"
  | "wood"
  | "leaves"
  | "water";

// Character classes from apps/game/src/modules/Characters.js
export type CharacterId =
  | "duck"
  | "knight"
  | "hunter"
  | "samurai"
  | "mage";

// Room phase
export type RoomPhase = "lobby" | "playing" | "shop" | "dead";

// Authoritative player record (extends PlayerSnapshot)
export interface VoxelPlayerSnapshot extends PlayerSnapshot {
  pitch: number;
  shield: number;
  ammo: number;
  reserveAmmo: number;
  characterId: CharacterId;
  selectedSlotIndex: number;
  isReloading: boolean;
  isGrounded: boolean;
  guardActive: boolean;
}

// Inputs from voxel game include ability buttons
export interface VoxelPlayerInput extends PlayerInput {
  pitch: number;
  jump: boolean;
  sprint: boolean;
  dash: boolean;
  attack: boolean;
  guard: boolean;
  reload: boolean;
  inventorySlot: number;
}

// Enemy kinds
export type EnemyKind = "skeleton" | "zombie" | "witch";

export interface EnemySnapshot {
  id: string;
  kind: EnemyKind;
  x: number;
  y: number;
  z: number;
  rotationY: number;
  health: number;
  maxHealth: number;
  /** Bitfield: 1=slow, 2=lifted, 4=parrying, 8=charging */
  flags: number;
}

export interface DragonSnapshot {
  id: string;
  x: number;
  y: number;
  z: number;
  rotationY: number;
  health: number;
  maxHealth: number;
  aggression: number;
  /** Bitfield */
  flags: number;
}

export interface FireballSnapshot {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** "dragon" or sessionId of owner */
  ownerId: string;
  damage: number;
}

export interface ProjectileSnapshot {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  weaponId: string;
  ownerSessionId: string;
}

export interface WorldDelta {
  /** "set" or "del" */
  op: "set" | "del";
  x: number;
  y: number;
  z: number;
  t?: BlockType;
}

export interface ShopOffer {
  id: string;
  name: string;
  cost: number;
  /** Bitfield of effect kinds */
  effect: number;
}
