import * as THREE from 'three';
import { createBlockMaterials } from './textures/BlockTextures.js';

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
  snow: {
    color: 0xf3f7fb,
    roughness: 0.85,
    metalness: 0,
  },
  ice: {
    color: 0xa7d8ef,
    roughness: 0.18,
    metalness: 0.1,
  },
  spruce_log: {
    color: 0x4a3320,
    roughness: 0.9,
    metalness: 0,
  },
  spruce_leaves: {
    color: 0x28452f,
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
    // The map descriptor decides how the terrain is laid out (see modules/maps).
    // World itself only provides the voxel-building primitives.
    this.map = options.map ?? null;
    // Custom (imported) maps can register extra block types on the fly; merge
    // them into the registry so they are valid and get a material.
    this.blockTypes = { ...BLOCK_TYPES, ...(options.extraBlocks ?? {}) };
    this.validTypes = new Set(Object.keys(this.blockTypes));
    this.blocks = new Map();
    // Per-block non-cube render shape (imported slabs/stairs/carpets/fences).
    // Keyed like `blocks`; absent ⇒ a full cube. Geometries below are baked in
    // cell-local [0,1]³ space (origin at the block's corner).
    this.shapes = new Map();
    this.meshes = new Map();
    this.time = 0;

    this.geometry = new THREE.BoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
    this.shapeGeometries = {
      slab_bottom: new THREE.BoxGeometry(1, 0.5, 1).translate(0.5, 0.25, 0.5),
      slab_top: new THREE.BoxGeometry(1, 0.5, 1).translate(0.5, 0.75, 0.5),
      layer: new THREE.BoxGeometry(1, 0.125, 1).translate(0.5, 0.0625, 0.5),
      post: new THREE.BoxGeometry(0.4, 1, 0.4).translate(0.5, 0.5, 0.5),
    };
    // Flat quad used for the water surface so adjacent water tiles merge into a
    // single seamless sheet instead of showing per-cube edges.
    this.waterGeometry = new THREE.PlaneGeometry(BLOCK_SIZE, BLOCK_SIZE);
    this.waterGeometry.rotateX(-Math.PI / 2);
    // Minecraft-style procedural pixel textures (grass uses a 6-face array).
    this.materials = createBlockMaterials(this.blockTypes);

    this.generate();
  }

  generate() {
    this.clearMeshes();
    this.blocks.clear();
    this.shapes.clear();
    this.flatTop = null;

    // The chosen map paints the terrain using the building primitives below.
    // Each map's generate() places blocks with rebuild=false; we rebuild once.
    if (this.map && typeof this.map.generate === 'function') {
      this.map.generate(this);
    } else {
      this.generateFlatTerrain(this.options.waterLevel + 1);
    }

    this.rebuildMeshes();
  }

  // Plain solid terrain used as a safe fallback when no map is supplied.
  generateFlatTerrain(top = 5) {
    this.forEachColumn((x, z) => {
      for (let y = 0; y <= top; y += 1) {
        let type = 'stone';
        if (y === top) type = 'grass';
        else if (y >= top - 2) type = 'dirt';
        this.setBlock(x, y, z, type, false);
      }
    });
  }

  // --- terrain helpers exposed to map generators ----------------------------
  // Smooth value noise in [0,1]. seedOffset lets a map mix several octaves.
  noise2D(x, z, scale, seedOffset = 0) {
    return valueNoise2D(x, z, this.options.seed + seedOffset, scale);
  }

  // Deterministic hash in [0,1] for scattering features (trees, etc.).
  hash(x, z, seedOffset = 0) {
    return hash2D(x, z, this.options.seed + seedOffset);
  }

  // Iterates every (x, z) column of the map, optionally shrinking the border.
  forEachColumn(callback, margin = 0) {
    const { width, depth } = this.options;
    const halfWidth = Math.floor(width / 2);
    const halfDepth = Math.floor(depth / 2);
    for (let x = -halfWidth + margin; x < width - halfWidth - margin; x += 1) {
      for (let z = -halfDepth + margin; z < depth - halfDepth - margin; z += 1) {
        callback(x, z);
      }
    }
  }

  generateFlat(top = 5) {
    this.clearMeshes();
    this.blocks.clear();
    this.shapes.clear();
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

  // Tall conical spruce with snow-dusted needles. The foliage radius cycles in
  // tiers (1→3) going down so it reads as a layered evergreen, and the very tip
  // is capped with snow.
  plantSpruce(x, baseY, z, height = 12) {
    const top = baseY + height;
    for (let trunk = 1; trunk <= height; trunk += 1) {
      this.setBlock(x, baseY + trunk, z, 'spruce_log', false);
    }

    // Pointed tip plus a snow cap.
    this.setBlock(x, top, z, 'spruce_leaves', false);
    this.setBlock(x, top + 1, z, 'snow', false);

    let radius = 1;
    for (let y = top - 1; y >= baseY + 3; y -= 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (dx === 0 && dz === 0) continue; // leave room for the trunk
          if (Math.abs(dx) + Math.abs(dz) > radius + 1) continue; // round the corners
          this.setBlock(x + dx, y, z + dz, 'spruce_leaves', false);
        }
      }
      radius += 1;
      if (radius > 3) radius = 1; // start a new (narrower) tier
    }
  }

  clearColumn(x, z) {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    for (let y = 0; y < this.options.maxHeight; y += 1) {
      const key = blockKey(ix, y, iz);
      this.blocks.delete(key);
      this.shapes.delete(key);
    }
  }


  getSpawnPoint() {
    const { width, depth, waterLevel } = this.options;
    const searchRadius = Math.floor(Math.min(width, depth) / 2);

    // Spawn on the first solid, walkable surface found near the centre. Works
    // for any map (grass meadow, snow field, …) since it no longer requires a
    // specific block type — just a non-water top that is not a tree.
    const walkable = (type) => Boolean(type) && type !== 'water'
      && type !== 'leaves' && type !== 'spruce_leaves' && type !== 'wood' && type !== 'spruce_log';

    for (let radius = 0; radius <= searchRadius; radius += 1) {
      for (let x = -radius; x <= radius; x += 1) {
        for (let z = -radius; z <= radius; z += 1) {
          if (Math.abs(x) !== radius && Math.abs(z) !== radius) continue;

          const y = this.getSurfaceY(x, z);
          if (y !== null && y >= waterLevel && walkable(this.getBlock(x, y, z))) {
            return new THREE.Vector3(x + 0.5, y + 2.2, z + 0.5);
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
    if (!hit?.position || !this.validTypes.has(type)) return false;

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

  setBlock(x, y, z, type, rebuild = true, shape = 'cube') {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const key = blockKey(ix, iy, iz);

    if (type === null || type === undefined) {
      const removed = this.blocks.delete(key);
      this.shapes.delete(key);
      if (removed && rebuild) this.rebuildMeshes();
      return removed;
    }

    if (!this.validTypes.has(type) || iy < 0 || iy >= this.options.maxHeight) return false;
    this.blocks.set(key, type);
    if (shape && shape !== 'cube' && this.shapeGeometries[shape]) this.shapes.set(key, shape);
    else this.shapes.delete(key);
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

  // True if this column has open water on top (a lake/pond surface). Enemies use
  // this to stay out of the water and avoid getting stuck below the surface.
  isWaterColumn(x, z) {
    return this.getBlock(x, this.options.waterLevel, z) === 'water';
  }

  // Carves a bowl-shaped crater centered at (cx,cz): clears each column and
  // refills up to a floor that dips toward the centre. Used by the wave-10
  // meteor cutscene to replace the castle with a crater. Rebuilds the meshes.
  carveCrater(cx, cz, radius) {
    const rim = this.options.waterLevel + 2;             // matches the old plateau top
    const floorMin = Math.max(1, this.options.waterLevel - 4); // deep centre
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const d = Math.hypot(dx, dz);
        if (d > radius) continue;
        const x = cx + dx;
        const z = cz + dz;
        this.clearColumn(x, z);
        const t = d / radius; // 0 centre .. 1 edge
        const floor = Math.round(lerp(floorMin, rim, t * t)); // quadratic bowl
        for (let y = 0; y <= floor; y += 1) {
          let type = 'stone';
          if (y === floor) type = t > 0.9 ? 'grass' : 'stone'; // scorched inside, grass rim
          else if (y >= floor - 2 && t > 0.85) type = 'dirt';
          this.setBlock(x, y, z, type, false);
        }
      }
    }
    this.rebuildMeshes();
  }

  // A walkable spawn at a random column (used to drop the player somewhere new
  // after the meteor). Falls back to the deterministic spawn if none is found.
  getRandomSpawnPoint() {
    const { width, depth, waterLevel } = this.options;
    const halfW = Math.floor(width / 2) - 2;
    const halfD = Math.floor(depth / 2) - 2;
    const walkable = (type) => Boolean(type) && type !== 'water'
      && type !== 'leaves' && type !== 'spruce_leaves' && type !== 'wood' && type !== 'spruce_log';
    for (let tries = 0; tries < 80; tries += 1) {
      const x = Math.floor((Math.random() * 2 - 1) * halfW);
      const z = Math.floor((Math.random() * 2 - 1) * halfD);
      const y = this.getSurfaceY(x, z);
      if (y !== null && y >= waterLevel && walkable(this.getBlock(x, y, z))) {
        return new THREE.Vector3(x + 0.5, y + 2.2, z + 0.5);
      }
    }
    return this.getSpawnPoint();
  }

  rebuildMeshes() {
    this.clearMeshes();

    const blocksByType = new Map(Object.keys(this.blockTypes).map((type) => [type, []]));
    const shapedByKey = new Map(); // `${type}__${shape}` → positions (non-cube blocks)
    const waterTops = [];
    for (const [key, type] of this.blocks) {
      const [x, y, z] = parseBlockKey(key);
      if (type === 'water') {
        // Only the surface of each water column is drawn (as a flat sheet).
        if (this.getBlock(x, y + 1, z) !== 'water') waterTops.push([x, y, z]);
        continue;
      }
      const shape = this.shapes.get(key);
      // Full cubes are culled when fully enclosed (truly invisible). Non-cube
      // shapes don't fill their cell, so an enclosed slab/layer/post still shows
      // through the partial-cell gap — always emit those.
      if (!shape && !this.isRenderableBlock(x, y, z, type)) continue;
      if (shape) {
        const k = `${type}__${shape}`;
        let arr = shapedByKey.get(k);
        if (!arr) { arr = []; shapedByKey.set(k, arr); }
        arr.push([x, y, z]);
      } else {
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

    // Non-cube shapes (slabs/stairs/carpets/fences): one InstancedMesh per
    // (type, shape). Their geometry is baked in cell-local space, so instances
    // translate to the block corner (x, y, z) rather than the centre.
    for (const [k, positions] of shapedByKey) {
      const sep = k.lastIndexOf('__');
      const type = k.slice(0, sep);
      const shape = k.slice(sep + 2);
      const geometry = this.shapeGeometries[shape] ?? this.geometry;
      const mesh = new THREE.InstancedMesh(geometry, this.materials.get(type), positions.length);
      mesh.name = `World:${type}:${shape}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      positions.forEach(([x, y, z], index) => {
        matrix.makeTranslation(x, y, z);
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.meshes.set(k, mesh);
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
    for (const g of Object.values(this.shapeGeometries)) g.dispose();
    for (const material of this.materials.values()) {
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
    this.materials.clear();
    this.blocks.clear();
    this.shapes.clear();
  }
}

export default World;
