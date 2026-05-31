// WaitingRoom.js
//
// Fullscreen DOM overlay shown between the menu (where the player typed a
// name / picked Create vs Join) and the actual 3D Game. By the time we mount,
// the NetworkBridge has already connected to a Colyseus room; our job is to:
//
//   1. Display the room code so the host can share it.
//   2. List every connected player (name, host crown, chosen character).
//   3. Let each player pick their character via a CharacterSelectStrip and
//      reflect server-confirmed picks back into the list.
//   4. Show "Empezar partida" to the host (gray "Esperando al host…" to
//      non-hosts). Click sends bridge.emitLobbyStart() with a defensive
//      raw send fallback.
//   5. Render a centered "3… 2… 1… ¡YA!" countdown when the server
//      broadcasts vs:lobby:startCountdown.
//   6. When the server promotes the room to phase "playing", invoke
//      opts.onStart() and tear down.
//
// This module is intentionally self-contained: it injects its own styles,
// owns its own DOM tree, and unwires every bridge subscription on hide().
// The integration into main.js (deciding when to mount it instead of Menu)
// happens in a later commit by the parent agent.

import "./lobby.css";
import { CHARACTERS } from "../content/characters/Characters.js";
import { CharacterSelectStrip } from "./CharacterSelectStrip.js";

const STYLE_ID = "vd-lobby-style";

