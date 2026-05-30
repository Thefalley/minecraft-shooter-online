import { defineConfig } from "vite";

// Vite config for the standalone Voxel-Dragons game.
// - Builds a static SPA into dist/, deployable to Vercel as its own project.
// - In dev we listen on 0.0.0.0 so LAN testing keeps working.
// - process.env.NEXT_PUBLIC_SERVER_URL is reused as the Colyseus endpoint so
//   the same env var name works across both apps. Falls back to localhost.
export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  define: {
    "import.meta.env.VITE_SERVER_URL": JSON.stringify(
      process.env.VITE_SERVER_URL ??
        process.env.NEXT_PUBLIC_SERVER_URL ??
        "ws://localhost:2567",
    ),
  },
});
