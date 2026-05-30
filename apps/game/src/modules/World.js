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
    this.rebuildMeshes();
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

    this.rebuildMeshes();
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
    const rayDirection = direction instanceof THREE.Vector3
      ? direction.clone()
      : new THREE.Vector3(direction.x, direction.y, direction.z);

    if (rayDirection.lengthSq() === 0 || maxDistance <= 0) return null;
    rayDirection.normalize();

    let x = Math.floor(rayOrigin.x);
    let y = Math.floor(rayOrigin.y);
    let z = Math.floor(rayOrigin.z);

    const stepX = Math.sign(rayDirection.x);
    const stepY = Math.sign(rayDirection.y);
    const stepZ = Math.sign(rayDirection.z);

    const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / rayDirection.x);
    const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / rayDirection.y);
    const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / rayDirection.z);

    let tMaxX = this.nextBoundaryDistance(rayOrigin.x, rayDirection.x, x);
    let tMaxY = this.nextBoundaryDistance(rayOrigin.y, rayDirection.y, y);
    let tMaxZ = this.nextBoundaryDistance(rayOrigin.z, rayDirection.z, z);
    let distance = 0;
    let normal = new THREE.Vector3(0, 0, 0);
    let previous = new THREE.Vector3(x, y, z);

    while (distance <= maxDistance) {
      const type = this.getBlock(x, y, z);
      if (type) {
        const position = new THREE.Vector3(x, y, z);
        const point = rayOrigin.clone().addScaledVector(rayDirection, Math.max(0, distance));
        return {
          position,
          normal: normal.clone(),
          previous: previous.clone(),
          point,
          distance,
          type,
        };
      }

      previous.set(x, y, z);
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        x += stepX;
        distance = tMaxX;
        tMaxX += tDeltaX;
        normal.set(-stepX, 0, 0);
      } else if (tMaxY <= tMaxZ) {
        y += stepY;
        distance = tMaxY;
        tMaxY += tDeltaY;
        normal.set(0, -stepY, 0);
      } else {
        z += stepZ;
        distance = tMaxZ;
        tMaxZ += tDeltaZ;
        normal.set(0, 0, -stepZ);
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

    if (type === null || type === undefined) {
      const removed = this.blocks.delete(key);
      if (removed && rebuild) this.rebuildMeshes();
      return removed;
    }

    if (!VALID_TYPES.has(type) || iy < 0 || iy >= this.options.maxHeight) return false;
    this.blocks.set(key, type);
    if (rebuild) this.rebuildMeshes();
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

  rebuildMeshes() {
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
      if (this.isRenderableBlock(x, y, z, type)) {
        blocksByType.get(type)?.push([x, y, z]);
      }
    }

    const matrix = new THREE.Matrix4();
    for (const [type, positions] of blocksByType) {
      if (type === 'water' || positions.length === 0) continue;

      const mesh = new THREE.InstancedMesh(this.geometry, this.materials.get(type), positions.length);
      mesh.name = `World:${type}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      positions.forEach(([x, y, z], index) => {
        matrix.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
        mesh.setMatrixAt(index, matrix);
      });

      mesh.instanceMatrix.needsUpdate = true;
      this.meshes.set(type, mesh);
      this.add(mesh);
    }

    if (waterTops.length > 0) {
      const water = new THREE.InstancedMesh(this.waterGeometry, this.materials.get('water'), waterTops.length);
      water.name = 'World:water';
      water.receiveShadow = true;
      waterTops.forEach(([x, y, z], index) => {
        matrix.makeTranslation(x + 0.5, y + 0.96, z + 0.5);
        water.setMatrixAt(index, matrix);
      });
      water.instanceMatrix.needsUpdate = true;
      this.meshes.set('water', water);
      this.add(water);
    }
  }

  clearMeshes() {
    for (const mesh of this.meshes.values()) {
      this.remove(mesh);
      mesh.dispose?.();
    }
    this.meshes.clear();
  }

  nextBoundaryDistance(value, direction, cell) {
    if (direction > 0) return (cell + 1 - value) / direction;
    if (direction < 0) return (value - cell) / -direction;
    return Infinity;
  }

  isRenderableBlock(x, y, z, type) {
    for (const [ox, oy, oz] of NEIGHBOR_OFFSETS) {
      const neighbor = this.getBlock(x + ox, y + oy, z + oz);
      if (!neighbor) return true;
      if (type !== 'water' && neighbor === 'water') return true;
      if (type === 'water' && neighbor !== 'water') return true;
    }
    return false;
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
