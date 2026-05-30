# 📊 STATUS — Voxel-Dragons Multiplayer Integration

> Last update: 2026-05-30 · Latest commit on `main`: **`894fd05`**
> Persistent state for the conversation. Designed to survive context compaction — read this first to get oriented.

---

## TL;DR de este momento

- **Repo**: https://github.com/Thefalley/minecraft-shooter-online
- **Backend en Render**: `https://minecraft-shooter-online.onrender.com` — auto-deploya al pushear a `main`. Free tier, Frankfurt, 0.1 vCPU, 512 MB, sleep 15 min.
- **Lobby en Vercel #1**: `https://minecraft-shooter-online-web.vercel.app` — auto-deploya al pushear. Solo lobby (form de nombre + sala). Tras crear/unir REDIRIGE a la URL de `apps/game`.
- **Game en Vercel #2**: ⚠️ **PENDIENTE DE DESPLEGAR** — apps/game (Voxel-Dragons + multiplayer) ya está en el repo pero NO tiene proyecto Vercel todavía. Sin esto, NO se puede probar end-to-end por internet. Acción: crear segundo proyecto Vercel apuntando a `apps/game/`.
- **Phase 0 + 1 + 2**: ✅ todo en `main`. **Phase 2.5** (5 optimizaciones de perf): ✅ todo en `main`.
- **Phase 3+ (mundo voxel sync server-authoritative, enemigos server, combate con lag comp)**: ⏳ pendiente. Plan en `docs/INTEGRATION-PLAN.md`.

---

## Estado del repo (commits clave)

```
894fd05  feat(game): integrate Phase 2 — WaitingRoom + StatsOverlay + bridge ext
ed2f00? Merges de las 9 ramas de Phase 2 sobre main
163a681  fix(game): correct characterId allowed set
ecec502  perf(game): pixelRatio 1.5 + WEAPON_KEYS pre-cached
fc9f56a  feat(game): import Voxel-Dragons (Phase 0)
5ddce12  chore: clean repo, MIT, README v0.1.0
b9019f8  perf(web): CSP + FPS/ping overlay (apps/web)
... commits anteriores del MVP cubo-sobre-plano
```

Branches mergeadas y limpias (worktrees ya removidos):
- `feat/phase2-csp` `c625ce8` — Player.applyInput + rewind/replay
- `feat/phase2-coord` `abd9c3e` — MultiplayerCoordinator + main.js rewire + Game.js (4 líneas)
- `feat/phase2-lobby-flow` `63121b0` — Server: phase=lobby + host + countdown + character validation
- `feat/phase2-web-redirect` `d4a32b0` — apps/web redirige a apps/game
- `feat/phase2-waiting-room` `f404531` — WaitingRoom + CharacterSelectStrip UI
- `feat/phase2-perf-world` `c029c27` — `rebuildMeshes` O(1) swap-pop + atlas
- `feat/phase2-perf-effects` `0e75d97` — pool geometrías/materiales
- `feat/phase2-perf-weapons` `9e25155` — scratch Vec3 + pool flash/proyectil
- `feat/phase2-perf-dragons` `967b837` — LOD 3 tiers + culling

---

## Arquitectura producción

```
   USUARIO          VERCEL (lobby)             VERCEL (game) ⚠️PENDIENTE     RENDER
   ───────          ─────────────              ──────────────                ──────
                    apps/web Next.js           apps/game Vite + Three        apps/server Colyseus
                    https://minecraft          https://voxel-dragons-game    https://minecraft-shooter
                    -shooter-online            -*.vercel.app (TBD)           -online.onrender.com
                    -web.vercel.app
                                                 │      ▲
                                                 │ WS   │ patches
                                                 ▼      │
   ┌─────────────────┐  redirect   ┌─────────────────────────────────┐  Colyseus  ┌─────────────────┐
   │ /             ─┼─────────────▶│ /?code=ABCDE&name=Pab&mode=join │◀──────────▶│ GameRoom.ts     │
   │ form nombre+  │                │ WaitingRoom → CharacterSelect   │            │ phase=lobby     │
   │ create/join   │                │ → Game (singleplayer renderer + │            │ → phase=playing │
   └─────────────────┘                │   network coordinator)           │            └─────────────────┘
                                     │ StatsOverlay (FPS + PING)        │
                                     └─────────────────────────────────┘
```

---

## Phase 0 — Importación de Voxel-Dragons

