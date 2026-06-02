import * as THREE from 'three';
import { moveHorizontal, easeToGround } from '../engine/Collision.js';

const STEP_MAX = 1.1;       // blocks up to this height are climbable steps
const STEP_CLIMB_SPEED = 9; // blocks/sec eased when stepping up (stair feel)

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

const FORWARD = new THREE.Vector3();
const RIGHT = new THREE.Vector3();
const MOVE = new THREE.Vector3();

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

    // Check the leading edge (radius ahead) so the dash stops a body-width short
    // of the wall instead of burying the camera in it.
    const r = this.config.radius;
    const edgeX = nextX + this.dashDir.x * r;
    const edgeZ = nextZ + this.dashDir.z * r;
    if (this.isBlockedAt(world, edgeX, edgeZ)) {
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
    this.resolveVerticalCollision(world, delta);
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
    this.cameraHolder.position.set(x, y, z);
    return this;
  }

  /**
   * Soft CSP reconciliation. Called from MultiplayerCoordinator when the
   * server pushes a self-snapshot. Goal: keep client visual within ≤1 u of
   * the server's stored position WITHOUT teleporting the player on every
   * 50 ms sync. The server stores Y at PLAYER_SPAWN_Y (a flat 1.0) which is
   * usually below terrain, so we never override Y from the snapshot — local
   * gravity + collision owns vertical.
   *
   * Strategy (XZ only):
   *   drift = hypot(client.x - snap.x, client.z - snap.z)
   *   - drift ≤ 0.5 u     no-op (within input-pump tolerance)
   *   - drift ≤ 4 u       lerp 25 % toward server (smooth catch-up)
   *   - drift > 4 u       hard snap to server XZ (network glitch / lag spike)
   *
   * Without this, when the user moves fast or rotates while a frame stalls,
   * the input pump's 1 s keep-alive cadence can leave the server 1-3 u
   * behind the client's visual — every enemy then chases the SERVER ghost
   * and the user sees zombies converge on a point 2 m behind them.
   */
  applyServerSnapshot(snap) {
    if (!snap) return;
    const x = Number.isFinite(snap.x) ? snap.x : null;
    const z = Number.isFinite(snap.z) ? snap.z : null;
    if (x == null || z == null) return;
    const cp = this.cameraHolder.position;
    const dx = cp.x - x;
    const dz = cp.z - z;
    const drift = Math.hypot(dx, dz);
    if (drift <= 0.5) return;
    if (drift > 4) {
      cp.x = x;
      cp.z = z;
      return;
    }
    cp.x = cp.x + (x - cp.x) * 0.25;
    cp.z = cp.z + (z - cp.z) * 0.25;
  }

  /** No-op used by PlayerPrediction to clear its rewind buffers on disable. */
  clearPrediction() {
    /* nothing to clear in the upstream player */
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

  update(delta, input = {}, world = null) {
    if (!Number.isFinite(delta) || delta <= 0 || !this.isAlive) return;

    if (this.maxShield > 0 && this.shield < this.maxShield && !this.shieldRegenLocked) {
      this.shield = Math.min(
        this.maxShield,
        this.shield + this.maxShield * (this.shieldRegenPercent / 100) * delta,
      );
    }

    // While the movement basis is overridden (e.g. the hunter top-down view)
    // mouse-look is ignored so the screen-aligned directions stay stable.
    const lookLocked = this.movementYaw != null;
    const lookDelta = readLookDelta(input);
    if (!lookLocked && (lookDelta.x || lookDelta.y)) {
      this.look(lookDelta.x, lookDelta.y);
    }

    if (this.dashActive) {
      this.updateDash(delta, world);
      return;
    }

    const xAxis = readAxis(input, ['KeyD', 'd', 'right', 'moveRight'], ['KeyA', 'a', 'left', 'moveLeft']);
    const zAxis = readAxis(input, ['KeyW', 'w', 'forward', 'moveForward'], ['KeyS', 's', 'backward', 'moveBackward']);

    const moveYaw = this.movementYaw != null ? this.movementYaw : this.cameraHolder.rotation.y;
    FORWARD.set(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), moveYaw);
    RIGHT.set(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), moveYaw);
    MOVE.copy(FORWARD).multiplyScalar(zAxis).addScaledVector(RIGHT, xAxis);

    if (MOVE.lengthSq() > 0) {
      MOVE.normalize();
      this.lastMoveDir.copy(MOVE);
    } else {
      this.lastMoveDir.set(FORWARD.x, 0, FORWARD.z);
      if (this.lastMoveDir.lengthSq() > 0) this.lastMoveDir.normalize();
    }

    const sprinting = hasInput(input, ['ShiftLeft', 'ShiftRight', 'shift', 'sprint']);
    const speed = this.config.moveSpeed * (sprinting ? this.config.sprintMultiplier : 1);
    this.velocity.x = MOVE.x * speed;
    this.velocity.z = MOVE.z * speed;

    if (this.wallJumpCooldown > 0) this.wallJumpCooldown -= delta;
    const jumpHeld = hasInput(input, ['Space', ' ', 'space', 'jump']);
    if (jumpHeld) {
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

    this.velocity.y -= this.config.gravity * delta;

    // Horizontal: resolve against the player's radius so the body (and the
    // first-person camera at its centre) can never enter a block. Per-axis, so
    // you slide along walls; one-block steps are climbable (eased vertically).
    const pos = this.cameraHolder.position;
    const blocked = moveHorizontal(
      world, pos, this.velocity.x * delta, this.velocity.z * delta,
      this.config.radius, this.config.height, STEP_MAX,
    );
    if (blocked.x) this.velocity.x = 0;
    if (blocked.z) this.velocity.z = 0;

    // Vertical moves on its own so the step-up easing isn't fighting gravity.
    pos.y += this.velocity.y * delta;
    this.resolveVerticalCollision(world, delta);

    this.direction.copy(FORWARD);
  }

  resolveVerticalCollision(world, dt = 0) {
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
        const rise = groundTop - pos.y;
        // Walking onto a step (not falling): ease up gradually like stairs.
        // Landing from a fall, or a large correction: snap.
        if (this.velocity.y <= 0.0001 && rise <= STEP_MAX && dt > 0) {
          pos.y += Math.min(rise, STEP_CLIMB_SPEED * dt);
        } else {
          pos.y = groundTop;
        }
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
    this.health = Math.min(this.maxHealth, this.health + Math.max(0, amount));
    this.isAlive = this.health > 0;
    return this.health;
  }

  consumeAmmo(amount = 1) {
    if (this.ammo < amount) return false;
    this.ammo -= amount;
    return true;
  }

  reload(amount = this.maxAmmo) {
    this.ammo = THREE.MathUtils.clamp(amount, 0, this.maxAmmo);
    return this.ammo;
  }
}

export default Player;
