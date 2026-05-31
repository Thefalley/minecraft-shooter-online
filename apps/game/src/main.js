import './styles.css';
import { Game } from './game/Game.js';
import { Menu } from './ui/Menu.js';
import { ModeMenu } from './ui/ModeMenu.js';
import { CampaignMenu } from './ui/CampaignMenu.js';
import { CHARACTERS, getCharacter } from './content/characters/Characters.js';
import { MAPS, getMap } from './content/maps/index.js';
import { CAMPAIGNS } from './content/campaigns/index.js';
import { createWebPlatform } from './platform/web/createWebPlatform.js';
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

// ─── Singleplayer / debug menus (upstream flow) ──────────────────────
//
// Reachable with ?solo=1. The lobby is the production entry point — bare
// game URL bounces back to it (see bottom of file).

function launchSolo(options) {
  const platform = createWebPlatform({ root });
  const game = new Game(root, { platform, onExit: showModeMenu, ...options });
  game.start();
}

function showModeMenu() {
  const menu = new ModeMenu(root, {
    onWaves: () => { menu.hide(); showWavesMenu(); },
    onCampaign: () => { menu.hide(); showCampaignMenu(); },
  });
}

function showWavesMenu() {
  const menu = new Menu(root, CHARACTERS, MAPS, (character, map) => {
    menu.hide();
    launchSolo({ character, map, mode: 'waves' });
  });
}

function showCampaignMenu() {
  const menu = new CampaignMenu(
    root,
    CAMPAIGNS,
    (campaign) => {
      menu.hide();
      launchSolo({
        character: getCharacter(campaign.character),
        map: getMap(campaign.map),
        mode: 'campaign',
        campaign,
      });
    },
    () => { menu.hide(); showModeMenu(); },
  );
}

// ─── Multiplayer flow ────────────────────────────────────────────────
//
// 1. URL params (?code=&name=&mode=) come from the lobby (apps/web).
// 2. Coordinator connects to Colyseus.
// 3. WaitingRoom (room code + player list + character cards + host start).
// 4. Host clicks "Empezar partida" → onStart fires → spawn Game with
//    network=coordinator, EnemySync+WorldSync take over from the local
//    AI, the server's WaveDirector drives every enemy and dragon.
// 5. On Esc / disconnect: tear down coordinator, return to lobby.

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
    await coordinator.start();
    const bridge = coordinator.getBridge();

    stats = new StatsOverlay();
    stats.mount();
    const initialCode = bridge.getRoomCode?.() ?? bridge.getRoomState?.()?.roomCode ?? null;
    if (initialCode) stats.setRoomCode(initialCode);
    bridge.on?.('welcome', (p) => stats?.setRoomCode?.(p?.roomCode));

    if (initialCharacter?.id && typeof bridge.emitCharacterSelect === 'function') {
      bridge.emitCharacterSelect(initialCharacter.id);
    }

    coordinator.onDisconnect?.((status) => {
      console.warn('[mp] coordinator disconnected:', status);
      teardown().finally(() => showModeMenu());
    });

    waitingRoom = new WaitingRoom(root, bridge, {
      initialCharacterId: initialCharacter.id,
      onStart: () => {
        try { waitingRoom?.dispose(); } catch { /* ignore */ }
        waitingRoom = null;

        const selfId = bridge.getSelfSessionId?.() ?? coordinator.getSelfSessionId();
        const state = bridge.getRoomState?.();
        const selfPlayer = state?.players?.get?.(selfId);
        const chosenId = selfPlayer?.characterId || initialCharacter.id;
        const character = findCharacter(chosenId);

        // Multiplayer game uses 'waves' mode by default (lobby doesn't pick
        // campaign yet) and the first available map. The server is the
        // wave director so this mode only affects the local UI/HUD.
        const platform = createWebPlatform({ root });
        const game = new Game(root, {
          platform,
          character,
          map: MAPS[0],
          mode: 'waves',
          network: coordinator,
          onExit: async () => {
            await teardown();
            showModeMenu();
          },
        });
        coordinator.bind(game);
        game.start();
        // Pointer-lock hint sits on top of the freshly-mounted canvas.
        pointerHint = new PointerLockHint();
        pointerHint.mount();
      },
      onLeave: async () => {
        await teardown();
        showModeMenu();
      },
    });
    waitingRoom.show();
  } catch (err) {
    console.error('[mp] could not start multiplayer, falling back to menu', err);
    await teardown();
    showModeMenu();
  }
}

// ─── Entry point ─────────────────────────────────────────────────────
//
// Lobby (apps/web) is the canonical entry point. The bare game URL has
// no useful UI on its own — it redirects you back to the lobby.
//
// ?code=…&name=…&mode={create|join} → multiplayer (set by the lobby form)
// ?solo=1                            → upstream singleplayer menus
// no params                          → redirect to lobby URL

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
  showModeMenu();
} else {
  const lobbyUrl = import.meta.env.VITE_LOBBY_URL || 'https://minecraft-shooter-online-web.vercel.app';
  window.location.replace(lobbyUrl);
}
