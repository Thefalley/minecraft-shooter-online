import * as THREE from 'three';

// Adapter around THREE.WebGLRenderer (the RendererPort). Game talks to this,
// never to WebGLRenderer directly, so a different backend (WebGPU, a desktop
// wrapper, or a headless null-renderer for tests) can be swapped in.
export class WebRenderer {
  constructor({ antialias = true, shadows = true } = {}) {
    this.three = new THREE.WebGLRenderer({ antialias });
    this.three.shadowMap.enabled = shadows;
    this.domElement = this.three.domElement;
  }

  setPixelRatio(ratio) { this.three.setPixelRatio(ratio); }
  setSize(width, height) { this.three.setSize(width, height); }
  render(scene, camera) { this.three.render(scene, camera); }

  // Precompiles the shader programs for everything currently in the scene, so
  // the first frames don't stall on GPU shader compilation. Call during init.
  prewarm(scene, camera) { this.three.compile(scene, camera); }

  dispose() {
    this.three.setAnimationLoop(null);
    this.three.dispose?.();
    this.domElement.remove();
  }
}

export default WebRenderer;