- Fuente: https://github.com/EHxuban11/Voxel-Dragons (vanilla JS + Three.js + Vite)
- Importado a `apps/game/` como paquete `@mvp/game` del monorepo pnpm.
- 22 módulos: Audio, BlockTextures, Characters, Diagnostics, DragonManager, Effects, Game, GameBalance, HUD, Icons, Input, Inventory, MageController, Menu, Player, Shop, SkeletonManager, Viewmodels, Weapons, WitchManager, World, ZombieManager.
- `apps/game/package.json`: pinned `three@0.169.0`, `vite@5.4.10`, workspace deps de `@mvp/shared` y `colyseus.js`.
- Build OK: 836 KB JS (223 KB gzip), 2.8 s.

---

## Phase 1 — Networking foundation

### `packages/shared` (extendido)
- `constants.ts`: + `BLOCK_INTERACTION_RANGE`, `WORLD_WIDTH/DEPTH/MAX_HEIGHT/WATER_LEVEL`, `INPUT_PUMP_RATE`, `SNAPSHOT_INTERPOLATION_DELAY_MS=120`, `RECONCILE_HARD_SNAP_DISTANCE=1.5`, `LAG_COMPENSATION_WINDOW_MS=300`, `SHOP_DURATION_MS=30000`, `DEFAULT_WAVE_COUNT=10`
- `types.ts`: + `BlockType`, `CharacterId`, `RoomPhase`, `VoxelPlayerSnapshot`, `VoxelPlayerInput`, `EnemyKind`, `EnemySnapshot`, `DragonSnapshot`, `FireballSnapshot`, `ProjectileSnapshot`, `WorldDelta`, `ShopOffer`
- `protocol.ts`: + `VoxelClientMessage` / `VoxelServerMessage` dicts con payloads completos. + `LobbyClientMessage` / `LobbyServerMessage` para Phase 2.
- `balance.ts` (nuevo): port completo de GameBalance.js a TS frozen.
- `voxel.ts` (nuevo): BLOCK_TYPES list + BLOCK_TO_ID/ID_TO_BLOCK + `blockKey` helpers.

### `apps/server` (reescrito)
- Schemas nuevos: `VoxelPlayer` (con `isHost`), `WorldState` (`seed`+`deltas: MapSchema<uint8>`), `EnemyState`, `DragonState`, `FireballState`.
- `GameState` expandido: `phase`, `wave`, `totalWaves`, `shopEndsAt`, `players`, `world`, `enemies`, `dragons`, `fireballs`.
- `GameRoom.ts`: handlers para `Input`, `WorldMine`, `WorldPlace`, `WeaponFire` (stub Phase 5), `WeaponReload`, `AbilityUse`, `SlotSelect`, `CharacterSelect`, `Ping`, `ReadyNextWave`, `ShopBuy`. + lobby handlers: `LobbyClientMessage.CharacterSelect/Start/HostKick`. Host se elige al primer joiner; reassign al next on disconnect.
- `systems/EnemyAI.ts`: ticks simples para skeleton/zombie/witch (mirror de los managers cliente).
- `systems/WorldSeed.ts`: mulberry32 + pickSeed.
- Tick gate por fase (`playing` only para input/enemigos/fireballs). Countdown gate al tope de `update()` para transición lobby→playing.

### `apps/game/src/networking` (creado por Phase 1 + Phase 2)
- `ColyseusClient.js`: wrapper que probea `/rooms/by-code/:code` antes de joinById para errores claros.
- `NetworkBridge.js`: orchestrator. `on(event)`, `pushInput`, `emitMineIntent`, `emitFireIntent`, `emitCharacterSelect` (ahora envía a ambos namespaces), `emitLobbyStart`, `emitLobbyHostKick`, etc. Re-emite VoxelServerMessage + LobbyServerMessage como eventos locales.
- `InputPump.js`: 20 Hz pump con throttle por cambios + keepalive 1 s.
- `RemotePlayerMesh.js`: cápsula + label `Sprite` + buffer de 24 snapshots con 120 ms de delay.
- `UrlParams.js`: lee `?code=&name=&mode=&characterId=` del URL.
- `PlayerPrediction.js`: glue entre Player y Bridge — `tick(input,dt,world)` aplica CSP + push input al pump.
- `MultiplayerCoordinator.js`: top-level. `bind(game)`, `start()`, `tickFrame(now)`, `pushInput(cmd)`, `stop()`. Marca `player.networkAuthority='server'`.
- `RemotePlayerRegistry.js`: lifecycle de RemotePlayerMesh por sessionId.

### `apps/web` (lobby)
- Tras `createRoom`/`joinRoomByCode` ya NO va a `/play` (R3F demo), ahora redirige a `${NEXT_PUBLIC_GAME_URL}/?code=&name=&mode=`. Antes de redirect llama a `getTransport().leave()` para cerrar la conexión Colyseus del lobby.
- Env: `NEXT_PUBLIC_GAME_URL=http://localhost:5173` (dev) o la URL de Vercel #2 (prod).
- El `/play` legacy (cubos en plano) sigue compilando para debug.

