// Registry of playable maps. Add a new map module here and it shows up in the
// menu automatically. The first entry is the default.
import { meadow } from './meadow.js';
import { snowland } from './snowland.js';

export const MAPS = [meadow, snowland];

export function getMap(id) {
  return MAPS.find((map) => map.id === id) ?? MAPS[0];
}

export default MAPS;
