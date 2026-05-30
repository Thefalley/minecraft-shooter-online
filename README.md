# Multiplayer Voxel Shooter

Juego web 3D **multiplayer-first**. La propiedad clave es el online: el servidor es autoritativo, el cliente predice localmente para que se sienta instantáneo, y dos jugadores cualesquiera pueden crear/unirse a una sala con un código y verse en tiempo real desde cualquier red.

**Jugar ya**: 👉 https://minecraft-shooter-online-web.vercel.app

> El servidor gratuito de Render se duerme después de 15 minutos sin tráfico. Si nadie está jugando, la primera petición tarda ~30 s en despertarlo. Después va fluido.

---

## Stack

| Capa | Librería | Versión | Dónde corre |
|---|---|---|---|
| Frontend | Next.js 14 + React 18 | 14.2 / 18.3 | Vercel |
| 3D | React Three Fiber + drei + three | 8.17 / 9.114 / 0.169 | Cliente |
| Estado cliente | Zustand | 5.0 | Cliente |
| Networking client | colyseus.js | 0.16 | Cliente |
| Servidor realtime | @colyseus/core + ws-transport | 0.16 | Render (Frankfurt) |
| Schema sync | @colyseus/schema | 3.0 | Server ↔ Cliente |
| HTTP server | express + cors | 4.21 / 2.8 | Render |
| Runtime TS dev | tsx | 4.19 | Local |
| Build bundle | esbuild | 0.24 | Render build |
| Monorepo | pnpm workspaces | 9.15 | Local + CI |
| Test E2E | playwright | 1.60 | Local |

## Estructura

```
.
├── apps/
│   ├── web/          # Next.js 14 + R3F (frontend → Vercel)
│   └── server/       # Colyseus 0.16 (servidor autoritativo → Render)
├── packages/
│   └── shared/       # Tipos, constantes, nombres de mensajes
├── tests/
│   ├── online.mjs        # Playwright: 2 navegadores, lobby+sync+disconnect
│   └── public-smoke.mjs  # Probe contra URLs públicas arbitrarias
├── render.yaml       # Blueprint del backend en Render
├── package.json      # pnpm workspace root
└── pnpm-workspace.yaml
```

## Cómo jugar (producción)

1. Abre https://minecraft-shooter-online-web.vercel.app
2. Escribe tu nombre y pulsa **Crear sala**. El HUD muestra un código (5 caracteres, p. ej. `K3PMT`).
3. Pasa la URL + el código a quien quieras invitar.
4. Esa persona abre la URL, escribe su nombre, pega el código, **Unirse**.
5. WASD para mover, Q/E para girar, Esc para volver al lobby.

Ambos jugadores aparecen como cápsulas en una escena 3D simple, y se mueven en tiempo real. Arriba a la derecha hay un overlay con **FPS** y **PING** al servidor.

## Arquitectura: por qué el servidor es autoritativo

- El cliente captura WASD + yaw y envía `{forward, backward, left, right, rotationY, seq}` al servidor.
- El servidor mantiene `GameState { roomCode, tick, players: Map<id, Player> }`.
- En cada tick (50 ms = 20 Hz) el servidor lee el último input de cada jugador, aplica `PLAYER_SPEED · dt` rotado por yaw, hace clamp de delta máximo (anti-cheat) y mete la posición dentro de `[-WORLD_HALF_SIZE, +WORLD_HALF_SIZE]`.
- Colyseus difunde el patch del schema a todos los clientes.

**El cliente NO decide su posición final** — el server tiene la última palabra. Si el cliente intenta teletransportarse, el server lo ignora.

### Client-Side Prediction (CSP)

El servidor autoritativo solo no basta para que se sienta bien: pulsar W y esperar 60-100 ms hasta ver el avatar moverse es muy raro. Por eso aplicamos la misma física en el cliente a 60 Hz:

