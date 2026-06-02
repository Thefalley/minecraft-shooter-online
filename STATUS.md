# Estado del repo — 2026-06-02

✅ **Multiplayer sincronizado**. Cliente y server convergen a <1.5u en todo movimiento.

## Bugs raíz arreglados (sesión hoy)

| Bug | Síntoma del usuario | Commit |
|---|---|---|
| Player spawneaba dentro del castillo de meadow | "no veo ningún enemigo, hay 3 zombies en HUD pero no los veo" | `2b64476` |
| P key en MP wipeaba meshes server-driven | "le doy a P y no sube oleada, los enemigos desaparecen" | `2b64476` |
| Server spawn (3,0,0) vs cliente (0.5,18.5) | "esqueleto dispara al suelo / pared" | `638d02b` |
| Input pump no conectado al ciclo de Game | "los bichos me siguen al spawn, no a mí" | `3dfd804` |
| Server PLAYER_SPEED=6 vs client moveSpeed=7×mult | "zombies persiguen una persona que no soy yo" | `4d66d79` |
| Server teleportaba al cliente a Y=1 cada 50ms | "estoy spameando debajo de la tierra" | `031bb89` |
| Sin reconciliación CSP → drift acumulativo | "zombies chase un punto detrás de mí" | `bf1d380` |
| WaveDirector emit/handler de boss + meteor | wave 5 dragón + wave 10 cinemática | `f730308 + 17019ef` |
| Death cinematic no propaga | "mato zombie y solo yo lo veo" | `c5af3af` |
| Tracers solo visibles para quien dispara | "no veo balas de otros" | `c5af3af` |
| Render rechazaba deploys (typecheck rojo) | "render ha fallado, sesión rota" | `a02a929` |

## Verificación cuantitativa (trace test contra producción)

```
tests/position-trace.mjs --clients=2 --secs=15
MAX client↔server drift across 2 browsers: 1.02u
```

Con CSP soft reconcile activo:
- Drift ≤ 0.5u → no-op (within tolerance)
- Drift ≤ 4u → lerp 25% toward server
- Drift > 4u → hard snap (XZ only, Y siempre local)

## CI auto-ejecutado tras cada push

12 checks corriendo en `.github/workflows/ci.yml`:
- typecheck (shared + server + web)
- build (server + web + game)
- server-multiplayer (16 raw-Colyseus checks)
- behavior-multiplayer (12 cross-feature checks)
- sync-rate (server tick vs client mesh rate)
- log-equivalence (server ring ≡ client ring)
- perf-metrics (server tickRateHz ≥ 15, tickDurationMsAvg ≤ 20ms)
- multi-client-kill (3 navegadores en paralelo correlacionan kill)
- ui-game-physics (Playwright pointer-lock, WASD, click-through)

## Features upstream integradas

Branch `feature/weapon-feel-pack` de EHxuban11/Voxel-Dragons:
- Mapas: meadow, snowland, Minecraft NBT importer (WASM embebido)
- Modos: Waves y Campaign
- Wave 5 dragón rojo miniboss server-authoritative
- Wave 10 cinemática meteorito + cráter procedural
- Weapon-feel: recoil, swing, samurai technique, blaster charge
- Threat marker, steering AI, water avoidance
- Collision radius-aware + step-up
- Profiler in-browser

## Métricas + debug

- `GET /debug/rooms/<CODE>/logs` → ring buffer del server (wave:start, enemy:spawn/despawn)
- `GET /debug/rooms/<CODE>/stats` → tickRateHz, ms/tick, AI cost, enemy/player count
- `GET /debug/global/stats` → uptime, total rooms/players, memoryUsedMB
- Cliente F12 → `__voxelDebug.dump()` → mismo schema mirror

## URLs en producción

- 🎮 https://minecraft-shooter-online-web.vercel.app (lobby)
- 🎯 https://voxel-dragons-game.vercel.app (game)
- 🚀 https://minecraft-shooter-online.onrender.com (server)
- 📦 https://github.com/Thefalley/minecraft-shooter-online

## Pendiente / Phase 5

- Shop persistente entre rondas en MP
- Selector mapa/modo desde el lobby (actualmente fuerza meadow + waves)
- Player health/respawn UI completo
- multi-client-kill ocasionalmente flake en CI (timing de Vercel cold-start con 3 navegadores simultáneos)
