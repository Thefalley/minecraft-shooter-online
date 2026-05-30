# Multiplayer Voxel Shooter — MVP

Juego web 3D **multiplayer-first**. La propiedad clave es el online: el servidor es autoritativo, los clientes solo envían inputs, y dos jugadores pueden crear/unirse a una sala por código y verse en tiempo real.

> Visualmente es deliberadamente simple (cápsulas en un plano con cuadrícula). El siguiente paso es añadir combate, después mundo voxel.

## Estructura

```
multiplayer-voxel-mvp/
├── apps/
│   ├── web/          # Next.js 14 + R3F (cliente)
│   └── server/       # Colyseus 0.16 + Node (servidor autoritativo)
├── packages/
│   └── shared/       # Tipos, constantes y nombres de mensajes
├── tests/
│   └── online.mjs    # Test Playwright con 2 navegadores
└── screenshots/      # Capturas del test online (ignorado por git)
```

## Stack

| Capa | Librería | Versión |
|---|---|---|
| Frontend | Next.js 14 + React 18 | 14.2 / 18.3 |
| 3D | React Three Fiber + drei + three | 8.17 / 9.114 / 0.169 |
| Estado cliente | Zustand | 5.0 |
| Networking | colyseus.js | 0.16 |
| Servidor | @colyseus/core + ws-transport | 0.16 |
| Schema | @colyseus/schema | 3.0 |
| HTTP server | express + cors | 4.21 / 2.8 |
| Runtime TS dev | tsx | 4.19 |
| Monorepo | pnpm workspaces | 9.15 |
| Test E2E | playwright | 1.60 |

## Requisitos

- Node.js ≥ 20
- pnpm ≥ 9

## Quick start

```bash
pnpm install --ignore-scripts   # ignore-scripts evita postinstalls problemáticos en Windows
pnpm dev:server                  # http://localhost:2567
pnpm dev:web                     # http://localhost:3000
```

Abre dos pestañas en `http://localhost:3000`:
1. En la primera, escribe tu nombre y pulsa **Crear sala**. El HUD enseña un código (5 caracteres).
2. En la segunda, escribe otro nombre, pega el código y pulsa **Unirse**.
3. Las dos cápsulas aparecen en la misma escena 3D. **WASD** mueve, **Q/E** rota.

## Arquitectura: por qué el servidor es autoritativo

- El cliente captura WASD + yaw y envía `{forward, backward, left, right, rotationY, seq}` a 20 Hz.
- El servidor mantiene `GameState { roomCode, tick, players: Map<id, Player> }`.
- En cada tick (50 ms) el servidor lee el último input de cada jugador, aplica `PLAYER_SPEED · dt` rotado por el yaw, hace clamp de delta máximo (anti-cheat) y mete la posición dentro de `[-WORLD_HALF_SIZE, +WORLD_HALF_SIZE]`.
- Colyseus difunde el patch del schema a todos los clientes.
- El cliente renderiza las cápsulas remotas con interpolación simple (lerp).

Esto significa que **el cliente no decide su posición final**. Si manda un input ilegal, lo ignora; si manda yaw raro lo limita.

### Capa de transport abstracta

`apps/web/src/networking/transport.ts` define una interfaz `NetworkTransport`. La única implementación actual es `ColyseusTransport` (servidor dedicado). Para añadir host-jugador con WebRTC en el futuro, basta crear `WebRTCHostTransport` y `WebRTCClientTransport` que cumplan la misma interfaz, sin tocar el resto de la app.

## Salas con código

