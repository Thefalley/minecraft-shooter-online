import { WebRenderer } from './WebRenderer.js';
import { WebClock } from './WebClock.js';
import { WebViewport } from './WebViewport.js';
import { Input } from './Input.js';
import { GameAudio } from './Audio.js';

// Composition of the browser host: the single object the game core depends on
// for all host I/O. `main.js` builds one of these and injects it into Game.
// Swapping this for a headless/alternate implementation (same shape) is how the
// core becomes testable and how future cross-platform/hardware backends plug in.
export function createWebPlatform({ root } = {}) {
  const renderer = new WebRenderer({ antialias: true, shadows: true });
  if (root) root.appendChild(renderer.domElement);

  const viewport = new WebViewport(window);
  renderer.setPixelRatio(viewport.pixelRatio);
  renderer.setSize(viewport.width, viewport.height);

  const loop = {
    start(callback) { renderer.three.setAnimationLoop(callback); },
    stop() { renderer.three.setAnimationLoop(null); },
  };

  const clock = new WebClock();
  const input = new Input({ target: renderer.domElement });
  const audio = new GameAudio();

  return {
    renderer,
    viewport,
    loop,
    clock,
    input,
    audio,
    dispose() {
      loop.stop();
      input.dispose?.();
      viewport.dispose();
      renderer.dispose();
      audio.dispose?.();
    },
  };
}

export default createWebPlatform;
