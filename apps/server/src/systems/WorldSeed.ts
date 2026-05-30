/**
 * Deterministic seeded RNG. The same `seed` always produces the same stream
 * of doubles in [0, 1). Used so the server and every client can regenerate
 * the same base voxel world from a single `uint32`.
 *
 * Reference: https://gist.github.com/tommyettinger/46a3a48b8862534c11ec3
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function rand(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a fresh uint32 seed using the host's CSPRNG-grade `Math.random`. */
export function pickSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}
