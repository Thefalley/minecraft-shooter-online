function isObject(value) {
  return value !== null && typeof value === 'object';
}

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function vectorState(vector) {
  if (!vector || !isFiniteNumber(vector.x) || !isFiniteNumber(vector.y) || !isFiniteNumber(vector.z)) {
    return null;
  }

  return {
    x: Number(vector.x.toFixed(3)),
    y: Number(vector.y.toFixed(3)),
    z: Number(vector.z.toFixed(3)),
  };
}

function hasMethod(target, name) {
  return typeof target?.[name] === 'function';
}

function safeCall(target, method, fallback = null) {
  if (!hasMethod(target, method)) return fallback;

  try {
    return target[method]();
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readCollectionSize(collection) {
  if (!collection) return 0;
  if (Array.isArray(collection)) return collection.length;
  if (collection instanceof Map || collection instanceof Set) return collection.size;
  if (typeof collection.length === 'number') return collection.length;
  return Object.keys(collection).length;
}

function readPlayerState(player) {
  const position = vectorState(player?.object?.position) ?? vectorState(player?.position);

  return {
    present: Boolean(player),
    position,
    health: player?.health ?? null,
    maxHealth: player?.maxHealth ?? null,
    isAlive: player?.isAlive ?? null,
    isGrounded: player?.isGrounded ?? null,
  };
}

function readWeaponState(weapons) {
  return {
    present: Boolean(weapons),
    currentWeapon: hasMethod(weapons, 'getCurrentWeaponName') ? safeCall(weapons, 'getCurrentWeaponName', '') : '',
    ammo: hasMethod(weapons, 'getAmmoState') ? safeCall(weapons, 'getAmmoState', null) : null,
    inventoryCount: readCollectionSize(weapons?.inventory),
    projectileCount: readCollectionSize(weapons?.projectiles),
  };
}

function readDragonState(dragons) {
  return {
    present: Boolean(dragons),
    alive: hasMethod(dragons, 'getAliveCount') ? safeCall(dragons, 'getAliveCount', null) : null,
    total: readCollectionSize(dragons?.dragons),
    fireballs: readCollectionSize(dragons?.fireballs),
    pendingImpacts: readCollectionSize(dragons?.impacts),
  };
}

function readWorldState(world) {
  return {
    present: Boolean(world),
    blocks: readCollectionSize(world?.blocks),
    meshes: readCollectionSize(world?.meshes),
    options: isObject(world?.options) ? { ...world.options } : null,
    spawnPoint: hasMethod(world, 'getSpawnPoint') ? vectorState(safeCall(world, 'getSpawnPoint', null)) : null,
  };
}

function readInputState(input) {
  const pointerLocked = hasMethod(input, 'isPointerLocked')
    ? safeCall(input, 'isPointerLocked', false)
    : input?.pointerLocked ?? false;

  return {
    present: Boolean(input),
    pointerLocked: Boolean(pointerLocked),
    keysDown: readCollectionSize(input?.keys),
    buttonsDown: readCollectionSize(input?.buttons),
    queuedActions: readCollectionSize(input?.actions),
    hasPointerLockRequest: hasMethod(input, 'lockPointer') || hasMethod(input, 'requestPointerLock'),
  };
}

function addCheck(checks, name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
}

export function collectGameState(game) {
  return {
    timestamp: new Date().toISOString(),
    present: Boolean(game),
    started: game?.started ?? null,
    paused: game?.paused ?? null,
    rootAttached: Boolean(game?.root),
    sceneChildren: readCollectionSize(game?.scene?.children),
    rendererCanvasAttached: Boolean(game?.renderer?.domElement?.parentNode),
    camera: {
      present: Boolean(game?.camera),
      position: vectorState(game?.camera?.position),
      aspect: game?.camera?.aspect ?? null,
    },
    player: readPlayerState(game?.player),
    weapons: readWeaponState(game?.weapons),
    dragons: readDragonState(game?.dragons),
    world: readWorldState(game?.world),
    input: readInputState(game?.input),
    effects: {
      present: Boolean(game?.effects),
    },
    audio: {
      present: Boolean(game?.audio),
    },
    hud: {
      present: Boolean(game?.hud),
    },
  };
}

export function basicSmokeCheck(game) {
  const state = collectGameState(game);
  const checks = [];

  addCheck(checks, 'game instance exists', state.present);
  addCheck(checks, 'renderer canvas is attached', state.rendererCanvasAttached);
  addCheck(checks, 'scene has children', state.sceneChildren > 0, `${state.sceneChildren} children`);
  addCheck(checks, 'camera exists', state.camera.present);
  addCheck(checks, 'player exists', state.player.present);
  addCheck(checks, 'player health is valid', isFiniteNumber(state.player.health) && state.player.health > 0);
  addCheck(checks, 'world exists', state.world.present);
  addCheck(checks, 'world has blocks', state.world.blocks > 0, `${state.world.blocks} blocks`);
  addCheck(checks, 'weapons exist', state.weapons.present);
  addCheck(checks, 'weapon inventory is populated', state.weapons.inventoryCount > 0);
  addCheck(checks, 'dragons manager exists', state.dragons.present);
  addCheck(checks, 'dragons are spawned', state.dragons.total > 0, `${state.dragons.total} total`);
  addCheck(checks, 'input exists', state.input.present);
  addCheck(checks, 'pointer lock can be requested', state.input.hasPointerLockRequest);

  const failed = checks.filter((check) => !check.ok);

  return {
    ok: failed.length === 0,
    checks,
    failed,
    state,
  };
}
