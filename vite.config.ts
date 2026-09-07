import { defineConfig } from "vite";

const COLLECTOR = process.env.PIT_COLLECTOR ?? "http://127.0.0.1:4318";

export default defineConfig({
  server: {
    port: 5173,
    open: false,
    proxy: {
      "/api": { target: COLLECTOR, changeOrigin: true },
      "/ingest": { target: COLLECTOR, changeOrigin: true },
      "/v1": { target: COLLECTOR, changeOrigin: true },
    },
  },
  build: { target: "es2022", sourcemap: true },
});
