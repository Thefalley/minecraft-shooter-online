// lobby/index.js
//
// Public barrel for the multiplayer waiting-room UI. main.js will import from
// here once the integration commit lands:
//
//   import { WaitingRoom, CharacterSelectStrip } from "./lobby/index.js";
//
// Keeping a barrel means downstream code never has to know about the file
// layout inside lobby/.

export { WaitingRoom } from "./WaitingRoom.js";
export { CharacterSelectStrip } from "./CharacterSelectStrip.js";
export { StatsOverlay } from "./StatsOverlay.js";
export { PointerLockHint } from "./PointerLockHint.js";
