// Pointer-lock hint: a non-blocking centered overlay that tells the player to
// click on the canvas to control the camera. Hides itself as soon as the
// browser confirms the lock. Mirrors what shooters traditionally do when the
// pointer isn't locked.
//
// Critical: `pointer-events: none` so clicks pass straight through to the
// canvas — otherwise the hint itself would steal the click meant to trigger
// the lock request.

import './lobby.css';

export class PointerLockHint {
  constructor() {
    this._root = null;
    this._onChange = null;
  }

  mount() {
    if (this._root) return;
    const el = document.createElement('div');
    el.className = 'vd-pointer-hint';
    el.innerHTML = `
      <div class="hint">
        <span class="icon">🖱️</span>
        <span class="text">Haz clic en el juego para activar el ratón</span>
        <span class="sub">Esc para liberar</span>
      </div>
    `;
    document.body.appendChild(el);
    this._root = el;

    this._onChange = () => this._refresh();
    document.addEventListener('pointerlockchange', this._onChange);
    document.addEventListener('webkitpointerlockchange', this._onChange);
    this._refresh();
  }

  unmount() {
    if (!this._root) return;
    document.removeEventListener('pointerlockchange', this._onChange);
    document.removeEventListener('webkitpointerlockchange', this._onChange);
    this._onChange = null;
    this._root.remove();
    this._root = null;
  }

  _refresh() {
    if (!this._root) return;
    const locked = document.pointerLockElement || document.webkitPointerLockElement;
    this._root.classList.toggle('is-hidden', !!locked);
  }
}
