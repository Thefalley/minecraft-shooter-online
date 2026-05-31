import * as THREE from 'three';

// Procedural Minecraft-style pixel textures (16x16), generated on a canvas.
// (The real Minecraft textures are copyrighted, so these are look-alikes.)
//
// Two layers live here:
//   1. The hand-drawn textures for the game's built-in block types (grass, dirt,
//      stone, …) used by the bundled maps. Unchanged.
//   2. A parameterised generator used by IMPORTED blocks: given a colour (or a
//      per-face colour set) and a texture "kind" (planks, bricks, cobble, bark,
//      rings, gem, ore, glass, fuzzy, smooth, speckle) it synthesises a matching
//      pixel texture so a Minecraft block looks like itself instead of a flat
//      colour cube. Blocks can also be transparent and/or emissive.
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

// --- snow biome textures --------------------------------------------------
function drawSnow(ctx) { speckle(ctx, '#f3f7fb', ['#ffffff', '#e4edf5', '#dbe6f0'], 211, 0.3); }

function drawIce(ctx) {
  speckle(ctx, '#a7d8ef', ['#bce6f7', '#8fcbe8', '#cdeefb'], 223, 0.22);
  // a couple of glossy cracks
  const rand = rng(229);
  ctx.fillStyle = '#d8f1fb';
  for (let i = 0; i < 5; i += 1) {
    const x = Math.floor(rand() * SIZE);
    const len = 3 + Math.floor(rand() * 6);
    for (let y = 0; y < len; y += 1) ctx.fillRect(x, (Math.floor(rand() * SIZE) + y) % SIZE, 1, 1);
  }
}

function drawSpruceLog(ctx) {
  speckle(ctx, '#4a3320', ['#3c2918', '#553b24', '#332113'], 233, 0.32);
  const rand = rng(239);
  for (let x = 0; x < SIZE; x += 2) {
    ctx.fillStyle = rand() < 0.5 ? '#3a2716' : '#553b24';
    ctx.fillRect(x, 0, 1, SIZE);
  }
}

function drawSpruceLeaves(ctx) {
  speckle(ctx, '#28452f', ['#1f3a27', '#33543a', '#1a3322', '#3c6044'], 241, 0.6);
  // dusting of snow caught in the needles
  const rand = rng(251);
  for (let i = 0; i < 26; i += 1) {
    ctx.fillStyle = rand() < 0.5 ? '#eef5fb' : '#d7e6f1';
    ctx.fillRect(Math.floor(rand() * SIZE), Math.floor(rand() * SIZE), 1, 1);
  }
}

