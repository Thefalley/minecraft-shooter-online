"use client";

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useLobbyStore } from "@/stores/lobbyStore";
import { usePlayersStore } from "@/stores/playersStore";

const STATUS_LABEL: Record<string, string> = {
  idle: "Inactivo",
  connecting: "Conectando",
  connected: "Conectado",
  disconnected: "Desconectado",
  error: "Error",
};

export function HUD(): JSX.Element {
  const router = useRouter();
  const roomCode = useLobbyStore(
    (s) => s.roomCode ?? usePlayersStore.getState().roomCode ?? "-----"
  );
  const name = useLobbyStore((s) => s.name);
  const status = useLobbyStore((s) => s.status);
  const leaveRoom = useLobbyStore((s) => s.leaveRoom);

  const players = usePlayersStore((s) => s.players);
  const selfId = usePlayersStore((s) => s.selfId);

  const playerList = useMemo(() => Object.values(players), [players]);

  const handleLeave = useCallback(async () => {
    await leaveRoom();
    router.push("/");
  }, [leaveRoom, router]);

  return (
    <div className="hud">
      <div className="room-code">{roomCode}</div>
      <div className="row">
        <span className="label">Jugador</span>
        <span>{name || "(sin nombre)"}</span>
      </div>
      <div className="row">
        <span className="label">Estado</span>
        <span>
          <span className={`dot ${status}`} style={{ display: "inline-block", verticalAlign: "middle", marginRight: 6 }} />
          {STATUS_LABEL[status] ?? status}
        </span>
      </div>
      <div className="row">
        <span className="label">Jugadores</span>
        <span>{playerList.length}</span>
      </div>
      <div className="players">
        {playerList.map((p) => (
          <div key={p.id} className="row">
            <span>
              {p.id === selfId ? "→ " : "  "}
              {p.name}
            </span>
            <span style={{ color: p.alive ? "#9bbcff" : "#ff8c8c" }}>
              {p.health} HP
            </span>
          </div>
        ))}
      </div>
      <div className="hint">WASD mover · Q/E girar · Esc volver</div>
      <button type="button" className="leave-btn" onClick={handleLeave}>
        Salir
      </button>
    </div>
  );
}
