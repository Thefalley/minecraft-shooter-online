import type { ServerErrorCode } from "./types";

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
