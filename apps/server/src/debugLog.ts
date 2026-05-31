// Cross-room debug ring buffer keyed by roomCode. Lives in-process and is
// exposed read-only over HTTP at GET /debug/rooms/:code/logs.
//
// Mirrors the client-side ring (apps/game/src/modules/Game.js → window
// .__voxelDebug.ring) so that a diagnostic harness can fetch both, line
// them up by `category + payload.id`, and check whether the server and
// client agree on what happened — and when.
//
// Categories are documented in tests/PROTOCOL_CONTRACT.md and must stay
// in sync with the client side.

const MAX_PER_ROOM = 500;

export interface DebugEvent {
  /** Milliseconds since epoch. */
  t: number;
  /** Short string id of the event. Keep stable across versions. */
  category: string;
  /** Arbitrary structured payload (must be JSON-serializable). */
  payload: Record<string, unknown>;
}

const buffers = new Map<string, DebugEvent[]>();

export function debugLog(
  roomCode: string | undefined | null,
  category: string,
  payload: Record<string, unknown> = {},
): void {
  if (!roomCode) return;
  let buf = buffers.get(roomCode);
  if (!buf) {
    buf = [];
    buffers.set(roomCode, buf);
  }
  buf.push({ t: Date.now(), category, payload });
  if (buf.length > MAX_PER_ROOM) buf.shift();
}

/** Read-only snapshot for the HTTP endpoint. */
export function getDebugLog(roomCode: string): DebugEvent[] {
  return buffers.get(roomCode)?.slice() ?? [];
}

/** Drop a room's buffer on dispose so old codes don't leak memory. */
export function clearDebugLog(roomCode: string): void {
  buffers.delete(roomCode);
}
