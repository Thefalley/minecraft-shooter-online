import * as THREE from 'three';

// First-person held-weapon models. They are added as children of the camera,
// so local space is: -Z forward, +X right, +Y up. Each builder returns a Group
// already positioned at the "hand" anchor in front of the player.

function box(width, height, depth, color, options = {}) {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.6,
    metalness: options.metalness ?? 0.25,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 1,
    flatShading: true,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

function cylinder(radiusTop, radiusBottom, height, color, options = {}) {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.5,
    metalness: options.metalness ?? 0.4,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 1,
    flatShading: true,
  });
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, options.segments ?? 10), material);
  mesh.castShadow = false;
  return mesh;
}

function anchor(group, x, y, z) {
  group.position.set(x, y, z);
  group.traverse((child) => { child.frustumCulled = false; });
  group.renderOrder = 5;
  return group;
}

// A blocky Minecraft-style arm/fist gripping the weapon, added to every
// viewmodel so each character is visibly holding their gear. Sleeve tinted
// per character.
function addArm(group, { skin = 0xe7b48a, sleeve = 0x6d6d6d } = {}) {
  const arm = new THREE.Group();

  const hand = box(0.17, 0.16, 0.2, skin, { roughness: 0.95, metalness: 0 });
  hand.position.set(0, 0, 0.02);
  arm.add(hand);

  const forearm = box(0.16, 0.16, 0.42, skin, { roughness: 0.95, metalness: 0 });
  forearm.position.set(0, -0.02, 0.32);
  arm.add(forearm);

  const cuff = box(0.2, 0.2, 0.14, sleeve, { roughness: 0.9, metalness: 0.1 });
  cuff.position.set(0, -0.03, 0.54);
  arm.add(cuff);

  arm.position.set(0.0, -0.08, 0.14);
  arm.rotation.set(0.5, -0.12, 0.05);
  arm.traverse((child) => { child.frustumCulled = false; });
  group.add(arm);
  return arm;
}

export function buildDagger() {
  const g = new THREE.Group();

  const pommel = box(0.07, 0.07, 0.05, 0x6b5030, { metalness: 0.5 });
  pommel.position.z = 0.27;
  g.add(pommel);

  const handle = box(0.045, 0.05, 0.2, 0x3a2a1e, { roughness: 0.85 }); // grip
  handle.position.z = 0.15;
  g.add(handle);

  const guard = box(0.2, 0.05, 0.06, 0x9aa0aa, { metalness: 0.7 }); // crossguard
  guard.position.z = 0.04;
  g.add(guard);

  // Tapered blade: wider near the guard, narrowing toward the tip.
  const bladeBase = box(0.075, 0.026, 0.2, 0xd4dce6, { metalness: 0.85, roughness: 0.25 });
  bladeBase.position.z = -0.09;
  g.add(bladeBase);

  const bladeMid = box(0.05, 0.022, 0.18, 0xe2e9f1, { metalness: 0.88, roughness: 0.22 });
  bladeMid.position.z = -0.27;
  g.add(bladeMid);

  // Sharp point.
  const tip = cylinder(0.0, 0.035, 0.16, 0xf4f8fc, { metalness: 0.9, roughness: 0.16, segments: 4 });
  tip.rotation.x = -Math.PI / 2;
  tip.position.z = -0.45;
  g.add(tip);

  // Central fuller / ridge highlight.
  const ridge = box(0.013, 0.03, 0.46, 0xf8fbfe, { metalness: 0.92, roughness: 0.14 });
  ridge.position.z = -0.2;
  g.add(ridge);

  g.rotation.x = -0.16;
  return anchor(g, 0.28, -0.26, -0.55);
}

