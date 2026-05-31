// Minecraft block → Voxel render spec database.
//
// Each Minecraft block resolves to one of:
//   { type: 'grass' }                 -> reuse a built-in game block type
//   { spec: { …material config… } }   -> a dynamic block carrying its own colour,
//                                          texture kind, transparency and emission
//   { skip: true }                    -> a non-solid decoration we drop on import
//
// The material config understands (consumed by engine/textures/BlockTextures.js):
//   color, texture ('speckle'|'smooth'|'fuzzy'|'planks'|'bricks'|'cobble'|'bark'|
//                   'rings'|'gem'|'ore'|'glass'|'coarse'), baseColor (for ore),
//   faces:{ top, side, bottom?:{ color, kind, base } }, roughness, metalness,
//   transparent, opacity, depthWrite, emissive, emissiveIntensity.
//
// Colours are look-alikes of the real (copyrighted) Minecraft textures.

// ---- helpers ----------------------------------------------------------------
const dyn = (color, texture = 'speckle', extra = {}) => ({ color, texture, ...extra });
const facesSpec = (top, side, bottom, extra = {}) => ({ faces: { top, side, ...(bottom ? { bottom } : {}) }, ...extra });
const face = (color, kind = 'speckle', base) => ({ color, kind, ...(base != null ? { base } : {}) });

// ---- colour-word palettes ---------------------------------------------------
const WOOL = {
  white: 0xe9ecec, orange: 0xf07613, magenta: 0xbd44b3, light_blue: 0x3aafd9, yellow: 0xf8c627,
  lime: 0x70b919, pink: 0xed8dac, gray: 0x3e4447, light_gray: 0x8e8e87, cyan: 0x158991,
  purple: 0x7b2fbe, blue: 0x35399d, brown: 0x724728, green: 0x546d1b, red: 0xa02722, black: 0x141519,
};
const CONCRETE = {
  white: 0xcfd5d6, orange: 0xe06101, magenta: 0xa9309f, light_blue: 0x2389c7, yellow: 0xf0af15,
  lime: 0x5ea919, pink: 0xd6658f, gray: 0x363a3d, light_gray: 0x7d7d73, cyan: 0x157788,
  purple: 0x641f9c, blue: 0x2c2e8f, brown: 0x603c20, green: 0x495b24, red: 0x8e2121, black: 0x080a0f,
};
const TERRACOTTA = {
  white: 0xd1b1a1, orange: 0xa15326, magenta: 0x95576c, light_blue: 0x716c8a, yellow: 0xba8523,
  lime: 0x677535, pink: 0xa24e4e, gray: 0x3a2b25, light_gray: 0x876b62, cyan: 0x565b5b,
  purple: 0x764656, blue: 0x4a3c5b, brown: 0x4d3324, green: 0x4c532a, red: 0x8f3d2e, black: 0x251610,
};
const GLASS = {
  white: 0xffffff, orange: 0xd87f33, magenta: 0xb24cd8, light_blue: 0x6699d8, yellow: 0xe5e533,
  lime: 0x7fcc19, pink: 0xf27fa5, gray: 0x4c4c4c, light_gray: 0x9a9a9a, cyan: 0x4c7f99,
  purple: 0x7f3fb2, blue: 0x334cb2, brown: 0x664c33, green: 0x667f33, red: 0x993333, black: 0x191919,
};
const DYE = { // generic dye colours for beds/banners/candles/etc.
  white: 0xf9ffff, orange: 0xf9801d, magenta: 0xc74ebd, light_blue: 0x3ab3da, yellow: 0xfed83d,
  lime: 0x80c71f, pink: 0xf38baa, gray: 0x474f52, light_gray: 0x9d9d97, cyan: 0x169c9c,
  purple: 0x8932b8, blue: 0x3c44aa, brown: 0x835432, green: 0x5e7c16, red: 0xb02e26, black: 0x1d1d21,
};

