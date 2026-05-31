/**
 * Raw Colyseus client helpers for headless multi-client tests.
 * Imports the colyseus.js bundle shipped with apps/game so the suite
 * does not require its own node_modules.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const colyseusEsmPath = path.resolve(
  __dirname,
  '../../apps/game/node_modules/colyseus.js/build/esm/index.mjs'
);
const colyseusEsmUrl = pathToFileURL(colyseusEsmPath).href;

let cachedClient = null;
async function loadColyseus() {
  if (cachedClient) return cachedClient;
  cachedClient = await import(colyseusEsmUrl);
  return cachedClient;
}

export async function createClient(url) {
  const { Client } = await loadColyseus();
  return new Client(url);
}

export async function createRoom(client, { name = 'Bot', characterId = 'duck' } = {}) {
  return await client.create('game', { name, characterId });
}

/**
 * Look up a room by its 5-char code via the HTTP endpoint exposed by the
 * server, then joinById. Mirrors what the game client does.
 */
export async function joinByCode(client, code, { name = 'Bot', characterId = 'mage' } = {}) {
  const s = client.settings;
  const httpBase = `${s.secure ? 'https' : 'http'}://${s.hostname}${s.port && s.port !== 80 && s.port !== 443 ? `:${s.port}` : ''}${s.pathname || ''}`;
  const res = await fetch(`${httpBase}/rooms/by-code/${code.toUpperCase()}`);
  if (!res.ok) {
    throw new Error(`join-by-code HTTP ${res.status}: ${await res.text()}`);
  }
  const { roomId } = await res.json();
  return await client.joinById(roomId, { name, characterId });
}

/** Helper to build the http base from a ws URL string. */
export function httpFromWs(wsUrl) {
  return wsUrl.replace(/^ws/, 'http');
}

/**
 * Resolve when predicate(room.state) returns truthy. Polls every 50ms.
 * Throws if timeoutMs elapses.
 */
export async function waitForState(room, predicate, { timeoutMs = 10000, label = 'state' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (predicate(room.state)) return Date.now() - start;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitForState(${label}) timeout after ${timeoutMs}ms`);
}

/**
 * Take a snapshot of a MapSchema/ArraySchema and project each entry through
 * `pick`. Returns a plain array, safe to JSON-stringify.
 */
export function snapshotMap(map, pick) {
  const out = [];
  map?.forEach((value, key) => out.push(pick(value, key)));
  return out;
}

/**
 * Best-effort cleanup. Use in finally{} blocks so a single hang does not
 * abandon socket connections (Render free tier is shared, be polite).
 */
export async function safeLeave(...rooms) {
  for (const r of rooms) {
    try {
      await r?.leave();
    } catch {}
  }
}