// Mirror the styles that lobby.css ships, injected via a <style> tag so the
// overlay still works in environments where Vite's CSS pipeline isn't doing
// the import (e.g. raw test harnesses). Keep this string roughly in sync with
// lobby.css — they describe the same selectors. The id guard means we never
// double-insert.
const INLINE_STYLES = `
.vd-lobby{position:fixed;inset:0;z-index:50;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;color:#f7fbff;font-family:Arial,Helvetica,sans-serif;text-align:center;background:rgba(10,12,16,0.92);user-select:none;padding:24px;box-sizing:border-box;}
.vd-lobby-card{width:100%;max-width:720px;padding:32px;box-sizing:border-box;background:rgba(20,24,30,0.95);border:1px solid rgba(255,255,255,0.08);border-radius:14px;display:flex;flex-direction:column;gap:22px;box-shadow:0 18px 48px rgba(0,0,0,0.55);}
.vd-lobby-header{display:flex;flex-direction:column;gap:6px;align-items:center;}
.vd-lobby-title{margin:0;font-size:22px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:rgba(231,246,255,0.85);}
.vd-lobby-room{display:flex;flex-direction:column;gap:4px;align-items:center;}
.vd-lobby-room-label{font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(231,246,255,0.6);}
.vd-lobby-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:36px;font-weight:800;letter-spacing:6px;color:#f7fbff;text-shadow:0 0 24px rgba(120,190,255,0.4);}
.vd-lobby-section-label{font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(231,246,255,0.55);text-align:left;margin:0 0 8px 0;}
.vd-lobby-players{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;}
.vd-lobby-player{display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:8px;font-size:15px;text-align:left;}
.vd-lobby-player.is-self{background:rgba(120,190,255,0.08);border-color:rgba(120,190,255,0.32);}
.vd-lobby-player-crown{font-size:18px;width:22px;text-align:center;}
.vd-lobby-player-name{flex:1;font-weight:700;color:#f7fbff;}
.vd-lobby-player-you{font-size:11px;font-weight:700;letter-spacing:1px;color:rgba(120,190,255,0.9);text-transform:uppercase;margin-left:6px;}
.vd-lobby-player-character{font-size:13px;font-weight:700;color:rgba(231,246,255,0.85);display:flex;align-items:center;gap:6px;}
.vd-lobby-player-character.is-pending{color:rgba(231,246,255,0.45);font-style:italic;font-weight:500;}
.vd-lobby-strip{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;}
.vd-lobby-char{flex:0 0 120px;display:flex;flex-direction:column;align-items:center;padding:14px 10px;box-sizing:border-box;background:rgba(20,28,38,0.7);border:2px solid rgba(255,255,255,0.12);border-radius:10px;cursor:pointer;transition:transform 120ms ease-out,border-color 120ms ease-out,background 120ms ease-out,box-shadow 120ms ease-out;}
.vd-lobby-char:hover{transform:translateY(-2px);background:rgba(36,48,62,0.78);}
.vd-lobby-char.is-selected{border-color:#5fa8ff;background:rgba(40,58,84,0.92);box-shadow:0 0 0 3px rgba(95,168,255,0.28),0 10px 24px rgba(0,0,0,0.4);transform:translateY(-3px);}
.vd-lobby-char-emoji{font-size:36px;line-height:1;}
.vd-lobby-char-name{margin-top:8px;font-size:14px;font-weight:800;color:#f7fbff;}
.vd-lobby-char-note{margin-top:4px;font-size:11px;font-weight:600;color:rgba(231,246,255,0.65);min-height:26px;text-align:center;line-height:1.25;}
.vd-lobby-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.vd-lobby-leave{padding:10px 22px;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:rgba(231,246,255,0.85);background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.18);border-radius:8px;cursor:pointer;transition:background 120ms ease-out,border-color 120ms ease-out;}
.vd-lobby-leave:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.28);}
.vd-lobby-start{padding:14px 36px;font-size:18px;font-weight:800;letter-spacing:1px;color:#102014;background:linear-gradient(180deg,#8be36a,#49a82f);border:none;border-radius:10px;cursor:pointer;box-shadow:0 6px 0 #2f6e1d,0 10px 22px rgba(0,0,0,0.4);transition:transform 90ms ease-out,box-shadow 90ms ease-out,opacity 120ms ease-out;}
.vd-lobby-start:active{transform:translateY(4px);box-shadow:0 2px 0 #2f6e1d,0 6px 14px rgba(0,0,0,0.4);}
.vd-lobby-start:disabled,.vd-lobby-start[disabled]{cursor:not-allowed;opacity:0.5;background:linear-gradient(180deg,#6b7280,#4b5563);box-shadow:0 6px 0 #1f2937,0 10px 22px rgba(0,0,0,0.3);}
.vd-lobby-wait{font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:rgba(231,246,255,0.55);padding:14px 28px;}
.vd-lobby-countdown{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;pointer-events:none;background:rgba(0,0,0,0.45);animation:vd-lobby-countdown-fade 240ms ease-out;}
.vd-lobby-countdown-number{font-size:120px;font-weight:900;color:#f7fbff;text-shadow:0 8px 32px rgba(120,190,255,0.6),0 0 80px rgba(120,190,255,0.5);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:4px;animation:vd-lobby-countdown-pop 800ms ease-out;}
.vd-lobby-countdown-number.is-go{font-size:96px;letter-spacing:8px;color:#8be36a;text-shadow:0 8px 32px rgba(139,227,106,0.7),0 0 80px rgba(139,227,106,0.55);}
@keyframes vd-lobby-countdown-fade{from{opacity:0;}to{opacity:1;}}
@keyframes vd-lobby-countdown-pop{from{transform:scale(0.5);opacity:0;}60%{transform:scale(1.1);opacity:1;}to{transform:scale(1);opacity:1;}}
`;

function injectStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = INLINE_STYLES;
  document.head.appendChild(style);
}

// Lookup a character by id, falling back to the default duck. Avoids
// re-implementing Characters.getCharacter to keep this file self-contained
// in case the helper signature changes.
function findCharacter(id) {
  if (!id) return null;
  return CHARACTERS.find((c) => c.id === id) || null;
}

export class WaitingRoom {
  /**
   * @param {HTMLElement} root   The #app container the Game would mount into.
   * @param {object}      bridge The connected NetworkBridge instance.
   * @param {object}      [opts]
   * @param {() => void}  [opts.onStart]  Phase transitioned lobby → playing.
   * @param {() => void}  [opts.onLeave]  User clicked "Salir".
   */
  constructor(root, bridge, opts = {}) {
    this.root = root;
    this.bridge = bridge;
    this.opts = opts || {};

    this._mounted = false;
    this._overlay = null;
    this._countdownNode = null;
    this._countdownInterval = null;
    this._countdownEndAt = 0;

    // Server-driven state mirrors.
    this._selfSessionId = bridge?.getSelfSessionId?.() ?? null;
    this._roomCode = bridge?.getRoomCode?.() ?? null;
    this._hostSessionId = null;
    /** @type {Map<string, {id:string,name:string,characterId:string|null,isHost:boolean}>} */
    this._players = new Map();

    this._localCharacterId = "duck";
    this._strip = null;

    // Bridge subscriptions — populated on show(), drained on hide().
    this._unsubs = [];

    // DOM references — populated by _buildDom().
    this._codeNode = null;
    this._playersNode = null;
    this._stripHost = null;
    this._actionsNode = null;
  }

