"use client";

import { useCallback, useMemo, useState } from "react";
import {
  PLAYER_NAME_MIN_LENGTH,
  PLAYER_NAME_MAX_LENGTH,
  ROOM_CODE_LENGTH,
  ROOM_CODE_ALPHABET,
} from "@mvp/shared";
import { useLobbyStore } from "@/stores/lobbyStore";
import { useTransportSubscription } from "@/hooks/useTransportSubscription";
import { getTransport } from "@/networking/colyseusTransport";

function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < PLAYER_NAME_MIN_LENGTH) {
    return `El nombre debe tener al menos ${PLAYER_NAME_MIN_LENGTH} caracteres.`;
  }
  if (trimmed.length > PLAYER_NAME_MAX_LENGTH) {
    return `El nombre debe tener como máximo ${PLAYER_NAME_MAX_LENGTH} caracteres.`;
  }
  return null;
}

function sanitizeCode(raw: string): string {
  const upper = raw.toUpperCase();
  const allowed = new Set(ROOM_CODE_ALPHABET.split(""));
  return upper
    .split("")
    .filter((c) => allowed.has(c))
    .join("")
    .slice(0, ROOM_CODE_LENGTH);
}

export function LobbyForm(): JSX.Element {
  useTransportSubscription();

  const name = useLobbyStore((s) => s.name);
  const setName = useLobbyStore((s) => s.setName);
  const status = useLobbyStore((s) => s.status);
  const errorFromStore = useLobbyStore((s) => s.error);
  const setError = useLobbyStore((s) => s.setError);
  const createRoom = useLobbyStore((s) => s.createRoom);
  const joinRoomByCode = useLobbyStore((s) => s.joinRoomByCode);
  const redirectToGame = useLobbyStore((s) => s.redirectToGame);

  const [code, setCode] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const connecting = status === "connecting";
  const error = localError ?? errorFromStore;
  const trimmedName = useMemo(() => name.trim(), [name]);

  const handleCreate = useCallback(async () => {
    const validation = validateName(name);
    if (validation) {
      setLocalError(validation);
      return;
    }
    setLocalError(null);
    setError(null);
    try {
      await createRoom(trimmedName);
      // Hand off cleanly: drop the lobby's demo connection, then go to the
      // standalone Voxel-Dragons app where character selection happens.
      try {
        await getTransport().leave();
      } catch {
        /* ignore — we're leaving the page anyway */
      }
      redirectToGame("create");
    } catch {
      // store-level error already populated
    }
  }, [name, trimmedName, createRoom, redirectToGame, setError]);

  const handleJoin = useCallback(async () => {
    const validation = validateName(name);
    if (validation) {
      setLocalError(validation);
      return;
    }
    if (code.length !== ROOM_CODE_LENGTH) {
      setLocalError(`El código debe tener ${ROOM_CODE_LENGTH} caracteres.`);
      return;
    }
    setLocalError(null);
    setError(null);
    try {
      await joinRoomByCode(trimmedName, code);
      try {
        await getTransport().leave();
      } catch {
        /* ignore — we're leaving the page anyway */
      }
      redirectToGame("join");
    } catch {
      // store-level error already populated
    }
  }, [name, trimmedName, code, joinRoomByCode, redirectToGame, setError]);

  return (
    <div className="lobby">
      <div>
        <h1>Voxel Shooter MVP</h1>
        <p className="subtitle">
          Crea o únete a una sala. Te llevamos al mundo voxel.
        </p>
      </div>

      <div className="section" style={{ borderTop: "none", paddingTop: 0 }}>
        <label htmlFor="name">Tu nombre</label>
        <input
          id="name"
          type="text"
          autoComplete="off"
          maxLength={PLAYER_NAME_MAX_LENGTH}
          placeholder="Ej. agent42"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (localError) setLocalError(null);
          }}
          disabled={connecting}
        />
      </div>

      <div className="section">
        <button
          type="button"
          onClick={handleCreate}
          disabled={connecting || trimmedName.length === 0}
        >
          {connecting ? "Conectando..." : "Crear sala"}
        </button>
      </div>

      <div className="section">
        <label htmlFor="code">Código de sala</label>
        <input
          id="code"
          type="text"
          className="room-code"
          autoComplete="off"
          placeholder={"X".repeat(ROOM_CODE_LENGTH)}
          value={code}
          onChange={(e) => {
            setCode(sanitizeCode(e.target.value));
            if (localError) setLocalError(null);
          }}
          maxLength={ROOM_CODE_LENGTH}
          disabled={connecting}
        />
        <button
          type="button"
          className="secondary"
          onClick={handleJoin}
          disabled={
            connecting ||
            trimmedName.length === 0 ||
            code.length !== ROOM_CODE_LENGTH
          }
        >
          {connecting ? "Conectando..." : "Unirse"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