---

## Phase 2 — CSP + WaitingRoom

### Player CSP (`apps/game/src/modules/Player.js`)
- `buildInputCommand(input, dt)` — extrae cmd `{forward,...,jump,sprint,dash,attack,guard,reload,rotationY,pitch,inventorySlot,seq}`.
- `applyInput(cmd, dt, world)` — física pura, mismas matemáticas que el `update()` singleplayer.
- `recordSnapshot(cmd)` — ring de 60 snapshots por `seq`.
- `applyServerSnapshot(snap)` — busca snapshot local por seq → blend 15% si drift < 1.5u o snap. Re-play de cmds pendientes.
- `clearPrediction()` — reset al desconectar.
- `networkAuthority: 'local' | 'server'` — cuando 'server', `update()` retorna early y todos los mutators públicos (setPosition, damage, heal, etc.) no-op con console.warn.

### WaitingRoom + CharacterSelectStrip (`apps/game/src/lobby/`)
- DOM puro, prefijo `vd-lobby-`. Idempotente.
- WaitingRoom: muestra código grande monospace, lista de jugadores con 👑 host + character chosen, strip de 5 personajes (Pato/Caballero/Cazador/Samurai/Mago), botón "Empezar partida" (solo host) o "Esperando al host..." (no host), overlay countdown 3...2...1...
- Listen a `welcome`, `playerJoined`, `playerLeft`, `playerSnapshot`, `lobbyHostChange`, `lobbyPhaseChange`, `lobbyStartCountdown` (con fallbacks).
- En `lobbyPhaseChange.to === 'playing'` → `onStart()` callback dispara la transición a Game.

### StatsOverlay (`apps/game/src/lobby/StatsOverlay.js`)
- Mounted en `<body>` arriba derecha mientras Game corre.
- FPS counter via rAF.
- Ping a `${VITE_SERVER_URL}/health` cada 2 s con EMA smoothing.
- Color verde / amarillo / rojo según ping.
- Mismo look que apps/web `/play`.

---

## Phase 2.5 — Optimizaciones de perf

| Win | Archivo | Impacto |
|---|---|---|
| `rebuildMeshes` O(N) → **O(1)** via swap-pop de InstancedMesh | World.js | 🔥🔥🔥 Minar 100 bloques sin stutter |
| Pool de geometrías + materiales en Effects | Effects.js | Cero GC pauses por disparo |
| Scratch Vec3 + pool muzzle/proyectil en Weapons | Weapons.js | Shotgun blast: 40→16 allocs, rifle: 10→2 |
| Dragons 3-tier LOD (full <25u / silueta <60u / billboard ≥60u) + cached collision lists | DragonManager.js | Sin traverse() per shot, frustum culling de health bars |
| `setPixelRatio` 2 → 1.5 + `WEAPON_KEYS` pre-cached | Game.js | 25-35% GPU libre en retina |
| `DynamicDrawUsage` en instanceMatrix | World.js | GPU upload optimizado |
| Atlas function añadida (NO cableada — pendiente Phase 3) | BlockTextures.js | -7 draw calls cuando se cablee |

---

## Lo que SÍ FUNCIONA ahora mismo

✅ Lobby Vercel #1 (cubos en plano) — el flujo original sigue vivo  
✅ Render server con schemas Phase 1 desplegado (después del commit anterior)  
✅ Build local de `apps/game` con todas las optimizaciones  
✅ Singleplayer del juego importado — menú → personaje → Empezar partida → mundo voxel con dragones/zombies/etc. (verificado con Playwright en `tests/game-singleplayer-smoke.mjs`)  
✅ Push `894fd05` arriba → Render redeploy en marcha ahora

## Lo que NO FUNCIONA todavía

⚠️ `apps/game` no tiene proyecto Vercel — no es alcanzable por internet, solo `pnpm dev:game` local  
⚠️ El flujo multiplayer completo lobby→waiting→character→game **NO está probado end-to-end** todavía (esperando deploy de apps/game)  
⚠️ Phase 3 (mundo voxel sync entre jugadores) **NO implementada** — el server tiene schema y handler stub pero el cliente NO emite `WorldMine`/`WorldPlace` desde Voxel-Dragons. Cada cliente todavía minaría localmente sin sync.  
⚠️ Phase 4 (enemigos server-authoritative) **NO implementada** — server tiene AI básica pero el cliente todavía corre AI local del Voxel-Dragons; conflicto.  
⚠️ Phase 5 (combate con lag comp) **NO implementada** — disparos NO se validan server-side, weapon:fire es stub.  
⚠️ Phase 6 (shop coord + nameplates) **NO implementada**.

