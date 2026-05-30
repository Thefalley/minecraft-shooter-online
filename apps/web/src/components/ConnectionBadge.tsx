"use client";

import type { ConnectionStatus } from "@mvp/shared";
import { useLobbyStore } from "@/stores/lobbyStore";

const LABEL: Record<ConnectionStatus, string> = {
  idle: "Inactivo",
  connecting: "Conectando",
  connected: "Conectado",
  reconnecting: "Reconectando",
  disconnected: "Desconectado",
  error: "Error",
};

export function ConnectionBadge(): JSX.Element {
  const status = useLobbyStore((s) => s.status);
  return (
    <div className="connection-status" role="status" aria-live="polite">
      <span className={`dot ${status}`} />
      <span>{LABEL[status] ?? status}</span>
    </div>
  );
}
