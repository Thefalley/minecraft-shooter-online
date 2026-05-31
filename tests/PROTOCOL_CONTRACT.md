# Wire protocol contract under test

The JS test suites in this folder are **black-box clients**: they talk to
the deployed Colyseus server over WebSocket using only the wire protocol.
Nothing in them depends on JavaScript-internal symbols of the server.

If we migrate the server (or any client) to Go / Rust / Python, you can
re-implement the same checks against the contract documented here and
get equivalent coverage.

---

## Transport

| Layer | Detail |
|---|---|
| Wire | WebSocket |
| Default server URL | `wss://minecraft-shooter-online.onrender.com` |
| HTTP companion | Same host over `https://` for the room-by-code lookup |
| Encoding | Colyseus binary schema (msgpack-like). Any Colyseus-compatible client works. |

## HTTP endpoints

```
GET  /health                      → { status: "ok", uptime: number }
GET  /rooms/by-code/<CODE>        → { roomId, roomCode, clients, maxClients }
                                   404 if not found, 400 if code malformed
```

Room code alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0, 1, I, O).
Length: 5.

## Lobby flow

```
1. client A:    Client.create("game", { name, characterId })
                → Room joined, state.phase === "lobby"
                → state.roomCode is a 5-char string in the alphabet above
                → state.players.get(self).isHost === true

2. client B:    HTTP GET /rooms/by-code/<roomCode>   → { roomId }
                Client.joinById(roomId, { name, characterId })
                → state.players.size === 2 (eventual)
                → state.players.get(self).isHost === false (exactly one host)

3. host:        room.send("vp:lobby:characterSelect", { characterId })
                → state.players.get(host).characterId updates for all clients
                → characterId must be in: duck, knight, hunter, samurai, mage

4. host:        room.send("vp:lobby:start", { countdownMs?: 0..10000 })
                → state.phase transitions to "playing"
                → state.wave === 1
                → state.enemies fills with wave 1 roster
```

## Game tick contract (server-authoritative)

```
state.phase: "lobby" | "countdown" | "playing" | "shop" | "ended"
state.wave: 1..10
state.players: MapSchema<sessionId, PlayerState>
state.enemies: MapSchema<id, EnemyState>
state.dragons: MapSchema<id, DragonState>
state.world.deltas: MapSchema<"x,y,z", DeltaState>
```

```
EnemyState   = { kind: "zombie"|"skeleton"|"witch", x, y, z, rotationY,
                  health, maxHealth }
DragonState  = { x, y, z, rotationY, health, maxHealth, ... }
PlayerState  = { x, y, z, rotationY, characterId, isHost, alive, connected,
                  health, ... }
```

### Server promises

- Spawns enemies according to the wave roster table on phase → playing.
- Wave 1 roster: 3 zombies + 1 skeleton + 0 witches + 0 dragons.
- First dragon spawns wave 4.
- Each enemy is broadcast to **every** client (state.enemies map sync).
- Each enemy's AI is ticked at ≥10 Hz; positions change over time.
- Zombies pathfind toward the nearest alive player (distance decreases).
- Player positions are owned by their `sessionId`: only inputs from that
  client move that player.
- World mining/placing intents update state.world.deltas and are visible
  to all current AND future clients in the same room.

### Player inputs (sent at ~20 Hz by clients)

```
room.send("vp:input", {
  forward, backward, left, right, jump: boolean,
  rotationY, pitch: number (radians),
  seq: monotonically increasing integer
})

room.send("vp:world:mine",  { x, y, z, t? })
room.send("vp:world:place", { x, y, z, t })
room.send("vp:ping",        { t: clientNow })
room.send("vp:lobby:start", { countdownMs?: 0..10000 })
room.send("vp:lobby:characterSelect", { characterId })
```

### Server broadcasts (over and above schema sync)

```
"vs:enemy:event"       → enemy attacks, shoots, throws, dies
"vs:dragon:fireball"   → dragon fireball spawn/despawn/reflect
"vs:weapon:hit"        → confirmed hit (Phase 5)
"vs:weapon:miss"       → rejected fire (Phase 5)
"vs:damage"            → player damaged
"vs:wave:start"        → new wave begins
"vs:wave:end"          → wave cleared
"vs:pong"              → reply to ping
```

The `state.*` MapSchemas are the source of truth for positions and health;
the broadcast events above are for animations / SFX / FX that aren't worth
syncing every field of.

## Test categories

| Suite | Connects via | What it validates |
|---|---|---|
| `server-multiplayer.mjs` | WebSocket | The pure protocol contract above. **Portable to any language.** |
| `behavior-multiplayer.mjs` | WebSocket | Game-rule emergent behaviors (zombie chases, late joiner gets state, players are isolated). **Portable.** |
| `ui-game-physics.mjs` | Playwright (Chromium) | The JS client correctly renders/handles input. **JS-specific.** |

If you re-implement the server in another language, the first two suites
(or their equivalents in your language) must continue to pass against
the new server. The UI suite verifies the client; if you also port the
client, write a parallel UI suite for it.

## Running locally

```bash
pnpm test:server       # ~30 s — backend, room create, 2 clients, enemy AI, world sync
pnpm test:behavior     # ~25 s — feature-level behaviors
pnpm test:ui           # ~60 s — Playwright headless against deployed lobby+game
pnpm test:all          # all three sequentially with a unified summary
```

## Running in CI

`.github/workflows/ci.yml` runs `pnpm test:all` on every push to `main`
and every PR. Failures block merges. Screenshots from failed UI runs
are uploaded as a workflow artifact.
