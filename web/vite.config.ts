import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy API + WebSocket calls to the Go server so the browser talks to a single
// origin in dev (no CORS juggling on the client side). The target is the Go API:
// `localhost:8080` for native dev, `api:8080` inside Docker Compose (set via env).
const api = process.env.API_PROXY_TARGET ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
    },
  },
});