const PLANKS = {
  oak: 0xb08a4f, spruce: 0x6a4e30, birch: 0xc6b17b, jungle: 0xa77c55, acacia: 0xa85a33,
  dark_oak: 0x40301b, mangrove: 0x76333a, cherry: 0xe0b1ac, bamboo: 0xc5a05a,
  crimson: 0x6a2d3f, warped: 0x2b6b62,
};
const LOGS = {
  oak: { side: 0x6d5435, top: 0xb29156 }, spruce: { side: 0x3b2c1a, top: 0x695130 },
  birch: { side: 0xd7d3cc, top: 0xc8be9b }, jungle: { side: 0x55421e, top: 0xab8350 },
  acacia: { side: 0x68645c, top: 0xa85b33 }, dark_oak: { side: 0x382b1a, top: 0x4d3a21 },
  mangrove: { side: 0x53301f, top: 0x77402f }, cherry: { side: 0x46342f, top: 0xd6a8a2 },
  crimson: { side: 0x4e1f2c, top: 0x8b3a4a }, warped: { side: 0x2c4a45, top: 0x398179 },
};
const LEAVES = {
  oak: 0x59a22b, birch: 0x80a755, spruce: 0x4f7a55, jungle: 0x4ea22b, acacia: 0x6ca22b,
  dark_oak: 0x529a2b, mangrove: 0x4da22b, cherry: 0xebb7cc, azalea: 0x647a37,
  flowering_azalea: 0x6e7c3e, oak_flowering: 0x6e7c3e,
};
const ORE_GEM = {
  coal: 0x21211f, iron: 0xd8a878, copper: 0x5fb89a, gold: 0xfcee4b, redstone: 0xd21a1a,
  diamond: 0x5be8df, lapis: 0x2f55c0, emerald: 0x2bd25c, quartz: 0xe6ddd0,
};

const SPECIES = Object.keys(PLANKS).concat(['warped', 'crimson']);
const COLOR_WORDS = Object.keys(WOOL); // longest-first handled in matcher