- `apps/web/src/game/selfPrediction.ts` reproduce la fórmula del server (movimiento world-space rotado por yaw, clamp a `WORLD_HALF_SIZE`).
- `useInput.ts` llama a `applyLocalInput()` cada frame con los keys actuales.
- `LocalPlayer.tsx` renderiza desde la predicción, no desde el snapshot.
- Cuando llega un snapshot del server, `reconcileWithSnapshot()`:
  - Si la divergencia es < 1.5 u → blend suave (15%) hacia el server, sin saltos visibles.
  - Si es ≥ 1.5 u → snap directo al server (el cliente había predicho mal o intentó cosas raras).

Esto es la técnica clásica de Quake/Source: el local se siente como single-player; el server sigue mandando.

### Snapshot interpolation buffer (remotos)

Para que los jugadores remotos no se vean a saltitos cada 50 ms, `RemotePlayer.tsx` mantiene un buffer de las últimas 24 snapshots con timestamp y renderiza con un delay de 120 ms, interpolando entre las dos snapshots que rodean al tiempo de render. Es lo que hace Source/CS:GO. La consecuencia: ves a tu rival con 120 ms de delay, invisible en gameplay casual; relevante si añadimos disparos a la cabeza (entonces toca lag compensation server-side).

### Capa de transport abstracta

`apps/web/src/networking/transport.ts` define una interfaz `NetworkTransport`. La única implementación actual es `ColyseusTransport` (servidor dedicado). El día que queramos modo host-jugador con WebRTC, basta crear `WebRTCHostTransport` + `WebRTCClientTransport` que cumplan la misma interfaz, sin tocar el resto.

## Salas con código

- Generación: 5 caracteres del alfabeto `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (sin 0/1/I/O).
- El servidor expone `GET /rooms/by-code/:code` que devuelve `{ roomId, roomCode, clients, maxClients }` (404 / 400 si no existe / mal formado).
- El cliente lo consulta antes del `joinById`, así puede mostrar errores claros: `ROOM_NOT_FOUND`, `INVALID_CODE`, `ROOM_FULL`.
- `MAX_PLAYERS_PER_ROOM = 8` (configurable en `packages/shared/src/constants.ts`).
- Ventana de reconexión: 10 s. Si la pestaña se cierra accidentalmente, el jugador queda `connected=false` durante 10 s antes de borrarlo del estado.

## Endpoints HTTP

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | `{ status: "ok", uptime: ... }` |
| GET | `/rooms/by-code/:code` | `{ roomId, roomCode, clients, maxClients }` |

URL producción: `https://minecraft-shooter-online.onrender.com`

## Desarrollo local

### Requisitos

- Node.js ≥ 20
- pnpm ≥ 9

### Arranque

```bash
pnpm install --ignore-scripts
pnpm dev:server   # http://localhost:2567 — backend
pnpm dev:web      # http://localhost:3000 — frontend
```

Abre dos pestañas en `http://localhost:3000` y juega contra ti mismo.

Si en tu Windows los `.cmd` shims de pnpm no encuentran `node` en PATH (ver memoria de [project-runtime](memory/project_runtime.md)), llama a los binarios con la ruta completa:

```bash
"$(which node)" apps/server/node_modules/tsx/dist/cli.mjs apps/server/src/index.ts
"$(which node)" apps/web/node_modules/next/dist/bin/next dev -H 0.0.0.0 -p 3000
```

### Variables de entorno

`apps/web/.env.local`:
```
NEXT_PUBLIC_SERVER_URL=ws://localhost:2567
```

`apps/server/.env`:
```
PORT=2567
CORS_ORIGIN=http://localhost:3000
NODE_ENV=development
```

## Tests

### E2E con dos navegadores reales

```bash
node tests/online.mjs                                          # contra localhost
WEB_URL=https://tu-deploy.vercel.app node tests/online.mjs     # contra producción
```

Playwright headless Chromium arranca dos contextos aislados, Alice crea sala, Bob entra con el código, ambos se mueven, se ven, Bob cierra → Alice queda sola. Genera 10 capturas en `screenshots/`.