  show() {
    if (this._mounted) return;
    injectStyles();
    this._buildDom();
    this._seedFromRoomState();
    this._subscribe();
    this._renderPlayers();
    this._renderActions();
    this._mounted = true;
  }

  hide() {
    if (!this._mounted) return;
    this._mounted = false;

    // Drain bridge subscriptions.
    for (const off of this._unsubs) {
      try {
        off();
      } catch {
        /* swallow */
      }
    }
    this._unsubs.length = 0;

    // Stop any in-flight countdown.
    this._clearCountdown();

    // Destroy the strip first so it can unsubscribe from its own state.
    try {
      this._strip?.destroy();
    } catch {
      /* swallow */
    }
    this._strip = null;

    // Detach the overlay.
    if (this._overlay && this._overlay.parentNode) {
      this._overlay.parentNode.removeChild(this._overlay);
    }
    this._overlay = null;
    this._codeNode = null;
    this._playersNode = null;
    this._stripHost = null;
    this._actionsNode = null;
    this._players.clear();
  }

  /** Alias of hide() for consistency with the disposable pattern. */
  dispose() {
    this.hide();
  }

  // ── DOM ──────────────────────────────────────────────────────────────────

  _buildDom() {
    const overlay = document.createElement("div");
    overlay.className = "vd-lobby";

    const card = document.createElement("div");
    card.className = "vd-lobby-card";

    const header = document.createElement("div");
    header.className = "vd-lobby-header";

    const title = document.createElement("h2");
    title.className = "vd-lobby-title";
    title.textContent = "Sala de espera";

    const room = document.createElement("div");
    room.className = "vd-lobby-room";

    const roomLabel = document.createElement("div");
    roomLabel.className = "vd-lobby-room-label";
    roomLabel.textContent = "Sala";

    const code = document.createElement("div");
    code.className = "vd-lobby-code";
    code.textContent = this._roomCode || "······";
    this._codeNode = code;

    room.appendChild(roomLabel);
    room.appendChild(code);
    header.appendChild(title);
    header.appendChild(room);
    card.appendChild(header);

    // Players section
    const playersSection = document.createElement("div");
    const playersLabel = document.createElement("div");
    playersLabel.className = "vd-lobby-section-label";
    playersLabel.textContent = "Jugadores";
    const playersList = document.createElement("ul");
    playersList.className = "vd-lobby-players";
    this._playersNode = playersList;
    playersSection.appendChild(playersLabel);
    playersSection.appendChild(playersList);
    card.appendChild(playersSection);

    // Character select section
    const stripSection = document.createElement("div");
    const stripLabel = document.createElement("div");
    stripLabel.className = "vd-lobby-section-label";
    stripLabel.textContent = "Tu personaje";
    const stripHost = document.createElement("div");
    this._stripHost = stripHost;
    stripSection.appendChild(stripLabel);
    stripSection.appendChild(stripHost);
    card.appendChild(stripSection);

    // Mount the character strip into the host element.
    this._strip = new CharacterSelectStrip(stripHost, this.bridge, {
      characters: CHARACTERS,
      initialSelection: this._localCharacterId,
    });

    // Actions row (leave + start/wait).
    const actions = document.createElement("div");
    actions.className = "vd-lobby-actions";
    this._actionsNode = actions;
    card.appendChild(actions);

    overlay.appendChild(card);
    this._overlay = overlay;
    this.root.appendChild(overlay);
  }

  // ── Server state seeding ─────────────────────────────────────────────────