// ---- explicit, named blocks -------------------------------------------------
// (Families like wool/planks/ores are handled by rules below; this table is for
// one-off blocks with distinctive looks.)
const BLOCKS = {
  // terrain
  coarse_dirt: dyn(0x7a5638, 'coarse'),
  rooted_dirt: dyn(0x84604a),
  podzol: facesSpec(face(0x5c3f1b), face(0x6e4c2a)),
  mycelium: facesSpec(face(0x6f6478), face(0x6e5a52)),
  grass_path: facesSpec(face(0x8c7340), face(0x77592f)),
  dirt_path: facesSpec(face(0x8c7340), face(0x77592f)),
  farmland: facesSpec(face(0x6b4a2b), face(0x866043)),
  moss_block: dyn(0x596e2e, 'coarse'),
  moss_carpet: dyn(0x596e2e, 'coarse'),
  mud: dyn(0x3c3537),
  muddy_mangrove_roots: dyn(0x40342c),
  clay: dyn(0xa4a8b6, 'smooth'),
  gravel: dyn(0x827e7c, 'coarse'),
  powder_snow: dyn(0xf7fbfb, 'smooth'),
  packed_ice: dyn(0x8db1eb, 'smooth', { roughness: 0.3, metalness: 0.05 }),
  blue_ice: dyn(0x74a6f0, 'smooth', { roughness: 0.2, metalness: 0.1 }),

  // stone family
  cobblestone: dyn(0x7a7a7a, 'cobble'),
  mossy_cobblestone: dyn(0x6e7560, 'cobble'),
  stone_bricks: dyn(0x7a7a78, 'bricks'),
  mossy_stone_bricks: dyn(0x6e7468, 'bricks'),
  cracked_stone_bricks: dyn(0x767674, 'bricks'),
  chiseled_stone_bricks: dyn(0x787876, 'bricks'),
  smooth_stone: dyn(0xa0a0a0, 'smooth'),
  granite: dyn(0x9a6b58),
  polished_granite: dyn(0xa17363, 'smooth'),
  diorite: dyn(0xbdbdbe),
  polished_diorite: dyn(0xc4c4c6, 'smooth'),
  andesite: dyn(0x888889),
  polished_andesite: dyn(0x999a9b, 'smooth'),
  deepslate: facesSpec(face(0x4f4f52, 'rings'), face(0x575759, 'bark')),
  cobbled_deepslate: dyn(0x4c4c4f, 'cobble'),
  polished_deepslate: dyn(0x484849, 'smooth'),
  deepslate_bricks: dyn(0x474749, 'bricks'),
  cracked_deepslate_bricks: dyn(0x434345, 'bricks'),
  deepslate_tiles: dyn(0x3b3b3d, 'bricks'),
  chiseled_deepslate: dyn(0x3f3f41, 'bricks'),
  reinforced_deepslate: dyn(0x4a4d44, 'bricks'),
  tuff: dyn(0x6b6c66),
  calcite: dyn(0xdedede, 'smooth'),
  dripstone_block: dyn(0x896c5b),
  pointed_dripstone: dyn(0x86695a),
  bedrock: dyn(0x555555, 'coarse'),
  blackstone: dyn(0x2a252b),
  gilded_blackstone: dyn(0x312a29, 'ore', { baseColor: 0x2a252b, color: 0xfcee4b }),
  polished_blackstone: dyn(0x2e2b33, 'smooth'),
  polished_blackstone_bricks: dyn(0x2b282f, 'bricks'),
  cracked_polished_blackstone_bricks: dyn(0x29262d, 'bricks'),
  basalt: facesSpec(face(0x494950, 'rings'), face(0x515159, 'bark')),
  polished_basalt: facesSpec(face(0x53535a, 'rings'), face(0x53535a, 'bark')),
  smooth_basalt: dyn(0x48484e, 'smooth'),
  obsidian: dyn(0x14121f, 'gem'),
  crying_obsidian: dyn(0x1f0f33, 'gem', { emissive: 0x6a1bd0, emissiveIntensity: 0.35 }),
  amethyst_block: dyn(0x9a6fd0, 'gem'),
  budding_amethyst: dyn(0x8f64c8, 'gem'),
  netherrack: dyn(0x6e2b2b, 'coarse'),
  nether_wart_block: dyn(0x7a0c0c, 'coarse'),
  warped_wart_block: dyn(0x1a7672, 'coarse'),
  crimson_nylium: facesSpec(face(0x7b0f0f, 'coarse'), face(0x6e2b2b)),
  warped_nylium: facesSpec(face(0x2c7163, 'coarse'), face(0x6e2b2b)),
  soul_sand: dyn(0x52403a),
  soul_soil: dyn(0x4e3d33),
  magma_block: dyn(0x8e4125, 'gem', { emissive: 0xd24a12, emissiveIntensity: 0.45 }),
  end_stone: dyn(0xdbe0a4),
  chorus_plant: dyn(0x67466b),
  chorus_flower: dyn(0x9a72a0),
  purpur_block: dyn(0xa77ca7),
  purpur_pillar: facesSpec(face(0xad83ad, 'rings'), face(0xab7fab, 'bark')),

  // sand / sandstone
  red_sand: dyn(0xbe6621),
  sandstone: facesSpec(face(0xe0d6aa, 'smooth'), face(0xdbd0a0)),
  cut_sandstone: dyn(0xddd2a0, 'bricks'),
  smooth_sandstone: dyn(0xe2d8ac, 'smooth'),
  chiseled_sandstone: dyn(0xded4a2, 'bricks'),
  red_sandstone: facesSpec(face(0xbc5e22, 'smooth'), face(0xb45b25)),
  cut_red_sandstone: dyn(0xb85b23, 'bricks'),
  smooth_red_sandstone: dyn(0xbe5e22, 'smooth'),
  chiseled_red_sandstone: dyn(0xb95c22, 'bricks'),

  // mineral / metal blocks
  coal_block: dyn(0x101010),
  iron_block: dyn(0xdcdcdc, 'smooth', { roughness: 0.4, metalness: 0.7 }),
  gold_block: dyn(0xf8d848, 'smooth', { roughness: 0.35, metalness: 0.8 }),
  diamond_block: dyn(0x6de0d7, 'gem', { roughness: 0.4, metalness: 0.3 }),
  emerald_block: dyn(0x42d070, 'gem', { roughness: 0.45, metalness: 0.3 }),
  lapis_block: dyn(0x1f4da8, 'gem'),
  redstone_block: dyn(0xab1709, 'smooth'),
  netherite_block: dyn(0x4a4248, 'smooth', { roughness: 0.45, metalness: 0.7 }),
  raw_iron_block: dyn(0xb08b6b),
  raw_copper_block: dyn(0xb4623f),
  raw_gold_block: dyn(0xdca928),
  copper_block: dyn(0xc06b4f, 'smooth', { roughness: 0.5, metalness: 0.6 }),

  // bricks / quartz / prismarine
  bricks: dyn(0x96604a, 'bricks'),
  mud_bricks: dyn(0x8a6a4e, 'bricks'),
  packed_mud: dyn(0x8c6c50),
  nether_bricks: dyn(0x2e1820, 'bricks'),
  cracked_nether_bricks: dyn(0x2b161e, 'bricks'),
  red_nether_bricks: dyn(0x440c0f, 'bricks'),
  chiseled_nether_bricks: dyn(0x2f1922, 'bricks'),
  prismarine: dyn(0x639a8e),
  prismarine_bricks: dyn(0x5f9c92, 'bricks'),
  dark_prismarine: dyn(0x335e4e, 'smooth'),
  quartz_block: dyn(0xece6df, 'smooth'),
  smooth_quartz: dyn(0xeee9e1, 'smooth'),
  quartz_bricks: dyn(0xeae4dc, 'bricks'),
  chiseled_quartz_block: dyn(0xe9e3db, 'bricks'),
  quartz_pillar: facesSpec(face(0xece6df, 'rings'), face(0xeae3d8, 'bark')),
  end_stone_bricks: dyn(0xdde2a4, 'bricks'),

  // decorative / utility
  bookshelf: facesSpec(face(0xb08a4f, 'planks'), face(0x70582f, 'planks')),
  chiseled_bookshelf: facesSpec(face(0xb08a4f, 'planks'), face(0x86663a, 'planks')),
  crafting_table: facesSpec(face(0x7a4f2b), face(0x6f4a28, 'planks')),
  furnace: facesSpec(face(0x6b6b6b, 'cobble'), face(0x676767, 'cobble')),
  blast_furnace: facesSpec(face(0x57575a, 'cobble'), face(0x4f4f52, 'cobble')),
  smoker: facesSpec(face(0x57463a), face(0x6f4a28, 'planks')),
  chest: dyn(0x99743a, 'planks'),
  trapped_chest: dyn(0x99743a, 'planks'),
  ender_chest: dyn(0x1d3331, 'gem', { emissive: 0x1b8b7a, emissiveIntensity: 0.2 }),
  barrel: facesSpec(face(0x8a6a3a, 'rings'), face(0x6f4a28, 'planks')),
  hay_block: facesSpec(face(0xa68b0e, 'rings'), face(0xc0a024, 'bark')),
  dried_kelp_block: dyn(0x39433a),
  pumpkin: facesSpec(face(0xc07615, 'rings'), face(0xc17618, 'bark')),
  carved_pumpkin: facesSpec(face(0xc07615, 'rings'), face(0xc17618, 'bark')),
  jack_o_lantern: facesSpec(face(0xc07615, 'rings'), face(0xd98a26, 'bark'), null, { emissive: 0xffae3a, emissiveIntensity: 0.6 }),
  melon: facesSpec(face(0x6e8c2e), face(0x768b3e, 'bark')),
  bone_block: facesSpec(face(0xe3decf, 'rings'), face(0xd7d0ba, 'bark')),
  sponge: dyn(0xc3c144, 'coarse'),
  wet_sponge: dyn(0xa3b13f, 'coarse'),
  slime_block: dyn(0x6fc05a, 'gem', { transparent: true, opacity: 0.75, depthWrite: true }),
  honey_block: dyn(0xe6a22b, 'gem', { transparent: true, opacity: 0.82, depthWrite: true }),
  honeycomb_block: dyn(0xe08a1e),
  target: dyn(0xd16b5e, 'smooth'),
  tnt: facesSpec(face(0xc1543b), face(0xb42e25, 'bark')),
  sculk: dyn(0x0e1419, 'coarse', { emissive: 0x0e5a63, emissiveIntensity: 0.18 }),
  sculk_catalyst: dyn(0x123036, 'coarse', { emissive: 0x18b3c4, emissiveIntensity: 0.25 }),
  lodestone: facesSpec(face(0x959596, 'rings'), face(0x767679, 'bark')),
  spawner: dyn(0x1b2632, 'cobble'),
  dragon_egg: dyn(0x110a1a, 'gem', { emissive: 0x4a1b6a, emissiveIntensity: 0.3 }),

  // light sources (emissive)
  glowstone: dyn(0xcaa64b, 'gem', { emissive: 0xffd87a, emissiveIntensity: 0.85 }),
  sea_lantern: dyn(0xbbc6bd, 'smooth', { emissive: 0xcfeede, emissiveIntensity: 0.75 }),
  shroomlight: dyn(0xf89345, 'coarse', { emissive: 0xffb45a, emissiveIntensity: 0.8 }),
  redstone_lamp: dyn(0x6e4424),
  ochre_froglight: facesSpec(face(0xe5e0b0, 'rings'), face(0xd9cf86, 'bark'), null, { emissive: 0xf2ecae, emissiveIntensity: 0.7 }),
  verdant_froglight: facesSpec(face(0xd6e0c2, 'rings'), face(0xb6cf86, 'bark'), null, { emissive: 0xd8f2ae, emissiveIntensity: 0.7 }),
  pearlescent_froglight: facesSpec(face(0xe8d6e0, 'rings'), face(0xdcb6cf, 'bark'), null, { emissive: 0xf2cee8, emissiveIntensity: 0.7 }),

  // glass
  glass: dyn(0xc3e0e8, 'glass', { transparent: true, opacity: 0.42, depthWrite: true }),
  glass_pane: dyn(0xc3e0e8, 'glass', { transparent: true, opacity: 0.42, depthWrite: true }),
  tinted_glass: dyn(0x29242e, 'glass', { transparent: true, opacity: 0.6, depthWrite: true }),

  // liquids (water reuses the built-in animated sheet; lava is an emissive cube)
  lava: dyn(0xd24a12, 'gem', { emissive: 0xff6a1a, emissiveIntensity: 0.75 }),
  flowing_lava: dyn(0xd24a12, 'gem', { emissive: 0xff6a1a, emissiveIntensity: 0.75 }),
};

