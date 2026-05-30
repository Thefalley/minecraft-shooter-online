"use client";

import { useEffect } from "react";
import { getTransport } from "@/networking/colyseusTransport";
import { useLobbyStore } from "@/stores/lobbyStore";
import { usePlayersStore } from "@/stores/playersStore";

let installed = false;
let unsubscribers: Array<() => void> = [];

/**
 * Wires the singleton transport to lobby + players stores. Idempotent so it
 * can be called from multiple components without double-binding.
 */
function installSubscriptions(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  installed = true;

  const transport = getTransport();
  const lobby = useLobbyStore.getState;
  const players = usePlayersStore.getState;

  unsubscribers.push(
    transport.on("status", (status) => {
      lobby().setStatus(status);
      if (status === "disconnected" || status === "idle") {
        players().reset();
      }
    })
  );

  unsubscribers.push(
    transport.on("welcome", (payload) => {
      lobby().setSelfId(payload.selfId ?? null);
      lobby().setRoomCode(payload.roomCode ?? null);
      players().setSelfId(payload.selfId ?? null);
      players().setRoomCode(payload.roomCode ?? null);
    })
  );

  unsubscribers.push(
    transport.on("error", (payload) => {
      lobby().setError(payload.message ?? payload.code ?? "Unknown error");
    })
  );

  unsubscribers.push(
    transport.on("state", (snap) => {
      players().setPlayers(snap.players);
      players().setTick(snap.tick);
      if (snap.roomCode) players().setRoomCode(snap.roomCode);
    })
  );
}

export function useTransportSubscription(): void {
  useEffect(() => {
    installSubscriptions();
    return () => {
      // We intentionally leave the subscription installed for the lifetime of
      // the page so navigations between lobby <-> /play don't lose events.
      // No-op cleanup.
    };
  }, []);
}

/** Test/utility: tear down subscriptions (not used in production). */
export function _resetTransportSubscriptions(): void {
  for (const u of unsubscribers) u();
  unsubscribers = [];
  installed = false;
}
