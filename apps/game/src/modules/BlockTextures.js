import * as THREE from 'three';

// Procedural Minecraft-style pixel textures (16x16), generated on a canvas.
// (The real Minecraft textures are copyrighted, so these are look-alikes.)
const SIZE = 16;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvasTexture(drawFn) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  drawFn(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function speckle(ctx, base, shades, seed, density = 0.34) {
  const rand = rng(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, SIZE, SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (rand() < density) {
        ctx.fillStyle = shades[Math.floor(rand() * shades.length)];
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

const DIRT = ['#7a4e25', '#9c6a3a', '#6e4626'];

function drawDirt(ctx) { speckle(ctx, '#8a5a2b', DIRT, 11); }
function drawStone(ctx) { speckle(ctx, '#8a8d92', ['#7c7f84', '#9aa0a6', '#74777c'], 23); }
function drawSand(ctx) { speckle(ctx, '#ddc999', ['#e7d6ab', '#cdb98a', '#d3c092'], 37); }
function drawLeaves(ctx) { speckle(ctx, '#3a7d34', ['#2f6b2c', '#46913d', '#2a5e26', '#52a046'], 55, 0.55); }
function drawWater(ctx) { speckle(ctx, '#2f8ed8', ['#3f9ee0', '#2a7ec0', '#56b0e8'], 71, 0.25); }
function drawGrassTop(ctx) { speckle(ctx, '#5d9c3f', ['#6fb04a', '#4f8a35', '#73b352'], 91, 0.4); }

function drawWood(ctx) {
  // oak-log style bark with vertical streaks
  speckle(ctx, '#6e4a28', ['#5e3e22', '#7c5630', '#4f3318'], 101, 0.3);
  const rand = rng(131);
  for (let x = 0; x < SIZE; x += 2) {
    ctx.fillStyle = rand() < 0.5 ? '#5a3c20' : '#7e5832';
    ctx.fillRect(x, 0, 1, SIZE);
  }
}

function drawGrassSide(ctx) {
  drawDirt(ctx);
  const rand = rng(141);
  for (let x = 0; x < SIZE; x += 1) {
    const h = 3 + Math.floor(rand() * 3); // jagged grass edge
    for (let y = 0; y < h; y += 1) {
      const shades = ['#5d9c3f', '#6fb04a', '#4f8a35'];
      ctx.fillStyle = shades[Math.floor(rand() * shades.length)];
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

let textures = null;

function getTextures() {
  if (textures) return textures;
  textures = {
    grass_top: canvasTexture(drawGrassTop),
    grass_side: canvasTexture(drawGrassSide),
    dirt: canvasTexture(drawDirt),
    stone: canvasTexture(drawStone),
    sand: canvasTexture(drawSand),
    wood: canvasTexture(drawWood),
    leaves: canvasTexture(drawLeaves),
    water: canvasTexture(drawWater),
  };
  return textures;
}

// Builds the per-block-type materials. Grass uses a 6-face material array
// (grassy top, grass-edged sides, dirt bottom); the rest are single textures.
export function createBlockMaterials(blockTypes) {
  const tex = getTextures();
  const make = (map, cfg) => new THREE.MeshStandardMaterial({
    map,
    roughness: cfg.roughness ?? 0.9,
    metalness: cfg.metalness ?? 0,
    transparent: Boolean(cfg.transparent),
    opacity: cfg.opacity ?? 1,
    depthWrite: !cfg.transparent,
    side: cfg.transparent ? THREE.DoubleSide : THREE.FrontSide,
  });

  const materials = new Map();
  for (const [type, cfg] of Object.entries(blockTypes)) {
    if (type === 'grass') {
      const side = make(tex.grass_side, cfg);
      const top = make(tex.grass_top, cfg);
      const bottom = make(tex.dirt, cfg);
      // BoxGeometry group order: +X, -X, +Y(top), -Y(bottom), +Z, -Z
      materials.set('grass', [side, side, top, bottom, side, side]);
    } else {
      materials.set(type, make(tex[type] ?? tex.stone, cfg));
    }
  }
  return materials;
}

export default createBlockMaterials;
