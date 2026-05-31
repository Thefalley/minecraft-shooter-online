# Estado del repo — 2026-05-31

✅ **Build estable.** CI 100% verde en commit `9be2603`.

## Última CI

Run https://github.com/Thefalley/minecraft-shooter-online/actions/runs/26718959254

| Step | Resultado |
|---|---|
| Typecheck | ✅ |
| Build | ✅ |
| `server-multiplayer` (16 checks) | ✅ |
| `behavior-multiplayer` (7 checks) | ✅ |
| `sync-rate` (3 checks) | ✅ |
| `log-equivalence` (6 checks) | ✅ |
| `ui-game-physics` (14 checks) | ✅ |

## Qué funciona en producción ahora mismo

- Lobby + waiting room (5 character cards, host start countdown)
- Crear/unirse a sala por código de 5 chars
- Server-authoritative: zombies, esqueletos, brujas, dragones movidos por el server
- Mismas posiciones de enemigos en cada cliente (drift inter-cliente <0.2u)
- Zombies persiguen al player más cercano
- Late joiner sincroniza state.world + state.enemies
- Player movement broadcast a otros clientes
- World delta sync (mining → todos lo ven)
- Logs equivalentes server↔cliente:
  - `GET /debug/rooms/<CODE>/logs` (server) → JSON con wave:start, enemy:spawn, enemy:despawn
  - `window.__voxelDebug.dump()` (cliente) → mismo schema
- Suite integrada Voxel-Dragons `feature/weapon-feel-pack`:
  - Modos Waves / Campaign (Campaign para Pato con headshot bonus)
  - Mapas múltiples (meadow, snowland, Minecraft NBT importer)
  - Wave 5 dragón rojo miniboss
  - Wave 10 cinemática meteorito
  - Weapon-feel: recoil, swing, samurai technique, blaster charge
  - Threat marker, steering AI, water avoidance
  - Collision radius-aware + step-up
  - Profiler in-browser

## Qué no está terminado todavía

- ⏳ **Combate sincronizado** (Phase 5): el client ya lanza el raycast y el server tiene `applyDamage`, pero falta el `WeaponFire` intent + lag compensation. Por eso disparar a un zombie no se propaga como kill.
- ⏳ **Shop entre oleadas en MP**: existe en singleplayer (campaign + waves), falta cablear el flujo de moneda persistente entre rondas en MP.
- ⏳ **Selección de mapa desde el lobby**: MP usa `MAPS[0]` (meadow) por defecto. Falta UI en el lobby para elegir.
- ⏳ **Selección de modo (campaign vs waves) desde el lobby**: MP fuerza `waves`. Falta UI para campaign.

## URLs en producción

- 🎮 Jugar: https://minecraft-shooter-online-web.vercel.app
- 📦 Repo: https://github.com/Thefalley/minecraft-shooter-online
- 🚀 Server: https://minecraft-shooter-online.onrender.com
- 🩺 Health: https://minecraft-shooter-online.onrender.com/health
- 📊 Logs (sustituye CODE): https://minecraft-shooter-online.onrender.com/debug/rooms/CODE/logs

## Documentación

- README.md — vista general del stack y deploy
- tests/PROTOCOL_CONTRACT.md — contrato WebSocket del server para tests multi-lenguaje
- memory/feedback_self_check.md — protocolo de self-check antes de declarar un fix completo
