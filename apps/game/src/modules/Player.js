import * as THREE from 'three';

const DEFAULTS = {
  height: 1.75,
  radius: 0.35,
  moveSpeed: 7,
  sprintMultiplier: 1.5,
  jumpSpeed: 8,
  gravity: 24,
  groundY: 0,
  mouseSensitivity: 0.0022,
  maxHealth: 100,
  maxShield: 100,
  shieldRegenPercent: 2,
  ammo: 30,
  maxAmmo: 30,
};

// Client-Side Prediction ring buffer size. 60 entries @ 20 Hz = 3 seconds of
// rewindable history, which comfortably covers a worst-case RTT for replay.
const PREDICTION_BUFFER_SIZE = 60;

// If the local snapshot at snap.seq is within this many world-units of the
// server's, we blend gently instead of snapping (avoids visible teleports for
// trivial drift). Beyond this, we hard-snap to the server's values.
const RECONCILE_SOFT_THRESHOLD = 1.5;

// Per-call blend factor when soft-correcting. ~15% drains a 1u error to
// imperceptible in ~20 server ticks (~1s @ 20 Hz).
const RECONCILE_BLEND = 0.15;

const FORWARD = new THREE.Vector3();
const RIGHT = new THREE.Vector3();
const MOVE = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function hasInput(input, names) {
  if (!input) return false;

  const keys = input.keys || input.pressed || input.down;
  for (const name of names) {
    if (input[name]) return true;
    if (keys instanceof Set && keys.has(name)) return true;
    if (keys instanceof Map && keys.get(name)) return true;
    if (keys && keys[name]) return true;
  }

  return false;
}

function readAxis(input, positiveNames, negativeNames) {
  return Number(hasInput(input, positiveNames)) - Number(hasInput(input, negativeNames));
}

function readLookDelta(input) {
  if (!input) return { x: 0, y: 0 };

  if (input.mouseDelta) {
    return {
      x: input.mouseDelta.x || 0,
      y: input.mouseDelta.y || 0,
    };
  }

  if (input.mouse) {
    return {
      x: input.mouse.dx || 0,
      y: input.mouse.dy || 0,
    };
  }

  return {
    x: input.lookX || input.mouseX || input.deltaX || 0,
    y: input.lookY || input.mouseY || input.deltaY || 0,
  };
}

function readInventorySlot(input) {
  if (!input) return 0;
  if (Number.isFinite(input.inventorySlot)) return input.inventorySlot | 0;
  if (Number.isFinite(input.slot)) return input.slot | 0;
  // Probe Digit1..Digit9 for a pressed slot key.
  for (let i = 1; i <= 9; i += 1) {
    if (hasInput(input, [`Digit${i}`, `${i}`])) return i;
  }
  return 0;
}

function isSolidBlock(world, x, y, z) {
  if (typeof world?.getBlock !== 'function') return false;
  const type = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
  return Boolean(type) && type !== 'water';
}

function getGroundY(world, position, fallback) {
  if (!world) return fallback;
  if (typeof world.getGroundHeight === 'function') {
    return world.getGroundHeight(position.x, position.z);
  }
  if (typeof world.getFloorHeight === 'function') {
    return world.getFloorHeight(position.x, position.z);
  }
  if (Number.isFinite(world.groundY)) return world.groundY;
  if (Number.isFinite(world.floorY)) return world.floorY;
  return fallback;
}

