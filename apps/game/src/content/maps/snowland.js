// Snowy map: mountainous snow terrain, a frozen lake, giant spruce trees and
// an igloo. Same footprint as the meadow (uses world.options width/depth), but
// with taller relief and a wintry palette.

function generateTerrain(world) {
  const { maxHeight, waterLevel } = world.options;
  world.forEachColumn((x, z) => {
    const mountains = world.noise2D(x, z, 24, 0);          // broad peaks/valleys
    const ridges = world.noise2D(x + 57, z - 31, 8, 41);    // sharper detail
    const swell = world.noise2D(x - 13, z + 88, 44, 7);     // very broad swell

    // Bigger amplitude than the meadow → noticeably mountainous.
    const height = Math.max(
      waterLevel + 1,
      Math.min(
        maxHeight - 1,
        Math.floor(waterLevel + 3 + (mountains - 0.5) * 18 + (ridges - 0.5) * 6 + (swell - 0.5) * 8),
      ),
    );

    const rocky = height >= 16; // exposed stone on the high peaks
    for (let y = 0; y <= height; y += 1) {
      let type = 'stone';
      if (y === height) {
        type = 'snow'; // snow blankets everything, even the peaks
      } else if (!rocky && y >= height - 3) {
        type = 'dirt';
      }
      world.setBlock(x, y, z, type, false);
    }
  });
}

// A frozen pond carved into a corner: water with a solid ice lid you can walk on.
function buildFrozenLake(world) {
  const { waterLevel } = world.options;
  const lake = { x: 14, z: -13, radius: 6 };
  const bed = waterLevel - 3;

  for (let x = lake.x - lake.radius - 1; x <= lake.x + lake.radius + 1; x += 1) {
    for (let z = lake.z - lake.radius - 1; z <= lake.z + lake.radius + 1; z += 1) {
      if (Math.hypot(x - lake.x, z - lake.z) > lake.radius) continue;
      world.clearColumn(x, z);
      for (let y = 0; y <= bed; y += 1) {
        world.setBlock(x, y, z, 'stone', false);
      }
      for (let y = bed + 1; y < waterLevel; y += 1) {
        world.setBlock(x, y, z, 'water', false);
      }
      world.setBlock(x, waterLevel, z, 'ice', false); // frozen surface
    }
  }
}

// Just three giant spruces clustered in one corner — the rest of the map stays
// bare, mountainous snow.
function plantCornerSpruces(world) {
  const spots = [[-31, -31], [-34, -27], [-27, -34]];
  for (const [x, z] of spots) {
    const y = world.getSurfaceY(x, z);
    if (y === null) continue;
    const height = 11 + Math.floor(world.hash(x, z, 311) * 5); // 11..15 blocks tall
    world.plantSpruce(x, y, z, height);
  }
}

// A classic snow-block igloo: flattened pad, ice floor, hemispherical dome with
// a doorway and a short entrance tunnel.
function buildIgloo(world, cx, cz) {
  const { maxHeight, waterLevel } = world.options;
  const surface = world.getSurfaceY(cx, cz);
  const floor = (surface === null ? waterLevel : surface) + 1; // first air block above ground
  const R = 4;

  // Flatten and clear the footprint, laying a snow pad underneath.
  for (let dx = -R - 1; dx <= R + 1; dx += 1) {
    for (let dz = -R - 1; dz <= R + 1; dz += 1) {
      if (Math.hypot(dx, dz) > R + 1) continue;
      const x = cx + dx;
      const z = cz + dz;
      for (let y = floor; y < maxHeight; y += 1) world.setBlock(x, y, z, null, false);
      world.setBlock(x, floor - 1, z, 'snow', false);
    }
  }

  // Ice floor inside.
  for (let dx = -R + 1; dx <= R - 1; dx += 1) {
    for (let dz = -R + 1; dz <= R - 1; dz += 1) {
      if (Math.hypot(dx, dz) > R - 1) continue;
      world.setBlock(cx + dx, floor - 1, cz + dz, 'ice', false);
    }
  }

  // Hemispherical snow shell (1 block thick) with a doorway on the +Z side.
  for (let y = 0; y <= R; y += 1) {
    for (let dx = -R; dx <= R; dx += 1) {
      for (let dz = -R; dz <= R; dz += 1) {
        const dist = Math.sqrt(dx * dx + dz * dz + y * y);
        if (dist > R + 0.5 || dist < R - 0.6) continue;
        if (dz >= R - 2 && Math.abs(dx) <= 1 && y <= 1) continue; // doorway gap
        world.setBlock(cx + dx, floor + y, cz + dz, 'snow', false);
      }
    }
  }

  // Short entrance tunnel poking out of the doorway.
  for (let ez = R - 1; ez <= R + 1; ez += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      world.setBlock(cx + dx, floor + 2, cz + ez, 'snow', false); // roof
      if (Math.abs(dx) === 1) {
        world.setBlock(cx + dx, floor, cz + ez, 'snow', false); // side walls
        world.setBlock(cx + dx, floor + 1, cz + ez, 'snow', false);
      }
    }
  }
}

export const snowland = {
  id: 'snowland',
  name: 'Nieve',
  emoji: '❄️',
  note: 'Montañas nevadas, abetos gigantes e iglú',
  environment: {
    sky: 0xdfeefc,
    fog: { color: 0xe8f1fa, near: 55, far: 240 },
    hemisphere: { sky: 0xeef6ff, ground: 0x9fb1c2, intensity: 1.7 },
    sun: { color: 0xfdfdff, intensity: 2.2 },
  },
  generate(world) {
    generateTerrain(world);
    buildFrozenLake(world);
    plantCornerSpruces(world);
    buildIgloo(world, 11, 9); // offset from the central spawn so it's visible nearby
  },
};

export default snowland;
