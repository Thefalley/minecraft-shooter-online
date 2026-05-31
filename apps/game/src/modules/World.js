import * as THREE from 'three';
import { createBlockMaterials } from './BlockTextures.js';

const BLOCK_SIZE = 1;
const DEFAULT_OPTIONS = {
  width: 48,
  depth: 48,
  maxHeight: 20,
  waterLevel: 6,
  seed: 1337,
};

const BLOCK_TYPES = Object.freeze({
  grass: {
    color: 0x58a548,
    roughness: 0.9,
    metalness: 0,
  },
  dirt: {
    color: 0x8b5a2b,
    roughness: 1,
    metalness: 0,
  },
  stone: {
    color: 0x7b7f86,
    roughness: 0.95,
    metalness: 0,
  },
  sand: {
    color: 0xd8c477,
    roughness: 1,
    metalness: 0,
  },
  wood: {
    color: 0x8a5a32,
    roughness: 0.9,
    metalness: 0,
  },
  leaves: {
    color: 0x2f7d32,
    roughness: 1,
    metalness: 0,
  },
  water: {
    color: 0x2f8ed8,
    roughness: 0.45,
    metalness: 0,
    transparent: true,
    opacity: 0.62,
  },
});

const VALID_TYPES = new Set(Object.keys(BLOCK_TYPES));
const NEIGHBOR_OFFSETS = Object.freeze([
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
]);

// Module-scope scratch objects reused across hot paths so we never allocate
// inside a per-frame or per-mutation loop. NEVER hold references to these from
// outside their immediate use site.
const _SCRATCH_M4 = new THREE.Matrix4();
const _RAY_NORMAL = new THREE.Vector3();
const _RAY_PREV = new THREE.Vector3();
const _RAY_DIR = new THREE.Vector3();

// Headroom past the bulk-generated instance count, so the player can place a
// few thousand blocks of any single type before we need to grow the mesh.
const INSTANCE_HEADROOM = 4096;

function blockKey(x, y, z) {
  return `${x},${y},${z}`;
}

function parseBlockKey(key) {
  return key.split(',').map(Number);
}