// ---- non-solid decorations we skip on import --------------------------------
// Rendered as a full cube these become ugly floating blocks; better to omit them
// than fill gardens/redstone with colour cubes. (A future pass can give them
// cross/thin geometry.)
const SKIP_EXACT = new Set([
  'air', 'cave_air', 'void_air', 'barrier', 'light', 'structure_void',
  'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'redstone_torch', 'redstone_wall_torch',
  'fire', 'soul_fire', 'redstone_wire', 'tripwire', 'string', 'lever',
  'rail', 'powered_rail', 'detector_rail', 'activator_rail',
  'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'seagrass', 'tall_seagrass',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower',
  'lily_of_the_valley', 'wither_rose', 'sunflower', 'lilac', 'rose_bush', 'peony', 'torchflower',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'spore_blossom', 'pink_petals',
  'wheat', 'carrots', 'potatoes', 'beetroots', 'pumpkin_stem', 'melon_stem', 'sweet_berry_bush',
  'sugar_cane', 'kelp', 'kelp_plant', 'bamboo', 'bamboo_sapling', 'cocoa', 'nether_wart',
  'vine', 'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant',
  'glow_lichen', 'sculk_vein', 'hanging_roots', 'small_dripleaf', 'big_dripleaf', 'big_dripleaf_stem',
  'lily_pad', 'crimson_roots', 'warped_roots', 'nether_sprouts', 'cobweb',
  'brown_mushroom', 'red_mushroom', 'crimson_fungus', 'warped_fungus', 'oak_sapling',
  'spruce_sapling', 'birch_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling',
  'cherry_sapling', 'mangrove_propagule', 'azalea', 'flowering_azalea',
  'flower_pot', 'lantern', 'soul_lantern', 'chain', 'end_rod', 'lightning_rod',
  'tripwire_hook', 'comparator', 'repeater', 'tnt_minecart',
]);

