# Multiplayer Voxel Shooter MVP

Juego web **multiplayer-first** estilo Minecraft shooter. Prioriza que el online funcione antes que cualquier gameplay visual.

> Esqueleto inicial. Cada paquete se construye en su propio worktree por agentes paralelos y se integra al final.

## Estructura

```
multiplayer-voxel-mvp/
├── apps/
│   ├── web/          # Next.js + React Three Fiber (cliente)
│   └── server/       # Colyseus + Node.js (servidor autoritativo)
└── packages/
    └── shared/       # Tipos, constantes y nombres de mensajes
```

## Requisitos

- Node.js >= 20
- pnpm >= 9

## Quick start

```bash
pnpm install
pnpm dev
```

- Web: http://localhost:3000
- Servidor: http://localhost:2567
- Health check: http://localhost:2567/health

Más detalles tras la integración de los worktrees.
