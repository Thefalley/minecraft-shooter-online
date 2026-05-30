"use client";

import { create } from "zustand";
import type { ConnectionStatus } from "@mvp/shared";
import { getTransport } from "@/networking/colyseusTransport";

const DEFAULT_GAME_URL = "http://localhost:5173";

function buildGameUrl(
  roomCode: string,
  name: string,
  mode: "create" | "join"
): string {
  const base = process.env.NEXT_PUBLIC_GAME_URL ?? DEFAULT_GAME_URL;
  const params = new URLSearchParams({ code: roomCode, name, mode });
  return `${base.replace(/\/$/, "")}/?${params.toString()}`;
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
  redirectToGame: (mode: "create" | "join") => void;
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
  redirectToGame(mode) {
    if (typeof window === "undefined") return;
    const { roomCode, name } = get();
    if (!roomCode) return; // defensive: nothing to hand off
    const trimmed = name.trim();
    window.location.href = buildGameUrl(roomCode, trimmed, mode);
  },
}));