function fade(t) {
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function hash2D(x, z, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(seed, 1442695041);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise2D(x, z, seed, scale) {
  const sx = x / scale;
  const sz = z / scale;
  const x0 = Math.floor(sx);
  const z0 = Math.floor(sz);
  const tx = fade(sx - x0);
  const tz = fade(sz - z0);

  const a = hash2D(x0, z0, seed);
  const b = hash2D(x0 + 1, z0, seed);
  const c = hash2D(x0, z0 + 1, seed);
  const d = hash2D(x0 + 1, z0 + 1, seed);

  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

export class World extends THREE.Group {
  constructor(options = {}) {
    super();

    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.blocks = new Map();
    this.meshes = new Map();
    // Incremental-update bookkeeping. Populated by both bulk and per-mutation
    // paths; both must keep them in sync with the InstancedMesh state.
    //   instanceIndexByKey: Map<key, { type, index }>
    //     Where the matrix for this block lives. Removed when the block is
    //     either deleted or hidden by neighbor occlusion.
    //   instanceKeyByPair:  Map<type, Array<key>>
    //     Reverse lookup so swap-pop on remove can update the displaced
    //     block's entry in instanceIndexByKey.
    this.instanceIndexByKey = new Map();
    this.instanceKeyByPair = new Map();
    this.time = 0;

    this.geometry = new THREE.BoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
    // Flat quad used for the water surface so adjacent water tiles merge into a
    // single seamless sheet instead of showing per-cube edges.
    this.waterGeometry = new THREE.PlaneGeometry(BLOCK_SIZE, BLOCK_SIZE);
    this.waterGeometry.rotateX(-Math.PI / 2);
    // Minecraft-style procedural pixel textures (grass uses a 6-face array).
    this.materials = createBlockMaterials(BLOCK_TYPES);

    this.generate();
  }

  // Rebuild the world from an authoritative seed + dimensions. Used by the
  // multiplayer WorldSync handshake: the server publishes its seed on join
  // and the client must regenerate the procedural base identically before
  // replaying the cumulative delta list. Pure additive — singleplayer never
  // calls this.
  regenerateFromSeed({ seed, width, depth, maxHeight, waterLevel } = {}) {
    if (Number.isFinite(seed)) this.options.seed = seed;
    if (Number.isFinite(width)) this.options.width = width;
    if (Number.isFinite(depth)) this.options.depth = depth;
    if (Number.isFinite(maxHeight)) this.options.maxHeight = maxHeight;
    if (Number.isFinite(waterLevel)) this.options.waterLevel = waterLevel;

    // generate() already clears meshes + blocks + instance indices before
    // running the procedural pass, so we can just delegate.
    this.flatTop = null;
    this.generate();
  }

  generate() {
    this.clearMeshes();
    this.blocks.clear();

    const { width, depth, maxHeight, waterLevel, seed } = this.options;
    const halfWidth = Math.floor(width / 2);
    const halfDepth = Math.floor(depth / 2);

    for (let x = -halfWidth; x < width - halfWidth; x += 1) {
      for (let z = -halfDepth; z < depth - halfDepth; z += 1) {
        const broad = valueNoise2D(x, z, seed, 18);
        const detail = valueNoise2D(x + 91, z - 47, seed + 19, 7);
        // Rolling hills kept above the water line, so there is no ocean.
        const height = Math.max(
          waterLevel + 1,
          Math.min(maxHeight - 2, Math.floor(waterLevel + 2 + (broad - 0.5) * 6 + (detail - 0.5) * 3)),
        );

        for (let y = 0; y <= height; y += 1) {
          let type = 'stone';
          if (y === height && height <= waterLevel + 1) {
            type = 'sand';
          } else if (y === height && height >= waterLevel) {
            type = 'grass';
          } else if (y >= height - 3) {
            type = 'dirt';
          }
          this.setBlock(x, y, z, type, false);
        }

        for (let y = height + 1; y <= waterLevel; y += 1) {
          this.setBlock(x, y, z, 'water', false);
        }
      }
    }

    this.generateTrees();
    this.buildLandmarks();
    this.rebuildMeshesFullBulk();
    this.populateInstanceIndexAfterBulk();
  }

  generateFlat(top = 5) {
    this.clearMeshes();
    this.blocks.clear();
    this.flatTop = top;

    const { width, depth } = this.options;
    const halfWidth = Math.floor(width / 2);
    const halfDepth = Math.floor(depth / 2);

    for (let x = -halfWidth; x < width - halfWidth; x += 1) {
      for (let z = -halfDepth; z < depth - halfDepth; z += 1) {
        for (let y = 0; y <= top; y += 1) {
          let type = 'stone';
          if (y === top) type = 'grass';
          else if (y >= top - 2) type = 'dirt';
          this.setBlock(x, y, z, type, false);
        }
      }
    }

    this.rebuildMeshesFullBulk();
    this.populateInstanceIndexAfterBulk();
  }

  generateTrees() {
    const { width, depth, seed, waterLevel } = this.options;
    const halfWidth = Math.floor(width / 2);
    const halfDepth = Math.floor(depth / 2);

    for (let x = -halfWidth + 3; x < width - halfWidth - 3; x += 1) {
      for (let z = -halfDepth + 3; z < depth - halfDepth - 3; z += 1) {
        if (hash2D(x * 3, z * 3, seed + 91) > 0.985) {
          const y = this.getSurfaceY(x, z);
          if (y === null || y < waterLevel || this.getBlock(x, y, z) !== 'grass') continue;
          this.plantTree(x, y, z);
        }
      }
    }
  }

  plantTree(x, baseY, z) {
    for (let trunk = 1; trunk <= 4; trunk += 1) {
      this.setBlock(x, baseY + trunk, z, 'wood', false);
    }
    for (let lx = -2; lx <= 2; lx += 1) {
      for (let ly = 3; ly <= 5; ly += 1) {
        for (let lz = -2; lz <= 2; lz += 1) {
          if (Math.abs(lx) + Math.abs(lz) + Math.max(0, ly - 4) <= 4) {
            this.setBlock(x + lx, baseY + ly, z + lz, 'leaves', false);
          }
        }
      }
    }
  }

  clearColumn(x, z) {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    for (let y = 0; y < this.options.maxHeight; y += 1) {
      this.blocks.delete(blockKey(ix, y, iz));
    }
  }

  buildLandmarks() {
    const { waterLevel } = this.options;
    const plateauTop = waterLevel + 2;
    const plateauRadius = 15;
    const castleHalf = 8;
    const lake = { x: 12, z: 12, radius: 4 };

    // Flat grass plateau for the castle (no moat).
    for (let x = -plateauRadius - 1; x <= plateauRadius + 1; x += 1) {
      for (let z = -plateauRadius - 1; z <= plateauRadius + 1; z += 1) {
        if (Math.hypot(x, z) > plateauRadius) continue;
        this.clearColumn(x, z);
        for (let y = 0; y <= plateauTop; y += 1) {
          let type = 'stone';
          if (y === plateauTop) type = 'grass';
          else if (y >= plateauTop - 2) type = 'dirt';
          this.setBlock(x, y, z, type, false);
        }
      }
    }

    // A single small lake tucked into a corner beside the castle.
    const bed = waterLevel - 2;
    for (let x = lake.x - lake.radius - 1; x <= lake.x + lake.radius + 1; x += 1) {
      for (let z = lake.z - lake.radius - 1; z <= lake.z + lake.radius + 1; z += 1) {
        if (Math.hypot(x - lake.x, z - lake.z) > lake.radius) continue;
        this.clearColumn(x, z);
        for (let y = 0; y <= bed; y += 1) {
          this.setBlock(x, y, z, y >= bed - 1 ? 'sand' : 'stone', false);
        }
        for (let y = bed + 1; y <= waterLevel; y += 1) {
          this.setBlock(x, y, z, 'water', false);
        }
      }
    }

    this.buildCastle(castleHalf, plateauTop);
    this.buildForest();
  }

  buildCastle(half, base) {
    const wallHeight = 5;
    const towerHeight = 8;

    // Outer walls with a south gate gap and battlements.
    for (let x = -half; x <= half; x += 1) {
      for (let z = -half; z <= half; z += 1) {
        const onPerimeter = Math.abs(x) === half || Math.abs(z) === half;
        if (!onPerimeter) continue;
        if (z === half && Math.abs(x) <= 1) continue; // gate
        for (let h = 1; h <= wallHeight; h += 1) {
          if (h === wallHeight && ((x + z) & 1) === 1) continue; // crenellations
          this.setBlock(x, base + h, z, 'stone', false);
        }
      }
    }

    // Taller 3x3 corner towers.
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = sx * half;
      const cz = sz * half;
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const ring = Math.abs(dx) === 1 || Math.abs(dz) === 1;
          for (let h = 1; h <= towerHeight; h += 1) {
            if (!ring && h < towerHeight) continue; // hollow inside
            if (h === towerHeight && ((dx + dz) & 1) === 1) continue;
            this.setBlock(cx + dx, base + h, cz + dz, 'stone', false);
          }
        }
      }
    }
  }

  buildForest() {
    const { width, depth, waterLevel, seed } = this.options;
    const centerX = -Math.floor(width / 4);
    const centerZ = Math.floor(depth / 4);

    for (let x = centerX - 7; x <= centerX + 7; x += 1) {
      for (let z = centerZ - 7; z <= centerZ + 7; z += 1) {
        if (hash2D(x * 7, z * 7, seed + 313) > 0.76) {
          const y = this.getSurfaceY(x, z);
          if (y === null || y < waterLevel || this.getBlock(x, y, z) !== 'grass') continue;
          this.plantTree(x, y, z);
        }
      }
    }
  }

  getSpawnPoint() {
    const { width, depth, waterLevel } = this.options;
    const searchRadius = Math.floor(Math.min(width, depth) / 2);

    let best = null;
    for (let radius = 0; radius <= searchRadius; radius += 1) {
      for (let x = -radius; x <= radius; x += 1) {
        for (let z = -radius; z <= radius; z += 1) {
          if (Math.abs(x) !== radius && Math.abs(z) !== radius) continue;

          const y = this.getSurfaceY(x, z);
          if (y !== null && y >= waterLevel && this.getBlock(x, y, z) === 'grass') {
            best = new THREE.Vector3(x + 0.5, y + 2.2, z + 0.5);
            return best;
          }
        }
      }
    }

    const fallbackY = this.getSurfaceY(0, 0) ?? waterLevel;
    return new THREE.Vector3(0.5, fallbackY + 2.2, 0.5);
  }

  raycastBlock(origin, direction, maxDistance = 6) {
    const rayOrigin = origin instanceof THREE.Vector3 ? origin : new THREE.Vector3(origin.x, origin.y, origin.z);
    // Use a module-scope scratch for the normalized direction inside the loop;
    // callers do not retain references to it. We still respect the caller's
    // direction Vector3 (we copy from it, never mutate it).
    _RAY_DIR.set(direction.x, direction.y, direction.z);

    if (_RAY_DIR.lengthSq() === 0 || maxDistance <= 0) return null;
    _RAY_DIR.normalize();

    let x = Math.floor(rayOrigin.x);
    let y = Math.floor(rayOrigin.y);
    let z = Math.floor(rayOrigin.z);

    const stepX = Math.sign(_RAY_DIR.x);
    const stepY = Math.sign(_RAY_DIR.y);
    const stepZ = Math.sign(_RAY_DIR.z);

    const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / _RAY_DIR.x);
    const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / _RAY_DIR.y);
    const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / _RAY_DIR.z);

    let tMaxX = this.nextBoundaryDistance(rayOrigin.x, _RAY_DIR.x, x);
    let tMaxY = this.nextBoundaryDistance(rayOrigin.y, _RAY_DIR.y, y);
    let tMaxZ = this.nextBoundaryDistance(rayOrigin.z, _RAY_DIR.z, z);
    let distance = 0;
    _RAY_NORMAL.set(0, 0, 0);
    _RAY_PREV.set(x, y, z);

    while (distance <= maxDistance) {
      const type = this.getBlock(x, y, z);
      if (type) {
        // Callers can hold the returned vectors past the call (e.g. they read
        // hit.position later in the same frame), so we DO allocate fresh
        // Vector3s here. Only the in-loop scratches are reused.
        const position = new THREE.Vector3(x, y, z);
        const point = rayOrigin.clone().addScaledVector(_RAY_DIR, Math.max(0, distance));
        return {
          position,
          normal: _RAY_NORMAL.clone(),
          previous: _RAY_PREV.clone(),
          point,
          distance,
          type,
        };
      }

      _RAY_PREV.set(x, y, z);
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        x += stepX;
        distance = tMaxX;
        tMaxX += tDeltaX;
        _RAY_NORMAL.set(-stepX, 0, 0);
      } else if (tMaxY <= tMaxZ) {
        y += stepY;
        distance = tMaxY;
        tMaxY += tDeltaY;
        _RAY_NORMAL.set(0, -stepY, 0);
      } else {
        z += stepZ;
        distance = tMaxZ;
        tMaxZ += tDeltaZ;
        _RAY_NORMAL.set(0, 0, -stepZ);
      }
    }

    return null;
  }

  removeBlock(hit) {
    if (!hit?.position) return false;
    const { x, y, z } = hit.position;
    return this.setBlock(x, y, z, null);
  }

  addBlock(hit, type = 'dirt') {
    if (!hit?.position || !VALID_TYPES.has(type)) return false;

    // Aiming directly at water fills that cell (you can build in water).
    if (hit.type === 'water') {
      return this.setBlock(hit.position.x, hit.position.y, hit.position.z, type);
    }

    const normal = hit.normal ?? new THREE.Vector3(0, 1, 0);
    const x = Math.floor(hit.position.x + normal.x);
    const y = Math.floor(hit.position.y + normal.y);
    const z = Math.floor(hit.position.z + normal.z);

    const existing = this.getBlock(x, y, z);
    if (existing && existing !== 'water') return false; // water can be built over
    return this.setBlock(x, y, z, type);
  }

  update(delta) {
    this.time += delta;
    const water = this.materials.get('water');
    if (water) {
      water.opacity = 0.56 + Math.sin(this.time * 1.5) * 0.06;
      water.needsUpdate = true;
    }
  }

  getBlock(x, y, z) {
    return this.blocks.get(blockKey(Math.floor(x), Math.floor(y), Math.floor(z))) ?? null;
  }

  setBlock(x, y, z, type, rebuild = true) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const key = blockKey(ix, iy, iz);

    // Removal path -----------------------------------------------------------
    if (type === null || type === undefined) {
      const oldType = this.blocks.get(key);
      if (oldType === undefined) return false;
      const wasWater = oldType === 'water';
      this.blocks.delete(key);

      if (!rebuild) return true;

      if (wasWater) {
        // Water is rendered as a column-top plane sheet; safest to rebuild
        // the water mesh only. (Water edits are rare in normal gameplay.)
        this.rebuildWaterMesh();
        return true;
      }

      // Free the instance slot of the removed block (if it had one — it
      // wouldn't if it was occluded).
      this.removeInstanceAt(ix, iy, iz, oldType);
      // Removing a block can expose neighbors that were previously fully
      // surrounded; promote them to visible.
      this.refreshNeighborVisibility(ix, iy, iz);
      return true;
    }

    // Add / overwrite path ---------------------------------------------------
    if (!VALID_TYPES.has(type) || iy < 0 || iy >= this.options.maxHeight) return false;

    const oldType = this.blocks.get(key);
    if (oldType === type) return true; // no-op
    this.blocks.set(key, type);

    if (!rebuild) return true;

    // Replacing water is treated as: water shrinks (rebuild water mesh) + new
    // solid block appears in this cell (incremental add).
    if (oldType === 'water') {
      this.rebuildWaterMesh();
    } else if (oldType !== undefined) {
      // Replacing a non-water type: drop the old instance slot first.
      this.removeInstanceAt(ix, iy, iz, oldType);
    }

    if (type === 'water') {
      // New water cell — easiest is to rebuild the water mesh so the column
      // tops are recomputed correctly.
      this.rebuildWaterMesh();
    } else if (this.isRenderableBlockTyped(ix, iy, iz, type)) {
      this.addInstanceAt(ix, iy, iz, type);
    }

    // Solid blocks that we just placed may now occlude (or expose) neighbors
    // (e.g. the cell to the side was visible because we were air, now it's
    // hidden because we're a solid neighbor on all sides).
    this.refreshNeighborVisibility(ix, iy, iz);
    return true;
  }

  getSurfaceY(x, z) {
    let surface = null;
    for (let y = this.options.maxHeight - 1; y >= 0; y -= 1) {
      const type = this.getBlock(x, y, z);
      if (type && type !== 'water') {
        surface = y;
        break;
      }
    }
    return surface;
  }

  getGroundHeight(x, z) {
    const surface = this.getSurfaceY(x, z);
    return surface === null ? 0 : surface + 1.02;
  }

  // ---------------------------------------------------------------------------
  // Incremental InstancedMesh maintenance
  // ---------------------------------------------------------------------------

  isRenderableBlockTyped(x, y, z, type) {
    // Same predicate as isRenderableBlock but takes the type as argument so we
    // skip a redundant Map lookup at call sites that already have it.
    for (let i = 0; i < NEIGHBOR_OFFSETS.length; i += 1) {
      const o = NEIGHBOR_OFFSETS[i];
      const neighbor = this.getBlock(x + o[0], y + o[1], z + o[2]);
      if (!neighbor) return true;
      if (type !== 'water' && neighbor === 'water') return true;
      if (type === 'water' && neighbor !== 'water') return true;
    }
    return false;
  }

  ensureMeshForType(type) {
    let mesh = this.meshes.get(type);
    if (mesh) return mesh;
    // Lazy allocation — sized to a headroom-only capacity, which will grow if
    // needed via _growMesh().
    mesh = new THREE.InstancedMesh(this.geometry, this.materials.get(type), INSTANCE_HEADROOM);
    mesh.name = `World:${type}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.meshes.set(type, mesh);
    this.instanceKeyByPair.set(type, []);
    this.add(mesh);
    return mesh;
  }

  _growMesh(type, newCapacity) {
    const old = this.meshes.get(type);
    const fresh = new THREE.InstancedMesh(this.geometry, this.materials.get(type), newCapacity);
    fresh.name = old?.name ?? `World:${type}`;
    fresh.castShadow = old?.castShadow ?? true;
    fresh.receiveShadow = old?.receiveShadow ?? true;
    fresh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    if (old) {
      const oldCount = old.count;
      for (let i = 0; i < oldCount; i += 1) {
        old.getMatrixAt(i, _SCRATCH_M4);
        fresh.setMatrixAt(i, _SCRATCH_M4);
      }
      fresh.count = oldCount;
      this.remove(old);
      old.dispose?.();
    } else {
      fresh.count = 0;
    }
    fresh.instanceMatrix.needsUpdate = true;
    this.meshes.set(type, fresh);
    this.add(fresh);
    return fresh;
  }

  addInstanceAt(x, y, z, type) {
    const key = blockKey(x, y, z);
    // If the block is already registered (e.g. add called twice), skip.
    if (this.instanceIndexByKey.has(key)) return;

    let mesh = this.ensureMeshForType(type);
    const idx = mesh.count;
    if (idx >= mesh.instanceMatrix.count) {
      // Grow the buffer; double capacity to amortize.
      mesh = this._growMesh(type, Math.max(idx + 1, mesh.instanceMatrix.count * 2));
    }

    _SCRATCH_M4.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
    mesh.setMatrixAt(idx, _SCRATCH_M4);
    mesh.count = idx + 1;
    mesh.instanceMatrix.needsUpdate = true;

    this.instanceIndexByKey.set(key, { type, index: idx });
    const keyList = this.instanceKeyByPair.get(type);
    keyList[idx] = key;
  }

  removeInstanceAt(x, y, z, type) {
    const key = blockKey(x, y, z);
    const entry = this.instanceIndexByKey.get(key);
    if (!entry) return; // wasn't rendered (occluded or never added)
    const mesh = this.meshes.get(type);
    if (!mesh) {
      this.instanceIndexByKey.delete(key);
      return;
    }

    const lastIdx = mesh.count - 1;
    const targetIdx = entry.index;
    const keyList = this.instanceKeyByPair.get(type);

    if (targetIdx !== lastIdx) {
      // Swap-pop: copy the last matrix into the freed slot and patch the
      // index of the swapped key.
      mesh.getMatrixAt(lastIdx, _SCRATCH_M4);
      mesh.setMatrixAt(targetIdx, _SCRATCH_M4);
      const swappedKey = keyList[lastIdx];
      keyList[targetIdx] = swappedKey;
      const swappedEntry = this.instanceIndexByKey.get(swappedKey);
      if (swappedEntry) swappedEntry.index = targetIdx;
    }

    keyList.length = lastIdx; // pop
    mesh.count = lastIdx;
    mesh.instanceMatrix.needsUpdate = true;
    this.instanceIndexByKey.delete(key);
  }

  refreshNeighborVisibility(x, y, z) {
    // For each of the 6 neighbors of the mutated cell, re-evaluate whether
    // they should currently be in the InstancedMesh. This handles both
    // "neighbor was hidden, now exposed" (add) and "neighbor was visible, now
    // fully buried" (remove).
    for (let i = 0; i < NEIGHBOR_OFFSETS.length; i += 1) {
      const o = NEIGHBOR_OFFSETS[i];
      const nx = x + o[0];
      const ny = y + o[1];
      const nz = z + o[2];
      const nType = this.blocks.get(blockKey(nx, ny, nz));
      if (nType === undefined || nType === 'water') continue;
      const nKey = blockKey(nx, ny, nz);
      const has = this.instanceIndexByKey.has(nKey);
      const shouldRender = this.isRenderableBlockTyped(nx, ny, nz, nType);
      if (shouldRender && !has) {
        this.addInstanceAt(nx, ny, nz, nType);
      } else if (!shouldRender && has) {
        this.removeInstanceAt(nx, ny, nz, nType);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Bulk paths
  // ---------------------------------------------------------------------------

  // Legacy full rebuild kept for the bulk generate() / generateFlat() codepath
  // — building 30K instances individually is slower than this one-shot pass.
  rebuildMeshesFullBulk() {
    this.clearMeshes();

    const blocksByType = new Map(Object.keys(BLOCK_TYPES).map((type) => [type, []]));
    const waterTops = [];
    for (const [key, type] of this.blocks) {
      const [x, y, z] = parseBlockKey(key);
      if (type === 'water') {
        // Only the surface of each water column is drawn (as a flat sheet).
        if (this.getBlock(x, y + 1, z) !== 'water') waterTops.push([x, y, z]);
        continue;
      }
      if (this.isRenderableBlockTyped(x, y, z, type)) {
        blocksByType.get(type)?.push([x, y, z]);
      }
    }

    for (const [type, positions] of blocksByType) {
      if (type === 'water' || positions.length === 0) continue;

      const capacity = positions.length + INSTANCE_HEADROOM;
      const mesh = new THREE.InstancedMesh(this.geometry, this.materials.get(type), capacity);
      mesh.name = `World:${type}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = positions.length;

      for (let i = 0; i < positions.length; i += 1) {
        const p = positions[i];
        _SCRATCH_M4.makeTranslation(p[0] + 0.5, p[1] + 0.5, p[2] + 0.5);
        mesh.setMatrixAt(i, _SCRATCH_M4);
      }

      mesh.instanceMatrix.needsUpdate = true;
      this.meshes.set(type, mesh);
      this.add(mesh);
    }

    if (waterTops.length > 0) {
      const water = new THREE.InstancedMesh(
        this.waterGeometry,
        this.materials.get('water'),
        waterTops.length + INSTANCE_HEADROOM,
      );
      water.name = 'World:water';
      water.receiveShadow = true;
      water.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      water.count = waterTops.length;
      for (let i = 0; i < waterTops.length; i += 1) {
        const p = waterTops[i];
        _SCRATCH_M4.makeTranslation(p[0] + 0.5, p[1] + 0.96, p[2] + 0.5);
        water.setMatrixAt(i, _SCRATCH_M4);
      }
      water.instanceMatrix.needsUpdate = true;
      this.meshes.set('water', water);
      this.add(water);
    }
  }

  // After the bulk rebuild, seed instanceIndexByKey + instanceKeyByPair so the
  // incremental setBlock() path can take over without inconsistencies.
  populateInstanceIndexAfterBulk() {
    this.instanceIndexByKey.clear();
    this.instanceKeyByPair.clear();

    // We re-walk the blocks map in the same iteration order the bulk path
    // used. Maps in JS preserve insertion order, and since we filtered with
    // identical isRenderableBlockTyped predicates the indices line up.
    const counters = new Map();
    for (const type of Object.keys(BLOCK_TYPES)) {
      if (this.meshes.has(type)) this.instanceKeyByPair.set(type, []);
      counters.set(type, 0);
    }

    for (const [key, type] of this.blocks) {
      if (type === 'water') continue; // water is rendered via column-top plane
      const [x, y, z] = parseBlockKey(key);
      if (!this.isRenderableBlockTyped(x, y, z, type)) continue;
      const idx = counters.get(type);
      counters.set(type, idx + 1);
      this.instanceIndexByKey.set(key, { type, index: idx });
      const list = this.instanceKeyByPair.get(type);
      if (list) list[idx] = key;
    }
  }

  // Rebuilds ONLY the water mesh from scratch. Used after water cell edits,
  // which are infrequent and complex (column-top plane requires re-scanning).
  rebuildWaterMesh() {
    const existing = this.meshes.get('water');
    if (existing) {
      this.remove(existing);
      existing.dispose?.();
      this.meshes.delete('water');
    }

    const waterTops = [];
    for (const [key, type] of this.blocks) {
      if (type !== 'water') continue;
      const [x, y, z] = parseBlockKey(key);
      if (this.getBlock(x, y + 1, z) !== 'water') waterTops.push([x, y, z]);
    }
    if (waterTops.length === 0) return;

    const water = new THREE.InstancedMesh(
      this.waterGeometry,
      this.materials.get('water'),
      waterTops.length + INSTANCE_HEADROOM,
    );
    water.name = 'World:water';
    water.receiveShadow = true;
    water.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    water.count = waterTops.length;
    for (let i = 0; i < waterTops.length; i += 1) {
      const p = waterTops[i];
      _SCRATCH_M4.makeTranslation(p[0] + 0.5, p[1] + 0.96, p[2] + 0.5);
      water.setMatrixAt(i, _SCRATCH_M4);
    }
    water.instanceMatrix.needsUpdate = true;
    this.meshes.set('water', water);
    this.add(water);
  }

  // Backwards-compat alias: some code paths or external callers might still
  // expect rebuildMeshes(). Route it to the bulk path (the safer choice).
  rebuildMeshes() {
    this.rebuildMeshesFullBulk();
    this.populateInstanceIndexAfterBulk();
  }

  clearMeshes() {
    for (const mesh of this.meshes.values()) {
      this.remove(mesh);
      mesh.dispose?.();
    }
    this.meshes.clear();
    this.instanceIndexByKey.clear();
    this.instanceKeyByPair.clear();
  }

  nextBoundaryDistance(value, direction, cell) {
    if (direction > 0) return (cell + 1 - value) / direction;
    if (direction < 0) return (value - cell) / -direction;
    return Infinity;
  }

  // Original predicate kept for any external callers; new code uses the
  // -Typed variant to skip a redundant Map lookup.
  isRenderableBlock(x, y, z, type) {
    return this.isRenderableBlockTyped(x, y, z, type);
  }

  dispose() {
    this.clearMeshes();
    this.geometry.dispose();
    this.waterGeometry.dispose();
    for (const material of this.materials.values()) {
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
    this.materials.clear();
    this.blocks.clear();
  }
}

export default World;
