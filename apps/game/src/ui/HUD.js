import { getIcon } from './Icons.js';
import { getGlyph } from './Sprites.js';

const DEFAULT_STATE = {
  health: 100,
  maxHealth: 100,
  shield: 100,
  maxShield: 100,
  ammo: 0,
  maxAmmo: 0,
  weapon: 'Blaster',
  dragons: 0,
  dragonsTotal: null,
  zombies: 0,
  skeletons: 0,
  witches: 0,
  wave: 1,
  waveCount: 10,
  fps: 0,
  coins: 0,
  revive: true,
  guard: false,
  ammoText: null,
  inventory: null,
};

const STYLE_ID = 'voxel-dragons-hud-style';

function injectStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .vd-hud {
      position: fixed;
      inset: 0;
      z-index: 20;
      pointer-events: none;
      color: #f7fbff;
      font: 700 14px/1.2 Arial, Helvetica, sans-serif;
      text-shadow: 0 2px 0 rgba(0, 0, 0, 0.65);
      user-select: none;
    }

    .vd-crosshair {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 22px;
      height: 22px;
      transform: translate(-50%, -50%);
      opacity: 0.92;
    }

    .vd-crosshair::before,
    .vd-crosshair::after {
      content: '';
      position: absolute;
      background: rgba(255, 255, 255, 0.92);
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), 0 0 8px rgba(255, 255, 255, 0.28);
      border-radius: 1px;
    }

    .vd-crosshair::before {
      left: 10px;
      top: 0;
      width: 2px;
      height: 22px;
    }

    .vd-crosshair::after {
      left: 0;
      top: 10px;
      width: 22px;
      height: 2px;
    }

    .vd-bottom-left,
    .vd-bottom-right,
    .vd-top-right,
    .vd-message,
    .vd-help {
      position: absolute;
      box-sizing: border-box;
    }

    .vd-bottom-left {
      left: 18px;
      bottom: 86px;
      min-width: min(360px, calc(100vw - 36px));
    }

    .vd-bottom-right {
      right: 18px;
      bottom: 86px;
      display: grid;
      gap: 6px;
      justify-items: end;
    }

    .vd-top-right {
      right: 18px;
      top: 42px;
      padding: 8px 10px;
      background: rgba(10, 14, 18, 0.48);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 6px;
      backdrop-filter: blur(4px);
    }

    .vd-fps {
      position: absolute;
      right: 18px;
      top: 16px;
      font-size: 14px;
      font-weight: 800;
      color: #8be36a;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
    }

    .vd-topline {
      margin-bottom: 5px;
      font-size: 16px;
    }

    .vd-heart {
      font-size: 18px;
      filter: drop-shadow(0 0 3px rgba(255, 80, 80, 0.65));
    }

    .vd-heart.is-used {
      filter: grayscale(1) brightness(0.55);
    }

    .vd-coins {
      color: #ffd166;
      margin-left: 6px;
    }

    .vd-wavebar {
      position: absolute;
      left: 50%;
      top: 14px;
      transform: translateX(-50%);
      display: flex;
      gap: 4px;
      padding: 6px 8px;
      background: rgba(10, 14, 18, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 8px;
    }

    .vd-wave-cell {
      width: 24px;
      height: 15px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.14);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 800;
      color: rgba(255, 255, 255, 0.55);
    }

    .vd-wave-cell.is-done {
      background: linear-gradient(180deg, #ffd166, #ff8a3c);
      color: #3a2200;
    }

    .vd-wave-cell.is-current {
      background: linear-gradient(180deg, #8be36a, #49a82f);
      color: #0e2008;
      box-shadow: 0 0 8px rgba(120, 230, 120, 0.6);
    }

    .vd-deathscreen {
      position: absolute;
      inset: 0;
      z-index: 40;
      display: none;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 14px;
      background: rgba(40, 0, 0, 0.8);
    }

    .vd-deathscreen.is-active { display: flex; }

    .vd-death-text {
      font-size: clamp(40px, 9vw, 90px);
      font-weight: 900;
      color: #ff5252;
      text-shadow: 0 4px 0 rgba(0, 0, 0, 0.6);
      letter-spacing: 2px;
    }

    .vd-death-sub {
      font-size: 16px;
      font-weight: 700;
      color: rgba(255, 230, 230, 0.85);
    }

    .vd-help {
      left: 18px;
      top: 18px;
      max-width: min(420px, calc(100vw - 36px));
      color: rgba(245, 248, 255, 0.82);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0;
      background: rgba(10, 14, 18, 0.38);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 7px 9px;
    }

    .vd-shield-label {
      margin-bottom: 6px;
      color: #dff4ff;
    }

    .vd-shield-shell {
      height: 14px;
      margin-bottom: 10px;
      overflow: hidden;
      background: rgba(18, 22, 26, 0.72);
      border: 2px solid rgba(255, 255, 255, 0.38);
      box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.45);
    }

    .vd-shield-fill {
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, #2f8ed8, #54d2ff 60%, #b8ecff);
      transform-origin: left center;
      transition: transform 120ms ease-out, filter 120ms ease-out;
    }

    .vd-health-label {
      margin-bottom: 6px;
      color: #fff5f5;
    }

    .vd-health-shell {
      height: 18px;
      overflow: hidden;
      background: rgba(18, 22, 26, 0.72);
      border: 2px solid rgba(255, 255, 255, 0.38);
      box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.45);
    }

    .vd-health-fill {
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, #d83b3b, #ff6b45 58%, #ffd166);
      transform-origin: left center;
      transition: transform 120ms ease-out, filter 120ms ease-out;
    }

    .vd-weapon {
      color: #e9f6ff;
      font-size: 15px;
    }

    .vd-ammo {
      color: #fff2a8;
      font-size: 22px;
      line-height: 1;
    }

    .vd-message {
      left: 50%;
      top: 18%;
      max-width: min(520px, calc(100vw - 36px));
      transform: translateX(-50%);
      opacity: 0;
      transition: opacity 140ms ease-out, transform 140ms ease-out;
      padding: 9px 12px;
      text-align: center;
      background: rgba(8, 12, 16, 0.62);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 6px;
    }

    .vd-message.is-visible {
      opacity: 1;
      transform: translateX(-50%) translateY(-4px);
    }

    .vd-guard {
      position: absolute;
      left: 50%;
      top: calc(50% + 34px);
      transform: translateX(-50%);
      font-size: 30px;
      opacity: 0;
      transition: opacity 80ms ease-out;
      filter: drop-shadow(0 0 8px rgba(120, 210, 255, 0.9));
    }

    .vd-guard.is-active {
      opacity: 1;
    }

    .vd-whiteout {
      position: absolute;
      inset: 0;
      z-index: 55;
      background: #ffffff;
      opacity: 0;
      pointer-events: none;
    }

    .vd-vignette {
      position: absolute;
      inset: 0;
      opacity: 0;
      background:
        radial-gradient(circle at center, rgba(255, 0, 0, 0) 42%, rgba(190, 0, 0, 0.38) 100%),
        rgba(255, 0, 0, 0.12);
      transition: opacity 220ms ease-out;
    }

    .vd-vignette.is-active {
      opacity: 1;
      transition: opacity 45ms ease-out;
    }

    .vd-tint {
      position: absolute;
      inset: 0;
      opacity: 0;
      pointer-events: none;
      background:
        radial-gradient(circle at center, rgba(120, 200, 255, 0.05) 24%, rgba(40, 120, 255, 0.62) 100%),
        rgba(60, 150, 255, 0.18);
    }

    .vd-countdown {
      position: absolute;
      left: 50%;
      top: 52px;
      transform: translateX(-50%);
      display: none;
      padding: 8px 18px;
      text-align: center;
      white-space: nowrap;
      background: rgba(10, 14, 18, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 8px;
      color: #ffe066;
      font-size: 20px;
      font-weight: 800;
      text-shadow: 0 2px 0 rgba(0, 0, 0, 0.6);
    }

    .vd-countdown.is-active { display: block; }

    .vd-countdown .vd-count-num { color: #8be36a; font-size: 26px; }

    .vd-hotbar {
      position: absolute;
      left: 50%;
      bottom: 14px;
      display: grid;
      grid-template-columns: repeat(8, 54px);
      gap: 4px;
      transform: translateX(-50%);
    }

    .vd-slot {
      position: relative;
      width: 54px;
      height: 54px;
      box-sizing: border-box;
      border: 3px solid rgba(25, 25, 25, 0.82);
      background: rgba(72, 72, 72, 0.72);
      box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.16);
    }

    .vd-slot.is-selected {
      border-color: #f5f0c8;
      background: rgba(120, 120, 120, 0.82);
      transform: translateY(-3px);
    }

    .vd-slot-swatch {
      position: absolute;
      left: 9px;
      top: 8px;
      width: 30px;
      height: 30px;
      background: var(--slot-color);
      border: 2px solid rgba(0, 0, 0, 0.42);
      box-shadow: inset -8px -8px 0 rgba(0, 0, 0, 0.18), inset 5px 5px 0 rgba(255, 255, 255, 0.16);
    }

    .vd-slot-swatch.has-icon {
      background: rgba(20, 24, 30, 0.85);
      background-size: 100% 100%;
      background-repeat: no-repeat;
      image-rendering: pixelated;
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.4);
    }

    .vd-slot-key {
      position: absolute;
      left: 4px;
      top: 3px;
      font-size: 10px;
      color: rgba(255, 255, 255, 0.72);
    }

    .vd-slot-count {
      position: absolute;
      right: 5px;
      bottom: 3px;
      font-size: 13px;
    }

    .vd-inventory {
      position: absolute;
      left: 50%;
      top: 50%;
      width: min(520px, calc(100vw - 32px));
      transform: translate(-50%, -50%);
      display: none;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      padding: 14px;
      box-sizing: border-box;
      background: rgba(34, 34, 34, 0.9);
      border: 3px solid rgba(0, 0, 0, 0.86);
      box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.14), 0 16px 40px rgba(0, 0, 0, 0.38);
    }

    .vd-inventory.is-open {
      display: grid;
    }

    .vd-inv-item {
      position: relative;
      min-height: 58px;
      display: grid;
      grid-template-columns: 36px 1fr;
      gap: 8px;
      align-items: center;
      padding: 8px;
      box-sizing: border-box;
      background: rgba(88, 88, 88, 0.7);
      border: 2px solid rgba(0, 0, 0, 0.55);
    }

    .vd-inv-item .vd-slot-swatch {
      position: static;
      width: 32px;
      height: 32px;
    }

    .vd-inv-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }

    @media (max-width: 620px) {
      .vd-bottom-left,
      .vd-bottom-right,
      .vd-help,
      .vd-top-right {
        left: 12px;
        right: 12px;
      }

      .vd-bottom-left {
        bottom: 82px;
      }

      .vd-bottom-right {
        bottom: 82px;
      }

      .vd-top-right {
        top: 48px;
        width: max-content;
        left: auto;
      }

      .vd-help {
        top: 12px;
      }

      .vd-hotbar {
        grid-template-columns: repeat(8, 40px);
        gap: 2px;
      }

      .vd-slot {
        width: 40px;
        height: 40px;
      }

      .vd-slot-swatch {
        left: 7px;
        top: 7px;
        width: 21px;
        height: 21px;
      }

      .vd-inventory {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }

    /* ===================== pixel-art restyle ===================== */
    .vd-hud {
      font-family: 'PixelFont', 'Courier New', monospace;
      text-shadow: 2px 2px 0 rgba(0, 0, 0, 0.85);
    }

    .vd-pixel, .vd-glyph { image-rendering: pixelated; image-rendering: crisp-edges; }

    .vd-help {
      border-radius: 0;
      border: 3px solid #000;
      background: rgba(0, 0, 0, 0.6);
      box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.12);
      font-family: 'PixelFont', monospace;
      font-size: 8px;
      line-height: 1.7;
      letter-spacing: 0;
      color: #dfe8f2;
    }

    .vd-fps {
      font-family: 'PixelFont', monospace;
      font-size: 9px;
      color: #5ad84a;
      text-shadow: 2px 2px 0 #000;
    }

    .vd-top-right {
      border-radius: 0;
      border: 3px solid #000;
      background: rgba(0, 0, 0, 0.62);
      box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.12);
      backdrop-filter: none;
      font-family: 'PixelFont', monospace;
      font-size: 9px;
      line-height: 1.9;
    }

    .vd-topline {
      font-size: 9px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .vd-glyph { width: 14px; height: 14px; vertical-align: middle; }
    .vd-heart { filter: none; }
    .vd-heart.is-used { filter: grayscale(1) brightness(0.5); }
    .vd-coins { color: #ffd166; margin-left: 0; display: inline-flex; align-items: center; gap: 4px; }

    .vd-wavebar {
      border-radius: 0;
      border: 3px solid #000;
      background: rgba(0, 0, 0, 0.72);
      gap: 4px;
      padding: 5px;
      box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.16);
    }

    .vd-wave-cell {
      width: 20px;
      height: 20px;
      border-radius: 0;
      border: 2px solid #000;
      background: rgba(0, 0, 0, 0.55);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
      font-family: 'PixelFont', monospace;
      font-size: 8px;
      color: #ffffff; /* future waves: white */
      text-shadow: 1px 1px 0 #000;
    }

    .vd-wave-cell.is-done {
      background: rgba(0, 0, 0, 0.55);
      color: #5ad84a; /* completed: green */
    }

    .vd-wave-cell.is-current {
      background: rgba(0, 0, 0, 0.55);
      color: #ff4d4d; /* current: red */
      box-shadow: inset 0 0 0 2px #ff4d4d;
    }

    .vd-shield-shell, .vd-health-shell {
      border-radius: 0;
      border: 3px solid #000;
      background: #0a0d10;
      box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.12);
    }

    .vd-shield-fill { background: #2f8ed8; }   /* single solid colour */
    .vd-health-fill { background: #d83b3b; }   /* single solid colour */
    .vd-shield-label, .vd-health-label { font-family: 'PixelFont', monospace; font-size: 9px; }

    .vd-weapon { font-family: 'PixelFont', monospace; font-size: 10px; }
    .vd-ammo { font-family: 'PixelFont', monospace; font-size: 14px; }

    .vd-message {
      border-radius: 0;
      border: 3px solid #000;
      background: rgba(0, 0, 0, 0.72);
      box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.14);
      font-family: 'PixelFont', monospace;
      font-size: 10px;
      line-height: 1.6;
    }

    .vd-death-text { font-family: 'PixelFont', monospace; font-size: clamp(24px, 6vw, 56px); letter-spacing: 0; }
    .vd-death-sub { font-family: 'PixelFont', monospace; font-size: 10px; }

    .vd-slot { border-radius: 0; }
    .vd-slot-key, .vd-slot-count { font-family: 'PixelFont', monospace; }
    .vd-slot-key { font-size: 7px; }
    .vd-slot-count { font-size: 9px; }
    .vd-inventory { border-radius: 0; }
    .vd-inv-name { font-family: 'PixelFont', monospace; font-size: 9px; }
    .vd-inv-item { font-size: 8px; }
    .vd-guard { width: 32px; height: 32px; }
  `;
  document.head.appendChild(style);
}

function firstNumber(source, keys, fallback) {
  for (const key of keys) {
    const value = source?.[key];
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return fallback;
}

function firstText(source, keys, fallback) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return fallback;
}

function getWeaponName(state) {
  if (typeof state.weapon === 'string') {
    return state.weapon;
  }

  if (state.weapon && typeof state.weapon.name === 'string') {
    return state.weapon.name;
  }

  return firstText(state, ['weaponName', 'currentWeapon'], DEFAULT_STATE.weapon);
}

function getAmmo(state) {
  if (state.weapon && typeof state.weapon === 'object') {
    return {
      ammo: firstNumber(state.weapon, ['ammo', 'currentAmmo', 'magazine'], DEFAULT_STATE.ammo),
      maxAmmo: firstNumber(state.weapon, ['maxAmmo', 'clipSize', 'magazineSize'], DEFAULT_STATE.maxAmmo),
    };
  }

  return {
    ammo: firstNumber(state, ['ammo', 'currentAmmo', 'bullets'], DEFAULT_STATE.ammo),
    maxAmmo: firstNumber(state, ['maxAmmo', 'clipSize', 'magazineSize'], DEFAULT_STATE.maxAmmo),
  };
}

function getDragonCount(state) {
  const killed = firstNumber(state, ['dragonsKilled', 'dragonKills', 'dragonsDefeated'], null);
  const alive = firstNumber(state, ['dragons', 'dragonsAlive', 'dragonCount'], null);
  const total = firstNumber(state, ['dragonsTotal', 'totalDragons'], DEFAULT_STATE.dragonsTotal);

  if (killed !== null) {
    return { value: killed, total };
  }

  return { value: alive ?? DEFAULT_STATE.dragons, total };
}

export class HUD {
  constructor(container = document.body) {
    injectStyles();

    this.container = container;
    this.messageTimeout = null;
    this.damageTimeout = null;

    this.root = document.createElement('div');
    this.root.className = 'vd-hud';
    this.root.setAttribute('aria-hidden', 'true');
    this.root.innerHTML = `
      <div class="vd-vignette"></div>
      <div class="vd-whiteout" data-hud="whiteout"></div>
      <div class="vd-tint" data-hud="tint"></div>
      <div class="vd-crosshair"></div>
      <img class="vd-guard vd-glyph" data-hud="guard" src="${getGlyph('shield')}" alt="guardia" />
      <div class="vd-help">WASD mover | Espacio saltar | E o clic izq atacar | F o clic der habilidad | I inventario</div>
      <div class="vd-fps" data-hud="fps">0 FPS</div>
      <div class="vd-wavebar" data-hud="wavebar"></div>
      <div class="vd-countdown" data-hud="countdown"></div>
      <div class="vd-top-right">
        <div class="vd-topline"><img class="vd-heart vd-glyph" data-hud="heart" src="${getGlyph('heart')}" alt="vida" /><span class="vd-coins"><img class="vd-glyph" src="${getGlyph('coin')}" alt="monedas" /> <span data-hud="coins">0</span></span></div>
        Dragones: <span data-hud="dragons">0</span><br>Zombies: <span data-hud="zombies">0</span><br>Esqueletos: <span data-hud="skeletons">0</span><br>Brujas: <span data-hud="witches">0</span>
      </div>
      <div class="vd-message" data-hud="message"></div>
      <div class="vd-deathscreen" data-hud="deathscreen">
        <div class="vd-death-text">Has muerto</div>
        <div class="vd-death-sub">Volviendo a la selección de personaje...</div>
      </div>
      <div class="vd-inventory" data-hud="inventoryPanel"></div>
      <div class="vd-bottom-left">
        <div class="vd-shield-label"><span data-hud="shieldName">Escudo</span> <span data-hud="shield">100 / 100</span></div>
        <div class="vd-shield-shell"><div class="vd-shield-fill" data-hud="shieldFill"></div></div>
        <div class="vd-health-label">Vida <span data-hud="health">100 / 100</span></div>
        <div class="vd-health-shell"><div class="vd-health-fill" data-hud="healthFill"></div></div>
      </div>
      <div class="vd-bottom-right">
        <div class="vd-weapon" data-hud="weapon">Blaster</div>
        <div class="vd-ammo" data-hud="ammo">0</div>
      </div>
      <div class="vd-hotbar" data-hud="hotbar"></div>
    `;

    this.nodes = {
      vignette: this.root.querySelector('.vd-vignette'),
      whiteout: this.root.querySelector('[data-hud="whiteout"]'),
      tint: this.root.querySelector('[data-hud="tint"]'),
      countdown: this.root.querySelector('[data-hud="countdown"]'),
      guard: this.root.querySelector('[data-hud="guard"]'),
      shieldName: this.root.querySelector('[data-hud="shieldName"]'),
      shield: this.root.querySelector('[data-hud="shield"]'),
      shieldFill: this.root.querySelector('[data-hud="shieldFill"]'),
      health: this.root.querySelector('[data-hud="health"]'),
      healthFill: this.root.querySelector('[data-hud="healthFill"]'),
      ammo: this.root.querySelector('[data-hud="ammo"]'),
      weapon: this.root.querySelector('[data-hud="weapon"]'),
      dragons: this.root.querySelector('[data-hud="dragons"]'),
      zombies: this.root.querySelector('[data-hud="zombies"]'),
      skeletons: this.root.querySelector('[data-hud="skeletons"]'),
      witches: this.root.querySelector('[data-hud="witches"]'),
      fps: this.root.querySelector('[data-hud="fps"]'),
      coins: this.root.querySelector('[data-hud="coins"]'),
      heart: this.root.querySelector('[data-hud="heart"]'),
      wavebar: this.root.querySelector('[data-hud="wavebar"]'),
      deathscreen: this.root.querySelector('[data-hud="deathscreen"]'),
      message: this.root.querySelector('[data-hud="message"]'),
      hotbar: this.root.querySelector('[data-hud="hotbar"]'),
      inventoryPanel: this.root.querySelector('[data-hud="inventoryPanel"]'),
    };

    this.waveCells = [];
    this.buildWaveCells(DEFAULT_STATE.waveCount);

    this.container.appendChild(this.root);
    this.update(DEFAULT_STATE);
  }

  showDeathScreen() {
    this.nodes.deathscreen.classList.add('is-active');
  }

  // (Re)build the wave bar to hold exactly `count` numbered cells. Campaign has
  // 20 waves vs 10 in waves mode, so the bar adapts to the active run.
  buildWaveCells(count) {
    this.nodes.wavebar.innerHTML = '';
    this.waveCells = [];
    for (let i = 1; i <= count; i += 1) {
      const cell = document.createElement('div');
      cell.className = 'vd-wave-cell';
      cell.textContent = String(i);
      this.nodes.wavebar.appendChild(cell);
      this.waveCells.push(cell);
    }
  }

  update(state = {}) {
    const nextState = { ...DEFAULT_STATE, ...state };
    const maxHealth = Math.max(1, firstNumber(nextState, ['maxHealth', 'healthMax'], DEFAULT_STATE.maxHealth));
    const health = Math.max(0, Math.min(maxHealth, firstNumber(nextState, ['health', 'hp'], DEFAULT_STATE.health)));
    const maxShield = Math.max(0, firstNumber(nextState, ['maxShield', 'shieldMax'], DEFAULT_STATE.maxShield));
    const shield = Math.max(0, Math.min(maxShield, firstNumber(nextState, ['shield'], DEFAULT_STATE.shield)));
    const { ammo, maxAmmo } = getAmmo(nextState);
    const weapon = getWeaponName(nextState);
    const dragons = getDragonCount(nextState);

    if (typeof nextState.shieldLabel === 'string') this.nodes.shieldName.textContent = nextState.shieldLabel;
    this.nodes.shield.textContent = `${Math.round(shield)} / ${Math.round(maxShield)}`;
    this.nodes.shieldFill.style.transform = `scaleX(${maxShield > 0 ? shield / maxShield : 0})`;
    this.nodes.health.textContent = `${Math.round(health)} / ${Math.round(maxHealth)}`;
    this.nodes.healthFill.style.transform = `scaleX(${health / maxHealth})`;
    this.nodes.weapon.textContent = weapon;
    this.nodes.ammo.textContent = nextState.ammoText != null
      ? nextState.ammoText
      : (maxAmmo > 0 ? `${ammo} / ${maxAmmo}` : String(ammo));
    this.nodes.dragons.textContent = dragons.total === null ? String(dragons.value) : `${dragons.value} / ${dragons.total}`;
    this.nodes.zombies.textContent = String(firstNumber(nextState, ['zombies'], DEFAULT_STATE.zombies));
    this.nodes.skeletons.textContent = String(firstNumber(nextState, ['skeletons'], DEFAULT_STATE.skeletons));
    this.nodes.witches.textContent = String(firstNumber(nextState, ['witches'], DEFAULT_STATE.witches));
    this.nodes.fps.textContent = `${Math.round(firstNumber(nextState, ['fps'], DEFAULT_STATE.fps))} FPS`;
    this.nodes.coins.textContent = String(firstNumber(nextState, ['coins'], DEFAULT_STATE.coins));
    this.nodes.heart.classList.toggle('is-used', !nextState.revive);
    this.nodes.guard.classList.toggle('is-active', Boolean(nextState.guard));

    const wave = firstNumber(nextState, ['wave'], DEFAULT_STATE.wave);
    const waveCount = firstNumber(nextState, ['waveCount'], DEFAULT_STATE.waveCount);
    if (this.waveCells.length !== waveCount) this.buildWaveCells(waveCount);
    for (let i = 0; i < this.waveCells.length; i += 1) {
      const cell = this.waveCells[i];
      const cellWave = i + 1;
      cell.classList.toggle('is-current', cellWave === wave);
      cell.classList.toggle('is-done', cellWave < wave);
    }
    const countdown = nextState.countdown;
    if (this.nodes.countdown) {
      if (typeof countdown === 'number' && countdown > 0) {
        this.nodes.countdown.classList.add('is-active');
        this.nodes.countdown.innerHTML = `Siguiente oleada en <span class="vd-count-num">${Math.ceil(countdown)}</span>`;
      } else {
        this.nodes.countdown.classList.remove('is-active');
      }
    }

    this.renderInventory(nextState.inventory);
  }

  renderInventory(inventory) {
    if (!inventory?.slots) return;

    const swatch = (slot) => {
      const url = getIcon(slot.icon);
      return url
        ? `<div class="vd-slot-swatch has-icon" style="background-image:url(${url})"></div>`
        : '<div class="vd-slot-swatch"></div>';
    };

    this.nodes.hotbar.innerHTML = inventory.slots.map((slot, index) => `
      <div class="vd-slot ${index === inventory.selectedIndex ? 'is-selected' : ''}" style="--slot-color: ${slot.color}">
        <div class="vd-slot-key">${index + 1}</div>
        ${swatch(slot)}
        <div class="vd-slot-count">${slot.count === null ? '' : slot.count}</div>
      </div>
    `).join('');

    this.nodes.inventoryPanel.classList.toggle('is-open', Boolean(inventory.open));
    this.nodes.inventoryPanel.innerHTML = inventory.slots.map((slot) => `
      <div class="vd-inv-item" style="--slot-color: ${slot.color}">
        ${swatch(slot)}
        <div>
          <div class="vd-inv-name">${slot.label}</div>
          <div>${slot.kind === 'block' ? `${slot.count} bloques` : 'Arma'}</div>
        </div>
      </div>
    `).join('');
  }

  showMessage(text, ms = 1800) {
    window.clearTimeout(this.messageTimeout);
    this.nodes.message.textContent = text;
    this.nodes.message.classList.toggle('is-visible', Boolean(text));

    if (text && ms > 0) {
      this.messageTimeout = window.setTimeout(() => {
        this.nodes.message.classList.remove('is-visible');
      }, ms);
    }
  }

  // Blue full-screen tint for the blaster's charge-up (0 = clear, 1 = full).
  setTint(alpha = 0) {
    if (!this.nodes.tint) return;
    this.nodes.tint.style.opacity = String(Math.max(0, Math.min(1, alpha)));
  }

  flashDamage() {
    window.clearTimeout(this.damageTimeout);
    this.nodes.vignette.classList.add('is-active');
    this.damageTimeout = window.setTimeout(() => {
      this.nodes.vignette.classList.remove('is-active');
    }, 90);
  }

  // Full-screen white flash that fades over `ms` (hides the meteor map swap).
  whiteout(ms = 900) {
    const el = this.nodes.whiteout;
    if (!el) return;
    el.style.transition = 'none';
    el.style.opacity = '1';
    window.requestAnimationFrame(() => {
      el.style.transition = `opacity ${ms}ms ease-out`;
      el.style.opacity = '0';
    });
  }

  destroy() {
    window.clearTimeout(this.messageTimeout);
    window.clearTimeout(this.damageTimeout);
    this.root.remove();
  }
}

export default HUD;