  _seedFromRoomState() {
    const state = this.bridge?.getRoomState?.();
    if (!state) return;

    // roomCode may have already arrived via the join handshake.
    if (state.roomCode && !this._roomCode) {
      this._roomCode = state.roomCode;
      if (this._codeNode) this._codeNode.textContent = this._roomCode;
    }

    // Walk state.players if available. Colyseus MapSchema exposes forEach().
    const players = state.players;
    if (players && typeof players.forEach === "function") {
      players.forEach((player, sessionId) => {
        this._upsertPlayer(sessionId, player);
      });
    }

    // Try to derive a host session id if the schema exposes one.
    if (typeof state.hostSessionId === "string") {
      this._hostSessionId = state.hostSessionId;
    }

    // Late-joiner detection: if the room is already past 'lobby' by the time
    // we mount, this player joined mid-game. We hold them at the lobby with
    // a manual "Entrar a la partida" button + character select, rather than
    // auto-dropping into the scene as soon as PhaseChange arrives.
    const initialPhase = typeof state.phase === "string" ? state.phase : "lobby";
    this._isLateJoiner = initialPhase !== "lobby";
  }

  // ── Bridge wiring ────────────────────────────────────────────────────────

  _subscribe() {
    const bridge = this.bridge;
    if (!bridge || typeof bridge.on !== "function") return;

    const add = (event, fn) => {
      try {
        const off = bridge.on(event, fn);
        if (typeof off === "function") this._unsubs.push(off);
      } catch {
        /* event might not exist yet on this bridge build; ignore */
      }
    };

    add("welcome", (p) => this._onWelcome(p));
    add("playerJoined", (p) => this._onPlayerJoined(p));
    add("playerLeft", (p) => this._onPlayerLeft(p));
    add("playerSnapshot", (p) => this._onPlayerSnapshot(p));

    // Host change comes from the server's vs:lobby:hostChange message. The
    // lobby-flow agent's bridge build re-emits it under one of these names;
    // we listen to both so we don't care which one wins.
    const onHost = (p) => this._onHostChange(p);
    add("lobbyHostChange", onHost);
    add("hostChange", onHost);

    // Phase transitions — when we go to "playing" we tear down and notify.
    const onPhase = (p) => this._onPhaseChange(p);
    add("lobbyPhaseChange", onPhase);
    add("phaseChange", onPhase);

    // Countdown updates.
    const onCountdown = (p) => this._onStartCountdown(p);
    add("lobbyStartCountdown", onCountdown);
    add("startCountdown", onCountdown);
  }

  _onWelcome(payload) {
    if (!payload) return;
    if (typeof payload.selfSessionId === "string") {
      this._selfSessionId = payload.selfSessionId;
    }
    if (typeof payload.roomCode === "string" && payload.roomCode) {
      this._roomCode = payload.roomCode;
      if (this._codeNode) this._codeNode.textContent = this._roomCode;
    }
    this._renderPlayers();
    this._renderActions();
  }

  _onPlayerJoined(payload) {
    if (!payload) return;
    const sessionId =
      payload.sessionId ?? payload.id ?? payload.player?.sessionId ?? null;
    if (!sessionId) return;
    this._upsertPlayer(sessionId, payload.player ?? payload);
    this._renderPlayers();
    this._renderActions();
  }

  _onPlayerLeft(payload) {
    if (!payload) return;
    const sessionId = payload.sessionId ?? payload.id ?? null;
    if (!sessionId) return;
    this._players.delete(sessionId);
    // If the host just left, fall back to "unknown host" until the server
    // broadcasts a new vs:lobby:hostChange.
    if (this._hostSessionId === sessionId) this._hostSessionId = null;
    this._renderPlayers();
    this._renderActions();
  }

  _onPlayerSnapshot(payload) {
    if (!payload) return;
    const sessionId =
      payload.sessionId ?? payload.id ?? payload.player?.sessionId ?? null;
    if (!sessionId) return;
    this._upsertPlayer(sessionId, payload.player ?? payload);

    // If the snapshot is for us, mirror the chosen character into the strip.
    if (sessionId === this._selfSessionId) {
      const entry = this._players.get(sessionId);
      if (entry?.characterId && entry.characterId !== this._localCharacterId) {
        this._localCharacterId = entry.characterId;
        this._strip?.setSelection(entry.characterId);
      }
    }

    this._renderPlayers();
    this._renderActions();
  }

