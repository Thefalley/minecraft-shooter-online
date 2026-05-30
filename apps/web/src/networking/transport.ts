import type {
  ConnectionStatus,
  PlayerInput,
  PlayerSnapshot,
  WelcomePayload,
  ErrorPayload,
  PlayerJoinedPayload,
  PlayerLeftPayload,
} from "@mvp/shared";

export type TransportEventMap = {
  status: ConnectionStatus;
  welcome: WelcomePayload;
  error: ErrorPayload;
  playerJoined: PlayerJoinedPayload;
  playerLeft: PlayerLeftPayload;
  /** Full snapshot diff per tick, derived from schema changes */
  state: { roomCode: string; tick: number; players: PlayerSnapshot[] };
};

export type TransportEventName = keyof TransportEventMap;
export type TransportListener<E extends TransportEventName> = (
  payload: TransportEventMap[E]
) => void;

export interface NetworkTransport {
  createRoom(name: string): Promise<void>;
  joinRoomByCode(name: string, code: string): Promise<void>;
  sendInput(input: PlayerInput): void;
  leave(): Promise<void>;
  on<E extends TransportEventName>(
    event: E,
    listener: TransportListener<E>
  ): () => void;
  getSelfId(): string | null;
  getRoomCode(): string | null;
  getStatus(): ConnectionStatus;
}
