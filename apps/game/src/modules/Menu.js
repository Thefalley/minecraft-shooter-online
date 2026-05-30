const STYLE_ID = 'voxel-dragons-menu-style';

function injectStyles() {
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

    .vd-menu-characters {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      justify-content: center;
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
  constructor(container, characters, onStart) {
    injectStyles();
    this.container = container;
    this.characters = characters;
    this.onStart = onStart;
    this.selectedId = characters[0]?.id ?? null;

    this.root = document.createElement('div');
    this.root.className = 'vd-menu';
    this.root.innerHTML = `
      <h1 class="vd-menu-title">Voxel Dragons</h1>
      <p class="vd-menu-subtitle">Seleccionar personaje</p>
      <div class="vd-menu-characters" data-menu="characters"></div>
      <button class="vd-menu-start" data-menu="start">Empezar partida</button>
    `;

    this.charactersNode = this.root.querySelector('[data-menu="characters"]');
    this.renderCharacters();

    this.root.querySelector('[data-menu="start"]').addEventListener('click', () => {
      const character = this.characters.find((c) => c.id === this.selectedId) ?? this.characters[0];
      this.onStart?.(character);
    });

    this.container.appendChild(this.root);
  }

  renderCharacters() {
    this.charactersNode.innerHTML = this.characters.map((character) => `
      <div class="vd-char-card ${character.id === this.selectedId ? 'is-selected' : ''}" data-char="${character.id}">
        <div class="vd-char-emoji">${character.emoji}</div>
        <div class="vd-char-name">${character.name}</div>
        <div class="vd-char-note">${CHARACTER_NOTES[character.id] ?? ''}</div>
      </div>
    `).join('');

    for (const card of this.charactersNode.querySelectorAll('[data-char]')) {
      card.addEventListener('click', () => {
        this.selectedId = card.getAttribute('data-char');
        this.renderCharacters();
      });
    }
  }

  hide() {
    this.root.remove();
  }
}

export default Menu;