  _onHostChange(payload) {
    if (!payload) return;
    const hostId =
      payload.hostSessionId ?? payload.host ?? payload.sessionId ?? null;
    if (typeof hostId !== "string") return;
    this._hostSessionId = hostId;

    // Reflect the crown on each player.
    for (const [sessionId, player] of this._players.entries()) {
      player.isHost = sessionId === hostId;
    }
    this._renderPlayers();
    this._renderActions();
  }

  _onPhaseChange(payload) {
    if (!payload) return;
    const to = payload.to ?? payload.phase ?? null;
    if (to !== "playing") return;
    // Late joiner: don't auto-drop into the game. The user needs a moment
    // to see what room they're in, who's there, and pick a character. The
    // "Entrar a la partida" button in _renderActions completes the entry.
    if (this._isLateJoiner) {
      this._renderActions();
      return;
    }
    // Normal flow (player was in lobby, host started): notify parent then
    // tear down.
    try {
      this.opts.onStart?.();
    } catch (err) {
      console.error("[WaitingRoom] onStart threw", err);
    }
    this.hide();
  }

  /** Late-joiner only: user clicked "Entrar a la partida". Notify + dismiss. */
  _onEnterClick() {
    try {
      this.opts.onStart?.();
    } catch (err) {
      console.error("[WaitingRoom] onStart threw", err);
    }
    this.hide();
  }

  _onStartCountdown(payload) {
    if (!payload) return;
    const startsAt =
      typeof payload.startsAt === "number"
        ? payload.startsAt
        : typeof payload.at === "number"
          ? payload.at
          : null;
    if (startsAt == null) return;

    this._countdownEndAt = startsAt;
    this._startCountdownLoop();
  }

  // ── Player table mutation helpers ────────────────────────────────────────

