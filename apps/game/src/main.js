import './styles.css';
import { Game } from './modules/Game.js';
import { Menu } from './modules/Menu.js';
import { CHARACTERS } from './modules/Characters.js';
import {
  MultiplayerCoordinator,
  readJoinParams,
  clearJoinParams,
} from './networking/index.js';
import { WaitingRoom, StatsOverlay, PointerLockHint } from './lobby/index.js';

const root = document.querySelector('#app');

function findCharacter(id) {
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}

function showMenu() {
  const menu = new Menu(root, CHARACTERS, (character) => {
    menu.hide();
    const game = new Game(root, { character, onExit: showMenu });
    game.start();
  });
}

/**
 * Multiplayer flow:
 *   1. URL params (?code=&name=&mode=) come from the lobby (apps/web).
 *   2. Coordinator connects to Colyseus.
 *   3. We show the WaitingRoom (room code + player list + character cards +
 *      host-only "Empezar partida"). Other agents own this UI.
 *   4. When the server flips phase to "playing", WaitingRoom's onStart fires
 *      and we instantiate Game with network=coordinator. game.start() runs the
 *      regular renderer loop with CSP wiring.
 *   5. On Esc / exit: stop the coordinator, clear URL params, back to menu.
 */
async function startMultiplayer({ name, code, characterId, mode }) {
  const initialCharacter = findCharacter(characterId);
  let coordinator = null;
  let waitingRoom = null;
  let stats = null;
  let pointerHint = null;

  const teardown = async () => {
    try { waitingRoom?.dispose(); } catch { /* ignore */ }
    try { stats?.unmount(); } catch { /* ignore */ }
    try { pointerHint?.unmount(); } catch { /* ignore */ }
    try { await coordinator?.stop(); } catch { /* ignore */ }
    clearJoinParams();
  };

  try {
    coordinator = new MultiplayerCoordinator({
      joinParams: { name, code, mode, characterId: initialCharacter.id },
    });

    // Open the connection FIRST — bind() needs a Game and we don't have one
    // yet; the WaitingRoom is happy with just the bridge.
    await coordinator.start();

    const bridge = coordinator.getBridge();

    // Persistent overlay (top-right FPS/PING + room code) — mirrors apps/web.
    stats = new StatsOverlay();
    stats.mount();
    // Welcome may have already fired (we awaited start() above) — try to
    // grab the room code immediately, and also subscribe so a reconnect
    // updates it.
    const initialCode = bridge.getRoomCode?.() ?? bridge.getRoomState?.()?.roomCode ?? null;
    if (initialCode) stats.setRoomCode(initialCode);
    bridge.on?.('welcome', (p) => stats?.setRoomCode?.(p?.roomCode));

    // If the URL hinted at a character (via the lobby flow), tell the
    // server up front so other clients render it correctly even before the
    // user clicks a card.
    if (initialCharacter?.id && typeof bridge.emitCharacterSelect === 'function') {
      bridge.emitCharacterSelect(initialCharacter.id);
    }

    // If the bridge fails / disconnects mid-game, route the user back to
    // the menu instead of leaving them frozen on a half-rendered scene.
    coordinator.onDisconnect?.((status) => {
      console.warn('[mp] coordinator disconnected:', status);
      teardown().finally(() => showMenu());
    });

    waitingRoom = new WaitingRoom(root, bridge, {
      initialCharacterId: initialCharacter.id,
      onStart: () => {
        try { waitingRoom?.dispose(); } catch { /* ignore */ }
        waitingRoom = null;

        // Read the character the user finally landed on, defaulting to their
        // URL hint then to duck. The bridge keeps the last selection echoed
        // back from the server in playerSnapshot events.
        const selfId = bridge.getSelfSessionId?.() ?? coordinator.getSelfSessionId();
        const state = bridge.getRoomState?.();
        const selfPlayer = state?.players?.get?.(selfId);
        const chosenId = selfPlayer?.characterId || initialCharacter.id;
        const character = findCharacter(chosenId);

        const game = new Game(root, {
          character,
          network: coordinator,
          onExit: async () => {
            await teardown();
            showMenu();
          },
        });
        coordinator.bind(game);
        game.start();
        // Mount the pointer-lock hint AFTER game.start() so it sits on top
        // of the freshly-mounted canvas. Hides itself as soon as the player
        // clicks and pointer lock engages.
        pointerHint = new PointerLockHint();
        pointerHint.mount();
      },
      onLeave: async () => {
        await teardown();
        showMenu();
      },
    });
    waitingRoom.show();
  } catch (err) {
    console.error('[mp] could not start multiplayer, falling back to menu', err);
    await teardown();
    showMenu();
  }
}

// The Voxel-Dragons game is the multiplayer client. The proper entry point
// is the lobby (apps/web) which creates/joins a room and redirects here with
// ?code=…&name=…&mode=. If someone lands here without those params they're
// taking a wrong turn — bounce them back to the lobby so the experience is
// consistent.
//
// `?solo=1` is a debug escape hatch that keeps the imported singleplayer
// menu reachable, useful for local dev and for verifying the original
// Voxel-Dragons code still works after a refactor.
const params = readJoinParams();
const isSoloDebug = (() => {
  try {
    return new URLSearchParams(window.location.search).get('solo') === '1';
  } catch {
    return false;
  }
})();

if (params.mode === 'create' || params.mode === 'join') {
  startMultiplayer(params);
} else if (isSoloDebug) {
  showMenu();
} else {
  const lobbyUrl = import.meta.env.VITE_LOBBY_URL || 'https://minecraft-shooter-online-web.vercel.app';
  window.location.replace(lobbyUrl);
}
