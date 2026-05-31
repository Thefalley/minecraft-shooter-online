# Estado del repo — 2026-05-31

⚠️ **Esta build NO es estable**. CI no está pasando todavía.

## Última CI ejecutada

Commit `7e23eee`, run https://github.com/Thefalley/minecraft-shooter-online/actions/runs/26718445705

| Step | Resultado |
|---|---|
| Typecheck | ✅ |
| Build | ✅ |
| `server-multiplayer` (16 checks) | ✅ |
| `behavior-multiplayer` (7 checks) | ✅ |
| `sync-rate` (3 checks) | ✗ **falla en CI** |
| `log-equivalence` | ◌ skipped (porque la anterior falló) |
| `ui-game-physics` | ◌ skipped |

## Qué funciona

- Lobby + waiting room
- Hosting + join por código
- Server-authoritative: enemigos spawneados y moviéndose por el server
- Mismos zombies/posiciones en cada cliente (raw Colyseus)
- Late joiner sincroniza state.world + state.enemies
- Player movement broadcast
- World delta sync (mining → todos lo ven)
- Logs equivalentes server↔cliente vía
  - `GET /debug/rooms/<CODE>/logs` (server)
  - `window.__voxelDebug.dump()` (cliente)

## Qué no funciona o no está claro

- **`sync-rate.mjs` falla en CI**, pasa local. Probable causa: Vercel cold-start lento en Linux CI excede el timeout del Playwright probe.
- **Combate sincronizado**: client raycast funciona local pero el server no recibe `WeaponFire` intent → matar un zombie no se propaga.
- **Wave progression**: solo wave 1 verificada, las siguientes 2-10 sin probar end-to-end.
- **Dragones**: 0 spawn en wave 1 (por diseño del roster). Wave 4+ no testeado.
- **Stress test 8 jugadores reales**: validado en `tests/stress-8-players-visual.mjs` solo a nivel de raw Colyseus, no UI.

## Bugs confirmados pendientes

Ninguno conocido actualmente — la última tanda (b58377e → 053ec4c → 60fa9f0 → 82d0b1e → 892b49b → 7e23eee) cubrió:
- Iterator wrong-collection en 4 managers
- Backfill de enemigos/dragones en EnemySync
- Backfill de worldSeed en WorldSync
- Local `startNextWave` doble-spawn en multiplayer
- Player spawn Y mismatch entre client y server
- CI `echo (...)` parseado como subshell en bash

## URLs en producción

- Jugar: https://minecraft-shooter-online-web.vercel.app
- Repo: https://github.com/Thefalley/minecraft-shooter-online
- Server: https://minecraft-shooter-online.onrender.com
- Health: https://minecraft-shooter-online.onrender.com/health

## Lo siguiente

El usuario va a indicar un nuevo repo a clonar y probablemente moveremos el trabajo allí.
