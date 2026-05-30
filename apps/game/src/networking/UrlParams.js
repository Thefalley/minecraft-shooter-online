// UrlParams.js
//
// Lightweight reader/writer for the lobby → game handoff. The web lobby (apps/web)
// redirects players into the standalone Vite game with query params like
//   /?name=Pab&code=AB12C&characterId=mage
// On boot, the game calls readJoinParams() and uses the result to drive
// NetworkBridge.connect(). When the result is mode === 'none' the game falls
// back to its own offline menu, so people who load the game directly still play.

import {
  PLAYER_NAME_MIN_LENGTH,
  PLAYER_NAME_MAX_LENGTH,
  ROOM_CODE_LENGTH,
} from "@mvp/shared";

// Must match CharacterId in packages/shared/src/types.ts and the CHARACTERS
// array in apps/game/src/modules/Characters.js.
const ALLOWED_CHARACTERS = new Set(["duck", "knight", "hunter", "samurai", "mage"]);

function safeUrl() {
  if (typeof window === "undefined") return null;
  try {
    return new URL(window.location.href);
  } catch {
    return null;
  }
}

function sanitizeName(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (
    trimmed.length < PLAYER_NAME_MIN_LENGTH ||
    trimmed.length > PLAYER_NAME_MAX_LENGTH
  ) {
    return null;
  }
  return trimmed;
}

function sanitizeCode(raw) {
  if (typeof raw !== "string") return null;
  const upper = raw.trim().toUpperCase();
  if (upper.length !== ROOM_CODE_LENGTH) return null;
  if (!/^[A-Z0-9]+$/.test(upper)) return null;
  return upper;
}

function sanitizeCharacter(raw) {
  if (typeof raw !== "string") return null;
  const lower = raw.trim().toLowerCase();
  if (!ALLOWED_CHARACTERS.has(lower)) return null;
  return lower;
}

/**
 * Reads ?name=&code=&characterId= from window.location.
 *
 * Returns a structured object even if everything is missing — callers should
 * branch on `mode`:
 *   - 'create' → spawn a fresh room (server picks the code)
 *   - 'join'   → join an existing code
 *   - 'none'   → no usable params, fall back to local menu
 */
export function readJoinParams() {
  const url = safeUrl();
  if (!url) {
    return { name: null, code: null, characterId: null, mode: "none" };
  }
  const params = url.searchParams;
  const name = sanitizeName(params.get("name"));
  const code = sanitizeCode(params.get("code"));
  const characterId = sanitizeCharacter(params.get("characterId"));
  // The web lobby also sends ?mode=create explicitly when the player clicked
  // "Create room". We honor it but only when name is valid.
  const declaredMode = (params.get("mode") || "").trim().toLowerCase();

  let mode = "none";
  if (name && code) {
    mode = "join";
  } else if (name && declaredMode === "create") {
    mode = "create";
  } else if (name && !code) {
    // Name without code = create a new room. Mirrors the lobby's default.
    mode = "create";
  }

  return { name, code, characterId, mode };
}

/**
 * Strips lobby-handoff params from the URL without forcing a reload. We keep
 * unrelated query params (analytics, debug flags, …) intact.
 */
export function clearJoinParams() {
  const url = safeUrl();
  if (!url) return;
  const toClear = ["name", "code", "characterId", "mode"];
  let mutated = false;
  for (const key of toClear) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      mutated = true;
    }
  }
  if (!mutated) return;
  try {
    const newUrl =
      url.pathname +
      (url.searchParams.toString() ? `?${url.searchParams.toString()}` : "") +
      url.hash;
    window.history.replaceState(null, "", newUrl);
  } catch {
    /* replaceState may throw in sandboxed iframes — ignore */
  }
}
