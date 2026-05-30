import './styles.css';
import { Game } from './modules/Game.js';
import { Menu } from './modules/Menu.js';
import { CHARACTERS } from './modules/Characters.js';

const root = document.querySelector('#app');

function showMenu() {
  const menu = new Menu(root, CHARACTERS, (character) => {
    menu.hide();
    const game = new Game(root, { character, onExit: showMenu });
    game.start();
  });
}

showMenu();