  _upsertPlayer(sessionId, payload) {
    if (!sessionId) return;
    const prev =
      this._players.get(sessionId) ?? {
        id: sessionId,
        name: "",
        characterId: null,
        isHost: false,
      };

    const name =
      typeof payload?.name === "string" && payload.name
        ? payload.name
        : prev.name || sessionId.slice(0, 6);
    const characterId =
      typeof payload?.characterId === "string" && payload.characterId
        ? payload.characterId
        : prev.characterId;
    const isHost =
      typeof payload?.isHost === "boolean"
        ? payload.isHost
        : this._hostSessionId
          ? sessionId === this._hostSessionId
          : prev.isHost;

    this._players.set(sessionId, {
      id: sessionId,
      name,
      characterId,
      isHost,
    });

    // Keep the running host id in sync if the snapshot carried the bit.
    if (isHost) this._hostSessionId = sessionId;
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  _renderPlayers() {
    const list = this._playersNode;
    if (!list) return;
    list.innerHTML = "";

    // Stable order: host first, then by name, then by sessionId.
    const rows = Array.from(this._players.values()).sort((a, b) => {
      if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
      const nameCmp = (a.name || "").localeCompare(b.name || "");
      if (nameCmp !== 0) return nameCmp;
      return a.id.localeCompare(b.id);
    });

    for (const player of rows) {
      const row = document.createElement("li");
      row.className = "vd-lobby-player";
      if (player.id === this._selfSessionId) row.classList.add("is-self");

      const crown = document.createElement("span");
      crown.className = "vd-lobby-player-crown";
      crown.textContent = player.isHost ? "👑" : "";

      const name = document.createElement("span");
      name.className = "vd-lobby-player-name";
      name.textContent = player.name || player.id.slice(0, 6);
      if (player.id === this._selfSessionId) {
        const tag = document.createElement("span");
        tag.className = "vd-lobby-player-you";
        tag.textContent = "Tú";
        name.appendChild(tag);
      }

      const character = document.createElement("span");
      character.className = "vd-lobby-player-character";
      const charDef = findCharacter(player.characterId);
      if (charDef) {
        character.textContent = `${charDef.emoji} ${charDef.name}`;
      } else {
        character.classList.add("is-pending");
        character.textContent = "Eligiendo…";
      }

      row.appendChild(crown);
      row.appendChild(name);
      row.appendChild(character);
      list.appendChild(row);
    }
  }

  _renderActions() {
    const actions = this._actionsNode;
    if (!actions) return;
    actions.innerHTML = "";

    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "vd-lobby-leave";
    leave.textContent = "Salir";
    leave.addEventListener("click", () => {
      try {
        this.opts.onLeave?.();
      } catch (err) {
        console.error("[WaitingRoom] onLeave threw", err);
      }
    });
    actions.appendChild(leave);

    // Late joiner — game is already in progress. Show "Entrar a la partida"
    // so the user can read the room + pick character at their own pace.
    if (this._isLateJoiner) {
      const note = document.createElement("div");
      note.className = "vd-lobby-wait";
      note.textContent = "Partida en curso · elige tu personaje";
      actions.appendChild(note);

      const enter = document.createElement("button");
      enter.type = "button";
      enter.className = "vd-lobby-start";
      enter.textContent = "Entrar a la partida";
      enter.addEventListener("click", () => this._onEnterClick());
      actions.appendChild(enter);
      return;
    }

    const isHost = this._isLocalHost();
    if (isHost) {
      const start = document.createElement("button");
      start.type = "button";
      start.className = "vd-lobby-start";
      start.textContent = "Empezar partida";
      // Spec: future iteration will require all players to have picked a
      // character; for now we keep it enabled whenever there is at least
      // one connected player (always true since the local player counts).
      start.disabled = this._players.size < 1;
      start.addEventListener("click", () => this._onStartClick());
      actions.appendChild(start);
    } else {
      const wait = document.createElement("div");
      wait.className = "vd-lobby-wait";
      wait.textContent = "Esperando al host…";
      actions.appendChild(wait);
    }
  }

  _isLocalHost() {
    if (!this._selfSessionId) return false;
    if (this._hostSessionId) return this._hostSessionId === this._selfSessionId;
    const me = this._players.get(this._selfSessionId);
    return !!me?.isHost;
  }

  _onStartClick() {
    const bridge = this.bridge;
    if (!bridge) return;
    try {
      if (typeof bridge.emitLobbyStart === "function") {
        bridge.emitLobbyStart({ countdownMs: 3000 });
        return;
      }
    } catch {
      /* fall through to raw send */
    }
    try {
      bridge._room?.send?.("vp:lobby:start", { countdownMs: 3000 });
    } catch {
      /* not connected — drop */
    }
  }

  // ── Countdown overlay ────────────────────────────────────────────────────

  _startCountdownLoop() {
    this._clearCountdown();

    const tick = () => {
      const remainingMs = this._countdownEndAt - Date.now();
      const remaining = Math.max(0, Math.ceil(remainingMs / 1000));

      if (!this._countdownNode) {
        this._countdownNode = document.createElement("div");
        this._countdownNode.className = "vd-lobby-countdown";
        const num = document.createElement("div");
        num.className = "vd-lobby-countdown-number";
        this._countdownNode.appendChild(num);
        // Append on the body so it sits above EVERYTHING, not just the lobby.
        document.body.appendChild(this._countdownNode);
      }

      const num = this._countdownNode.firstElementChild;
      if (remaining > 0) {
        if (num) {
          num.textContent = String(remaining);
          num.classList.remove("is-go");
          // Restart the pop animation on every tick.
          num.style.animation = "none";
          // eslint-disable-next-line no-unused-expressions
          num.offsetHeight;
          num.style.animation = "";
        }
      } else {
        if (num) {
          num.textContent = "¡YA!";
          num.classList.add("is-go");
        }
        // Hold the "¡YA!" frame briefly, then clean up. The actual phase
        // transition happens via the server's vs:lobby:phaseChange.
        if (this._countdownInterval) {
          clearInterval(this._countdownInterval);
          this._countdownInterval = null;
        }
        setTimeout(() => this._clearCountdown(), 700);
      }
    };

    // Render immediately, then once per second.
    tick();
    this._countdownInterval = setInterval(tick, 1000);
  }

  _clearCountdown() {
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
      this._countdownInterval = null;
    }
    if (this._countdownNode && this._countdownNode.parentNode) {
      this._countdownNode.parentNode.removeChild(this._countdownNode);
    }
    this._countdownNode = null;
  }
}

export default WaitingRoom;
