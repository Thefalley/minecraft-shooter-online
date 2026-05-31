// Turns an uploaded Minecraft world (a .zip downloaded from e.g. minecraftmaps)
// into a playable map descriptor. It unzips the save, finds the overworld region
// files, measures the FULL extent of the build, sizes the game world to fit it
// and maps every block to a game block type — inventing a coloured block for
// anything unmatched.
//
// To keep a pathological save (an explored world spanning thousands of blocks)
// from blowing up memory / the single-mesh renderer, the footprint is capped:
// builds up to MAX_DIM × MAX_DIM and MAX_HEIGHT tall load whole; anything bigger
// is cropped to that window, centred on the build.

import { ZipArchive } from './zip.js';
import { gunzip } from './decompress.js';
import { parseNBT } from './nbt.js';
import { eachChunk, extractBlocks, parseRegionCoords } from './anvil.js';
import { BlockResolver } from './blockMap.js';
import { shapeOf } from './blockData.js';

// Safety caps for the imported footprint. The renderer keeps one InstancedMesh
// per block type with no chunking or distance culling, so these bound how much
// geometry a single map can throw at the GPU / the mesh rebuild.
const MAX_DIM = 384;     // max width / depth in blocks
const MAX_HEIGHT = 96;   // max vertical layers of build (y=0 is the floor)
const WATER_LEVEL = 8;
// Decompressing every region of a huge save is wasteful; scan at most this many,
// nearest the spawn. 16 regions is an 8192×8192 area — far beyond MAX_DIM.
const MAX_SCAN_REGIONS = 16;

function findRegionEntries(zip) {
  // Prefer the overworld (a "region/" folder not under DIM-1 / DIM1).
  const all = zip.list().filter((p) => p.endsWith('.mca') && p.includes('region/'));
  const overworld = all.filter((p) => !/DIM-?1\//.test(p));
  const chosen = overworld.length ? overworld : all;
  return chosen
    .map((path) => ({ path, coords: parseRegionCoords(path) }))
    .filter((r) => r.coords);
}

async function readSpawn(zip) {
  const levelPath = zip.list().find((p) => p.endsWith('level.dat'));
  if (!levelPath) return { x: 0, z: 0 };
  try {
    const nbt = parseNBT(await gunzip(await zip.read(levelPath)));
    const data = nbt.Data ?? nbt;
    if (typeof data.SpawnX === 'number' && typeof data.SpawnZ === 'number') {
      return { x: data.SpawnX, z: data.SpawnZ };
    }
  } catch {
    /* fall through to origin */
  }
  return { x: 0, z: 0 };
}

// Keeps the MAX_SCAN_REGIONS regions closest to the spawn (by region grid
// distance). Most saves have only a handful, so this is usually a no-op.
function pickScanRegions(regions, spawn) {
  if (regions.length <= MAX_SCAN_REGIONS) return regions;
  const sx = Math.floor(spawn.x / 512);
  const sz = Math.floor(spawn.z / 512);
  const dist = ([rx, rz]) => Math.max(Math.abs(rx - sx), Math.abs(rz - sz));
  return [...regions].sort((a, b) => dist(a.coords) - dist(b.coords)).slice(0, MAX_SCAN_REGIONS);
}

// Decompress + parse each present chunk ONCE and keep it. Both later passes
// (measure extent, then place blocks) reuse these parsed chunks instead of
// re-inflating and re-parsing every chunk (the expensive zlib + NBT work).
async function loadChunks(regions) {
  const chunks = [];
  for (const region of regions) {
    await eachChunk(region.bytes, region.coords[0], region.coords[1], (nbt, cx, cz) => {
      chunks.push({ nbt, cx, cz });
    });
  }
  return chunks;
}

// Full bounding box (in Minecraft world coords) of every non-air block in the
// cached chunks — the build's true extent.
function measureBounds(chunks) {
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const { nbt, cx, cz } of chunks) {
    extractBlocks(nbt, cx, cz, (x, y, z) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    });
  }
  return { minX, maxX, minZ, maxZ, minY, maxY };
}

// Picks a [lo, hi] window of at most `cap` blocks inside [min, max], centred on
// the build's middle so an over-large build keeps its centre.
function clampAxis(min, max, cap) {
  const extent = max - min + 1;
  if (extent <= cap) return [min, max];
  const center = Math.floor((min + max) / 2);
  let lo = center - Math.floor(cap / 2);
  let hi = lo + cap - 1;
  if (lo < min) { lo = min; hi = lo + cap - 1; }
  if (hi > max) { hi = max; lo = hi - cap + 1; }
  return [lo, hi];
}

