// Decompression helpers built on the native DecompressionStream API (available
// in every modern browser and in Node 18+), so no external dependency is
// needed to read gzip/zlib/raw-deflate data from Minecraft saves.

async function inflate(bytes, format) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const stream = new Response(input).body.pipeThrough(new DecompressionStream(format));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

// gzip (level.dat, region compression type 1)
export function gunzip(bytes) {
  return inflate(bytes, 'gzip');
}

// zlib stream (region compression type 2 — the common one)
export function zlibInflate(bytes) {
  return inflate(bytes, 'deflate');
}

// raw deflate (zip entries with method 8)
export function rawInflate(bytes) {
  return inflate(bytes, 'deflate-raw');
}

// Auto-detect by magic bytes: gzip (1f 8b), zlib (78 xx), otherwise raw deflate.
export async function autoInflate(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0x1f && b[1] === 0x8b) return gunzip(b);
  if (b[0] === 0x78) return zlibInflate(b);
  return rawInflate(b);
}
