// Playable characters. No 3D models are needed — only the loadout, ability and
// base stats differ. The menu shows the name + emoji of each one.
//
// speedMult is relative to BALANCE.player.moveSpeed (the current "fast" speed):
//   fast = 1.0, normal = 0.8, slow = 0.6
export const CHARACTERS = [
  {
    id: 'duck',
    name: 'Pato',
    emoji: '🦆',
    loadout: 'guns', // rifle / shotgun / blaster + buildable blocks
    canPlaceBlocks: true,
    ability: 'place', // right click / F places blocks
    health: 100,
    shield: 100,
    speedMult: 0.8, // normal
  },
  {
    id: 'knight',
    name: 'Caballero',
    emoji: '⚔️',
    loadout: 'sword', // melee sword
    canPlaceBlocks: false,
    ability: 'guard', // right click / F raises a parrying guard
    health: 200,
    shield: 50,
    speedMult: 0.6, // slow
  },
  {
    id: 'hunter',
    name: 'Cazador',
    emoji: '🔪',
    loadout: 'dagger', // throws daggers that arc with gravity
    canPlaceBlocks: false,
    ability: 'dash', // right click / F dashes in the movement direction
    health: 75,
    shield: 50,
    speedMult: 1.0, // fast
  },
  {
    id: 'samurai',
    name: 'Samurai',
    emoji: '🗡️',
    loadout: 'katana', // melee katana with a parry-buff and a dash strike
    canPlaceBlocks: false,
    ability: 'samurai',
    health: 120,
    shield: 40,
    speedMult: 0.9,
  },
  {
    id: 'mage',
    name: 'Mago',
    emoji: '🧙',
    loadout: 'spells', // five elemental skills that cost mana (the shield)
    canPlaceBlocks: false,
    ability: 'none',
    health: 25,
    shield: 225, // shown as "Maná"
    speedMult: 0.8,
    manaName: true,
  },
];

export function getCharacter(id) {
  return CHARACTERS.find((character) => character.id === id) ?? CHARACTERS[0];
}

export default CHARACTERS;
