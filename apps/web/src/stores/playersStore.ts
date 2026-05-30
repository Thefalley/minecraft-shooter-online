"use client";

import { create } from "zustand";
import type { PlayerSnapshot } from "@mvp/shared";

type PlayersState = {
  players: Record<string, PlayerSnapshot>;
  setPlayers: (snap: PlayerSnapshot[]) => void;
  selfId: string | null;
  setSelfId: (id: string | null) => void;
  tick: number;
  setTick: (tick: number) => void;
  roomCode: string | null;
  setRoomCode: (code: string | null) => void;
  reset: () => void;
};

export const usePlayersStore = create<PlayersState>((set) => ({
  players: {},
  setPlayers: (snap) => {
    const next: Record<string, PlayerSnapshot> = {};
    for (const p of snap) next[p.id] = p;
    set({ players: next });
  },
  selfId: null,
  setSelfId: (selfId) => set({ selfId }),
  tick: 0,
  setTick: (tick) => set({ tick }),
  roomCode: null,
  setRoomCode: (roomCode) => set({ roomCode }),
  reset: () =>
    set({ players: {}, selfId: null, tick: 0, roomCode: null }),
}));
