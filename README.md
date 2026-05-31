# Multiplayer Voxel-Dragons

Juego web 3D multiplayer-first construido sobre [EHxuban11/Voxel-Dragons](https://github.com/EHxuban11/Voxel-Dragons). Lobby con código de sala, sala de espera con selección de personaje, mundo voxel compartido con dragones, zombies, esqueletos y brujas — todo sincronizado por un servidor Colyseus autoritativo.

**Jugar ya**: 👉 https://minecraft-shooter-online-web.vercel.app

---

## Stack en producción

```
   USUARIO (navegador)
   │
   ├──▶  Lobby            (Next.js 14)        https://minecraft-shooter-online-web.vercel.app
   │     • Form nombre + crear/unirse sala
   │     • Redirect al juego con ?code=&name=&mode=
   │
   ├──▶  Juego            (Vite + Three.js)    https://voxel-dragons-game.vercel.app
   │     • Sala de espera (código, jugadores, personajes)
   │     • Voxel-Dragons (mundo + enemigos + combate)
   │     • Cliente Colyseus + CSP + interpolación de remotos
   │
   └──▶  Servidor         (Colyseus + Node)    wss://minecraft-shooter-online.onrender.com
         • Autoritativo: estado de sala, jugadores, mundo (seed+deltas), enemigos
         • Tick 20 Hz, snapshot diff por @colyseus/schema
         • Free tier 0.1 vCPU, Frankfurt, sleep 15 min
```

| Pieza | Coste mensual extra |
|---|---|
| Vercel lobby (Hobby) | 0 € |
| Vercel game (Hobby) | 0 € |
| Render Free | 0 € |
| GitHub | 0 € |
| **Total** | **0 €** |

Para producción seria sin sleep: Render Starter $7/mes.

---

## Estructura del repo

```
.
├── apps/
│   ├── web/          # Next.js 14 — lobby (Vercel #1)
│   ├── game/         # Vite + vanilla Three.js — Voxel-Dragons + networking (Vercel #2)
│   │   └── src/
│   │       ├── modules/     # 22 módulos del juego original (EHxuban)
│   │       ├── networking/  # NetworkBridge + Coordinator + WorldSync + EnemySync + ...
│   │       └── lobby/       # WaitingRoom + CharacterSelect + StatsOverlay + PointerLockHint
│   └── server/       # Colyseus + esbuild bundle (Render)
│       └── src/
│           ├── rooms/       # GameRoom autoritativo
│           ├── schema/      # VoxelPlayer + WorldState + EnemyState + DragonState + ...
│           └── systems/     # EnemyAI + WorldSeed + WaveDirector
├── packages/
│   └── shared/       # Tipos, constantes, protocolo de mensajes, balance
├── tests/
│   ├── e2e-production-health.mjs   # 8 checks contra producción en <90s
│   ├── online.mjs                  # 2 navegadores E2E
│   ├── public-smoke.mjs            # Probe rápido de URLs públicas
│   ├── stress-many-players.mjs     # N bots colyseus.js raw
│   ├── stress-8-players-visual.mjs # 8 navegadores Chromium con capturas
│   └── game-singleplayer-smoke.mjs # Verificar singleplayer baseline
├── docs/
│   ├── INTEGRATION-PLAN.md   # Plan maestro por fases (síntesis 8 agentes)
│   └── STATUS.md             # Snapshot persistente del estado
├── render.yaml       # Blueprint Render para server
├── package.json      # pnpm workspace root
└── pnpm-workspace.yaml
```

---

## Quickstart (local)

### Requisitos
- Node.js ≥ 20
- pnpm ≥ 9

### Clone + install + run
```bash
git clone git@github.com:Thefalley/minecraft-shooter-online.git
cd minecraft-shooter-online
pnpm install --ignore-scripts

# Servidor Colyseus (terminal 1)
pnpm dev:server          # http://localhost:2567

# Frontend del juego (terminal 2)
pnpm dev:game            # http://localhost:5173

# Lobby Next.js (terminal 3)
pnpm dev:web             # http://localhost:3000
```

Si quieres probar multiplayer local, abre dos pestañas en `http://localhost:3000`.

### Variables de entorno
- `apps/web/.env.local`: `NEXT_PUBLIC_SERVER_URL=ws://localhost:2567` y `NEXT_PUBLIC_GAME_URL=http://localhost:5173`
- `apps/game/.env.local`: `VITE_SERVER_URL=ws://localhost:2567` y `VITE_LOBBY_URL=http://localhost:3000`
- `apps/server/.env`: `PORT=2567`, `CORS_ORIGIN=*`, `NODE_ENV=development`

---

## Deploy en 3 servicios free

### 1. GitHub
Pushea el repo a tu cuenta. Esta línea usa SSH:
```bash
git remote add origin git@github.com:<tu-user>/<tu-repo>.git
git push -u origin main
```

### 2. Render (servidor Colyseus)
1. https://dashboard.render.com → New → Web Service → conecta tu repo
2. Region: Frankfurt (o más cercana a tus jugadores)
3. Build Command: `npm install -g pnpm@9.15.0 && pnpm install --ignore-scripts --no-prod && pnpm --filter @mvp/server build`
4. Start Command: `pnpm --filter @mvp/server start`
5. Instance: Free
6. Env: `NODE_ENV=production`, `CORS_ORIGIN=*` (o tu URL Vercel)
7. Health Check Path: `/health`

URL final: `https://<nombre>.onrender.com`

### 3. Vercel #1 (lobby)
1. https://vercel.com/new → import el repo
2. Root Directory: `apps/web`
3. Framework: Next.js
4. Install Command: `pnpm install --ignore-scripts`
5. Env: `NEXT_PUBLIC_SERVER_URL=wss://<render-url>` y `NEXT_PUBLIC_GAME_URL=https://<vercel-game-url>` (se rellena tras paso 4)

### 4. Vercel #2 (juego)
1. https://vercel.com/new → mismo repo
2. Root Directory: `apps/game`
3. Framework: Vite
4. Install Command: `pnpm install --ignore-scripts`
5. Env: `VITE_SERVER_URL=wss://<render-url>`

Vuelve al paso 3 y rellena `NEXT_PUBLIC_GAME_URL` con la URL de Vercel #2. Trigger redeploy del lobby (Settings → Deployments → Redeploy).

Cada push a `main` redeploya los 3 servicios automáticamente.

---

## Tests

### Smoke automatizado contra producción (~90 s)
```bash
node tests/e2e-production-health.mjs
# o contra otro stack:
node tests/e2e-production-health.mjs --lobby=URL --game=URL --server=URL
```
Verifica: backend reachable, lobby carga, redirect correcto, waiting room con código, transición a juego, pointer hint click-through, escape hatch `?solo=1`, redirect del juego al lobby.

### E2E 2-navegadores
```bash
WEB_URL=https://tu-lobby.vercel.app node tests/online.mjs
```

### Stress 8 jugadores con capturas
```bash
node tests/stress-8-players-visual.mjs
```

---

## Historia (lo que se construyó, por fases)

Hecho con agentes en paralelo en git worktrees. Todos los hitos están en commits + tags + branches `feat/phase*` en el historial.

### v0.1.0 — MVP cubos-en-plano multiplayer
Punto de partida. Monorepo pnpm con tres apps. Phase 0 (esqueleto), Phase 1 (protocolo shared + bridge Colyseus + GameRoom v1), Phase 2 (CSP + sala con código + sincronización autoritativa). Probado con dos navegadores reales contra producción.

### v0.2.0 — Lobby + sala de espera + Voxel-Dragons importado
- Phase 0 v2: importado el juego de Voxel-Dragons (`apps/game/`, Vite vanilla JS), corre singleplayer.
- Phase 1 v2: protocolo voxel ampliado (`packages/shared`), GameRoom v2 con `phase`, `world.deltas`, `enemies`, `dragons`, schemas `VoxelPlayer/WorldState/EnemyState/DragonState/FireballState`.
- Phase 2 v2: CSP del Player (rewind/replay), `MultiplayerCoordinator`, `RemotePlayerRegistry`, `WaitingRoom` con personajes y countdown, host election + start, late joiner button.
- Phase 2.5: optimizaciones por agentes paralelos — `World.rebuildMeshes` O(N)→O(1) swap-pop, atlas de texturas, pool de geometrías en Effects, scratch Vec3 en Weapons, LOD 3-tier en dragons, pixelRatio cap 1.5.

### v0.3.0 — Mundo y enemigos sincronizados (este tag)
- Phase 3: World sync (seed compartido + deltas autoritativos por bloque editado), Remote Players visibles dentro de la escena 3D con tinte por clase.
- Phase 4: enemigos server-authoritative — server spawnea zombies/skeletons/witches/dragons al pasar a `phase=playing`, corre la AI a 20 Hz, broadcast por Colyseus schema. Cliente desactiva su AI local y solo renderiza desde snapshots. Y-offset de cápsulas remotas corregido.
- UX: sala de espera dedicada para late joiners, overlay con código de sala persistente arriba derecha, pista visual del pointer-lock.
- Tests: E2E health check automatizado contra producción.

### Pendiente para v0.4.0
- Combate sincronizado: cliente envía `WeaponFire intent` → server valida con lag compensation (ring buffer 300 ms) → server aplica daño y broadcast.
- Sistema de oleadas progresivo con shop entre rondas.
- Persistencia de partidas en base de datos.

---

## Arquitectura — decisiones técnicas relevantes

| Decisión | Por qué |
|---|---|
| Server autoritativo total | Anti-cheat por diseño. Cliente solo predice; server tiene la última palabra. |
| Mundo determinista por seed + deltas | Server solo guarda ~1 KB inicial (no la malla entera). Cliente regenera desde seed, aplica deltas. |
| Colyseus 0.16 + `@colyseus/schema` 3.x | Diff-based snapshot sync, MapSchema/ArraySchema, callbacks de cambio. |
| `apps/game` separado de `apps/web` | Lobby SEO-friendly Next.js, juego Vite vanilla Three (más nativo para el renderer). Dos despliegues Vercel free. |
| CSP estilo Quake/Source | Player se mueve al instante local (60 Hz), server reconcilia (20 Hz). |
| Interpolation buffer 120 ms en remotos | Smooth sin lag compensation. Suficiente para casual; combate preciso requerirá lag-comp server-side. |
| pnpm workspaces | Tipos compartidos sin publicar npm. |

---

## Limitaciones conocidas

- Render Free tiene sleep tras 15 min de inactividad. Primera petición tras dormir tarda ~30 s. $7/mes en Starter lo arregla.
- Sin persistencia: si cierras todas las pestañas y caduca la sala de Colyseus, se pierde el estado.
- Sin colisiones jugador-jugador.
- Sin lag compensation server-side (necesario para disparos a la cabeza precisos a distancia).
- Render Free 0.1 vCPU aguanta 8 jugadores en una sala. Probado y medido en `stress-many-players.mjs` y `stress-8-players-visual.mjs`: 37 ms RTT mediana, 0 errores, 0 packet loss.
- Sin matchmaking público; las salas se comparten por código.

---

## Créditos

- **Juego base**: [EHxuban11/Voxel-Dragons](https://github.com/EHxuban11/Voxel-Dragons) — todo el `apps/game/src/modules/` (los 22 archivos: World, Player, Weapons, DragonManager, ZombieManager, SkeletonManager, WitchManager, HUD, Inventory, Effects, Audio, GameBalance, Menu, Shop, Characters, MageController, Diagnostics, Icons, Input, Viewmodels, BlockTextures) es obra suya, importada y parcheada para multiplayer.
- **Infraestructura multiplayer + integración + deploy**: este repo.

---

## Licencia

[MIT](LICENSE). Haz lo que quieras con ello, con atribución a EHxuban11 para el juego base.

---

## Enlaces clave

- Jugar: https://minecraft-shooter-online-web.vercel.app
- Repo: https://github.com/Thefalley/minecraft-shooter-online
- Server health: https://minecraft-shooter-online.onrender.com/health
- Plan maestro de fases: [docs/INTEGRATION-PLAN.md](docs/INTEGRATION-PLAN.md)
- Estado actual detallado: [docs/STATUS.md](docs/STATUS.md)
- Issues: https://github.com/Thefalley/minecraft-shooter-online/issues

> Esta versión del README documenta el viaje hasta v0.3.0 (Phase 4). Para el roadmap de v0.4.0 y posteriores ver `docs/INTEGRATION-PLAN.md`.
