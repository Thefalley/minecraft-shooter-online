import { importMinecraftMap } from '../content/maps/custom/importer.js';
import { getCharacterSprite, getMapSprite } from './Sprites.js';

const STYLE_ID = 'voxel-dragons-menu-style';

export function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .vd-menu {
      position: fixed;
      inset: 0;
      z-index: 50;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 22px;
      color: #f7fbff;
      font-family: Arial, Helvetica, sans-serif;
      text-align: center;
      background:
        radial-gradient(circle at 50% 18%, rgba(120, 190, 255, 0.35), transparent 60%),
        linear-gradient(180deg, #1b2a3a 0%, #0d141d 100%);
      user-select: none;
    }

    .vd-menu-title {
      font-size: clamp(32px, 6vw, 64px);
      font-weight: 800;
      letter-spacing: 2px;
      margin: 0;
      text-shadow: 0 4px 0 rgba(0, 0, 0, 0.55);
    }

    .vd-menu-subtitle {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 1px;
      color: rgba(231, 246, 255, 0.78);
      text-transform: uppercase;
    }

    .vd-menu-characters,
    .vd-menu-maps {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      justify-content: center;
    }

    .vd-map-card {
      width: 200px;
      padding: 14px 16px;
      box-sizing: border-box;
      background: rgba(20, 28, 38, 0.72);
      border: 3px solid rgba(255, 255, 255, 0.18);
      border-radius: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 12px;
      text-align: left;
      transition: transform 120ms ease-out, border-color 120ms ease-out, background 120ms ease-out;
    }

    .vd-map-card:hover {
      transform: translateY(-3px);
      background: rgba(36, 48, 62, 0.82);
    }

    .vd-map-card.is-selected {
      border-color: #66ccff;
      background: rgba(48, 64, 82, 0.92);
      transform: translateY(-4px);
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.4);
    }

    .vd-map-emoji {
      font-size: 40px;
      line-height: 1;
    }

    .vd-map-name {
      font-size: 17px;
      font-weight: 800;
    }

    .vd-map-note {
      margin-top: 4px;
      font-size: 12px;
      font-weight: 600;
      color: rgba(231, 246, 255, 0.7);
    }

    .vd-map-card.vd-map-custom {
      border-style: dashed;
      border-color: rgba(255, 255, 255, 0.35);
    }

    .vd-menu-status {
      margin: 0;
      min-height: 18px;
      font-size: 13px;
      font-weight: 700;
      color: #9fd0ff;
    }

    .vd-char-card {
      width: 150px;
      padding: 18px 14px;
      box-sizing: border-box;
      background: rgba(20, 28, 38, 0.72);
      border: 3px solid rgba(255, 255, 255, 0.18);
      border-radius: 12px;
      cursor: pointer;
      transition: transform 120ms ease-out, border-color 120ms ease-out, background 120ms ease-out;
    }

    .vd-char-card:hover {
      transform: translateY(-3px);
      background: rgba(36, 48, 62, 0.82);
    }

    .vd-char-card.is-selected {
      border-color: #ffd166;
      background: rgba(48, 64, 82, 0.92);
      transform: translateY(-4px);
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.4);
    }

    .vd-char-emoji {
      font-size: 52px;
      line-height: 1;
    }

    .vd-char-name {
      margin-top: 10px;
      font-size: 18px;
      font-weight: 800;
    }

    .vd-char-note {
      margin-top: 6px;
      font-size: 12px;
      font-weight: 600;
      color: rgba(231, 246, 255, 0.7);
      min-height: 30px;
    }

    .vd-menu-start {
      margin-top: 6px;
      padding: 14px 42px;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: 1px;
      color: #102014;
      background: linear-gradient(180deg, #8be36a, #49a82f);
      border: none;
      border-radius: 10px;
      cursor: pointer;
      box-shadow: 0 6px 0 #2f6e1d, 0 10px 22px rgba(0, 0, 0, 0.4);
      transition: transform 90ms ease-out, box-shadow 90ms ease-out;
    }

    .vd-menu-start:active {
      transform: translateY(4px);
      box-shadow: 0 2px 0 #2f6e1d, 0 6px 14px rgba(0, 0, 0, 0.4);
    }

    /* ===================== pixel-art restyle ===================== */
    .vd-menu { font-family: 'PixelFont', 'Courier New', monospace; }

    .vd-menu-title {
      font-family: 'PixelFont', monospace;
      letter-spacing: 0;
      font-size: clamp(20px, 4.4vw, 40px);
      text-shadow: 4px 4px 0 rgba(0, 0, 0, 0.6);
    }

    .vd-menu-subtitle { font-family: 'PixelFont', monospace; font-size: 11px; letter-spacing: 0; }

    .vd-char-card, .vd-map-card {
      border-radius: 0;
      border: 3px solid #000;
      background: rgba(16, 22, 30, 0.85);
      box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.12);
    }

    .vd-char-card:hover, .vd-map-card:hover { background: rgba(30, 40, 52, 0.9); }

    .vd-char-card.is-selected {
      border-color: #ffd166;
      background: rgba(40, 50, 64, 0.92);
      box-shadow: inset 0 0 0 2px #ffd166, 0 6px 0 rgba(0, 0, 0, 0.5);
    }

    .vd-map-card.is-selected {
      border-color: #54d2ff;
      background: rgba(40, 50, 64, 0.92);
      box-shadow: inset 0 0 0 2px #54d2ff, 0 6px 0 rgba(0, 0, 0, 0.5);
    }

    .vd-char-name, .vd-map-name { font-family: 'PixelFont', monospace; font-size: 11px; }

    .vd-char-sprite {
      width: 52px; height: 52px; margin: 0 auto;
      image-rendering: pixelated; image-rendering: crisp-edges;
      background-size: 100% 100%; background-repeat: no-repeat;
    }

    .vd-map-sprite {
      width: 46px; height: 46px; flex: 0 0 auto;
      image-rendering: pixelated; image-rendering: crisp-edges;
      background-size: 100% 100%; background-repeat: no-repeat;
    }

    .vd-map-note { font-family: 'PixelFont', monospace; font-size: 7px; line-height: 1.5; }

    .vd-menu-start {
      border-radius: 0;
      font-family: 'PixelFont', monospace;
      font-size: 13px;
      letter-spacing: 0;
      border: 3px solid #000;
      box-shadow: 0 6px 0 #2f6e1d;
    }

    .vd-menu-start:active { box-shadow: 0 2px 0 #2f6e1d; }

    .vd-menu-status { font-family: 'PixelFont', monospace; font-size: 9px; }
  `;
  document.head.appendChild(style);
}

const CHARACTER_NOTES = {
  duck: 'Armas + puede construir bloques',
  knight: 'Espada y guardia que repele',
  hunter: 'Dagas, bombas y vista aérea',
  samurai: 'Katana con parry y dash potenciado',
  mage: 'Frágil pero con 5 hechizos de maná',
};

export class Menu {
  constructor(container, characters, maps, onStart) {
    injectStyles();
    this.container = container;
    this.characters = characters;
    this.maps = maps ?? [];
    this.onStart = onStart;
    this.selectedId = characters[0]?.id ?? null;
    this.selectedMapId = this.maps[0]?.id ?? null;

    this.root = document.createElement('div');
    this.root.className = 'vd-menu';
    this.root.innerHTML = `
      <h1 class="vd-menu-title">Voxel Dragons</h1>
      <p class="vd-menu-subtitle">Seleccionar personaje</p>
      <div class="vd-menu-characters" data-menu="characters"></div>
      <p class="vd-menu-subtitle">Seleccionar mapa</p>
      <div class="vd-menu-maps" data-menu="maps"></div>
      <p class="vd-menu-status" data-menu="status"></p>
      <input type="file" accept=".zip,.mca" data-menu="file" style="display:none" />
      <button class="vd-menu-start" data-menu="start">Empezar partida</button>
    `;

    this.charactersNode = this.root.querySelector('[data-menu="characters"]');
    this.mapsNode = this.root.querySelector('[data-menu="maps"]');
    this.statusNode = this.root.querySelector('[data-menu="status"]');
    this.fileInput = this.root.querySelector('[data-menu="file"]');
    this.fileInput.addEventListener('change', (event) => this.onCustomFile(event));
    this.renderCharacters();
    this.renderMaps();

    this.root.querySelector('[data-menu="start"]').addEventListener('click', () => {
      const character = this.characters.find((c) => c.id === this.selectedId) ?? this.characters[0];
      const map = this.maps.find((m) => m.id === this.selectedMapId) ?? this.maps[0];
      this.onStart?.(character, map);
    });

    this.container.appendChild(this.root);
  }

  renderCharacters() {
    this.charactersNode.innerHTML = this.characters.map((character) => `
      <div class="vd-char-card ${character.id === this.selectedId ? 'is-selected' : ''}" data-char="${character.id}">
        <div class="vd-char-sprite" style="background-image:url(${getCharacterSprite(character.id)})"></div>
        <div class="vd-char-name">${character.name}</div>
      </div>
    `).join('');

    for (const card of this.charactersNode.querySelectorAll('[data-char]')) {
      card.addEventListener('click', () => {
        this.selectedId = card.getAttribute('data-char');
        this.renderCharacters();
      });
    }
  }

  renderMaps() {
    const cards = this.maps.map((map) => `
      <div class="vd-map-card ${map.id === this.selectedMapId ? 'is-selected' : ''}" data-map="${map.id}">
        <div class="vd-map-sprite" style="background-image:url(${getMapSprite(map.id)})"></div>
        <div class="vd-map-name">${map.name}</div>
      </div>
    `).join('');

    // The "+" card lets you import a Minecraft world (.zip from minecraftmaps).
    const addCard = `
      <div class="vd-map-card vd-map-custom" data-map-add="1">
        <div class="vd-map-sprite" style="background-image:url(${getMapSprite('custom')})"></div>
        <div>
          <div class="vd-map-name">+ Custom</div>
          <div class="vd-map-note">Subir .zip</div>
        </div>
      </div>
    `;
    this.mapsNode.innerHTML = cards + addCard;

    for (const card of this.mapsNode.querySelectorAll('[data-map]')) {
      card.addEventListener('click', () => {
        this.selectedMapId = card.getAttribute('data-map');
        this.renderMaps();
      });
    }
    this.mapsNode.querySelector('[data-map-add]')?.addEventListener('click', () => {
      this.fileInput.click();
    });
  }

  setStatus(text) {
    if (this.statusNode) this.statusNode.textContent = text ?? '';
  }

  async onCustomFile(event) {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-importing the same file later
    if (!file) return;

    this.setStatus('Importando mapa…');
    try {
      const map = await importMinecraftMap(file, (msg) => this.setStatus(msg));
      this.maps.push(map);
      this.selectedMapId = map.id;
      this.renderMaps();
      this.setStatus(`✓ ${map.name} importado. Pulsa "Empezar partida".`);
    } catch (err) {
      console.error('[import]', err);
      this.setStatus(`✗ No se pudo importar: ${err.message}`);
    }
  }

  hide() {
    this.root.remove();
  }
}

export default Menu;
