// The viewport port: window dimensions + resize notifications. Keeps `window`
// out of the game core.
export class WebViewport {
  constructor(win = window) {
    this.win = win;
    this._callbacks = [];
    this._onResize = () => { for (const cb of this._callbacks) cb(this.width, this.height); };
    this.win.addEventListener('resize', this._onResize);
  }

  get width() { return this.win.innerWidth; }
  get height() { return this.win.innerHeight; }
  get pixelRatio() { return Math.min(this.win.devicePixelRatio || 1, 2); }

  onResize(cb) { this._callbacks.push(cb); }

  dispose() {
    this.win.removeEventListener('resize', this._onResize);
    this._callbacks.length = 0;
  }
}

export default WebViewport;
