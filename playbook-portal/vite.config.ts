import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4321,
    fs: {
      allow: [".."]
    }
  },
  preview: {
    host: "127.0.0.1",
    port: 4321
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react-markdown") || id.includes("node_modules/remark-") || id.includes("node_modules/unified") || id.includes("node_modules/mdast") || id.includes("node_modules/micromark")) return "markdown";
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) return "react";
          if (id.includes("node_modules/minisearch")) return "search";
          return undefined;
        }
      }
    }
  }
});
