import { getGlyph, getShopGlyph } from './Sprites.js';

const STYLE_ID = 'voxel-dragons-shop-style';

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .vd-shop {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 18px;
      color: #f7fbff;
      font-family: Arial, Helvetica, sans-serif;
      text-align: center;
      background: rgba(8, 12, 18, 0.82);
      backdrop-filter: blur(4px);
      user-select: none;
    }

    .vd-shop-title {
      font-size: clamp(26px, 5vw, 46px);
      font-weight: 800;
      letter-spacing: 1px;
      margin: 0;
    }

    .vd-shop-coins {
      font-size: 20px;
      font-weight: 800;
      color: #ffd166;
    }

    .vd-shop-items {
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
      justify-content: center;
      max-width: 720px;
    }

    .vd-shop-item {
      width: 150px;
      padding: 16px 12px;
      box-sizing: border-box;
      background: rgba(24, 32, 42, 0.85);
      border: 3px solid rgba(255, 255, 255, 0.16);
      border-radius: 12px;
      cursor: pointer;
      transition: transform 100ms ease-out, border-color 100ms ease-out;
    }

    .vd-shop-item:hover { transform: translateY(-3px); }

    .vd-shop-item.is-disabled {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none;
    }

    .vd-shop-emoji { font-size: 40px; line-height: 1; }
    .vd-shop-name { margin-top: 8px; font-size: 15px; font-weight: 800; }
    .vd-shop-cost { margin-top: 6px; font-size: 14px; color: #ffd166; font-weight: 700; }
    .vd-shop-owned { margin-top: 4px; font-size: 12px; color: rgba(231,246,255,0.7); }

    .vd-shop-continue {
      margin-top: 6px;
      padding: 12px 36px;
      font-size: 18px;
      font-weight: 800;
      color: #102014;
      background: linear-gradient(180deg, #8be36a, #49a82f);
      border: none;
      border-radius: 10px;
      cursor: pointer;
      box-shadow: 0 5px 0 #2f6e1d;
    }
    .vd-shop-continue:active { transform: translateY(3px); box-shadow: 0 2px 0 #2f6e1d; }

    /* ===================== pixel-art restyle ===================== */
    .vd-shop { font-family: 'PixelFont', 'Courier New', monospace; backdrop-filter: none; background: rgba(8, 12, 18, 0.9); }
    .vd-shop-title { font-family: 'PixelFont', monospace; font-size: clamp(18px, 4vw, 34px); letter-spacing: 0; text-shadow: 3px 3px 0 rgba(0, 0, 0, 0.6); }
    .vd-shop-coins { font-family: 'PixelFont', monospace; font-size: 12px; display: inline-flex; align-items: center; gap: 6px; }
    .vd-shop-item {
      border-radius: 0; border: 3px solid #000; background: rgba(20, 28, 38, 0.9);
      box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.12);
    }
    .vd-shop-item:hover { background: rgba(34, 46, 60, 0.92); }
    .vd-shop-glyph { width: 34px; height: 34px; image-rendering: pixelated; image-rendering: crisp-edges; }
    .vd-shop-name { font-family: 'PixelFont', monospace; font-size: 10px; }
    .vd-shop-cost { font-family: 'PixelFont', monospace; font-size: 10px; display: flex; align-items: center; justify-content: center; gap: 5px; }
    .vd-shop-coinico { width: 14px; height: 14px; image-rendering: pixelated; }
    .vd-shop-owned { font-family: 'PixelFont', monospace; font-size: 8px; }
    .vd-shop-continue { border-radius: 0; font-family: 'PixelFont', monospace; font-size: 13px; border: 3px solid #000; box-shadow: 0 5px 0 #2f6e1d; }
  `;
  document.head.appendChild(style);
}

export class Shop {
  constructor(container, { items, getCoins, getOwned, onBuy, onClose, title = 'Tienda' }) {
    injectStyles();
    this.container = container;
    this.items = items;
    this.getCoins = getCoins;
    this.getOwned = getOwned ?? (() => 0);
    this.onBuy = onBuy;
    this.onClose = onClose;

    this.root = document.createElement('div');
    this.root.className = 'vd-shop';
    this.root.innerHTML = `
      <h1 class="vd-shop-title">${title}</h1>
      <div class="vd-shop-coins"><img class="vd-shop-coinico" src="${getGlyph('coin')}" alt="" /> <span data-shop="coins">0</span> monedas</div>
      <div class="vd-shop-items" data-shop="items"></div>
      <button class="vd-shop-continue" data-shop="continue">Continuar</button>
    `;
    this.itemsNode = this.root.querySelector('[data-shop="items"]');
    this.coinsNode = this.root.querySelector('[data-shop="coins"]');

    this.root.querySelector('[data-shop="continue"]').addEventListener('click', () => {
      this.hide();
      this.onClose?.();
    });

    this.container.appendChild(this.root);
    this.render();
  }

  render() {
    const coins = this.getCoins();
    this.coinsNode.textContent = String(coins);
    this.itemsNode.innerHTML = this.items.map((item) => {
      const owned = this.getOwned(item.id);
      const maxed = item.max != null && owned >= item.max;
      const affordable = coins >= item.cost;
      const disabled = !affordable || maxed;
      const ownedLabel = item.max != null
        ? (owned > 0 ? '✓ comprado' : '')
        : `Comprado: ${owned}`;
      return `
        <div class="vd-shop-item ${disabled ? 'is-disabled' : ''}" data-item="${item.id}">
          <img class="vd-shop-glyph" src="${item.iconUrl ?? getShopGlyph(item.id)}" alt="" />
          <div class="vd-shop-name">${item.name}</div>
          <div class="vd-shop-cost"><img class="vd-shop-coinico" src="${getGlyph('coin')}" alt="" /> ${item.cost}</div>
          <div class="vd-shop-owned">${ownedLabel}</div>
        </div>
      `;
    }).join('');

    for (const node of this.itemsNode.querySelectorAll('[data-item]')) {
      node.addEventListener('click', () => {
        const item = this.items.find((entry) => entry.id === node.getAttribute('data-item'));
        if (item && this.onBuy?.(item)) {
          this.render();
        }
      });
    }
  }

  hide() {
    this.root.remove();
  }
}

export default Shop;