// Distances that let the player see across the whole footprint without the fog
// (or built-in defaults) cutting the map in half.
function environmentFor(width, depth) {
  const span = Math.max(width, depth);
  const far = Math.min(880, Math.max(220, Math.round(span * 1.35 + 50)));
  return {
    sky: 0x9fb8d4,
    fog: { color: 0xb9c9dc, near: Math.round(far * 0.35), far },
    hemisphere: { sky: 0xdceaf7, ground: 0x4a4f44, intensity: 1.4 },
    sun: { color: 0xfff4da, intensity: 2.3 },
  };
}

export async function importMinecraftMap(file, onProgress = () => {}) {
  onProgress('Leyendo el archivo…');
  const buffer = await file.arrayBuffer();
  const zip = new ZipArchive(new Uint8Array(buffer));

  const regions = findRegionEntries(zip);
  if (regions.length === 0) {
    throw new Error('No se encontraron archivos region/*.mca (¿es un mundo de Minecraft?).');
  }

  const spawn = await readSpawn(zip);
  const scan = pickScanRegions(regions, spawn);
  onProgress(`Descomprimiendo ${scan.length} región(es)…`);
  for (const region of scan) region.bytes = await zip.read(region.path);

  // Decompress + parse every present chunk once; later passes reuse them.
  const chunks = await loadChunks(scan);

  // Pass 1: measure the build's full extent.
  onProgress('Midiendo el mapa…');
  const b = measureBounds(chunks);
  if (b.maxY === -Infinity) throw new Error('El mapa está vacío (sin bloques).');

  // XZ window: whole build, or the centred MAX_DIM crop if it's larger.
  const [winMinX, winMaxX] = clampAxis(b.minX, b.maxX, MAX_DIM);
  const [winMinZ, winMaxZ] = clampAxis(b.minZ, b.maxZ, MAX_DIM);
  const width = winMaxX - winMinX + 1;
  const depth = winMaxZ - winMinZ + 1;

  // Vertical: keep the build from the bottom up, or its top MAX_HEIGHT layers if
  // it's taller than the cap. y=0 is reserved for the solid floor, so blocks land
  // at gameY 1..keep.
  const buildHeight = b.maxY - b.minY + 1;
  const keep = Math.min(buildHeight, MAX_HEIGHT);
  const base = buildHeight <= MAX_HEIGHT ? b.minY : b.maxY - keep + 1;
  const maxHeight = keep + 1;

  // Pass 2: place the clipped blocks (window-local X/Z, floored Y).
  onProgress('Convirtiendo bloques…');
  const resolver = new BlockResolver();
  const xs = [];
  const ys = [];
  const zs = [];
  const types = [];
  const shapes = [];
  for (const { nbt, cx, cz } of chunks) {
    extractBlocks(nbt, cx, cz, (x, y, z, name, props) => {
      if (x < winMinX || x > winMaxX || z < winMinZ || z > winMaxZ) return;
      const gameY = y - base + 1;
      if (gameY < 1 || gameY >= maxHeight) return;
      const type = resolver.resolve(name);
      if (!type) return; // skipped decoration (flower, torch, rail, …)
      xs.push(x - winMinX);
      ys.push(gameY);
      zs.push(z - winMinZ);
      types.push(type);
      shapes.push(shapeOf(name, props));
    });
  }

  const halfW = Math.floor(width / 2);
  const halfD = Math.floor(depth / 2);
  const name = file.name.replace(/\.(zip|mca)$/i, '').slice(0, 24) || 'Custom';
  const cropped = width < b.maxX - b.minX + 1 || depth < b.maxZ - b.minZ + 1
    || buildHeight > MAX_HEIGHT || scan.length < regions.length;

  return {
    id: `custom-${name}-${xs.length}`,
    name,
    emoji: '📦',
    note: `Importado · ${width}×${depth}${cropped ? ' (recortado)' : ''} · ${Object.keys(resolver.extraBlocks).length} bloques nuevos`,
    dimensions: { width, depth, maxHeight, waterLevel: WATER_LEVEL },
    extraBlocks: resolver.extraBlocks,
    environment: environmentFor(width, depth),
    generate(world) {
      // Solid floor so there are never bottomless gaps to fall through.
      world.forEachColumn((x, z) => world.setBlock(x, 0, z, 'stone', false));
      for (let i = 0; i < xs.length; i += 1) {
        world.setBlock(xs[i] - halfW, ys[i], zs[i] - halfD, types[i], false, shapes[i]);
      }
    },
  };
}

export default importMinecraftMap;