function isSkippable(name) {
  if (SKIP_EXACT.has(name)) return true;
  return /(_sapling|_carpet|_button|_pressure_plate|_sign|_wall_sign|_hanging_sign|_banner|_candle|potted_)/.test(name)
    && !name.endsWith('_carpet'); // carpets are kept (thin but visible); rest skipped
}

// ---- shape suffixes treated as a full cube of the base material -------------
const SHAPE_SUFFIX = /_(stairs|slab|wall|fence_gate|fence|trapdoor|door|wall_gate)$/;
function baseOfShape(name) {
  // oak_stairs -> oak_planks ; cobblestone_wall -> cobblestone ; stone_brick_slab -> stone_bricks
  const m = SHAPE_SUFFIX.exec(name);
  if (!m) return null;
  let base = name.slice(0, m.index);
  if (base === 'cobblestone') return 'cobblestone';
  if (base === 'brick') return 'bricks';         // brick_slab -> bricks
  if (base.endsWith('_brick')) base += 's';      // stone_brick_slab -> stone_bricks
  if (SPECIES.includes(base)) base += '_planks'; // oak_slab -> oak_planks
  return base;
}

// ---- copper oxidation -------------------------------------------------------
function copperColor(name) {
  if (name.includes('oxidized')) return 0x53a386;
  if (name.includes('weathered')) return 0x6f9582;
  if (name.includes('exposed')) return 0xa1745a;
  return 0xc06b4f; // unaffected / waxed
}

