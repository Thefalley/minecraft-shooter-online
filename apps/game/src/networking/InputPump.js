// InputPump.js
//
// 20 Hz throttled input pump. The game loop pushes the latest input command
// every frame (60+ Hz) by calling pump.push(cmd). Internally we tick on a
// setInterval at INPUT_PUMP_INTERVAL_MS and forward the current command to
// the network if-and-only-if:
//   1. The command differs from the last one we sent (any field flipped, or
//      yaw/pitch drifted past the dead-zone), OR
//   2. More than 1000 ms have elapsed since the last send (keepalive — server
//      otherwise can't tell "still standing still" from "tab crashed").
//
// This is the exact same pattern proven out in apps/web's useInput hook; the
// payoff is ~70% fewer messages while the player is idle without sacrificing
// the server's liveness signal.

import { INPUT_PUMP_INTERVAL_MS } from "@mvp/shared";

const KEEPALIVE_MS = 1000;
const ANGULAR_EPSILON = 0.01;

export class InputPump {
  /**
   * @param {(cmd: object) => void} sendFn - Called with the throttled command.
   *   The bridge wires this to `room.send(VoxelClientMessage.Input, cmd)`.
   */
  constructor(sendFn) {
    this._send = sendFn;
    this._last = null;
    this._lastT = 0;
    this._seq = 0;
    this._currentCmd = null;
    this._interval = setInterval(
      () => this._tick(),
      INPUT_PUMP_INTERVAL_MS || 50,
    );
  }

  /**
   * Push the latest input state. Cheap — overwrites the pending command.
   * Pass null to clear (e.g. on disconnect/blur).
   */
  push(cmd) {
    this._currentCmd = cmd;
  }

  /** Stop the timer. Call on disconnect. Safe to call repeatedly. */
  destroy() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._currentCmd = null;
  }

  _tick() {
    const cmd = this._currentCmd;
    if (!cmd) return;

    const now = performance.now();
    const last = this._last;

    const same =
      last &&
      last.forward === cmd.forward &&
      last.backward === cmd.backward &&
      last.left === cmd.left &&
      last.right === cmd.right &&
      last.jump === cmd.jump &&
      last.sprint === cmd.sprint &&
      last.dash === cmd.dash &&
      last.attack === cmd.attack &&
      last.guard === cmd.guard &&
      last.reload === cmd.reload &&
      last.inventorySlot === cmd.inventorySlot &&
      Math.abs((last.rotationY ?? 0) - (cmd.rotationY ?? 0)) < ANGULAR_EPSILON &&
      Math.abs((last.pitch ?? 0) - (cmd.pitch ?? 0)) < ANGULAR_EPSILON;

    if (same && now - this._lastT < KEEPALIVE_MS) return;

    // CSP reconciliation needs the SAME seq the client recorded against its
    // ring buffer. Player.buildInputCommand() assigns cmd.seq from its own
    // monotonic counter — honor it. Only fall back to a pump-side seq if the
    // caller didn't bring one (e.g. a non-Voxel-Dragons sender).
    const payload =
      typeof cmd.seq === 'number' && Number.isFinite(cmd.seq)
        ? { ...cmd }
        : { ...cmd, seq: ++this._seq };
    try {
      this._send(payload);
    } catch {
      // The bridge may be mid-disconnect; swallow so the interval keeps running
      // and we don't burn CPU on a runaway exception loop.
      return;
    }
    this._last = payload;
    this._lastT = now;
  }
}