// --- colour helpers ----------------------------------------------------------
function clampByte(v) { return Math.max(0, Math.min(255, Math.round(v))); }
function toHex(r, g, b) {
  return `#${[r, g, b].map((v) => clampByte(v).toString(16).padStart(2, '0')).join('')}`;
}
function baseHex(color) { return toHex((color >> 16) & 255, (color >> 8) & 255, color & 255); }
function shadeHex(color, f) {
  return toHex(((color >> 16) & 255) * f, ((color >> 8) & 255) * f, (color & 255) * f);
}
function shadeSet(color, factors) { return factors.map((f) => shadeHex(color, f)); }
function seedOf(kind, color) {
  let h = (color >>> 0) ^ 0x9e3779b9;
  for (let i = 0; i < kind.length; i += 1) h = (Math.imul(h, 31) + kind.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

// --- parameterised draw kinds for imported blocks ----------------------------
function drawKindSpeckle(ctx, color, density = 0.3) {
  speckle(ctx, baseHex(color), shadeSet(color, [0.86, 1.12, 0.74]), seedOf('speckle', color), density);
}
function drawKindSmooth(ctx, color) {
  // near-flat (concrete / smooth stone): very light dithering only.
  speckle(ctx, baseHex(color), shadeSet(color, [0.96, 1.04]), seedOf('smooth', color), 0.1);
}
function drawKindFuzzy(ctx, color) {
  // wool / carpet: soft dense two-tone noise.
  speckle(ctx, baseHex(color), shadeSet(color, [0.9, 1.08, 0.82]), seedOf('fuzzy', color), 0.5);
}
function drawKindPlanks(ctx, color) {
  speckle(ctx, baseHex(color), shadeSet(color, [0.93, 1.06]), seedOf('planks', color), 0.16);
  ctx.fillStyle = shadeHex(color, 0.68);
  for (let y = 3; y < SIZE; y += 4) ctx.fillRect(0, y, SIZE, 1); // horizontal plank seams
  const rand = rng(seedOf('planks2', color));
  for (let y = 0; y < SIZE; y += 4) { // staggered board ends
    const x = Math.floor(rand() * SIZE);
    ctx.fillRect(x, y, 1, 3);
  }
}
function drawKindBricks(ctx, color) {
  speckle(ctx, baseHex(color), shadeSet(color, [0.92, 1.07]), seedOf('bricks', color), 0.12);
  ctx.fillStyle = shadeHex(color, 0.66);
  for (let y = 0; y < SIZE; y += 4) ctx.fillRect(0, y, SIZE, 1);       // mortar rows
  for (let y = 0; y < SIZE; y += 8) ctx.fillRect(0, y, 1, 4);          // verticals, row A
  for (let y = 0; y < SIZE; y += 8) ctx.fillRect(8, y, 1, 4);
  for (let y = 4; y < SIZE; y += 8) ctx.fillRect(4, y, 1, 4);          // verticals, offset row B
  for (let y = 4; y < SIZE; y += 8) ctx.fillRect(12, y, 1, 4);
}
function drawKindCobble(ctx, color) {
  speckle(ctx, baseHex(color), shadeSet(color, [0.74, 1.14, 0.6, 0.95]), seedOf('cobble', color), 0.5);
  // a few dark mortar gaps
  const rand = rng(seedOf('cobble2', color));
  ctx.fillStyle = shadeHex(color, 0.5);
  for (let i = 0; i < 10; i += 1) ctx.fillRect(Math.floor(rand() * SIZE), Math.floor(rand() * SIZE), 1, 1);
}
function drawKindBark(ctx, color) {
  speckle(ctx, baseHex(color), shadeSet(color, [0.82, 1.1, 0.7]), seedOf('bark', color), 0.32);
  const rand = rng(seedOf('bark2', color));
  for (let x = 0; x < SIZE; x += 2) {
    ctx.fillStyle = rand() < 0.5 ? shadeHex(color, 0.74) : shadeHex(color, 1.12);
    ctx.fillRect(x, 0, 1, SIZE);
  }
}
function drawKindRings(ctx, color) {
  // log end grain: concentric squares around the centre.
  speckle(ctx, baseHex(color), shadeSet(color, [0.9, 1.08]), seedOf('rings', color), 0.18);
  ctx.strokeStyle = shadeHex(color, 0.74);
  ctx.lineWidth = 1;
  for (let r = 1; r < 8; r += 2) ctx.strokeRect(r + 0.5, r + 0.5, SIZE - 2 * r - 1, SIZE - 2 * r - 1);
}
function drawKindGem(ctx, color) {
  // solid gem / mineral block: base with bright crystalline flecks.
  speckle(ctx, baseHex(color), shadeSet(color, [0.85, 1.16, 0.72]), seedOf('gem', color), 0.28);
  const rand = rng(seedOf('gem2', color));
  ctx.fillStyle = shadeHex(color, 1.45);
  for (let i = 0; i < 12; i += 1) ctx.fillRect(Math.floor(rand() * SIZE), Math.floor(rand() * SIZE), 1, 1);
}
function drawKindOre(ctx, gemColor, baseColor) {
  // ore: stone base with a few clustered gem specks.
  speckle(ctx, baseHex(baseColor), shadeSet(baseColor, [0.88, 1.08, 0.78]), seedOf('ore', baseColor), 0.3);
  const rand = rng(seedOf('ore2', gemColor));
  for (let c = 0; c < 5; c += 1) {
    const cx = 2 + Math.floor(rand() * 11);
    const cy = 2 + Math.floor(rand() * 11);
    for (let j = 0; j < 4; j += 1) {
      ctx.fillStyle = rand() < 0.5 ? baseHex(gemColor) : shadeHex(gemColor, 1.3);
      ctx.fillRect(cx + (j & 1), cy + ((j >> 1) & 1), 1, 1);
    }
  }
}
function drawKindGlass(ctx, color) {
  ctx.fillStyle = baseHex(color);
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = shadeHex(color, 1.35); // lighter pane frame
  ctx.fillRect(0, 0, SIZE, 1); ctx.fillRect(0, 0, 1, SIZE);
  ctx.fillRect(0, SIZE - 1, SIZE, 1); ctx.fillRect(SIZE - 1, 0, 1, SIZE);
  ctx.fillStyle = shadeHex(color, 1.2); // a diagonal glint
  for (let i = 0; i < 6; i += 1) ctx.fillRect(3 + i, 3 + i, 1, 1);
}

// Returns a CanvasTexture for one face of a dynamic block, cached by signature.
const dynCache = new Map();
function faceTexture(kind, color, baseColor) {
  const sig = `${kind}:${color}:${baseColor ?? ''}`;
  const hit = dynCache.get(sig);
  if (hit) return hit;
  let draw;
  switch (kind) {
    case 'smooth': draw = (c) => drawKindSmooth(c, color); break;
    case 'fuzzy': draw = (c) => drawKindFuzzy(c, color); break;
    case 'planks': draw = (c) => drawKindPlanks(c, color); break;
    case 'bricks': draw = (c) => drawKindBricks(c, color); break;
    case 'cobble': draw = (c) => drawKindCobble(c, color); break;
    case 'bark': draw = (c) => drawKindBark(c, color); break;
    case 'rings': draw = (c) => drawKindRings(c, color); break;
    case 'gem': draw = (c) => drawKindGem(c, color); break;
    case 'ore': draw = (c) => drawKindOre(c, color, baseColor ?? 0x7e7e7e); break;
    case 'glass': draw = (c) => drawKindGlass(c, color); break;
    case 'coarse': draw = (c) => drawKindSpeckle(c, color, 0.55); break;
    case 'speckle':
    default: draw = (c) => drawKindSpeckle(c, color); break;
  }
  const tex = canvasTexture(draw);
  dynCache.set(sig, tex);
  return tex;
}

// Back-compat: flat-colour tinted-noise cube for dynamic blocks with only a color.
function solidTexture(color) { return faceTexture('speckle', color); }

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
    snow: canvasTexture(drawSnow),
    ice: canvasTexture(drawIce),
    spruce_log: canvasTexture(drawSpruceLog),
    spruce_leaves: canvasTexture(drawSpruceLeaves),
  };
  return textures;
}

