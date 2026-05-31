import * as THREE from 'three';

// The ClockPort: per-frame delta time. Wrapping THREE.Clock keeps the game loop
// from depending on it directly, so tests can inject a FakeClock with scripted
// deltas to step Game.tick() deterministically.
export class WebClock {
  constructor() { this._clock = new THREE.Clock(); }
  getDelta() { return this._clock.getDelta(); }
}

export default WebClock;
