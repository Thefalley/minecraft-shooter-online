"use client";

import {
  PLAYER_SPAWN_Y,
  PLAYER_SPEED,
  WORLD_HALF_SIZE,
} from "@mvp/shared";

/**
 * Client-side prediction state for the LOCAL player only.
 *
 * The same movement formula as the server is applied at 60 Hz in the browser
 * so the local mesh responds to WASD with zero perceived latency. When the
 * authoritative snapshot arrives from the server we reconcile: small drifts
 * blend toward server, large divergence snaps. The server still owns the
 * truth — this is presentation only.
 */
export interface SelfPrediction {
  x: number;
  y: number;
  z: number;
  rotationY: number;
}

const state: SelfPrediction = {
  x: 0,
  y: PLAYER_SPAWN_Y,
  z: 0,
  rotationY: 0,
};

let initialized = false;

export function getPrediction(): SelfPrediction {
  return state;
}

export function isPredictionReady(): boolean {
  return initialized;
}

export function resetPrediction(): void {
  initialized = false;
  state.x = 0;
  state.y = PLAYER_SPAWN_Y;
  state.z = 0;
  state.rotationY = 0;
}

/** Pull predicted state back toward server snapshot. Snap when way off. */
export function reconcileWithSnapshot(snap: SelfPrediction): void {
  if (!initialized) {
    state.x = snap.x;
    state.y = snap.y;
    state.z = snap.z;
    state.rotationY = snap.rotationY;
    initialized = true;
    return;
  }
  const dx = snap.x - state.x;
  const dz = snap.z - state.z;
  const distSq = dx * dx + dz * dz;
  if (distSq > 2.25) {
    // Big disagreement (>1.5 units): server wins immediately.
    state.x = snap.x;
    state.z = snap.z;
  } else {
    // Small drift: blend gently so the player doesn't see jitter.
    state.x += dx * 0.15;
    state.z += dz * 0.15;
  }
  state.y = snap.y;
}

/** Apply local input for dt seconds (world-space, mirrors server math). */
export function applyLocalInput(
  input: {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    rotationY: number;
  },
  dt: number,
): void {
  if (!initialized) return;
  state.rotationY = input.rotationY;

  let mx = 0;
  let mz = 0;
  if (input.forward) mz -= 1;
  if (input.backward) mz += 1;
  if (input.left) mx -= 1;
  if (input.right) mx += 1;
  if (mx === 0 && mz === 0) return;

  const len = Math.hypot(mx, mz);
  mx /= len;
  mz /= len;

  const cos = Math.cos(input.rotationY);
  const sin = Math.sin(input.rotationY);
  const worldX = mx * cos - mz * sin;
  const worldZ = mx * sin + mz * cos;

  const dx = worldX * PLAYER_SPEED * dt;
  const dz = worldZ * PLAYER_SPEED * dt;

  state.x = Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, state.x + dx));
  state.z = Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, state.z + dz));
  state.y = PLAYER_SPAWN_Y;
}
