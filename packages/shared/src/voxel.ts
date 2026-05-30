import type { BlockType } from "./types";

export const BLOCK_TYPES = [
  "grass",
  "dirt",
  "stone",
  "sand",
  "wood",
  "leaves",
  "water",
] as const satisfies readonly BlockType[];

export type BlockId = number;

export const BLOCK_TO_ID: Readonly<Record<BlockType, BlockId>> = Object.freeze({
  grass: 1,
  dirt: 2,
  stone: 3,
  sand: 4,
  wood: 5,
  leaves: 6,
  water: 7,
});

export const ID_TO_BLOCK: Readonly<Record<BlockId, BlockType>> = Object.freeze(
  Object.fromEntries(
    Object.entries(BLOCK_TO_ID).map(([k, v]) => [v, k as BlockType]),
  ) as Record<BlockId, BlockType>,
);

export interface WorldOptions {
  seed: number;
  width: number;
  depth: number;
  maxHeight: number;
  waterLevel: number;
}

/** "x,y,z" — primary key used throughout the codebase */
export function blockKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export function parseBlockKey(key: string): [number, number, number] {
  const [xs, ys, zs] = key.split(",");
  return [Number(xs), Number(ys), Number(zs)];
}
