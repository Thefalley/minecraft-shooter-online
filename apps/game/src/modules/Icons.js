// Simple pixel-art icons for hotbar items/abilities, drawn on a tiny canvas
// and exposed as cached data URLs. The HUD renders them pixelated.
const SIZE = 16;
const cache = new Map();

function make(draw) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, SIZE, SIZE);
  const r = (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  draw(r);
  return canvas.toDataURL();
}

const DRAW = {
  'pistol-bullet': (r) => {
    r(6, 3, 4, 3, '#b6bcc2'); // tip
    r(7, 2, 2, 1, '#d7dce0');
    r(5, 6, 6, 7, '#caa53a'); // casing
    r(6, 6, 2, 7, '#e9cf63'); // highlight
    r(5, 12, 6, 1, '#7d6a26');
  },
  'shotgun-shell': (r) => {
    r(5, 2, 6, 9, '#c63a2e'); // red body
    r(6, 2, 2, 9, '#e06151'); // highlight
    r(5, 11, 6, 3, '#caa53a'); // brass base
    r(6, 11, 2, 3, '#e9cf63');
  },
  'rifle-bullet': (r) => {
    r(7, 1, 2, 2, '#c87b3a'); // pointed tip
    r(6, 3, 4, 3, '#b5651d');
    r(5, 6, 6, 8, '#caa53a'); // long casing
    r(6, 6, 2, 8, '#e9cf63');
    r(5, 13, 6, 1, '#7d6a26');
  },
  'blue-laser': (r) => {
    r(6, 2, 4, 12, '#1f8bff'); // bolt
    r(7, 1, 2, 14, '#7cc0ff');
    r(7, 2, 2, 12, '#eaffff'); // core
  },
  sword: (r) => {
    r(7, 1, 2, 9, '#cfd6df'); // blade
    r(7, 1, 1, 9, '#eef3f8');
    r(8, 2, 1, 7, '#9aa0aa');
    r(5, 10, 6, 1, '#9aa0aa'); // crossguard
    r(7, 11, 2, 3, '#6b4a2a'); // handle
    r(6, 14, 4, 1, '#caa53a'); // pommel
  },
  dagger: (r) => {
    r(7, 3, 2, 7, '#cfd6df'); // blade
    r(7, 3, 1, 7, '#eef3f8');
    r(6, 10, 4, 1, '#9aa0aa'); // guard
    r(7, 11, 2, 3, '#3a2a1e'); // handle
    r(7, 14, 2, 1, '#6b5030');
  },
  bomb: (r) => {
    r(5, 7, 6, 6, '#161616'); // body
    r(4, 8, 8, 4, '#161616');
    r(6, 6, 4, 1, '#161616');
    r(6, 9, 2, 2, '#444'); // shine
    r(9, 4, 1, 3, '#6b4a2a'); // fuse
    r(9, 2, 2, 2, '#ffd166'); // spark
    r(10, 1, 1, 1, '#ff7a1a');
  },
  slash: (r) => {
    r(3, 12, 2, 2, '#bfe6ff');
    r(4, 10, 2, 2, '#ffffff');
    r(5, 9, 2, 2, '#ffffff');
    r(6, 8, 2, 1, '#ffffff');
    r(7, 7, 2, 1, '#ffffff');
    r(8, 7, 2, 1, '#ffffff');
    r(9, 8, 2, 2, '#ffffff');
    r(10, 10, 2, 2, '#bfe6ff');
  },
  'katana-sheathed': (r) => {
    // diagonal dark scabbard
    for (let i = 0; i < 9; i += 1) r(3 + i, 12 - i, 2, 2, '#16243c');
    r(2, 12, 3, 2, '#1b1b22'); // wrapped handle
    r(4, 10, 2, 2, '#caa53a'); // tsuba
  },
  'katana-drawn': (r) => {
    for (let i = 0; i < 9; i += 1) r(3 + i, 12 - i, 2, 2, '#eef2f7'); // bare blade
    r(3 + 8, 12 - 8, 2, 1, '#ffffff');
    r(2, 12, 3, 2, '#1b1b22'); // handle
    r(4, 10, 2, 2, '#caa53a'); // tsuba
  },
  fireball: (r) => {
    r(5, 6, 6, 6, '#ff5a1a');
    r(4, 7, 8, 4, '#ff6b1a');
    r(6, 7, 4, 4, '#ffd166'); // core
    r(7, 8, 2, 2, '#fff3a8');
    r(6, 4, 1, 2, '#ff9f1c'); // flames
    r(9, 4, 1, 2, '#ff9f1c');
    r(8, 3, 1, 2, '#ffcf5c');
  },
  thunder: (r) => {
    r(8, 1, 3, 4, '#ffe066');
    r(6, 5, 3, 3, '#ffd000');
    r(8, 6, 3, 3, '#ffe066');
    r(5, 9, 3, 4, '#ffd000');
    r(7, 11, 2, 4, '#ffe066');
  },
  tornado: (r) => {
    r(3, 3, 10, 2, '#ff3b1a');
    r(4, 5, 8, 2, '#ff5a2a');
    r(5, 7, 6, 2, '#ff7a1a');
    r(6, 9, 4, 2, '#ff5a2a');
    r(7, 11, 2, 3, '#ff3b1a');
  },
  snowball: (r) => {
    r(5, 6, 6, 6, '#bfeaff');
    r(4, 7, 8, 4, '#bfeaff');
    r(6, 6, 4, 1, '#bfeaff');
    r(6, 7, 3, 3, '#eaffff'); // highlight
    r(5, 11, 6, 1, '#8fd3ff'); // shadow
  },
  nuke: (r) => {
    r(3, 3, 10, 10, '#ffd000'); // yellow disc
    r(2, 5, 12, 6, '#ffd000');
    r(5, 2, 6, 12, '#ffd000');
    r(7, 7, 2, 2, '#111'); // hub
    r(6, 3, 4, 3, '#111'); // top blade
    r(3, 9, 4, 3, '#111'); // lower-left blade
    r(9, 9, 4, 3, '#111'); // lower-right blade
  },
  wood: (r) => {
    r(2, 2, 12, 12, '#8a5a32');
    r(2, 5, 12, 1, '#6e4626');
    r(2, 9, 12, 1, '#6e4626');
    r(7, 2, 1, 12, '#9c6a3e');
  },
};

export function getIcon(id) {
  if (!id || !DRAW[id]) return '';
  if (!cache.has(id)) cache.set(id, make(DRAW[id]));
  return cache.get(id);
}

export default getIcon;
