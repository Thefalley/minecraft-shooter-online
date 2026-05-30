"use client";

/**
 * Lightweight stats module: tracks rendered FPS (sampled every second) and
 * HTTP RTT to the server's /health endpoint. Read by the StatsOverlay.
 */

let fps = 0;
let frames = 0;
let lastFpsT = 0;

let pingMs = 0;
let pingPoller: number | null = null;

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function subscribeStats(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getFps(): number {
  return fps;
}

export function getPingMs(): number {
  return pingMs;
}

/** Call once per rendered frame. Recomputes fps once per second. */
export function tickFrame(now: number): void {
  frames++;
  if (lastFpsT === 0) lastFpsT = now;
  const elapsed = now - lastFpsT;
  if (elapsed >= 1000) {
    fps = Math.round((frames * 1000) / elapsed);
    frames = 0;
    lastFpsT = now;
    notify();
  }
}

/** Start polling /health to estimate RTT. Idempotent. */
export function startPingPoller(serverUrl: string): void {
  if (typeof window === "undefined") return;
  if (pingPoller !== null) return;

  // Convert ws(s):// to http(s):// for the /health probe.
  const httpBase = serverUrl
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://");
  const url = `${httpBase.replace(/\/$/, "")}/health`;

  const probe = async () => {
    const t0 = performance.now();
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      await res.text();
      const rtt = performance.now() - t0;
      // Exponential smoothing so spikes don't dominate the display.
      pingMs = pingMs === 0 ? rtt : pingMs * 0.7 + rtt * 0.3;
      notify();
    } catch {
      /* ignore — server may be cold-starting */
    }
  };

  probe();
  pingPoller = window.setInterval(probe, 2000);
}

export function stopPingPoller(): void {
  if (pingPoller !== null) {
    window.clearInterval(pingPoller);
    pingPoller = null;
  }
}
