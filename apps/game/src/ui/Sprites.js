// Pixel-art sprites for characters, maps and HUD glyphs. Each is drawn on a
// 16x16 canvas and cached as a data URL; the UI renders them scaled up with
// image-rendering: pixelated so they stay crisp and blocky.
const SIZE = 16;
const cache = new Map();

function make(key, draw) {
  if (cache.has(key)) return cache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, SIZE, SIZE);
  const r = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
  draw(r);
  const url = canvas.toDataURL();
  cache.set(key, url);
  return url;
}

// --- characters -----------------------------------------------------------
const CHARACTERS = {
  duck: (r) => {
    r(4, 9, 8, 5, '#f7d038');        // body
    r(5, 14, 2, 1, '#e0791a'); r(9, 14, 2, 1, '#e0791a'); // feet
    r(9, 4, 5, 5, '#f7d038');        // head
    r(13, 6, 3, 2, '#e0791a');       // beak
    r(11, 5, 2, 2, '#fff'); r(12, 5, 1, 1, '#111'); // eye
  },
  knight: (r) => {
    r(5, 2, 6, 5, '#9aa0aa'); r(6, 4, 4, 1, '#3a3f47'); // helmet + visor
    r(4, 7, 8, 6, '#c2c8d0');        // armor
    r(5, 13, 6, 2, '#6b727d');       // legs
    r(12, 3, 1, 9, '#eef3f8'); r(11, 11, 4, 1, '#caa53a'); // sword + guard
  },
  hunter: (r) => {
    r(5, 2, 6, 4, '#3a5e34');        // hood
    r(5, 6, 6, 3, '#cdab83');        // face
    r(7, 6, 1, 2, '#111');           // eye gap
    r(4, 9, 8, 5, '#4a7a3f');        // tunic
    r(12, 8, 1, 5, '#cfd6df'); r(11, 12, 3, 1, '#6b4a2a'); // dagger
  },
  samurai: (r) => {
    r(5, 2, 6, 4, '#1b1b22');        // helmet
    r(6, 3, 4, 1, '#caa53a');        // crest
    r(5, 6, 6, 3, '#cdab83');        // face
    r(4, 9, 8, 5, '#b23a3a');        // red armor
    r(2, 3, 1, 11, '#eef2f7'); r(2, 13, 2, 1, '#caa53a'); // katana
  },
  mage: (r) => {
    r(4, 1, 8, 4, '#5a3f8a'); r(6, 0, 4, 2, '#7a5ac0'); // pointy hat
    r(6, 5, 4, 3, '#cdab83');        // face
    r(4, 8, 8, 6, '#6a4fa0');        // robe
    r(12, 4, 1, 10, '#8a5a32'); r(11, 3, 3, 2, '#54d2ff'); // staff + gem
  },
};

// --- maps ------------------------------------------------------------------
const MAPS = {
  meadow: (r) => {
    r(0, 11, 16, 5, '#58a548');      // grass
    r(0, 11, 16, 1, '#6fb04a');
    r(3, 4, 10, 7, '#8a8d92');       // castle wall
    r(3, 3, 2, 2, '#9aa0a6'); r(7, 3, 2, 2, '#9aa0a6'); r(11, 3, 2, 2, '#9aa0a6'); // battlements
    r(7, 7, 2, 4, '#3a3f47');        // gate
  },
  snowland: (r) => {
    r(0, 11, 16, 5, '#eef4fb');      // snow
    r(2, 12, 3, 4, '#0a0a0a'); r(0, 11, 16, 1, '#dbe6f0');
    r(10, 9, 2, 5, '#4a3320');       // spruce trunk
    r(8, 3, 6, 2, '#28452f'); r(9, 5, 4, 2, '#33543a'); r(10, 7, 2, 2, '#28452f'); // foliage tiers
    r(2, 3, 2, 2, '#bce6f7'); r(4, 5, 1, 1, '#bce6f7'); // snowflakes
  },
  custom: (r) => {
    r(3, 3, 10, 10, '#8a5a32');      // crate
    r(3, 3, 10, 1, '#a6713f'); r(3, 12, 10, 1, '#6e4626');
    r(3, 7, 10, 1, '#6e4626'); r(7, 3, 2, 10, '#6e4626'); // banding
    r(6, 6, 4, 1, '#ffd166'); r(7, 5, 2, 3, '#ffd166'); // plus mark
  },
};

// --- HUD glyphs ------------------------------------------------------------
const GLYPHS = {
  heart: (r) => {
    r(3, 3, 4, 3, '#ff5252'); r(9, 3, 4, 3, '#ff5252');
    r(2, 5, 12, 4, '#ff5252');
    r(4, 9, 8, 2, '#ff5252'); r(6, 11, 4, 2, '#ff5252'); r(7, 13, 2, 1, '#ff5252');
    r(3, 4, 2, 1, '#ff8a8a'); r(9, 4, 2, 1, '#ff8a8a'); // shine
  },
  coin: (r) => {
    r(5, 2, 6, 12, '#caa53a'); r(3, 4, 10, 8, '#caa53a');
    r(4, 5, 8, 6, '#e9cf63');
    r(7, 5, 2, 6, '#a8862a'); // engraved bar
  },
  shield: (r) => {
    r(4, 2, 8, 2, '#54d2ff'); r(3, 4, 10, 5, '#54d2ff');
    r(4, 9, 8, 3, '#2f8ed8'); r(6, 12, 4, 2, '#2f8ed8'); r(7, 14, 2, 1, '#2f8ed8');
    r(5, 4, 3, 3, '#bdecff'); // shine
  },
  sword: (r) => {
    r(7, 1, 2, 9, '#cfd6df'); r(7, 1, 1, 9, '#eef3f8'); // blade
    r(5, 10, 6, 1, '#9aa0aa'); // crossguard
    r(7, 11, 2, 3, '#6b4a2a'); r(6, 14, 4, 1, '#caa53a'); // handle + pommel
  },
  boot: (r) => {
    r(5, 2, 4, 8, '#6b4a2a'); // leg
    r(5, 10, 8, 3, '#5a3c20'); // foot
    r(5, 13, 9, 1, '#3a2716'); // sole
    r(6, 3, 2, 3, '#8a5e36'); // shine
  },
};

// Maps shop-buff ids to a glyph.
const SHOP_GLYPHS = { damage: 'sword', speed: 'boot', health: 'heart', shield: 'shield' };
export function getShopGlyph(id) {
  return getGlyph(SHOP_GLYPHS[id] ?? 'coin');
}

export function getCharacterSprite(id) {
  return CHARACTERS[id] ? make(`char-${id}`, CHARACTERS[id]) : '';
}

export function getMapSprite(id) {
  // Imported custom maps share the "custom" crate sprite.
  const key = MAPS[id] ? id : (String(id).startsWith('custom') ? 'custom' : null);
  return key ? make(`map-${key}`, MAPS[key]) : make('map-custom', MAPS.custom);
}

export function getGlyph(name) {
  return GLYPHS[name] ? make(`glyph-${name}`, GLYPHS[name]) : '';
}
