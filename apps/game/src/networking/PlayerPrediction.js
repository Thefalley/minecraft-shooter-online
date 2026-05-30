// PlayerPrediction.js
//
// Thin orchestrator that wires a Player to a NetworkBridge so the game loop
// can call one method per frame and get the full Client-Side Prediction
// pipeline:
//
//   game loop ─▶ pred.tick(input, dt, world)
//                    │
//                    ├─▶ player.buildInputCommand(input, dt)   // decode raw input
//                    ├─▶ player.applyInput(cmd, dt, world)      // local prediction
//                    ├─▶ player.recordSnapshot(cmd)             // rewind buffer
//                    └─▶ bridge.pushInput(cmd)                  // → server
//
//   bridge ──"selfSnapshot"──▶ player.applyServerSnapshot(snap)
//                                  // reconcile + replay unacked cmds
//
// Why this lives outside Player.js:
//   - Player has no idea NetworkBridge exists. It exposes the CSP primitives
//     (buildInputCommand / applyInput / recordSnapshot / applyServerSnapshot)
//     and nothing else.
//   - Subscribing to "selfSnapshot" + cleaning up on disconnect is bridge
//     wiring, not movement math. Keeps Player free of import side effects.
//
// The orchestrator is intentionally tiny — it should never grow movement
// logic, only glue. New CSP behavior belongs in Player.

export class PlayerPrediction {
  /**
   * @param {object} player - A Player instance exposing the CSP API.
   * @param {object} bridge - A NetworkBridge-like object with .on() returning
   *   an unsubscribe function, and an optional .pushInput(cmd) sink.
   */
  constructor(player, bridge) {
    this.player = player;
    this.bridge = bridge;
    this._offSnapshot = null;
  }

  /**
   * Per-frame entry point. Build the cmd from raw input, predict locally,
   * record for rewind, and forward to the bridge for the server to ack.
   *
   * Safe to call whether or not enable() has been called yet — the predict +
   * record steps work standalone; only the snapshot reconciliation needs the
   * subscription.
   */
  tick(input, dt, world) {
    const player = this.player;
    if (!player) return;
    const cmd = player.buildInputCommand(input, dt);
    player.applyInput(cmd, dt, world);
    player.recordSnapshot(cmd);
    // Bridge may be absent in tests; pushInput may be missing if the bridge
    // is a stub. Tolerate both without throwing.
    if (this.bridge && typeof this.bridge.pushInput === 'function') {
      this.bridge.pushInput(cmd);
    }
  }

  /**
   * Subscribe to per-self snapshot events. Idempotent — calling enable()
   * twice keeps the original subscription instead of layering duplicates.
   */
  enable() {
    if (this._offSnapshot) return;
    if (!this.bridge || typeof this.bridge.on !== 'function') return;
    this._offSnapshot = this.bridge.on('selfSnapshot', (snap) => {
      this.player?.applyServerSnapshot(snap);
    });
  }

  /**
   * Unsubscribe and drop the local prediction rings. Safe to call when
   * never enabled — the unsubscribe is a no-op and clearPrediction() is
   * idempotent.
   */
  disable() {
    if (typeof this._offSnapshot === 'function') {
      try {
        this._offSnapshot();
      } catch {
        /* ignore — bridge may already be torn down */
      }
    }
    this._offSnapshot = null;
    this.player?.clearPrediction?.();
  }
}

export default PlayerPrediction;