### Smoke test rápido contra URLs públicas

```bash
node tests/public-smoke.mjs https://web.example.com https://api.example.com
```

## Deploy

Producción actual:
- **Frontend**: Vercel → https://minecraft-shooter-online-web.vercel.app
- **Backend**: Render Free (Frankfurt) → https://minecraft-shooter-online.onrender.com

### Frontend en Vercel

1. Importar el repo en Vercel.
2. **Root Directory**: `apps/web`.
3. **Framework**: Next.js (auto-detectado).
4. **Install Command**: `pnpm install --ignore-scripts`.
5. **Environment Variable**: `NEXT_PUBLIC_SERVER_URL=wss://minecraft-shooter-online.onrender.com`.
6. Deploy.

### Backend en Render

1. New → Web Service → conectar el repo.
2. **Region**: Frankfurt (EU Central) — o el más cercano a tus jugadores.
3. **Build Command**: `npm install -g pnpm@9.15.0 && pnpm install --ignore-scripts --no-prod && pnpm --filter @mvp/server build`.
4. **Start Command**: `pnpm --filter @mvp/server start`.
5. **Instance Type**: Free (sleep tras 15 min) o Starter ($7/mes, sin sleep).
6. **Health Check Path**: `/health`.
7. **Env vars**: `NODE_ENV=production`, `CORS_ORIGIN=https://tu-vercel-domain`.

El bundle final es un único `apps/server/dist/index.mjs` de ~1.9 MB generado por esbuild, que Render arranca con `node`.

## Decisión técnica: servidor dedicado vs host-jugador (WebRTC)

| Criterio | Servidor dedicado (elegido) | Host-jugador |
|---|---|---|
| Implementación | Sencilla, Colyseus listo | Compleja: señalización + STUN/TURN |
| Si el host se va | Sin efecto | Partida cae o necesita migración |
| Trampas | Difícil (server decide) | Fácil (host controla todo) |
| Coste hosting | Sí (pequeño VPS o free tier) | Mínimo |
| NAT / firewalls | Sin problema | Riesgo serio sin TURN |

Decisión: MVP con servidor dedicado autoritativo en Colyseus. La capa `NetworkTransport` está preparada para añadir host-jugador cuando interese.

## Estado actual / limitaciones

- ✅ Crear sala con código corto
- ✅ Unirse por código
- ✅ Movimiento WASD multijugador autoritativo
- ✅ Client-Side Prediction (sensación instantánea local)
- ✅ Snapshot interpolation buffer (remotos smooth)
- ✅ Overlay FPS / ping en tiempo real
- ✅ Desconexión limpia con ventana de reconexión 10 s
- ✅ Lobby + validación de nombre + códigos sin caracteres ambiguos
- ❌ Sin combate (próximo hito: disparos autoritativos, vida, respawn)
- ❌ Sin mundo voxel (después del combate)
- ❌ Sin colisiones entre jugadores
- ❌ Sin chat, voz, persistencia, matchmaking público
- ❌ Sin lag compensation server-side (necesario para disparos a la cabeza)

## Próximo hito recomendado

**Combate básico autoritativo**:
- Click izquierdo → cliente envía intención de disparo.
- Servidor hace raycast contra cápsulas, aplica daño.
- Vida sincronizada en el schema (`Player.health` ya existe).
- Muerte → cápsula gris → respawn tras 3 s.

Mantener la regla: el cliente nunca decide quién muere ni cuándo. La predicción cliente del MUSO ya está; lo que falta es lag compensation server-side (replay del estado N ms atrás) para que apuntar se sienta justo.

## Histórico

Construido con agentes paralelos en git worktrees: `feat/shared`, `feat/server`, `feat/web` mergeados en `main`. Ver `git log --oneline` para el historial detallado.

## Licencia

MIT — ver [LICENSE](LICENSE).