- Generación: 5 caracteres del alfabeto `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (sin 0/1/I/O).
- El servidor expone `GET /rooms/by-code/:code` que devuelve `{ roomId, roomCode, clients, maxClients }`. El cliente lo consulta antes del `joinById`, así puede mostrar errores claros: `ROOM_NOT_FOUND`, `INVALID_CODE`, `ROOM_FULL`.
- `MAX_PLAYERS_PER_ROOM = 8` (configurable en `packages/shared/src/constants.ts`).
- Ventana de reconexión: 10 s. Si la pestaña se cierra, el jugador queda marcado como `connected=false` durante 10 s antes de borrarlo del estado.

## Validación: test online con dos navegadores

```bash
# en una terminal
pnpm dev:server
# en otra
pnpm dev:web
# en una tercera
node tests/online.mjs
```

El test (`tests/online.mjs`):
1. Lanza Chromium con 2 contextos aislados (= 2 dispositivos).
2. Alice crea sala, extrae el código del HUD.
3. Bob se une con el código.
4. Comprueba que ambos clientes ven `Alice` y `Bob` en su lista.
5. Alice pulsa W y D — confirma que la pantalla cambia.
6. Bob ve a Alice moverse desde su perspectiva.
7. Bob cierra la pestaña, Alice queda sola tras la ventana de reconexión.
8. Guarda 10 screenshots en `screenshots/`.

## Endpoints HTTP del servidor

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | `{ status: "ok", uptime: ... }` |
| GET | `/rooms/by-code/:code` | `{ roomId, roomCode, clients, maxClients }` o 404 / 400 |

## Variables de entorno

`apps/web/.env.example`:
```
NEXT_PUBLIC_SERVER_URL=ws://localhost:2567
```

`apps/server/.env.example`:
```
PORT=2567
CORS_ORIGIN=http://localhost:3000
NODE_ENV=development
```

## Deploy

- **Frontend** (Vercel): `vercel` desde `apps/web`. Define `NEXT_PUBLIC_SERVER_URL=wss://tu-servidor`.
- **Servidor realtime** (Railway / Fly.io / Render):
  - Comando build: `pnpm install --ignore-scripts && pnpm --filter @mvp/server build`.
  - Comando start: `node apps/server/dist/index.js`.
  - Variable `PORT` la inyecta la plataforma. Define `CORS_ORIGIN=https://tu-vercel-domain`.

## Decisión técnica importante

### Servidor dedicado vs. host-jugador (WebRTC)

| Criterio | Servidor dedicado (elegido) | Host-jugador |
|---|---|---|
| Implementación | Sencilla, Colyseus listo | Complejo: señalización + STUN/TURN |
| Si el host se va | Sin efecto | Partida se cae o necesita migración |
| Trampas | Difícil (servidor decide) | Fácil (host controla todo) |
| Coste hosting | Sí (pequeño VPS) | Mínimo |
| NAT | No es problema | Riesgo serio sin TURN |

**Decisión**: arrancar con servidor dedicado autoritativo (Colyseus). Diseñar la capa de transport del cliente como interfaz para que, cuando merezca la pena, se pueda añadir un `WebRTCHostTransport` sin reescribir nada del juego.

## Limitaciones del MVP (deuda conocida)

- Sin combate (sin armas, sin daño, sin muerte). Próximo hito: click izquierdo → intención de disparo → servidor valida → daño autoritativo.
- Sin mundo voxel. Las cápsulas se mueven sobre un suelo plano con grid.
- Sin colisiones entre jugadores (pasan entre sí).
- Sin chat ni voz.
- Sin persistencia: cerrar el servidor borra todas las salas.
- Sin matchmaking público (siempre por código).
- La interpolación de remotos es un lerp simple. Para movimientos rápidos en el futuro habrá que buffer de snapshots con delay tipo Quake/Source.
- `pnpm install --ignore-scripts` evita un fallo de postinstall de `esbuild`/`msgpackr-extract` en este entorno Windows; en Linux/Mac no debería ser necesario.

## Siguiente hito

Combate básico autoritativo:
- Click izquierdo → cliente envía intención de disparo.
- Servidor calcula raycast, decide impacto, aplica daño.
- Vida sincronizada en el schema.
- Muerte + respawn.

Mantener la regla: el cliente nunca decide quién muere ni cuándo.

---

Generado con agentes paralelos en git worktrees: `feat/shared`, `feat/server`, `feat/web` mergeados en `main`.