## Próximos pasos para hacer el juego JUGABLE end-to-end con voxel

1. **Desplegar apps/game a 2º Vercel** (~5 min de dashboard, hago yo si me das luz verde). Tras esto el flujo lobby→waiting→character→Game funciona — peeero el world/enemigos/combate cada cliente lo simula localmente.
2. **Phase 3 — Mundo sync** (~3-4h con agentes):
   - Cliente: en mine/place hooks de Voxel-Dragons, emitir `emitMineIntent`/`emitPlaceIntent` en vez de aplicar localmente.
   - Cliente: en `worldDelta` event del bridge, aplicar el cambio al World.js local.
   - Cliente al join: usar `worldSeed` event para regenerar el mundo idéntico, aplicar deltas iniciales.
3. **Phase 4 — Enemigos server** (~3-4h):
   - Cliente: deshabilitar local AI (SkeletonManager/ZombieManager/WitchManager/DragonManager).
   - Cliente: en `enemySpawn`/`enemyState`/`enemyDespawn` events, render-only (interpolation).
4. **Phase 5 — Combate server** (~3-4h):
   - Cliente: en Weapons.fire(), emitir `emitFireIntent` con origin/dir/seq + spreadSeed.
   - Server: lag comp con ring buffer 300ms, decide hits.
   - Cliente: en `weaponHit`/`weaponMiss`, render confirmados y rollback ammo predicho.

---

## Tests planeados (lista de stress + verificación)

### Tests de carga al server (Render Free 0.1 vCPU)
1. **Baseline 1 jugador idle** — CPU%, RAM, RTT
2. **2 jugadores moviéndose** — input rate ×2, broadcast ×4
3. **4 jugadores moviéndose** — escalado
4. **8 jugadores (MAX_PLAYERS_PER_ROOM) moviéndose** — límite del schema
5. **2 salas × 4 jugadores** — matchmaker scaling
6. **World edits stress** — N jugadores minando simultáneo
7. **Shot intent flood** — N×rifle 8/s × Δt
8. **Reconexión durante carga** — 10 s allowReconnection window

### Tests de cliente
9. FPS con 0 / 8 / 30 / 60 enemigos
10. FPS con 1 / 3 / 6 dragones
11. FPS minando 50 bloques seguidos (verificar O(1) world)
12. FPS disparando rifle/shotgun rápido (verificar effects pool)
13. Bundle download cold (3G simulado)
14. Render cold-start time (15 min sleep)

### Tests de red
15. Ping bajo carga
16. Reconexión post-network-loss
17. Late joiner consigue worldSeed + deltas correctos

### Tests funcionales
18. lobby create → waitingroom → host start → game (1 jugador)
19. lobby create + lobby join → ambos se ven en waitingroom → host start → ambos jugando
20. Validación character (rechaza ids fuera del set)
21. Host disconnect mid-countdown → cancela
22. Host disconnect mid-game → reassign
23. Esc en game → vuelve a menú

---

## Decisiones técnicas relevantes

- **Server-authoritative** porque la regla "multiplayer-first" del usuario rechaza el patrón "client decide y luego validamos" — anti-cheat por diseño.
- **Mundo determinista (seed + deltas)** — server solo guarda ~1 KB inicial. Cliente regenera. Permite escalar a más rooms en Render Free sin que el state explote.
- **CSP en cliente + reconciliation** — el local se siente instantáneo (60 Hz local), el server tiene la última palabra (20 Hz tick).
- **Interpolation buffer 120 ms para remotos** — Source-style. Invisible en gameplay casual. Cuando metamos combate apuntable, hay que añadir lag compensation server-side (ring buffer 300 ms ya constante en shared).
- **`apps/web` lobby separado de `apps/game` juego** — dos despliegues Vercel free. El lobby es Next.js (server-rendered, SEO friendly). El game es Vite vanilla (mejor para Three.js, hot reload limpio).

---

## Próximas decisiones que necesito de ti

- ☐ **¿Despliego apps/game a Vercel #2 ya?** Lo puedo guiar paso a paso (5 min dashboard) o intentar con `vercel` CLI desde aquí. Sin esto no podemos jugar online.
- ☐ **Render Starter $7/mes**: si vamos a tener varios jugadores reales, evitamos sleep + 5× CPU.
- ☐ **Phase 3 lanzo agentes?**: lo más impactante para que el voxel multiplayer "se sienta de verdad" — sync de bloques entre jugadores.

---

*Este archivo se mantiene actualizado en cada commit grande. Si lo lees después de una compactificación, este es el estado real del proyecto y de mi razonamiento.*
