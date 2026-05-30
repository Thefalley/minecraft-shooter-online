const DEFAULT_BINDINGS = {
  Space: 'jump',
  KeyE: 'attack',
  KeyI: 'interact',
  KeyF: 'alternate',
  KeyQ: 'drop',
  KeyR: 'reload',
  KeyP: 'debugSkipWave',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  ControlLeft: 'crouch',
  ControlRight: 'crouch',
  Digit1: 'weapon1',
  Digit2: 'weapon2',
  Digit3: 'weapon3',
  Digit4: 'weapon4',
  Digit5: 'weapon5',
  Digit6: 'weapon6',
  Digit7: 'weapon7',
  Digit8: 'weapon8',
  Digit9: 'weapon9',
  Digit0: 'weapon0',
  Mouse0: 'attack',
  Mouse1: 'aim',
  Mouse2: 'alternate'
};

export class Input extends EventTarget {
  constructor(options = {}) {
    super();

    this.target = options.target || document.body;
    this.document = this.target.ownerDocument || document;
    this.window = this.document.defaultView || window;
    this.bindings = { ...DEFAULT_BINDINGS, ...(options.bindings || {}) };
    this.pointerLockEnabled = options.pointerLock !== false;
    this.touchEnabled = options.touch !== false;

    this.keys = new Set();
    this.buttons = new Set();
    this.actions = new Set();
    this.pointerLocked = false;
    this.mouse = { x: 0, y: 0, dx: 0, dy: 0, wheel: 0 };
    this.touch = { active: false, x: 0, y: 0, dx: 0, dy: 0 };

    this._lastTouch = null;
    this._listeners = [];

    this._bind(this.window, 'keydown', this._onKeyDown);
    this._bind(this.window, 'keyup', this._onKeyUp);
    this._bind(this.target, 'mousedown', this._onMouseDown);
    this._bind(this.window, 'mouseup', this._onMouseUp);
    this._bind(this.window, 'mousemove', this._onMouseMove);
    this._bind(this.target, 'wheel', this._onWheel, { passive: false });
    this._bind(this.document, 'pointerlockchange', this._onPointerLockChange);
    this._bind(this.document, 'pointerlockerror', this._onPointerLockError);

    if (this.pointerLockEnabled) {
      this._bind(this.target, 'click', this.requestPointerLock);
    }

    if (this.touchEnabled) {
      this._bind(this.target, 'touchstart', this._onTouchStart, { passive: false });
      this._bind(this.target, 'touchmove', this._onTouchMove, { passive: false });
      this._bind(this.target, 'touchend', this._onTouchEnd, { passive: false });
      this._bind(this.target, 'touchcancel', this._onTouchEnd, { passive: false });
    }

    this.target.tabIndex = this.target.tabIndex < 0 ? 0 : this.target.tabIndex;
    this.target.style.touchAction = this.target.style.touchAction || 'none';
  }

  isDown(code) {
    return this.keys.has(code) || this.buttons.has(code);
  }

  consume(action) {
    if (!this.actions.has(action)) {
      return false;
    }

    this.actions.delete(action);
    return true;
  }

  update() {
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
    this.touch.dx = 0;
    this.touch.dy = 0;
  }

  requestPointerLock = () => {
    if (!this.pointerLockEnabled || this.pointerLocked || !this.target.requestPointerLock) {
      return;
    }

    this.target.requestPointerLock();
  };

  exitPointerLock() {
    if (this.pointerLocked && this.document.exitPointerLock) {
      this.document.exitPointerLock();
    }
  }

  dispose() {
    for (const [target, type, listener, options] of this._listeners) {
      target.removeEventListener(type, listener, options);
    }
    this._listeners.length = 0;
    this.keys.clear();
    this.buttons.clear();
    this.actions.clear();
  }

  _bind(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this._listeners.push([target, type, listener, options]);
  }

  _queue(action, detail = {}) {
    if (!action) {
      return;
    }

    this.actions.add(action);
    this._emit('input:action', { action, ...detail });
  }

  _emit(type, detail = {}) {
    const event = new CustomEvent(type, { detail });
    this.dispatchEvent(event);

    if (this.target.dispatchEvent) {
      this.target.dispatchEvent(new CustomEvent(type, { detail }));
    }
  }

  _onKeyDown = (event) => {
    const wasDown = this.keys.has(event.code);
    this.keys.add(event.code);

    if (!wasDown) {
      this._queue(this.bindings[event.code], { code: event.code, source: 'keyboard' });
    }
  };

  _onKeyUp = (event) => {
    this.keys.delete(event.code);
  };

  _onMouseDown = (event) => {
    const code = `Mouse${event.button}`;
    this.buttons.add(code);
    this._queue(this.bindings[code], { code, button: event.button, source: 'mouse' });
  };

  _onMouseUp = (event) => {
    this.buttons.delete(`Mouse${event.button}`);
  };

  _onMouseMove = (event) => {
    this.mouse.x = event.clientX;
    this.mouse.y = event.clientY;
    this.mouse.dx += event.movementX || 0;
    this.mouse.dy += event.movementY || 0;

    this._emit('input:move', {
      x: this.mouse.x,
      y: this.mouse.y,
      dx: event.movementX || 0,
      dy: event.movementY || 0,
      pointerLocked: this.pointerLocked
    });
  };

  _onWheel = (event) => {
    event.preventDefault();

    const direction = Math.sign(event.deltaY);
    this.mouse.wheel += event.deltaY;

    if (direction > 0) {
      this._queue('weaponNext', { delta: event.deltaY, source: 'wheel' });
    } else if (direction < 0) {
      this._queue('weaponPrev', { delta: event.deltaY, source: 'wheel' });
    }

    this._emit('input:wheel', { delta: event.deltaY, direction });
  };

  _onPointerLockChange = () => {
    this.pointerLocked = this.document.pointerLockElement === this.target;
    this._emit('input:pointerlock', { locked: this.pointerLocked });
  };

  _onPointerLockError = () => {
    this._emit('input:pointerlockerror');
  };

  _onTouchStart = (event) => {
    event.preventDefault();

    const touch = event.changedTouches[0];
    if (!touch) {
      return;
    }

    this.touch.active = true;
    this.touch.x = touch.clientX;
    this.touch.y = touch.clientY;
    this.touch.dx = 0;
    this.touch.dy = 0;
    this._lastTouch = { x: touch.clientX, y: touch.clientY };

    this._queue('touchPrimary', { source: 'touch', x: touch.clientX, y: touch.clientY });
    this._emit('input:touch', { phase: 'start', ...this.touch });
  };

  _onTouchMove = (event) => {
    event.preventDefault();

    const touch = event.changedTouches[0];
    if (!touch || !this._lastTouch) {
      return;
    }

    const dx = touch.clientX - this._lastTouch.x;
    const dy = touch.clientY - this._lastTouch.y;
    this.touch.x = touch.clientX;
    this.touch.y = touch.clientY;
    this.touch.dx += dx;
    this.touch.dy += dy;
    this.mouse.dx += dx;
    this.mouse.dy += dy;
    this._lastTouch = { x: touch.clientX, y: touch.clientY };

    this._emit('input:touch', { phase: 'move', ...this.touch });
  };

  _onTouchEnd = (event) => {
    event.preventDefault();
    this.touch.active = false;
    this._lastTouch = null;
    this._emit('input:touch', { phase: 'end', ...this.touch });
  };
}

export default Input;
