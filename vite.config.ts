import { defineConfig } from "vite";

// Tauri expects a fixed dev server port and does not like the terminal being
// cleared on every rebuild.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/models/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    sourcemap: false,
  },
});
