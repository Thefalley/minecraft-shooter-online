import { Client, Room, getStateCallbacks } from "colyseus.js";
import {
  ClientMessage,
  ServerMessage,
  GAME_ROOM_NAME,
  type ConnectionStatus,
  type PlayerInput,
  type PlayerSnapshot,
  type WelcomePayload,
  type ErrorPayload,
  type PlayerJoinedPayload,
  type PlayerLeftPayload,
} from "@mvp/shared";
import type {
  NetworkTransport,
  TransportEventMap,
  TransportEventName,
  TransportListener,
} from "./transport";

const DEFAULT_SERVER_URL = "ws://localhost:2567";

function getServerUrl(): string {
  return process.env.NEXT_PUBLIC_SERVER_URL || DEFAULT_SERVER_URL;
}

function getHttpBaseUrl(): string {
  const ws = getServerUrl();
  if (ws.startsWith("wss://")) return "https://" + ws.slice("wss://".length);
  if (ws.startsWith("ws://")) return "http://" + ws.slice("ws://".length);
  return ws;
}

type PlayerLike = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  rotationY: number;
  health: number;
  alive: boolean;
  connected: boolean;
};

type RoomLike = Room<{
  roomCode: string;
  tick: number;
  players: {
    forEach: (cb: (p: PlayerLike, k: string) => void) => void;
    get: (k: string) => PlayerLike | undefined;
    size: number;
  };
}>;

export class ColyseusTransport implements NetworkTransport {
  private client: Client | null = null;
  private room: RoomLike | null = null;
  private selfId: string | null = null;
  private roomCode: string | null = null;
  private status: ConnectionStatus = "idle";
  private listeners: Map<TransportEventName, Set<(p: unknown) => void>> =
    new Map();
  private snapshot: Map<string, PlayerSnapshot> = new Map();

  private ensureClient(): Client {
    if (!this.client) {
      this.client = new Client(getServerUrl());
    }
    return this.client;
  }

  private emit<E extends TransportEventName>(
    event: E,
    payload: TransportEventMap[E]
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.forEach((cb) => {
      try {
        (cb as TransportListener<E>)(payload);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[transport] listener error", err);
      }
    });
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }

  private toSnapshot(p: PlayerLike, sessionId: string): PlayerSnapshot {
    return {
      id: p.id ?? sessionId,
      name: p.name,
      x: p.x,
      y: p.y,
      z: p.z,
      rotationY: p.rotationY,
      health: p.health,
      alive: p.alive,
      connected: p.connected,
    };
  }

  private emitState(): void {
    if (!this.room) return;
    const state = this.room.state;
    const players: PlayerSnapshot[] = [];
    this.snapshot.forEach((s) => players.push(s));
    this.emit("state", {
      roomCode: state?.roomCode ?? this.roomCode ?? "",
      tick: state?.tick ?? 0,
      players,
    });
  }

