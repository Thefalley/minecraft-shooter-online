// The original green map: rolling grass hills above the water line, a stone
// castle on a central plateau, a small lake and a scattered forest.
//
// A map is a plain descriptor. `generate(world)` paints the terrain using the
// voxel-building primitives on the World instance (setBlock, clearColumn,
// plantTree, noise2D, hash, forEachColumn, …). Every setBlock here passes
// rebuild=false; World rebuilds the instanced meshes once afterwards.

function generateTerrain(world) {
  const { maxHeight, waterLevel } = world.options;
  world.forEachColumn((x, z) => {
    const broad = world.noise2D(x, z, 18, 0);
    const detail = world.noise2D(x + 91, z - 47, 7, 19);
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
      world.setBlock(x, y, z, type, false);
    }

    for (let y = height + 1; y <= waterLevel; y += 1) {
      world.setBlock(x, y, z, 'water', false);
    }
  });
}

function generateTrees(world) {
  const { waterLevel } = world.options;
  world.forEachColumn((x, z) => {
    if (world.hash(x * 3, z * 3, 91) > 0.985) {
      const y = world.getSurfaceY(x, z);
      if (y === null || y < waterLevel || world.getBlock(x, y, z) !== 'grass') return;
      world.plantTree(x, y, z);
    }
  }, 3);
}

function buildCastle(world, half, base) {
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
        world.setBlock(x, base + h, z, 'stone', false);
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
          world.setBlock(cx + dx, base + h, cz + dz, 'stone', false);
        }
      }
    }
  }
}

function buildForest(world) {
  const { width, depth, waterLevel } = world.options;
  const centerX = -Math.floor(width / 4);
  const centerZ = Math.floor(depth / 4);

  for (let x = centerX - 7; x <= centerX + 7; x += 1) {
    for (let z = centerZ - 7; z <= centerZ + 7; z += 1) {
      if (world.hash(x * 7, z * 7, 313) > 0.76) {
        const y = world.getSurfaceY(x, z);
        if (y === null || y < waterLevel || world.getBlock(x, y, z) !== 'grass') continue;
        world.plantTree(x, y, z);
      }
    }
  }
}

function buildLandmarks(world) {
  const { waterLevel } = world.options;
  const plateauTop = waterLevel + 2;
  const plateauRadius = 15;
  const castleHalf = 8;
  const lake = { x: 12, z: 12, radius: 4 };

  // Flat grass plateau for the castle (no moat).
  for (let x = -plateauRadius - 1; x <= plateauRadius + 1; x += 1) {
    for (let z = -plateauRadius - 1; z <= plateauRadius + 1; z += 1) {
      if (Math.hypot(x, z) > plateauRadius) continue;
      world.clearColumn(x, z);
      for (let y = 0; y <= plateauTop; y += 1) {
        let type = 'stone';
        if (y === plateauTop) type = 'grass';
        else if (y >= plateauTop - 2) type = 'dirt';
        world.setBlock(x, y, z, type, false);
      }
    }
  }

  // A single small lake tucked into a corner beside the castle.
  const bed = waterLevel - 2;
  for (let x = lake.x - lake.radius - 1; x <= lake.x + lake.radius + 1; x += 1) {
    for (let z = lake.z - lake.radius - 1; z <= lake.z + lake.radius + 1; z += 1) {
      if (Math.hypot(x - lake.x, z - lake.z) > lake.radius) continue;
      world.clearColumn(x, z);
      for (let y = 0; y <= bed; y += 1) {
        world.setBlock(x, y, z, y >= bed - 1 ? 'sand' : 'stone', false);
      }
      for (let y = bed + 1; y <= waterLevel; y += 1) {
        world.setBlock(x, y, z, 'water', false);
      }
    }
  }

  buildCastle(world, castleHalf, plateauTop);
  buildForest(world);
}

export const meadow = {
  id: 'meadow',
  name: 'Pradera',
  emoji: '🏰',
  note: 'Castillo, lago y bosque verde',
  environment: {
    sky: 0x8fc7ff,
    fog: { color: 0x8fc7ff, near: 80, far: 340 },
    hemisphere: { sky: 0xcfe8ff, ground: 0x31451e, intensity: 1.5 },
    sun: { color: 0xfff0c5, intensity: 2.4 },
  },
  generate(world) {
    generateTerrain(world);
    generateTrees(world);
    buildLandmarks(world);
  },
};

export default meadow;
