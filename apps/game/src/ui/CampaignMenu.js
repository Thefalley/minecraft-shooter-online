import { injectStyles } from './Menu.js';
import { getCharacterSprite } from './Sprites.js';

// Campaign picker (only the duck's campaign for now). Reuses the pixel-art menu
// styles; each campaign card shows the character's sprite + name.
export class CampaignMenu {
  constructor(container, campaigns, onStart, onBack) {
    injectStyles();
    this.container = container;
    this.campaigns = campaigns ?? [];
    this.onStart = onStart;
    this.onBack = onBack;

    this.root = document.createElement('div');
    this.root.className = 'vd-menu';
    const cards = this.campaigns.map((c) => `
      <div class="vd-char-card" data-campaign="${c.id}">
        <div class="vd-char-sprite" style="background-image:url(${getCharacterSprite(c.character)})"></div>
        <div class="vd-char-name">${c.name}</div>
        <div class="vd-map-note">${c.note ?? ''}</div>
      </div>
    `).join('');
    this.root.innerHTML = `
      <h1 class="vd-menu-title">Campaña</h1>
      <p class="vd-menu-subtitle">Elige campaña</p>
      <div class="vd-menu-characters">${cards}</div>
      <button class="vd-menu-start" data-menu="back">Volver</button>
    `;

    for (const card of this.root.querySelectorAll('[data-campaign]')) {
      card.addEventListener('click', () => {
        const campaign = this.campaigns.find((c) => c.id === card.getAttribute('data-campaign'));
        if (campaign) this.onStart?.(campaign);
      });
    }
    this.root.querySelector('[data-menu="back"]').addEventListener('click', () => this.onBack?.());

    this.container.appendChild(this.root);
  }

  hide() { this.root.remove(); }
}

export default CampaignMenu;
