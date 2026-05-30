import './styles.css';
import { Game } from './modules/Game.js';
import { Menu } from './modules/Menu.js';
import { CHARACTERS } from './modules/Characters.js';
import {
  MultiplayerCoordinator,
  readJoinParams,
  clearJoinParams,
} from './networking/index.js';
import { WaitingRoom, StatsOverlay } from './lobby/index.js';

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

  const teardown = async () => {
    try { waitingRoom?.dispose(); } catch { /* ignore */ }
    try { stats?.unmount(); } catch { /* ignore */ }
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

    // Persistent overlay (top-right FPS/PING) — mirrors apps/web.
    stats = new StatsOverlay();
    stats.mount();

    waitingRoom = new WaitingRoom(root, bridge, {
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

const params = readJoinParams();
if (params.mode === 'create' || params.mode === 'join') {
  startMultiplayer(params);
} else {
  showMenu();
}
