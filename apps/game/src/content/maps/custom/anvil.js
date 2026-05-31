// Anvil region (.mca) reader. A region file holds up to 32x32 chunks behind a
// 8 KiB header; each chunk is a compressed NBT structure. This extracts the
// block grid from chunks in the modern palette formats:
//   - 1.18+   : root `sections[]`, each with `block_states.{palette,data}`
//   - 1.13-17 : root `Level.Sections[]`, each with `Palette` + `BlockStates`
// Legacy numeric-id chunks (pre 1.13) are not supported.

import { parseNBT } from './nbt.js';
import { zlibInflate, gunzip } from './decompress.js';
import { ANVIL_UNPACK_WASM_B64 } from './anvil-unpack-wasm.js';

const SECTOR = 4096;

// --- optional WASM acceleration of the block-state unpacker -------------------
// WASM has native u64, so the 64-bit bit math runs without BigInt. The module is
// tiny (<4 KB) so it compiles synchronously on the main thread; if WebAssembly is
// unavailable or fails, unpackIndices falls back to the pure-JS path below.
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

let WASM; // undefined = not tried, null = unavailable, object = ready
function wasmUnpacker() {
  if (WASM !== undefined) return WASM;
  try {
    const module = new WebAssembly.Module(b64ToBytes(ANVIL_UNPACK_WASM_B64));
    const instance = new WebAssembly.Instance(module, {});
    const mem = instance.exports.memory;
    // The stub-runtime module starts with ~0 pages; grow so the output region
    // (byte 16384) plus a full 4096-entry section fits, then build the views.
    const NEEDED = 16384 + 4096 * 2;
    if (mem.buffer.byteLength < NEEDED) {
      mem.grow(Math.ceil((NEEDED - mem.buffer.byteLength) / 65536));
    }
    WASM = {
      unpack: instance.exports.unpack,
      longs: new BigInt64Array(mem.buffer, 0),     // packed longs at byte 0
      out: new Uint16Array(mem.buffer, 16384),      // unpacked indices at byte 16384
      maxLongs: 16384 / 8,
      capacity: (mem.buffer.byteLength - 16384) / 2,
    };
  } catch {
    WASM = null;
  }
  return WASM;
}

function stripNamespace(name) {
  if (!name) return name;
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
}

const AIR = new Set(['air', 'cave_air', 'void_air']);
export function isAir(name) {
  return !name || AIR.has(name);
}

function ceilLog2(n) {
  return n <= 1 ? 0 : Math.ceil(Math.log2(n));
}

// Unpacks `count` palette indices from an array of 64-bit longs (BigInt).
// padded=false (pre-1.16) packs bits tightly across long boundaries;
// padded=true (1.16+) keeps each long's entries from spanning into the next.
export function unpackIndices(longs, bits, count, padded) {
  // Fast path: hand the longs to WASM (native u64), read the indices back.
  const w = wasmUnpacker();
  if (w && longs.length <= w.maxLongs && count <= w.capacity) {
    for (let k = 0; k < longs.length; k += 1) w.longs[k] = longs[k];
    w.unpack(bits, count, padded ? 1 : 0);
    const wout = new Uint16Array(count);
    wout.set(w.out.subarray(0, count));
    return wout;
  }

  const out = new Uint16Array(count);
  // Block-state palettes cap at 4096 entries, so bits <= 12 and the mask fits a
  // plain 32-bit Number — no BigInt mask needed.
  const mask = (1 << bits) - 1;

  if (padded) {
    // Modern (1.16+) packing: entries never span a 64-bit boundary. Split each
    // long into two unsigned 32-bit words ONCE (the only BigInt left, O(longs)),
    // then resolve every entry with plain Number bit math — O(count) BigInt-free.
    const n = longs.length;
    const lo = new Uint32Array(n);
    const hi = new Uint32Array(n);
    for (let k = 0; k < n; k += 1) {
      const u = BigInt.asUintN(64, longs[k]);
      lo[k] = Number(u & 0xffffffffn);
      hi[k] = Number(u >> 32n);
    }
    const perLong = Math.floor(64 / bits);
    for (let i = 0; i < count; i += 1) {
      const li = (i / perLong) | 0;
      const shift = (i - li * perLong) * bits;
      if (shift + bits <= 32) {
        out[i] = (lo[li] >>> shift) & mask;
      } else if (shift >= 32) {
        out[i] = (hi[li] >>> (shift - 32)) & mask;
      } else {
        // Entry straddles the 32-bit word split inside this one long.
        out[i] = ((lo[li] >>> shift) | (hi[li] << (32 - shift))) & mask;
      }
    }
    return out;
  }

  // Legacy (pre-1.16) tight packing can span 64-bit boundaries; kept on BigInt
  // for correctness — this path is only reached by very old maps.
  const u = longs.map((v) => BigInt.asUintN(64, v));
  const bmask = (1n << BigInt(bits)) - 1n;
  for (let i = 0; i < count; i += 1) {
    const bitPos = i * bits;
    const li = bitPos >> 6;
    const offset = BigInt(bitPos & 63);
    let value = u[li] >> offset;
    if ((bitPos & 63) + bits > 64 && li + 1 < u.length) {
      value |= u[li + 1] << (64n - offset);
    }
    out[i] = Number(value & bmask);
  }
  return out;
}