// Builds the per-block-type materials. Grass uses a 6-face material array
// (grassy top, grass-edged sides, dirt bottom); built-in types use their
// hand-drawn texture; imported blocks synthesise a texture from their config
// (per-face colours, a texture kind, transparency and emission).
export function createBlockMaterials(blockTypes) {
  const tex = getTextures();
  const make = (map, cfg) => {
    const emissive = cfg.emissive != null;
    return new THREE.MeshStandardMaterial({
      map,
      roughness: cfg.roughness ?? 0.9,
      metalness: cfg.metalness ?? 0,
      transparent: Boolean(cfg.transparent),
      opacity: cfg.opacity ?? 1,
      depthWrite: cfg.depthWrite ?? !cfg.transparent,
      side: cfg.transparent ? THREE.DoubleSide : THREE.FrontSide,
      emissive: new THREE.Color(emissive ? cfg.emissive : 0x000000),
      emissiveMap: emissive ? map : null,
      emissiveIntensity: emissive ? (cfg.emissiveIntensity ?? 0.85) : 1,
    });
  };

  // BoxGeometry group order: +X, -X, +Y(top), -Y(bottom), +Z, -Z
  const faceArray = (side, top, bottom) => [side, side, top, bottom, side, side];

  const dynamicMaterial = (cfg) => {
    if (cfg.faces) {
      const f = cfg.faces;
      const top = make(faceTexture(f.top.kind ?? 'speckle', f.top.color, f.top.base), cfg);
      const side = make(faceTexture(f.side.kind ?? 'speckle', f.side.color, f.side.base), cfg);
      const bottomFace = f.bottom ?? f.side;
      const bottom = make(faceTexture(bottomFace.kind ?? 'speckle', bottomFace.color, bottomFace.base), cfg);
      return faceArray(side, top, bottom);
    }
    const map = cfg.color != null
      ? faceTexture(cfg.texture ?? 'speckle', cfg.color, cfg.baseColor)
      : tex.stone;
    return make(map, cfg);
  };

  const materials = new Map();
  for (const [type, cfg] of Object.entries(blockTypes)) {
    if (type === 'grass') {
      const side = make(tex.grass_side, cfg);
      const top = make(tex.grass_top, cfg);
      const bottom = make(tex.dirt, cfg);
      materials.set('grass', faceArray(side, top, bottom));
    } else if (tex[type]) {
      // Built-in block with a hand-drawn texture.
      materials.set(type, make(tex[type], cfg));
    } else {
      // Imported / dynamic block.
      materials.set(type, dynamicMaterial(cfg));
    }
  }
  return materials;
}

export default createBlockMaterials;
