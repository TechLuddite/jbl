import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Custom domain (jbl.opsvibe.systems) serves from the root.
  // If you ever drop the custom domain and fall back to
  // techluddite.github.io/jbl, this MUST become "/jbl/".
  base: "/",
  build: {
    outDir: "dist",
    // The baked dex is one big JSON chunk; don't warn about it.
    chunkSizeWarningLimit: 2000,
  },
});
