// Maps Minecraft block names to the game's block types. Built-in terrain blocks
// reuse the game's hand-drawn types (grass/dirt/stone/sand/…); everything else
// becomes a dynamic block carrying its real Minecraft colour, a matching texture
// kind (planks/bricks/cobble/bark/ore/glass/…), transparency and emission. Pure
// decorations (flowers, torches, rails) are skipped so they don't import as ugly
// floating cubes.
//
// The block database + resolution rules live in blockData.js; this class just
// caches results, de-duplicates identical materials into one game type, and
// accumulates the dynamic types into `extraBlocks` for the World to register.

import { resolveBlock } from './blockData.js';

function stripNamespace(name) {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
}

function slug(name) {
  return `mc_${name.replace(/[^a-z0-9_]/g, '_')}`;
}

export class BlockResolver {
  constructor() {
    this.extraBlocks = {};       // dynamic type id → material config
    this.cache = new Map();      // raw name → type id | null(skip)
    this.bySignature = new Map(); // spec signature → type id (de-dup identical materials)
    this.skipped = new Set();    // names dropped on import (decorations)
    this.unmatched = new Set();  // names that fell back to a hashed colour
  }

  resolve(rawName) {
    const name = stripNamespace(rawName);
    if (this.cache.has(name)) return this.cache.get(name);

    const r = resolveBlock(name);

    let type;
    if (r.skip) {
      type = null;
      this.skipped.add(name);
    } else if (r.type) {
      type = r.type; // reuse a built-in game type
    } else {
      // dynamic block: de-dupe identical specs onto one game type / InstancedMesh
      const sig = JSON.stringify(r.spec);
      const existing = this.bySignature.get(sig);
      if (existing) {
        type = existing;
      } else {
        type = slug(name);
        // guard against a slug collision between two different specs
        while (this.extraBlocks[type] && JSON.stringify(this.extraBlocks[type]) !== sig) type += '_';
        this.extraBlocks[type] = r.spec;
        this.bySignature.set(sig, type);
      }
      if (r.fallback) this.unmatched.add(name);
    }

    this.cache.set(name, type);
    return type;
  }
}

export default BlockResolver;