export function buildKatana(drawn = false) {
  const g = new THREE.Group();

  // Tsuka (wrapped grip).
  const handle = box(0.06, 0.06, 0.3, 0x1b1b22, { metalness: 0.2, roughness: 0.85 });
  handle.position.z = 0.18;
  g.add(handle);

  // Tsuba (guard).
  const tsuba = box(0.16, 0.16, 0.04, 0x2a2a2a, { metalness: 0.7 });
  tsuba.position.z = 0.02;
  g.add(tsuba);

  if (drawn) {
    // Bare curved blade.
    const blade = box(0.045, 0.06, 0.95, 0xeef2f7, { metalness: 0.92, roughness: 0.14 });
    blade.position.z = -0.46;
    blade.rotation.x = 0.05;
    g.add(blade);
    const edge = box(0.014, 0.062, 0.95, 0xffffff, { metalness: 0.95, roughness: 0.1 });
    edge.position.set(0.02, 0, -0.46);
    edge.rotation.x = 0.05;
    g.add(edge);
  } else {
    // Sheathed: dark lacquered scabbard (saya) covering the blade.
    const saya = box(0.085, 0.095, 0.92, 0x14223a, { metalness: 0.3, roughness: 0.5 });
    saya.position.z = -0.44;
    g.add(saya);
    const koiguchi = box(0.1, 0.11, 0.06, 0x0e0e0e, { metalness: 0.6 });
    koiguchi.position.z = 0.0;
    g.add(koiguchi);
  }

  g.rotation.x = -0.14;
  return anchor(g, 0.32, -0.28, -0.6);
}

export function buildSword() {
  const g = new THREE.Group();

  const handle = box(0.07, 0.07, 0.24, 0x3c2a20);
  handle.position.z = 0.2;
  g.add(handle);

  const pommel = box(0.1, 0.1, 0.08, 0xb8a64a, { metalness: 0.7 });
  pommel.position.z = 0.34;
  g.add(pommel);

  const guard = box(0.34, 0.07, 0.07, 0xb8a64a, { metalness: 0.7 });
  guard.position.z = 0.06;
  g.add(guard);

  const blade = box(0.09, 0.025, 0.92, 0xd7dee7, { metalness: 0.85, roughness: 0.25 });
  blade.position.z = -0.42;
  g.add(blade);

  g.rotation.x = -0.16;
  return anchor(g, 0.32, -0.28, -0.6);
}

export function buildRifle() {
  const g = new THREE.Group();

  const body = box(0.12, 0.16, 0.7, 0x2c3038, { metalness: 0.5 });
  body.position.z = -0.1;
  g.add(body);

  const barrel = cylinder(0.035, 0.035, 0.5, 0x1d2026, { metalness: 0.7 });
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02, -0.6);
  g.add(barrel);

  const handguard = box(0.1, 0.1, 0.34, 0x23272e);
  handguard.position.z = -0.42;
  g.add(handguard);

  const magazine = box(0.09, 0.26, 0.1, 0x3a3f48);
  magazine.position.set(0, -0.2, -0.02);
  magazine.rotation.x = 0.25;
  g.add(magazine);

  const stock = box(0.1, 0.13, 0.26, 0x2c3038);
  stock.position.z = 0.34;
  g.add(stock);

  const grip = box(0.08, 0.18, 0.09, 0x23272e);
  grip.position.set(0, -0.14, 0.14);
  grip.rotation.x = -0.3;
  g.add(grip);

  const sight = box(0.04, 0.06, 0.12, 0x15181d);
  sight.position.set(0, 0.12, -0.05);
  g.add(sight);

  return anchor(g, 0.34, -0.3, -0.7);
}

export function buildShotgun() {
  const g = new THREE.Group();

  const body = box(0.14, 0.15, 0.6, 0x4a2f1c, { metalness: 0.2, roughness: 0.7 }); // wood receiver
  body.position.z = -0.05;
  g.add(body);

  for (const x of [-0.045, 0.045]) {
    const barrel = cylinder(0.04, 0.04, 0.72, 0x20242a, { metalness: 0.7 });
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(x, 0.03, -0.5);
    g.add(barrel);
  }

  const pump = box(0.13, 0.09, 0.22, 0x6b4428, { roughness: 0.8 });
  pump.position.set(0, -0.1, -0.4);
  g.add(pump);

  const stock = box(0.12, 0.16, 0.34, 0x4a2f1c, { roughness: 0.7 });
  stock.position.z = 0.34;
  stock.rotation.x = 0.08;
  g.add(stock);

  const grip = box(0.09, 0.16, 0.09, 0x3a2516);
  grip.position.set(0, -0.13, 0.16);
  grip.rotation.x = -0.28;
  g.add(grip);

  return anchor(g, 0.34, -0.3, -0.7);
}

