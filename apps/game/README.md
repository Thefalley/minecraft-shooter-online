# @mvp/game

Voxel-Dragons (originally by [EHxuban11](https://github.com/EHxuban11/Voxel-Dragons)) brought into this monorepo as `apps/game`.

This is the renderer/client app. The Colyseus server in `apps/server` is what makes it multiplayer.

## Status

Phase 0 — code imported as-is. **Singleplayer for now**. Networking layer (Phase 1+) lives in `apps/game/src/networking/` and is not wired in yet.

## Tech stack

- **Vanilla JavaScript + Three.js** (kept from upstream — not React, not R3F)
- **Vite** dev server / build
- Workspace dependency on `@mvp/shared` (types/protocol shared with the lobby and the server)
- Workspace dependency on `colyseus.js` (client SDK for the realtime layer)

## Dev

From the repo root:

```bash
pnpm install --ignore-scripts
pnpm --filter @mvp/game dev
```

Vite serves at `http://localhost:5173`. Click the canvas once to lock the pointer; WASD + mouse to play.

## Build

```bash
pnpm --filter @mvp/game build
# output: apps/game/dist/
```

## Deploy

Static SPA → any static host. We deploy this as a **separate Vercel project** from the lobby (apps/web). Both can live on the free tier.

Vercel project settings:
- **Root Directory**: `apps/game`
- **Build Command**: leave blank (Vite default `vite build` picked up via `package.json`)
- **Install Command**: `pnpm install --ignore-scripts`
- **Output Directory**: `dist`
- **Framework**: Other (Vite)
- **Env var**: `VITE_SERVER_URL=wss://minecraft-shooter-online.onrender.com`

## Multiplayer integration plan

See [../../docs/INTEGRATION-PLAN.md](../../docs/INTEGRATION-PLAN.md) for the full design.

In short, the next phases will:

1. Add `src/networking/` (NetworkBridge, ColyseusClient, InputPump, RemotePlayerMesh).
2. Refactor `Player.update()` to extract `applyInput(cmd)` for client-side prediction.
3. Sync the voxel world via a seed + delta map (the original `World.js` is already deterministic, so the server only stores ~1 KB initial state).
4. Move enemy AI (skeletons / zombies / witches / dragons) to the server.
5. Make weapons server-authoritative with lag compensation.
6. Coordinate the shop and waves across all players in a room.

## Credits & upstream

- Original game: [EHxuban11/Voxel-Dragons](https://github.com/EHxuban11/Voxel-Dragons).
- We mirror their main branch in `UPSTREAM-README.md` for reference.

## Modifications from upstream (kept minimal)

- `package.json` rewritten: pinned versions (`three@0.169.0`, `vite@5.4.10`), namespaced as `@mvp/game`, added `@mvp/shared` workspace dep and `colyseus.js`. Original used `"latest"` for everything.
- `vite.config.js` added (upstream relied on Vite defaults). Exposes `import.meta.env.VITE_SERVER_URL`.
- Source `src/` is copied verbatim from upstream at the time of import. Module-by-module patching happens in later phases.