async function decompressChunk(compType, bytes) {
  if (compType === 1) return gunzip(bytes);
  if (compType === 2) return zlibInflate(bytes);
  if (compType === 3) return bytes; // uncompressed
  throw new Error(`Compresión de chunk no soportada: ${compType}`);
}

// Calls cb(chunkNBT, chunkX, chunkZ) for every present chunk in the region.
export async function eachChunk(regionBytes, regionX, regionZ, cb) {
  const bytes = regionBytes instanceof Uint8Array ? regionBytes : new Uint8Array(regionBytes);
  if (bytes.byteLength < SECTOR) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let index = 0; index < 1024; index += 1) {
    const loc = index * 4;
    const sectorOffset = (bytes[loc] << 16) | (bytes[loc + 1] << 8) | bytes[loc + 2];
    const sectorCount = bytes[loc + 3];
    if (sectorOffset === 0 || sectorCount === 0) continue;

    const start = sectorOffset * SECTOR;
    if (start + 5 > bytes.byteLength) continue;
    const length = view.getUint32(start, false);
    if (length <= 0 || start + 4 + length > bytes.byteLength) continue;
    const compType = bytes[start + 4];
    const payload = bytes.subarray(start + 5, start + 4 + length);

    let nbt;
    try {
      nbt = parseNBT(await decompressChunk(compType, payload));
    } catch {
      continue; // skip unreadable chunks rather than aborting the whole import
    }

    const chunkX = regionX * 32 + (index % 32);
    const chunkZ = regionZ * 32 + Math.floor(index / 32);
    cb(nbt, chunkX, chunkZ);
  }
}

// Walks the sections of one chunk, calling onBlock(x, y, z, blockName, props) for
// every non-air block (absolute world coordinates). `props` is the palette
// entry's block-state Properties (facing/half/type/…) or null — used by the
// importer to pick slab/stair/layer geometry.
export function extractBlocks(nbt, chunkX, chunkZ, onBlock) {
  const dataVersion = nbt.DataVersion ?? (nbt.Level && nbt.Level.DataVersion) ?? 0;
  const padded = dataVersion >= 2529; // 1.16+ uses non-spanning packing

  let sections;
  if (Array.isArray(nbt.sections)) sections = nbt.sections;
  else if (nbt.Level && Array.isArray(nbt.Level.Sections)) sections = nbt.Level.Sections;
  else return;

  for (const sec of sections) {
    const sectionY = sec.Y;
    if (sectionY === undefined) continue;

    let palette;
    let data;
    if (sec.block_states) { palette = sec.block_states.palette; data = sec.block_states.data; }
    else if (sec.Palette) { palette = sec.Palette; data = sec.BlockStates; }
    else continue;
    if (!palette || palette.length === 0) continue;

    const names = palette.map((p) => stripNamespace(p && p.Name));
    const props = palette.map((p) => (p && p.Properties) || null);

    // Single-entry palettes omit the data array: the whole section is that block.
    if (palette.length === 1 || !data || data.length === 0) {
      const name = names[0];
      if (isAir(name)) continue;
      const prop = props[0];
      for (let i = 0; i < 4096; i += 1) {
        const x = i & 15;
        const z = (i >> 4) & 15;
        const y = (i >> 8) & 15;
        onBlock(chunkX * 16 + x, sectionY * 16 + y, chunkZ * 16 + z, name, prop);
      }
      continue;
    }

    const bits = Math.max(4, ceilLog2(palette.length));
    const indices = unpackIndices(data, bits, 4096, padded);
    for (let i = 0; i < 4096; i += 1) {
      const idx = indices[i];
      const name = names[idx];
      if (isAir(name)) continue;
      const x = i & 15;
      const z = (i >> 4) & 15;
      const y = (i >> 8) & 15;
      onBlock(chunkX * 16 + x, sectionY * 16 + y, chunkZ * 16 + z, name, props[idx]);
    }
  }
}

// Parses a region filename like "r.-1.2.mca" into [regionX, regionZ].
export function parseRegionCoords(path) {
  const m = /r\.(-?\d+)\.(-?\d+)\.mca$/.exec(path);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}