export function buildPistol() {
  const g = new THREE.Group();

  const slide = box(0.09, 0.11, 0.34, 0x2a2e35, { metalness: 0.6 });
  slide.position.z = -0.12;
  g.add(slide);

  const barrel = cylinder(0.025, 0.025, 0.14, 0x16191e, { metalness: 0.7 });
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02, -0.32);
  g.add(barrel);

  const grip = box(0.09, 0.2, 0.1, 0x23272e);
  grip.position.set(0, -0.16, 0.06);
  grip.rotation.x = -0.32;
  g.add(grip);

  const trigger = box(0.03, 0.06, 0.04, 0x15181d);
  trigger.position.set(0, -0.06, -0.02);
  g.add(trigger);

  return anchor(g, 0.32, -0.26, -0.6);
}

export function buildBlaster() {
  const g = new THREE.Group();

  const body = box(0.16, 0.18, 0.46, 0x2a3550, { metalness: 0.6, roughness: 0.35 });
  body.position.z = 0.0;
  g.add(body);

  // Futuristic cannon barrel.
  const barrel = cylinder(0.11, 0.13, 0.5, 0x1b2336, { metalness: 0.75 });
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.0, -0.5);
  g.add(barrel);

  const muzzle = cylinder(0.14, 0.11, 0.12, 0x10182a, { metalness: 0.8 });
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(0, 0, -0.78);
  g.add(muzzle);

  // Glowing blue energy accents.
  const coreColor = 0x54d2ff;
  const core = cylinder(0.05, 0.05, 0.52, coreColor, { metalness: 0.2, roughness: 0.2, emissive: coreColor, emissiveIntensity: 2.2 });
  core.rotation.x = Math.PI / 2;
  core.position.set(0, 0, -0.5);
  g.add(core);

  for (const z of [-0.2, -0.35, -0.5]) {
    const ring = cylinder(0.135, 0.135, 0.04, coreColor, { emissive: coreColor, emissiveIntensity: 2.4, metalness: 0.3 });
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0, z);
    g.add(ring);
  }

  const sideGlowL = box(0.03, 0.05, 0.3, coreColor, { emissive: coreColor, emissiveIntensity: 2 });
  sideGlowL.position.set(-0.09, 0.06, 0.02);
  g.add(sideGlowL);
  const sideGlowR = sideGlowL.clone();
  sideGlowR.position.x = 0.09;
  g.add(sideGlowR);

  const grip = box(0.09, 0.18, 0.1, 0x222a3c);
  grip.position.set(0, -0.16, 0.16);
  grip.rotation.x = -0.3;
  g.add(grip);

  return anchor(g, 0.34, -0.3, -0.72);
}

export function buildViewmodel(kind, opts = {}) {
  let model = null;
  switch (kind) {
    case 'rifle': model = buildRifle(); break;
    case 'shotgun': model = buildShotgun(); break;
    case 'blaster': model = buildBlaster(); break;
    case 'pistol': model = buildPistol(); break;
    case 'dagger': model = buildDagger(); break;
    case 'sword': model = buildSword(); break;
    case 'katana': model = buildKatana(false); break;
    case 'katana-drawn': model = buildKatana(true); break;
    default: return null;
  }
  // Every character grips their weapon with a blocky arm.
  if (model) addArm(model, { sleeve: opts.sleeve });
  return model;
}

export function disposeViewmodel(group) {
  group?.traverse?.((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
    else child.material?.dispose?.();
  });
}

export default buildViewmodel;
