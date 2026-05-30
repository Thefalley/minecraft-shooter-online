# Plan maestro — Integración Voxel-Dragons ↔ Multiplayer Colyseus

> Síntesis de 8 análisis paralelos en profundidad sobre [EHxuban11/Voxel-Dragons](https://github.com/EHxuban11/Voxel-Dragons) (vanilla JS + Three.js + Vite) contra nuestra infra existente (Next.js + Colyseus + Render + Vercel).
> Generado: 2026-05-30. Estado: **pendiente de aprobación**.

---

## TL;DR

- **Voxel-Dragons es un juego completo de 22 módulos** con mundo voxel determinista, 3 dragones, 3 enemigos terrestres (skeleton/zombie/witch), 5 clases de personaje, 3 armas (rifle/shotgun/blaster) + melee, viewmodels, HUD/inventario/shop completos. Hecho en Three.js puro con Vite.
- **El mundo es 100% reproducible desde un `seed`** → el servidor solo necesita guardar `{seed, deltas[]}`, no la malla entera. Ganancia: 1 KB inicial en vez de 6 MB.
- **Existen 30+ optimizaciones identificadas** de impacto medio-alto que pueden aplicarse durante la integración. La mayor: `World.rebuildMeshes()` es O(N) por bloque editado → cambio a `swap-pop` de `InstancedMesh` lo lleva a O(1). Solo eso = minar fluido aunque revientes el mapa entero.
- **Server-authoritative es viable en Render Free** para todo el modelo: 30 enemigos a 20 Hz consumen <600 ops/s en 0.1 vCPU; 8 jugadores generan ~24 KB/s de bandwidth.
- **Decisión arquitectónica**: traer Voxel-Dragons **como segundo paquete `apps/game`** (Vite, vanilla JS), mantener `apps/web` como lobby (Next.js). Compartir tipos y constantes vía `packages/shared`. Dos despliegues Vercel separados, un único servidor Colyseus en Render.

---

## 1 · Decisión arquitectónica

### Opciones que evalué

| Opción | Pro | Contra | Decisión |
|---|---|---|---|
| **A** — Portar todo a React/R3F | Mantiene nuestro stack TS | 2-4 semanas de rewrite, riesgo alto de romper gameplay | ❌ |
| **B** — Voxel-Dragons como `apps/game` Vite separado | Código nativo intacto, deploy rápido | Dos despliegues Vercel separados | ✅ **ELEGIDA** |
| **C** — Embed dentro de Next.js con `dynamic({ssr:false})` | Un solo deploy | Mezcla complicada de Vite + Next, hot reload roto | ❌ |

### Estructura propuesta

```
multiplayer-voxel-mvp/
├── apps/
│   ├── web/                 # YA EXISTE — lobby Next.js (sigue en Vercel)
│   ├── server/              # YA EXISTE — Colyseus Render (sigue, expandido)
│   └── game/                # NUEVO — Voxel-Dragons + capa de networking
│       ├── index.html       # Vite entry
│       ├── package.json
│       ├── vite.config.js
│       └── src/
│           ├── main.js
│           ├── modules/     # Los 22 módulos de EHxuban (copiados + parcheados)
│           └── networking/  # NUEVO — bridge a Colyseus
│               ├── NetworkBridge.js
│               ├── ColyseusClient.js
│               ├── InputPump.js
│               └── RemotePlayerMesh.js
└── packages/
    └── shared/              # YA EXISTE — extender con:
        ├── world/           # NUEVO — generación determinista compartida
        ├── balance.ts       # NUEVO — GameBalance.js portado
        └── protocol.ts      # extender con mensajes voxel/combat
```

### Flujo de jugador

```
1. Usuario abre apps/web (lobby Vercel)         https://minecraft-shooter-online-web.vercel.app
2. Mete nombre + crea/une sala con código       (lo que ya funciona)
3. Lobby redirige a apps/game con params        https://voxel-dragons-game.vercel.app/?code=ABCDE&name=Bob
4. Game lee URL, conecta a Render Colyseus,     wss://minecraft-shooter-online.onrender.com
   joinById con esos datos
5. Juega
```

Lo único nuevo en lobby: un botón redirect tras crear/unir sala.

---

## 2 · Modelo server-authoritative

### Lo que va al servidor (Render)

| Sistema | Justificación | Bandwidth | CPU |
|---|---|---|---|
| **Jugadores** (pos, vel, salud, escudo, ammo, clase, slot seleccionado) | Anti-cheat | ~50 B/jugador @ 20 Hz | trivial |
| **Mundo: seed + deltas** | Edición compartida (player A mina, B lo ve) | ~6 B/edit, raras | ~0 (deltas en Map) |
| **Enemigos** (skel/zomb/witch/dragon: pos, hp, estado) | Fair gameplay | 2.4 KB/s @ 30 enemigos | <600 ops/s |
| **Wave state + score + coins** | Sin desync | <1 KB/wave | trivial |
| **Hit registration** (disparos, parries, knockback) | Anti-cheat + lag comp | depende del ritmo | medio (ring buffer 300ms) |
| **Shop transactions** | Economía | trivial | trivial |

**Total estimado para 8 jugadores + 30 enemigos**: ~80-100 KB/s server out. Render Free 0.1 vCPU lo aguanta — los análisis confirman que la AI es trivial (no hay pathfinding).

### Lo que se queda en cliente (presentación)

- Todos los efectos visuales (explosion, tracer, slashMark, particles, shake)
- Audio completo (WebAudio synth puro)
- HUD del jugador propio (HP/ammo/inventario/wavebar)
- Viewmodels (animaciones first-person)
- Block textures (idénticas en todos, no se sincroniza)
- Cámara, pitch local
- Predicción local (CSP) del propio jugador

### Lo que es shared (constantes en `packages/shared`)

```ts
// packages/shared/src/balance.ts (NUEVO)
export const BALANCE = {
  player: { moveSpeed: 7, jumpSpeed: 8, gravity: 24, sensitivity: 0.0022, ... },
  weapons: { rifle: { damage: 22, fireRate: 8, ... }, shotgun: {...}, blaster: {...} },
  world:   { blockSize: 1, interactionRange: 6, maxHeight: 20, waterLevel: 6 },
} as const;
```

Idéntico en cliente (para predicción) y servidor (para validación).

---

## 3 · Plan en 6 fases

Cada fase es lanzable con agentes paralelos en worktrees. Te detallo cuántos y con qué scope.

### Fase 0 · Foundation (yo, sin agentes) — ~30 min

1. Crear `apps/game/` con `package.json` y `vite.config.js`.
2. Copiar el repo de Voxel-Dragons dentro de `apps/game/src/` (los 22 módulos + index.html + styles).
3. Adaptar import paths para que no se rompan dentro del workspace.
4. Crear `packages/shared/src/balance.ts` portando `GameBalance.js`.
5. Crear `packages/shared/src/world/` con `World.generate()` determinista refactorizado a TS puro (sin Three.js, devuelve `Map<string,blockType>`).
6. Levantar Vite local, probar que el juego corre como antes (singleplayer).
7. Configurar Vercel para el segundo despliegue (`voxel-dragons-game.vercel.app`).
8. Commit + push.

**Exit criteria**: el juego sigue jugable en producción contra `nada` (singleplayer) como tu compañero lo dejó.

### Fase 1 · Networking bridge (3 agentes paralelos) — ~2 h reloj

| Agente | Worktree | Scope |
|---|---|---|
| A | `feat/net-protocol` | Extender `packages/shared/src/protocol.ts` con todos los mensajes: `player:input`, `player:snapshot`, `world:delta`, `enemy:state`, `weapon:fire`, `weapon:hit`, `dragon:fireball`, `shop:buy`, `wave:next`, etc. Definir todos los `interface XPayload` con bytes esperados. |
| B | `feat/net-bridge-client` | Implementar `apps/game/src/networking/NetworkBridge.js` con `connect(code, name)`, `sendInput(cmd)`, `applySnapshot(state)`, sistema de event-emitter para que los módulos del juego se suscriban. Implementar `InputPump` que junta input + yaw + pitch + acciones a 20 Hz con throttle. |
| C | `feat/server-rooms-v2` | Reescribir `apps/server/src/rooms/GameRoom.ts`: ampliar `GameState` con `world: { seed, deltas: MapSchema<string,number> }`, `enemies: MapSchema<Enemy>`, `dragons: MapSchema<Dragon>`, `wave: number`, `phase: 'lobby'|'playing'|'shop'`. Implementar handlers para todos los mensajes. AI simple para enemigos terrestres en server. |

**Exit criteria**: cliente conecta, server arranca el mundo con seed, dos jugadores se ven en la misma escena (cápsulas placeholder, sin físicas todavía).

### Fase 2 · Player CSP + reconciliation (2 agentes paralelos) — ~2 h reloj

| Agente | Worktree | Scope |
|---|---|---|
| D | `feat/player-csp` | Refactorizar `Player.update()` en `applyInput(cmd)` extraído. Añadir `pendingInputs[]` ring buffer keyed por `seq`. Añadir `applyServerSnapshot({seq, pos, vel, grounded, wjcd, dashRem})` que rewind+replay desde el último ack. Bloquear `setPosition`, `damage`, `heal` detrás de `this._authoritative`. |
| E | `feat/remote-players` | Crear `apps/game/src/networking/RemotePlayerMesh.js`. Cápsulas que se renderizan desde state del server. Interpolation buffer (120 ms delay, ring de 24 snapshots) — copiar la lógica de `apps/web/src/game/RemotePlayer.tsx`. Soportar nameplate con `Sprite` o overlay DOM. |

**Exit criteria**: dos jugadores reales se mueven con WASD y se ven smooth. El local responde instantáneo. El servidor decide.

### Fase 3 · Mundo voxel sincronizado (2 agentes paralelos) — ~3 h reloj

| Agente | Worktree | Scope |
|---|---|---|
| F | `feat/world-deltas` | En cliente y servidor: generar terreno desde seed. Servidor recibe `world:mine(x,y,z)` y `world:place(x,y,z,type)`. Valida `distance(player,target)<6 + tolerance`, valida que la celda contiene/no contiene bloque, aplica a su `MapSchema<string,number>`, broadcast del delta a todos. Cliente aplica el delta inmediato al recibirlo. |
| G | `feat/world-perf` | 🔥 **Aplicar las optimizaciones críticas del agente World**: convertir `rebuildMeshes()` a `swap-pop incremental`. Mantener `instanceIndexByKey: Map<key,{type,index}>`. En `setBlock`: append/swap-remove de la `InstancedMesh` correspondiente. O(1) por edit en vez de O(N). + atlas de texturas a una única 64×64 → 1 draw call. + scratch `Matrix4` reutilizable. + pool de Vector3 en `raycastBlock`. |

**Exit criteria**: jugador A mina un bloque y jugador B lo ve desaparecer instantáneamente. Minar 50 bloques seguidos no causa stutter.

### Fase 4 · Enemigos + dragones server-authoritative (2 agentes paralelos) — ~3 h reloj

| Agente | Worktree | Scope |
|---|---|---|
| H | `feat/enemies-server` | Portar AI de Skeleton/Zombie/Witch a `apps/server`. En cada tick, actualizar posición/HP/eventos. Broadcast `enemy:snapshot` a 10 Hz con state delta. Cliente desactiva su AI local (`setAuthority('client-presentation')`), solo interpola posiciones y reproduce eventos (shoot/throw/attack) como FX. Implementar dragons igual con orbital flight + fireballs. |
| I | `feat/lod-culling` | Implementar las optimizaciones de presentación: LOD de 3 niveles para dragones (full/silhouette/billboard a 25u/60u). Frustum culling en grupos. Pool de geometrías en `Effects.js`. Pool de materiales por color. Pool de partículas. Scratch vectors en `_spawnBurst`. Cap `effects.length` a 60 cuando hay 4+ jugadores. |

**Exit criteria**: 30 enemigos vivos en la sala, 60 FPS en cliente con GPU media, server Render Free aguanta sin cold start mid-game.

### Fase 5 · Combate + lag compensation (2 agentes paralelos) — ~3 h reloj

| Agente | Worktree | Scope |
|---|---|---|
| J | `feat/combat-server` | En server: ring buffer de snapshots de entidades los últimos 300 ms. Handler `weapon:fire(intent)`: rewind a `clientTime - rtt/2`, re-raycast con misma lógica que cliente (seeded PRNG para spread con `inputSeq`), decidir hits, aplicar daño, broadcast `weapon:hit` con array de `{targetId, damage, point}`. Reload server-authoritative. Parry de fireballs: validar guard activo, calcular reflejo. |
| K | `feat/combat-client` | En cliente: refactorizar `Weapons.fire()` para no resolver localmente. Emitir intent → seguir mostrando tracer/muzzle/recoil predictivos. Al recibir `weapon:hit`: reproducir efectos confirmados. Si server dice "miss" → mantener tracer (solo visual) y rollback de ammo predicho. Pool de Vector3, eliminar las 40 clones por shotgun blast. |

**Exit criteria**: dos jugadores disparan a un dragón, server decide quién hace daño con orden correcto, sensación de respuesta inmediata.

### Fase 6 · UI multiplayer + shop coordination (yo, sin agentes) — ~2 h reloj

- Lobby panel persistente con nombres + HP de todos.
- Nameplates 3D sobre remotos.
- Shop entre waves: countdown 30 s, cada uno compra lo suyo, "Listo" sincronizado.
- `NetworkDiagnostics` extension del overlay FPS/PING con: input rate, snapshot lag, prediction error.

**Exit criteria**: sesión completa de 5 waves jugada por 2 jugadores reales sin bugs visibles.

---

## 4 · Optimizaciones identificadas (30+)

Resumen priorizado de los hallazgos de los 8 agentes:

### 🔥 Críticas (impacto enorme, integradas en fases)

1. **`World.rebuildMeshes()` O(N) → O(1)** con `instanceIndexByKey` + `swap-pop`. → Fase 3 agente G.
2. **Atlas de block textures**: 8 texturas → 1 (`BlockTextures.js:84-94`). 8 draw calls → 1. → Fase 3 agente G.
3. **Server determinista por seed**: mundo de ~6 MB → ~1 KB inicial + deltas. → Fase 3 agente F.
4. **LOD de dragones** a 3 niveles (mesh/silueta/billboard). → Fase 4 agente I.
5. **Lag compensation con ring buffer** de 300 ms para hits autoritativos. → Fase 5 agente J.

### 💪 Altas (mejoras de feel y CPU)

6. CSP del jugador local con rewind/replay desde `seq`. → Fase 2 agente D.
7. Interpolation buffer 120 ms para remotos. → Fase 2 agente E.
8. **Pool de geometrías de Effects** (`Effects.js:118,160,191,256,444`). → Fase 4 agente I.
9. **Pool de materiales por color** en Effects. → Fase 4 agente I.
10. **Pool de proyectiles** (`Weapons._spawnProjectile:541-543`). → Fase 5 agente K.
11. **Seeded PRNG para spread** (`Weapons._spreadDirection`). → Fase 5 agente J/K.
12. **Scratch vectors en hot paths** (`Effects._spawnBurst`, `Weapons._buildHitPayload`). → Fase 4 / 5.
13. **Extracción de `_simulate(delta)`** en Game.js para deduplicar branches `aerial`/`playing`. → Fase 2 agente D.
14. **`THREE.Clock.reset` en exit de pausa** para no quemar el clamp de 50ms. → Fase 1 agente B.

### 👍 Medias (calidad)

15. **`renderer.setPixelRatio(min(devicePixelRatio, 1.5))`** en retina → ~30% fill-rate ahorrado.
16. **Precomputar `WEAPON_KEYS`** en Game.js para evitar `'weapon'+i` alloc por slot por frame.
17. **Lazy-create `aerialCamera`** solo cuando se activa el modo.
18. **Cache `aliveCount()` con dirty flag** en lugar de iterar 4 managers cada tick.
19. **Mipmaps en block textures** para reducir shimmer a distancia.
20. **Pre-warm noise buffer** en `audio.unlock()` para no alocar mid-shot.
21. **HUD: diff `lastInventorySig`** antes de rebuild innerHTML.
22. **HUD: leer state.fields directamente** sin `{...DEFAULT_STATE, ...state}` por frame.

### 📐 Bajas pero limpias

23. `_updateMuzzleFlashes`: pool flash sprites.
24. `Effects.slash` quaternion hoist a scratch.
25. `parseBlockKey` packed Int en vez de string split.
26. `World.getBlock` versión integer para hot loops.
27. `_isRenderableBlock` precompute en bulk gen.
28. `audio.shootAt(weaponId, position)` con `PannerNode` para spatial.
29. Health bar dragons ocultar a >40u.
30. `frustumCulled=true` en grupos remotos cuando fuera de vista.

---

## 5 · Estimación realista de tiempo

| Fase | Reloj humano | Coste agentes paralelos | Notas |
|---|---|---|---|
| 0 — Foundation | 30 min | 0 | Yo. Setup mecánico. |
| 1 — Networking bridge | 2-3 h | 3 agentes paralelos | Define toda la pasarela. Bloqueante para el resto. |
| 2 — Player CSP + remotos | 2-3 h | 2 agentes paralelos | Fase con valor visible inmediato. |
| 3 — Mundo sincronizado | 3-4 h | 2 agentes paralelos | Lo más arquitectónico. |
| 4 — Enemigos server-side | 3-4 h | 2 agentes paralelos | Más CPU-sensitive del lote. |
| 5 — Combate + lag comp | 3-4 h | 2 agentes paralelos | El que mejor se siente. |
| 6 — UI + shop coord | 2 h | 0 | Yo. Pulido final. |
| **TOTAL** | **~15-20 h reloj** | **13 agent runs** | Distribuido en sesiones. |

15-20 horas de trabajo "guiado" es lo que cuesta esto bien hecho. No hay atajos serios sin sacrificar calidad o seguridad anti-cheat.

---

## 6 · Lo que NO está en este plan (deliberadamente)

- Persistencia (BD, saves) — no es necesario para co-op por sesión.
- Matchmaking público — seguimos con códigos.
- Skins / cosmetics — no aportan al MVP.
- Mobile / touch controls — Voxel-Dragons no está pensado.
- Server replication más allá de 8 jugadores — Render Free no aguanta.
- WebRTC P2P — la capa abstracta queda para futuro.

---

## 7 · Aprobación / siguiente paso

Si te suena bien:
- **A.** Empiezo Fase 0 (foundation, sin agentes) → te paso pull request en 30 min con el juego subido a `apps/game` y desplegado de nuevo a Vercel.
- **B.** Quieres que cambie algo del plan antes de arrancar (foco diferente, fases en otro orden, presupuesto distinto).
- **C.** Te interesa que arranque varias fases en paralelo en cuanto Fase 0 esté lista (Fases 1-4 son paralelizables con coordinación, mientras yo hago la integración final).

Dime tu preferencia.
