"use client";

import { create } from "zustand";
import type { ConnectionStatus } from "@mvp/shared";
import { getTransport } from "@/networking/colyseusTransport";

function buildGameUrl(
  roomCode: string | null,
  name: string,
  mode: "create" | "join"
): string {
  const explicit = process.env.NEXT_PUBLIC_GAME_URL;
  const params = new URLSearchParams({ name, mode });
  if (roomCode) params.set("code", roomCode);
  if (explicit) {
    return `${explicit.replace(/\/$/, "")}/?${params.toString()}`;
  }
  return `/play?${params.toString()}`;
}

type LobbyState = {
  name: string;
  setName: (n: string) => void;
  status: ConnectionStatus;
  error: string | null;
  roomCode: string | null;
  selfId: string | null;
  setStatus: (s: ConnectionStatus) => void;
  setError: (e: string | null) => void;
  setRoomCode: (c: string | null) => void;
  setSelfId: (id: string | null) => void;
  createRoom: (name: string) => Promise<void>;
  joinRoomByCode: (name: string, code: string) => Promise<void>;
  leaveRoom: () => Promise<void>;
  redirectToGame: (mode: "create" | "join", code?: string | null) => void;
};

export const useLobbyStore = create<LobbyState>((set, get) => ({
  name: "",
  setName: (name) => set({ name }),
  status: "idle",
  error: null,
  roomCode: null,
  selfId: null,
  setStatus: (status) => set({ status }),
  setError: (error) => set({ error }),
  setRoomCode: (roomCode) => set({ roomCode }),
  setSelfId: (selfId) => set({ selfId }),
  async createRoom(name) {
    set({ error: null, name });
    try {
      await getTransport().createRoom(name);
      set({
        roomCode: getTransport().getRoomCode(),
        selfId: getTransport().getSelfId(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not create room";
      set({ error: message });
      throw err;
    }
  },
  async joinRoomByCode(name, code) {
    set({ error: null, name });
    try {
      await getTransport().joinRoomByCode(name, code);
      set({
        roomCode: getTransport().getRoomCode(),
        selfId: getTransport().getSelfId(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not join room";
      set({ error: message });
      throw err;
    }
  },
  async leaveRoom() {
    await getTransport().leave();
    set({ roomCode: null, selfId: null, status: "idle", error: null });
    // Reset transient connection state but keep the chosen name.
    void get;
  },
  redirectToGame(mode, code) {
    if (typeof window === "undefined") return;
    const { roomCode, name } = get();
    const trimmed = name.trim();
    // For 'create' there's no roomCode yet — apps/game creates the room
    // and the server returns the authoritative code which the WaitingRoom
    // surfaces. For 'join' the caller passes the code from the form input.
    const finalCode = mode === "join" ? (code ?? roomCode) : null;
    window.location.href = buildGameUrl(finalCode, trimmed, mode);
  },
}));