// ---- keyword fallbacks (only when nothing else matched) ---------------------
const KEYWORD_COLORS = [
  [/glowstone|sea_lantern|shroomlight|lantern|froglight/, 0xe8c14a],
  [/lava|magma/, 0xd24a12], [/prismarine/, 0x5f9c92],
  [/slime/, 0x6fc05a], [/honey/, 0xe6a22b], [/quartz/, 0xece6df],
  [/diamond/, 0x6de0d7], [/emerald/, 0x42d070], [/gold/, 0xf8d848], [/iron/, 0xd8d8d8],
  [/lapis/, 0x1f4da8], [/redstone/, 0xab1709], [/amethyst/, 0x9a6fd0], [/copper/, 0xc06b4f],
  [/netherite|ancient_debris/, 0x4a4248], [/coal/, 0x101010], [/bone/, 0xe3decf],
  [/obsidian/, 0x14121f], [/pumpkin|melon/, 0xc07615], [/brick/, 0x96604a],
  [/sandstone/, 0xe0d6aa], [/blackstone|basalt|deepslate/, 0x3a3a3e],
  [/netherrack|nether/, 0x6e2b2b], [/end_stone|purpur|chorus/, 0xc9b6c9], [/mushroom/, 0xcaa67a],
];

function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
  const hue = ((h >>> 0) % 360) / 360;
  const s = 0.4;
  const l = 0.52;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue * 6) % 2) - 1));
  const m = l - c / 2;
  let r = 0; let g = 0; let b = 0;
  const seg = Math.floor(hue * 6);
  if (seg === 0) { r = c; g = x; } else if (seg === 1) { r = x; g = c; } else if (seg === 2) { g = c; b = x; } else if (seg === 3) { g = x; b = c; } else if (seg === 4) { r = x; b = c; } else { r = c; b = x; }
  return ((Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255));
}

// Finds the colour word at the START of a name, longest match first so
// 'light_gray'/'light_blue' win over 'gray'/'blue'.
function leadingColorWord(name) {
  if (name.startsWith('light_gray_')) return 'light_gray';
  if (name.startsWith('light_blue_')) return 'light_blue';
  for (const word of COLOR_WORDS) {
    if (name.startsWith(`${word}_`)) return word;
  }
  return null;
}

// Built-in game types we reuse verbatim for the dominant terrain blocks (their
// hand-drawn textures already look great).
const EXACT_BUILTIN = {
  grass_block: 'grass',
  dirt: 'dirt',
  stone: 'stone',
  sand: 'sand',
  snow: 'snow',
  snow_block: 'snow',
  ice: 'ice',
  water: 'water',
  flowing_water: 'water',
  bubble_column: 'water',
};

// Picks a render shape for a block from its name + block-state Properties.
// Returns 'cube' | 'slab_bottom' | 'slab_top' | 'layer' | 'post'. Stairs are
// approximated by a half-slab (top/bottom) — captures the half-height profile
// without a bespoke stepped geometry.
export function shapeOf(name, props) {
  if (name.endsWith('_slab')) {
    const t = props && props.type;
    if (t === 'double') return 'cube';
    return t === 'top' ? 'slab_top' : 'slab_bottom';
  }
  if (name.endsWith('_stairs')) {
    return props && props.half === 'top' ? 'slab_top' : 'slab_bottom';
  }
  if (name === 'snow') {
    const layers = props && props.layers ? parseInt(props.layers, 10) : 8;
    return layers >= 8 ? 'cube' : 'layer';
  }
  if (name.endsWith('_carpet') || name === 'moss_carpet') return 'layer';
  if (name.endsWith('_fence') || name.endsWith('_fence_gate') || name.endsWith('_wall')
    || name === 'iron_bars' || name.endsWith('glass_pane')) return 'post';
  return 'cube';
}

