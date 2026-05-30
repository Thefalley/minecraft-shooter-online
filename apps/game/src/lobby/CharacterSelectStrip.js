// CharacterSelectStrip.js
//
// Horizontal row of character cards (Pato / Caballero / Cazador / Samurai /
// Mago) used inside the WaitingRoom. The strip is a self-contained DOM widget:
//
//   const strip = new CharacterSelectStrip(host, bridge, {
//     characters: CHARACTERS,
//     initialSelection: "duck",
//   });
//   …
//   strip.destroy();
//
// Click semantics:
//   - Local selection updates immediately (optimistic UI).
//   - We notify the server via bridge.emitCharacterSelect(id). The lobby-flow
//     agent ships that method on NetworkBridge; if a stale build is loaded
//     we fall back to room.send("vp:lobby:characterSelect", …) so the strip
//     still works end-to-end during integration.
//
// The strip does NOT subscribe to bridge events itself — the parent
// WaitingRoom owns the snapshot subscription and calls setSelection() when
// the server echoes back the change, which keeps a single source of truth.

import "./lobby.css";

// Default subtitles per character. Kept in sync with the menu's CHARACTER_NOTES
// table so both screens describe the heroes the same way. We don't import that
// table directly to stay loosely coupled to Menu.js.
const CHARACTER_NOTES = {
  duck: "Armas + bloques",
  knight: "Espada y guardia",
  hunter: "Dagas y dash",
  samurai: "Katana con parry",
  mage: "5 hechizos de maná",
};

export class CharacterSelectStrip {
  /**
   * @param {HTMLElement} host
   * @param {object}      bridge   NetworkBridge instance (see networking/NetworkBridge.js)
   * @param {object}      options
   * @param {Array<{id:string,name:string,emoji:string}>} options.characters
   * @param {string}      [options.initialSelection="duck"]
   */
  constructor(host, bridge, { characters, initialSelection = "duck" } = {}) {
    this.host = host;
    this.bridge = bridge;
    this.characters = Array.isArray(characters) ? characters.slice() : [];
    this.selectedId =
      this.characters.find((c) => c.id === initialSelection)?.id ??
      this.characters[0]?.id ??
      null;

    this.root = document.createElement("div");
    this.root.className = "vd-lobby-strip";

    this._cards = new Map(); // id -> { card, emoji, name, note }
    this._onClick = this._onClick.bind(this);

    for (const character of this.characters) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "vd-lobby-char";
      card.setAttribute("data-char", character.id);
      if (character.id === this.selectedId) card.classList.add("is-selected");

      const emoji = document.createElement("div");
      emoji.className = "vd-lobby-char-emoji";
      emoji.textContent = character.emoji ?? "";

      const name = document.createElement("div");
      name.className = "vd-lobby-char-name";
      name.textContent = character.name ?? character.id ?? "";

      const note = document.createElement("div");
      note.className = "vd-lobby-char-note";
      note.textContent =
        character.note ?? CHARACTER_NOTES[character.id] ?? "";

      card.appendChild(emoji);
      card.appendChild(name);
      card.appendChild(note);
      card.addEventListener("click", this._onClick);

      this.root.appendChild(card);
      this._cards.set(character.id, { card });
    }

    this.host.appendChild(this.root);
  }

  /** External setter — used by WaitingRoom when the server echoes the choice. */
  setSelection(id) {
    if (!id || id === this.selectedId) {
      this._refreshSelected();
      return;
    }
    if (!this._cards.has(id)) return;
    this.selectedId = id;
    this._refreshSelected();
  }

  getSelection() {
    return this.selectedId;
  }

  destroy() {
    for (const { card } of this._cards.values()) {
      card.removeEventListener("click", this._onClick);
    }
    this._cards.clear();
    this.root.remove();
    this.bridge = null;
    this.host = null;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _refreshSelected() {
    for (const [id, { card }] of this._cards.entries()) {
      card.classList.toggle("is-selected", id === this.selectedId);
    }
  }

  _onClick(event) {
    const card = event.currentTarget;
    if (!card) return;
    const id = card.getAttribute("data-char");
    if (!id || id === this.selectedId) return;
    this.selectedId = id;
    this._refreshSelected();
    this._notify(id);
  }

  _notify(id) {
    const bridge = this.bridge;
    if (!bridge) return;
    try {
      if (typeof bridge.emitCharacterSelect === "function") {
        bridge.emitCharacterSelect(id);
        return;
      }
    } catch {
      /* fall through to the raw send */
    }
    // Defensive fallback: the lobby-flow agent may not have shipped the
    // dedicated emitter yet. Send the raw lobby message — the server
    // protocol-agent's branch handles "vp:lobby:characterSelect".
    try {
      bridge._room?.send?.("vp:lobby:characterSelect", { characterId: id });
    } catch {
      /* offline / not connected — drop silently */
    }
  }
}

export default CharacterSelectStrip;
