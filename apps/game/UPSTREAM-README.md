# Minecraft Guns Dragons

Prototipo web en Vite/Three.js de exploracion voxel con hotbar, inventario, mineria, colocacion de bloques, armas y dragones voladores.

## Ejecucion

Requisitos:

- Node.js 18 o superior.
- npm.

Instalacion y servidor local:

```bash
npm install
npm run dev
```

Vite mostrara la URL local en la terminal. Por defecto el proyecto usa `127.0.0.1`.

Comandos disponibles:

- `npm run dev`: inicia el servidor de desarrollo.
- `npm run build`: genera una build de produccion.
- `npm run preview`: sirve la build generada para revisarla localmente.

## Controles

- Click en la pantalla: activar audio, capturar el puntero e iniciar la partida.
- Raton: mirar alrededor.
- Click izquierdo: minar si tienes un bloque seleccionado; disparar si tienes un arma seleccionada.
- Click derecho: colocar el bloque seleccionado.
- `W` / `A` / `S` / `D`: moverse.
- `Shift`: correr.
- `Space`: saltar.
- `1` a `8`: seleccionar ranura del hotbar.
- Rueda del raton: cambiar ranura del hotbar.
- `E`: abrir o cerrar inventario.
- `R`: recargar.
- `F`: minar bloque apuntado como alternativa.

## Diagnostico manual

`src/modules/Diagnostics.js` exporta utilidades sin framework para revisar el estado desde consola o desde un modulo temporal:

```js
import { collectGameState, basicSmokeCheck } from './src/modules/Diagnostics.js';

console.table(basicSmokeCheck(game).checks);
console.log(collectGameState(game));
```

- `collectGameState(game)`: devuelve una instantanea de renderer, escena, camara, jugador, mundo, armas, dragones, input, audio, efectos y HUD.
- `basicSmokeCheck(game)`: devuelve `{ ok, checks, failed, state }` con validaciones basicas para confirmar que la partida arranco y sus sistemas principales existen.
