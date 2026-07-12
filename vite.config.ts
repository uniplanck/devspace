import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "src/ui"),
  plugins: [react()],
  base: "./",
  build: {
    outDir: process.env.DEVSPACE_UI_OUT_DIR
      ? resolve(process.env.DEVSPACE_UI_OUT_DIR)
      : resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: resolve(__dirname, "src/ui/workspace-app.html"),
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
