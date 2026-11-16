import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built into ../wwwroot so the .NET app serves the SPA as static files (N1: everything bundled, nothing external).
// `vite --mode mock` points /api at the mock server (mock/server.mjs) instead of the .NET app.
export default defineConfig(({ mode }) => ({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "../wwwroot",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ["echarts/core", "echarts/charts", "echarts/components", "echarts/renderers"],
          react: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: mode === "mock" ? "http://localhost:5090" : "http://localhost:5080", changeOrigin: true } },
  },
}));
