import './styles.css';
import { Game } from './modules/Game.js';
import { Menu } from './modules/Menu.js';
import { CHARACTERS } from './modules/Characters.js';
import {
  MultiplayerCoordinator,
  readJoinParams,
  clearJoinParams,
} from './networking/index.js';

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

async function startMultiplayer({ name, code, characterId, mode }) {
  const character = findCharacter(characterId);
  let coordinator = null;
  try {
    coordinator = new MultiplayerCoordinator({
      joinParams: { name, code, mode, characterId: character.id },
    });
    const game = new Game(root, {
      character,
      onExit: () => {
        coordinator?.stop().catch(() => {});
        clearJoinParams();
        showMenu();
      },
      network: coordinator,
    });
    coordinator.bind(game);
    await coordinator.start();
    game.start();
  } catch (err) {
    console.error('[mp] could not start multiplayer, falling back to menu', err);
    try {
      await coordinator?.stop();
    } catch {
      /* ignore */
    }
    clearJoinParams();
    showMenu();
  }
}

const params = readJoinParams();
if (params.mode === 'create' || params.mode === 'join') {
  startMultiplayer(params);
} else {
  showMenu();
}