// ---- the resolver -----------------------------------------------------------
// Returns { type } | { spec } | { skip } for a namespace-stripped block name.
export function resolveBlock(name) {
  if (isSkippable(name)) return { skip: true };
  if (EXACT_BUILTIN[name]) return { type: EXACT_BUILTIN[name] };
  if (BLOCKS[name]) return { spec: BLOCKS[name] };

  // shape variants (stairs/slabs/walls/…) → full cube of the base material
  const shapeBase = baseOfShape(name);
  if (shapeBase && shapeBase !== name) {
    const r = resolveBlock(shapeBase);
    if (r && !r.skip) return r;
  }

  // wood species
  let m;
  if ((m = /^(?:stripped_)?(\w+?)_planks$/.exec(name)) && PLANKS[m[1]] != null) {
    return { spec: dyn(PLANKS[m[1]], 'planks') };
  }
  if ((m = /^stripped_(\w+?)_(?:log|wood|stem|hyphae)$/.exec(name)) && LOGS[m[1]]) {
    const L = LOGS[m[1]];
    return { spec: facesSpec(face(L.top, 'rings'), face(L.top, 'bark')) }; // stripped: bark uses inner tone
  }
  if ((m = /^(\w+?)_(?:log|wood|stem|hyphae)$/.exec(name)) && LOGS[m[1]]) {
    const L = LOGS[m[1]];
    return { spec: facesSpec(face(L.top, 'rings'), face(L.side, 'bark')) };
  }
  if ((m = /^(\w+?)_leaves$/.exec(name))) {
    const c = LEAVES[m[1]] ?? 0x59a22b;
    return { spec: dyn(c, 'coarse') };
  }

  // colour-word material families
  const word = leadingColorWord(name);
  if (word) {
    if (name.endsWith('_wool') || name.endsWith('_carpet')) return { spec: dyn(WOOL[word], 'fuzzy') };
    if (name.endsWith('_concrete')) return { spec: dyn(CONCRETE[word], 'smooth') };
    if (name.endsWith('_concrete_powder')) return { spec: dyn(CONCRETE[word], 'coarse') };
    if (name.endsWith('_stained_glass') || name.endsWith('_stained_glass_pane')) {
      return { spec: dyn(GLASS[word], 'glass', { transparent: true, opacity: 0.45, depthWrite: true }) };
    }
    if (name.endsWith('_glazed_terracotta')) return { spec: dyn(TERRACOTTA[word], 'smooth') };
    if (name.endsWith('_terracotta')) return { spec: dyn(TERRACOTTA[word], 'speckle') };
    if (name.endsWith('_shulker_box')) return { spec: dyn(DYE[word], 'smooth') };
    if (name.endsWith('_bed')) return { spec: dyn(DYE[word], 'fuzzy') };
    // generic coloured thing (banner/candle handled by skip; fall through otherwise)
    return { spec: dyn(DYE[word] ?? WOOL[word]) };
  }
  if (name === 'terracotta') return { spec: dyn(TERRACOTTA.orange ?? 0x985e43) };
  if (name === 'white_glazed_terracotta') return { spec: dyn(0xbfcccc, 'smooth') };

  // ores
  if ((m = /^(?:deepslate_)?(coal|iron|copper|gold|redstone|diamond|lapis|emerald)_ore$/.exec(name))) {
    const base = name.startsWith('deepslate_') ? 0x4f4f52 : 0x7e7e7e;
    return { spec: dyn(ORE_GEM[m[1]], 'ore', { baseColor: base }) };
  }
  if (name === 'nether_quartz_ore') return { spec: dyn(ORE_GEM.quartz, 'ore', { baseColor: 0x6e2b2b }) };
  if (name === 'nether_gold_ore') return { spec: dyn(ORE_GEM.gold, 'ore', { baseColor: 0x6e2b2b }) };
  if (name === 'ancient_debris') return { spec: dyn(0x6a4a3f, 'ore', { baseColor: 0x4a3a34, color: 0xc77b4a }) };

  // copper (any oxidation/cut/waxed state)
  if (name.includes('copper')) {
    return { spec: dyn(copperColor(name), 'smooth', { roughness: 0.5, metalness: 0.55 }) };
  }

  // sand / sandstone catch-alls
  if (name.includes('red_sandstone')) return { spec: dyn(0xbc5e22, 'smooth') };
  if (name.includes('sandstone')) return { spec: dyn(0xe0d6aa, 'smooth') };

  // keyword fallback colours
  for (const [re, color] of KEYWORD_COLORS) {
    if (re.test(name)) return { spec: dyn(color) };
  }

  // last resort: a stable (non-random-looking) hashed colour
  return { spec: dyn(hashColor(name)) };
}

export default resolveBlock;