  private attachRoom(room: RoomLike): void {
    this.room = room;
    this.selfId = room.sessionId;
    this.snapshot.clear();

    // Wire up server messages.
    room.onMessage(ServerMessage.Welcome, (payload: WelcomePayload) => {
      this.selfId = payload.sessionId ?? this.selfId;
      this.roomCode = payload.roomCode ?? this.roomCode;
      this.emit("welcome", payload);
    });
    room.onMessage(ServerMessage.Error, (payload: ErrorPayload) => {
      this.emit("error", payload);
    });
    room.onMessage(
      ServerMessage.PlayerJoined,
      (payload: PlayerJoinedPayload) => {
        this.emit("playerJoined", payload);
      }
    );
    room.onMessage(ServerMessage.PlayerLeft, (payload: PlayerLeftPayload) => {
      this.emit("playerLeft", payload);
    });

    room.onLeave(() => {
      this.setStatus("disconnected");
      this.snapshot.clear();
      this.room = null;
      this.selfId = null;
      this.roomCode = null;
    });

    room.onError((code, message) => {
      this.emit("error", {
        code: "TRANSPORT_ERROR" as ErrorPayload["code"],
        message: message ?? `Colyseus error ${code}`,
      });
    });

    // Schema callbacks.
    try {
      const $ = getStateCallbacks(room as unknown as Room);
      const stateAny = room.state as unknown as { players: unknown };
      // @ts-expect-error - schema-callbacks proxy
      $(stateAny).players.onAdd((player: PlayerLike, sessionId: string) => {
        this.snapshot.set(sessionId, this.toSnapshot(player, sessionId));
        this.emitState();
        // @ts-expect-error - schema-callbacks proxy
        $(player).onChange(() => {
          this.snapshot.set(sessionId, this.toSnapshot(player, sessionId));
          this.emitState();
        });
      });
      // @ts-expect-error - schema-callbacks proxy
      $(stateAny).players.onRemove((_p: PlayerLike, sessionId: string) => {
        this.snapshot.delete(sessionId);
        this.emitState();
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[transport] failed to attach state callbacks", err);
    }

    this.setStatus("connected");
  }

  async createRoom(name: string): Promise<void> {
    if (typeof window === "undefined") return;
    this.setStatus("connecting");
    try {
      const client = this.ensureClient();
      const room = (await client.create(GAME_ROOM_NAME, { name })) as RoomLike;
      this.roomCode = (room.state?.roomCode as string) ?? null;
      this.attachRoom(room);
    } catch (err) {
      this.setStatus("error");
      const message = err instanceof Error ? err.message : "Failed to create room";
      this.emit("error", {
        code: "CREATE_FAILED" as ErrorPayload["code"],
        message,
      });
      throw err;
    }
  }

  async joinRoomByCode(name: string, code: string): Promise<void> {
    if (typeof window === "undefined") return;
    this.setStatus("connecting");
    const normalized = code.toUpperCase();
    try {
      const httpBase = getHttpBaseUrl();
      const res = await fetch(
        `${httpBase}/rooms/by-code/${encodeURIComponent(normalized)}`
      );
      if (res.status === 404) {
        const payload: ErrorPayload = {
          code: "ROOM_NOT_FOUND" as ErrorPayload["code"],
          message: `Room ${normalized} not found`,
        };
        this.emit("error", payload);
        this.setStatus("error");
        throw new Error(payload.message);
      }
      if (res.status === 400) {
        const payload: ErrorPayload = {
          code: "INVALID_CODE" as ErrorPayload["code"],
          message: `Invalid room code ${normalized}`,
        };
        this.emit("error", payload);
        this.setStatus("error");
        throw new Error(payload.message);
      }
      if (!res.ok) {
        const payload: ErrorPayload = {
          code: "JOIN_FAILED" as ErrorPayload["code"],
          message: `Server returned ${res.status}`,
        };
        this.emit("error", payload);
        this.setStatus("error");
        throw new Error(payload.message);
      }
      const data = (await res.json()) as {
        roomId: string;
        roomCode: string;
        clients: number;
        maxClients: number;
      };
      const client = this.ensureClient();
      const room = (await client.joinById(data.roomId, { name })) as RoomLike;
      this.roomCode = data.roomCode;
      this.attachRoom(room);
    } catch (err) {
      if (this.status !== "error") {
        this.setStatus("error");
        const message =
          err instanceof Error ? err.message : "Failed to join room";
        this.emit("error", {
          code: "JOIN_FAILED" as ErrorPayload["code"],
          message,
        });
      }
      throw err;
    }
  }

  sendInput(input: PlayerInput): void {
    this.room?.send(ClientMessage.Input, input);
  }

  async leave(): Promise<void> {
    if (this.room) {
      try {
        await this.room.leave(true);
      } catch {
        /* ignore */
      }
    }
    this.room = null;
    this.selfId = null;
    this.roomCode = null;
    this.snapshot.clear();
    this.setStatus("idle");
  }

  on<E extends TransportEventName>(
    event: E,
    listener: TransportListener<E>
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (p: unknown) => void);
    return () => {
      set?.delete(listener as (p: unknown) => void);
    };
  }

  getSelfId(): string | null {
    return this.selfId;
  }

  getRoomCode(): string | null {
    return this.roomCode;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }
}

// --- SSR-safe singleton ----------------------------------------------------

const stubTransport: NetworkTransport = {
  async createRoom() {
    /* no-op during SSR */
  },
  async joinRoomByCode() {
    /* no-op during SSR */
  },
  sendInput() {
    /* no-op */
  },
  async leave() {
    /* no-op */
  },
  on() {
    return () => {
      /* no-op */
    };
  },
  getSelfId() {
    return null;
  },
  getRoomCode() {
    return null;
  },
  getStatus() {
    return "idle";
  },
};

let _instance: NetworkTransport | null = null;

export function getTransport(): NetworkTransport {
  if (typeof window === "undefined") return stubTransport;
  if (!_instance) _instance = new ColyseusTransport();
  return _instance;
}

/**
 * Backwards-compatible singleton export. Reading this on the server returns
 * the stub; on the client it lazily constructs the real ColyseusTransport.
 */
export const transport: NetworkTransport = new Proxy({} as NetworkTransport, {
  get(_target, prop, receiver) {
    const target = getTransport() as unknown as Record<string | symbol, unknown>;
    const value = target[prop as string];
    if (typeof value === "function") {
      return (value as (...args: unknown[]) => unknown).bind(target);
    }
    return Reflect.get(target as object, prop, receiver);
  },
});
