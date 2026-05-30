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
