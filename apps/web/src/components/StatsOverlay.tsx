"use client";

import { useEffect, useState } from "react";
import {
  getFps,
  getPingMs,
  startPingPoller,
  subscribeStats,
} from "@/game/clientStats";

const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL ?? "ws://localhost:2567";

function pingClass(ms: number): string {
  if (ms === 0) return "p-idle";
  if (ms < 80) return "p-good";
  if (ms < 160) return "p-ok";
  return "p-bad";
}

export function StatsOverlay(): JSX.Element {
  const [, force] = useState(0);

  useEffect(() => {
    startPingPoller(SERVER_URL);
    const unsub = subscribeStats(() => force((n) => n + 1));
    return () => {
      unsub();
    };
  }, []);

  const fps = getFps();
  const ping = getPingMs();

  return (
    <div className="stats-overlay" aria-live="polite">
      <div className="row">
        <span className="lbl">FPS</span>
        <span className="val">{fps || "--"}</span>
      </div>
      <div className="row">
        <span className="lbl">PING</span>
        <span className={`val ${pingClass(ping)}`}>
          {ping ? `${Math.round(ping)} ms` : "--"}
        </span>
      </div>
    </div>
  );
}