export class Player {
  constructor(camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000), options = {}) {
    this.config = { ...DEFAULTS, ...options };
    this.camera = camera;

    this.cameraHolder = new THREE.Object3D();
    this.pitchHolder = new THREE.Object3D();
    this.cameraHolder.add(this.pitchHolder);
    this.pitchHolder.add(this.camera);

    // Eye height lives on the pitch pivot so the camera sits exactly at the
    // rotation center. Pitching then only turns the view (Minecraft-style)
    // instead of swinging the eye down into the floor blocks.
    this.pitchHolder.position.set(0, this.config.height, 0);
    this.camera.position.set(0, 0, 0);
    this.position = this.cameraHolder.position;
    this.velocity = new THREE.Vector3();
    this.direction = new THREE.Vector3();

    this.health = this.config.maxHealth;
    this.maxHealth = this.config.maxHealth;
    this.maxShield = this.config.maxShield;
    this.shield = this.config.maxShield;
    this.shieldRegenPercent = this.config.shieldRegenPercent;
    this.shieldRegenLocked = false; // disabled briefly after the mage nuke
    this.ammo = this.config.ammo;
    this.maxAmmo = this.config.maxAmmo;

    this.isGrounded = false;
    this.isAlive = true;
    this.wallJumpCooldown = 0;
    this.movementYaw = null; // when set, WASD uses this fixed yaw (top-down view)

    // Knight/Hunter parry guard (right click). While active, melee attackers
    // die and dragon fireballs are reflected back.
    this.guardActive = false;
    this.guardTimer = 0;

    // Temporary invulnerability (e.g. hunter aerial view).
    this.invulnerable = false;

    // Hunter dash state.
    this.lastMoveDir = new THREE.Vector3(0, 0, -1);
    this.dashDir = new THREE.Vector3();
    this.dashActive = false;
    this.dashRemaining = 0;
    this.dashSpeed = 0;

    // ── Client-Side Prediction state ───────────────────────────────────────
    //
    // networkAuthority === 'local' (default): legacy singleplayer path. The
    // update() loop reads input and drives the player directly.
    //
    // networkAuthority === 'server': the network layer pushes the local cmd
    // into applyInput() and feeds server snapshots into applyServerSnapshot().
    // update() becomes a no-op so a stray game-loop call can't double-step
    // the player out of phase with the server.
    this.networkAuthority = 'local';
    this._cmdSeq = 0;
    this._snapBuffer = new Array(PREDICTION_BUFFER_SIZE);
    this._snapHead = 0;
    this._recentCmds = new Array(PREDICTION_BUFFER_SIZE);
    this._cmdHead = 0;
    this._authorityWarned = new Set();
  }

  // ── Anti-cheat ───────────────────────────────────────────────────────────
  //
  // While networkAuthority === 'server' the local Player is purely a visual
  // proxy for what the server says. Any caller trying to mutate health/ammo/
  // position out of band is a bug at best and a cheat path at worst. We
  // no-op and warn once per method-name so logs stay clean.
  _denyMutationIfRemote(method) {
    if (this.networkAuthority !== 'server') return false;
    if (!this._authorityWarned.has(method)) {
      this._authorityWarned.add(method);
      // eslint-disable-next-line no-console
      console.warn(
        `[Player] ignoring ${method}() while networkAuthority === "server"; ` +
          'the server is authoritative.',
      );
    }
    return true;
  }

  startDash(distance, speed) {
    if (this.dashActive || !this.isAlive) return false;
    this.dashDir.copy(this.lastMoveDir);
    this.dashDir.y = 0;
    if (this.dashDir.lengthSq() < 0.0001) return false;
    this.dashDir.normalize();
    this.dashRemaining = distance;
    this.dashSpeed = speed;
    this.dashActive = true;
    return true;
  }

  updateDash(delta, world) {
    const step = Math.min(this.dashSpeed * delta, this.dashRemaining);
    const pos = this.cameraHolder.position;
    const nextX = pos.x + this.dashDir.x * step;
    const nextZ = pos.z + this.dashDir.z * step;

    if (this.isBlockedAt(world, nextX, nextZ)) {
      // Hit a block -> the dash stops here. Enemies are ignored (pass through).
      this.dashActive = false;
      this.dashRemaining = 0;
    } else {
      pos.x = nextX;
      pos.z = nextZ;
      this.dashRemaining -= step;
      if (this.dashRemaining <= 0) {
        this.dashActive = false;
        this.dashRemaining = 0;
      }
    }

    this.velocity.y = 0;
    this.resolveVerticalCollision(world);
  }

  isBlockedAt(world, x, z) {
    if (typeof world?.getBlock !== 'function') return false;
    const cx = Math.floor(x);
    const cz = Math.floor(z);
    const feet = Math.floor(this.cameraHolder.position.y + 0.1);
    const head = Math.floor(this.cameraHolder.position.y + this.config.height - 0.1);
    for (let y = feet; y <= head; y += 1) {
      if (isSolidBlock(world, cx, y, cz)) return true;
    }
    return false;
  }

  isTouchingWall(world) {
    if (typeof world?.getBlock !== 'function') return false;
    const pos = this.cameraHolder.position;
    return this.isBlockedAt(world, pos.x + 0.5, pos.z)
      || this.isBlockedAt(world, pos.x - 0.5, pos.z)
      || this.isBlockedAt(world, pos.x, pos.z + 0.5)
      || this.isBlockedAt(world, pos.x, pos.z - 0.5);
  }

  // Blocked only if a wall rises more than one block above the feet (a single
  // block is a climbable step).
  isClimbBlocked(world, x, z) {
    if (typeof world?.getBlock !== 'function') return false;
    const cx = Math.floor(x);
    const cz = Math.floor(z);
    const feetY = this.cameraHolder.position.y;
    const lowCell = Math.floor(feetY + 1.05); // first cell above the one-block step
    const highCell = Math.floor(feetY + this.config.height - 0.05);
    for (let y = lowCell; y <= highCell; y += 1) {
      if (isSolidBlock(world, cx, y, cz)) return true;
    }
    return false;
  }

  activateGuard(duration) {
    this.guardActive = true;
    this.guardTimer = Math.max(this.guardTimer, duration);
  }

  updateGuard(delta) {
    if (this.guardTimer > 0) {
      this.guardTimer -= delta;
      if (this.guardTimer <= 0) {
        this.guardTimer = 0;
        this.guardActive = false;
      }
    }
  }

  get object() {
    return this.cameraHolder;
  }

  setPosition(x, y, z) {
    if (this._denyMutationIfRemote('setPosition')) return this;
    this.cameraHolder.position.set(x, y, z);
    return this;
  }

  look(yawDelta, pitchDelta) {
    this.cameraHolder.rotation.y -= yawDelta * this.config.mouseSensitivity;
    this.pitchHolder.rotation.x -= pitchDelta * this.config.mouseSensitivity;
    this.pitchHolder.rotation.x = THREE.MathUtils.clamp(
      this.pitchHolder.rotation.x,
      -Math.PI / 2 + 0.01,
      Math.PI / 2 - 0.01,
    );
  }

  // ── Client-Side Prediction API ─────────────────────────────────────────
  //
  // Step 1: decode raw input into a self-contained command object that's
  // safe to push over the wire AND safe to replay locally after a server
  // reconciliation. The cmd is what InputPump expects to forward.
  buildInputCommand(input = {}, deltaSec = 0) {
    const forward = hasInput(input, ['KeyW', 'w', 'forward', 'moveForward']);
    const backward = hasInput(input, ['KeyS', 's', 'backward', 'moveBackward']);
    const left = hasInput(input, ['KeyA', 'a', 'left', 'moveLeft']);
    const right = hasInput(input, ['KeyD', 'd', 'right', 'moveRight']);
    const jump = hasInput(input, ['Space', ' ', 'space', 'jump']);
    const sprint = hasInput(input, ['ShiftLeft', 'ShiftRight', 'shift', 'sprint']);
    const dash = hasInput(input, ['dash', 'KeyQ', 'q']);
    const attack = hasInput(input, ['attack', 'fire', 'shoot', 'Mouse0', 'mouse0']);
    const guard = hasInput(input, ['guard', 'parry', 'Mouse2', 'mouse2']);
    const reload = hasInput(input, ['reload', 'KeyR', 'r']);

    return {
      forward,
      backward,
      left,
      right,
      jump,
      sprint,
      dash,
      attack,
      guard,
      reload,
      // Use the holders' current orientation as-of right now. In the local
      // path look() has already been applied for this tick, so this captures
      // the latest yaw/pitch for the server-side replay.
      rotationY: this.cameraHolder.rotation.y,
      pitch: this.pitchHolder.rotation.x,
      inventorySlot: readInventorySlot(input),
      seq: ++this._cmdSeq,
      // dt is informational — server uses its own clock. Useful for replay
      // when no explicit delta is passed.
      dt: deltaSec,
    };
  }

  // Step 2: apply a single decoded command. Pure with respect to (cmd, world)
  // — same math the legacy singleplayer update() used, just keyed off cmd
  // fields instead of querying input dictionaries. Used by:
  //   - the local path (singleplayer) once per frame, and
  //   - the rewind/replay path after applyServerSnapshot() rolls back state.
  applyInput(cmd, deltaSec, world = null) {
    if (!cmd) return;
    if (!Number.isFinite(deltaSec) || deltaSec <= 0 || !this.isAlive) return;

    // Mid-dash inputs are ignored — the dash plays out under its own logic
    // and the singleplayer update() already early-returns while dashing.
    if (this.dashActive) {
      this.updateDash(deltaSec, world);
      return;
    }

    const xAxis = (cmd.right ? 1 : 0) - (cmd.left ? 1 : 0);
    const zAxis = (cmd.forward ? 1 : 0) - (cmd.backward ? 1 : 0);

    // When the cmd carries an explicit rotationY (network replay), use it so
    // the replay reproduces the same lateral basis the original tick used.
    // Otherwise fall back to whatever the cameraHolder currently shows
    // (matches the legacy local behavior bit-for-bit).
    const cameraYaw = Number.isFinite(cmd.rotationY)
      ? cmd.rotationY
      : this.cameraHolder.rotation.y;
    const moveYaw = this.movementYaw != null ? this.movementYaw : cameraYaw;

    FORWARD.set(0, 0, -1).applyAxisAngle(Y_AXIS, moveYaw);
    RIGHT.set(1, 0, 0).applyAxisAngle(Y_AXIS, moveYaw);
    MOVE.copy(FORWARD).multiplyScalar(zAxis).addScaledVector(RIGHT, xAxis);

    if (MOVE.lengthSq() > 0) {
      MOVE.normalize();
      this.lastMoveDir.copy(MOVE);
    } else {
      this.lastMoveDir.set(FORWARD.x, 0, FORWARD.z);
      if (this.lastMoveDir.lengthSq() > 0) this.lastMoveDir.normalize();
    }

    const speed = this.config.moveSpeed * (cmd.sprint ? this.config.sprintMultiplier : 1);
    this.velocity.x = MOVE.x * speed;
    this.velocity.z = MOVE.z * speed;

    if (this.wallJumpCooldown > 0) this.wallJumpCooldown -= deltaSec;
    if (cmd.jump) {
      if (this.isGrounded) {
        this.velocity.y = this.config.jumpSpeed;
        this.isGrounded = false;
        this.wallJumpCooldown = 0.35;
      } else if (this.wallJumpCooldown <= 0 && this.isTouchingWall(world)) {
        // Wall jump: kick off a wall to climb out of pits/lakes.
        this.velocity.y = this.config.jumpSpeed;
        this.wallJumpCooldown = 0.35;
      }
    }

    this.velocity.y -= this.config.gravity * deltaSec;

    // Walls taller than one block stop horizontal movement (a single-block
    // step is allowed and is climbed by the vertical resolve). Per-axis so
    // you can still slide along a wall.
    const pos = this.cameraHolder.position;
    if (this.velocity.x !== 0 && this.isClimbBlocked(world, pos.x + this.velocity.x * deltaSec, pos.z)) {
      this.velocity.x = 0;
    }
    if (this.velocity.z !== 0 && this.isClimbBlocked(world, pos.x, pos.z + this.velocity.z * deltaSec)) {
      this.velocity.z = 0;
    }

    pos.addScaledVector(this.velocity, deltaSec);

    this.resolveVerticalCollision(world);

    this.direction.copy(FORWARD);
  }

  // Step 3: push a post-step transform into the ring so applyServerSnapshot()
  // can find it again by seq when reconciliation arrives.
  recordSnapshot(cmd) {
    if (!cmd || !Number.isFinite(cmd.seq)) return;
    const pos = this.cameraHolder.position;
    const entry = {
      seq: cmd.seq,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      vx: this.velocity.x,
      vy: this.velocity.y,
      vz: this.velocity.z,
      rotationY: this.cameraHolder.rotation.y,
      pitch: this.pitchHolder.rotation.x,
      isGrounded: this.isGrounded,
      wallJumpCooldown: this.wallJumpCooldown,
      dashRemaining: this.dashRemaining,
    };
    this._snapBuffer[this._snapHead] = entry;
    this._recentCmds[this._cmdHead] = cmd;
    this._snapHead = (this._snapHead + 1) % PREDICTION_BUFFER_SIZE;
    this._cmdHead = (this._cmdHead + 1) % PREDICTION_BUFFER_SIZE;
  }

  // Step 4: server delivered ground truth for snap.seq. Reconcile by:
  //   1. Looking up our local prediction at that seq.
  //   2. If divergence > soft threshold OR we can't find a matching seq,
  //      hard-snap to the server's transform.
  //   3. Otherwise gently blend toward the server's transform.
  //   4. Replay every cmd we issued AFTER snap.seq so the latest local
  //      transform incorporates the server correction plus the inputs that
  //      were still in-flight when the snapshot was captured.
  applyServerSnapshot(snap) {
    if (!snap || !Number.isFinite(snap.seq)) return;

    const localSnap = this._findSnapshot(snap.seq);
    const pos = this.cameraHolder.position;

    let divergence = Infinity;
    if (localSnap) {
      const dx = pos.x - snap.x;
      const dy = pos.y - snap.y;
      const dz = pos.z - snap.z;
      divergence = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    if (!localSnap || divergence > RECONCILE_SOFT_THRESHOLD) {
      // Hard snap — we drifted too far, or the server reported a seq we
      // already evicted from the ring.
      pos.set(snap.x, snap.y, snap.z);
      this.velocity.set(snap.vx ?? 0, snap.vy ?? 0, snap.vz ?? 0);
      if (Number.isFinite(snap.rotationY)) {
        this.cameraHolder.rotation.y = snap.rotationY;
      }
      if (Number.isFinite(snap.pitch)) {
        this.pitchHolder.rotation.x = snap.pitch;
      }
      if (typeof snap.grounded === 'boolean') this.isGrounded = snap.grounded;
      if (Number.isFinite(snap.wallJumpCooldown)) {
        this.wallJumpCooldown = snap.wallJumpCooldown;
      }
      if (Number.isFinite(snap.dashRemaining)) {
        this.dashRemaining = snap.dashRemaining;
        this.dashActive = snap.dashRemaining > 0;
      }
    } else {
      // Soft correction — blend a fraction of the error each call.
      pos.x += (snap.x - pos.x) * RECONCILE_BLEND;
      pos.y += (snap.y - pos.y) * RECONCILE_BLEND;
      pos.z += (snap.z - pos.z) * RECONCILE_BLEND;
      // Velocity tracks the server exactly so future ticks predict from the
      // corrected basis; blending velocity adds compounded drift.
      this.velocity.set(snap.vx ?? this.velocity.x, snap.vy ?? this.velocity.y, snap.vz ?? this.velocity.z);
      if (typeof snap.grounded === 'boolean') this.isGrounded = snap.grounded;
      if (Number.isFinite(snap.wallJumpCooldown)) {
        this.wallJumpCooldown = snap.wallJumpCooldown;
      }
      if (Number.isFinite(snap.dashRemaining)) {
        this.dashRemaining = snap.dashRemaining;
        this.dashActive = snap.dashRemaining > 0;
      }
    }

    // Replay unacked cmds (seq > snap.seq). The ring is small (≤60) so the
    // worst-case cost is bounded — we don't allocate.
    const unacked = this._collectUnackedCmds(snap.seq);
    if (unacked.length === 0) return;

    // We're temporarily rewriting the same snapshot ring while replaying.
    // Drop the entries we're about to invalidate first so recordSnapshot
    // overwrites cleanly; replays use the same cmd.seq.
    for (const cmd of unacked) {
      const dt = Number.isFinite(cmd.dt) && cmd.dt > 0 ? cmd.dt : 1 / 60;
      // applyInput touches the same private state (velocity, position) we
      // just reconciled — exactly what we want.
      this.applyInput(cmd, dt, snap.world ?? null);
      this._overwriteSnapshot(cmd);
    }
  }

  // Internal: scan ring for the entry matching seq. Returns null if it's
  // already been evicted (older than 60 ticks behind the head).
  _findSnapshot(seq) {
    for (let i = 0; i < PREDICTION_BUFFER_SIZE; i += 1) {
      const entry = this._snapBuffer[i];
      if (entry && entry.seq === seq) return entry;
    }
    return null;
  }

  // Internal: collect cmds with seq > ackedSeq in seq-ascending order so
  // replay applies them oldest-first.
  _collectUnackedCmds(ackedSeq) {
    const out = [];
    for (let i = 0; i < PREDICTION_BUFFER_SIZE; i += 1) {
      const cmd = this._recentCmds[i];
      if (cmd && cmd.seq > ackedSeq) out.push(cmd);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  // Internal: replace the snapshot in the ring matching cmd.seq with the
  // current transform. Used during replay so subsequent snapshots find the
  // post-correction values, not the pre-correction predictions.
  _overwriteSnapshot(cmd) {
    if (!cmd || !Number.isFinite(cmd.seq)) return;
    for (let i = 0; i < PREDICTION_BUFFER_SIZE; i += 1) {
      const entry = this._snapBuffer[i];
      if (entry && entry.seq === cmd.seq) {
        const pos = this.cameraHolder.position;
        entry.x = pos.x;
        entry.y = pos.y;
        entry.z = pos.z;
        entry.vx = this.velocity.x;
        entry.vy = this.velocity.y;
        entry.vz = this.velocity.z;
        entry.rotationY = this.cameraHolder.rotation.y;
        entry.pitch = this.pitchHolder.rotation.x;
        entry.isGrounded = this.isGrounded;
        entry.wallJumpCooldown = this.wallJumpCooldown;
        entry.dashRemaining = this.dashRemaining;
        return;
      }
    }
  }

  // Step 5: drop everything. Called on disconnect or when authority flips
  // back to 'local' so a stale snapshot can't reconcile against future
  // singleplayer history.
  clearPrediction() {
    this._snapBuffer = new Array(PREDICTION_BUFFER_SIZE);
    this._snapHead = 0;
    this._recentCmds = new Array(PREDICTION_BUFFER_SIZE);
    this._cmdHead = 0;
    this._cmdSeq = 0;
    this._authorityWarned.clear();
  }

  update(delta, input = {}, world = null) {
    if (!Number.isFinite(delta) || delta <= 0 || !this.isAlive) return;

    // Mouse-look runs ALWAYS, even under networkAuthority === 'server'.
    // Rotating the camera is presentation-only and the local player needs
    // to be able to aim regardless of who owns movement. Without this,
    // multiplayer made the camera frozen because the early-return below
    // bypassed look() too.
    const lookLocked = this.movementYaw != null;
    const lookDelta = readLookDelta(input);
    if (!lookLocked && (lookDelta.x || lookDelta.y)) {
      this.look(lookDelta.x, lookDelta.y);
    }

    // Server-authoritative mode: Game.js drives buildInputCommand / applyInput
    // / recordSnapshot directly so the CSP path runs there. Nothing else to do
    // here besides the look() that already happened above.
    if (this.networkAuthority === 'server') return;

    if (this.maxShield > 0 && this.shield < this.maxShield && !this.shieldRegenLocked) {
      this.shield = Math.min(
        this.maxShield,
        this.shield + this.maxShield * (this.shieldRegenPercent / 100) * delta,
      );
    }

    // Build the cmd AFTER look() so rotationY/pitch reflect this tick's look.
    const cmd = this.buildInputCommand(input, delta);
    this.applyInput(cmd, delta, world);
    this.recordSnapshot(cmd);
  }

  resolveVerticalCollision(world) {
    const pos = this.cameraHolder.position;
    const headHeight = this.config.height;

    // Voxel-aware path: resolve against the actual blocks in the player's
    // column so floating blocks above never snap us up, and a ceiling stops
    // an upward jump instead of teleporting us on top of the block.
    if (typeof world?.getBlock === 'function') {
      const cx = Math.floor(pos.x);
      const cz = Math.floor(pos.z);

      // Ceiling: heading up into a solid block -> stop just below it.
      if (this.velocity.y > 0) {
        const headCell = Math.floor(pos.y + headHeight);
        if (isSolidBlock(world, cx, headCell, cz)) {
          pos.y = headCell - headHeight - 0.001;
          this.velocity.y = 0;
        }
      }

      // Ground: highest solid block at or below the feet.
      let groundTop = null;
      for (let y = Math.floor(pos.y + 0.05); y >= -4; y -= 1) {
        if (isSolidBlock(world, cx, y, cz)) {
          groundTop = y + 1;
          break;
        }
      }

      if (groundTop !== null && pos.y <= groundTop) {
        pos.y = groundTop;
        this.velocity.y = Math.max(0, this.velocity.y);
        this.isGrounded = true;
      } else {
        this.isGrounded = false;
      }
      return;
    }

    // Fallback for environments without a voxel API (e.g. unit tests).
    const groundY = getGroundY(world, pos, this.config.groundY);
    if (pos.y <= groundY) {
      pos.y = groundY;
      this.velocity.y = Math.max(0, this.velocity.y);
      this.isGrounded = true;
    } else {
      this.isGrounded = false;
    }
  }

  damage(amount) {
    if (this._denyMutationIfRemote('damage')) return this.health;
    if (this.invulnerable) return this.health;
    let remaining = Math.max(0, amount);

    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield -= absorbed;
      remaining -= absorbed;
    }

    this.health = Math.max(0, this.health - remaining);
    this.isAlive = this.health > 0;
    return this.health;
  }

  revive() {
    if (this._denyMutationIfRemote('revive')) return this;
    this.health = this.maxHealth;
    this.shield = this.maxShield;
    this.isAlive = true;
    this.guardActive = false;
    this.guardTimer = 0;
    this.dashActive = false;
    this.dashRemaining = 0;
    this.invulnerable = false;
    this.velocity.set(0, 0, 0);
    return this;
  }

  heal(amount) {
    if (this._denyMutationIfRemote('heal')) return this.health;
    this.health = Math.min(this.maxHealth, this.health + Math.max(0, amount));
    this.isAlive = this.health > 0;
    return this.health;
  }

  consumeAmmo(amount = 1) {
    if (this._denyMutationIfRemote('consumeAmmo')) return false;
    if (this.ammo < amount) return false;
    this.ammo -= amount;
    return true;
  }

  reload(amount = this.maxAmmo) {
    if (this._denyMutationIfRemote('reload')) return this.ammo;
    this.ammo = THREE.MathUtils.clamp(amount, 0, this.maxAmmo);
    return this.ammo;
  }
}

export default Player;
