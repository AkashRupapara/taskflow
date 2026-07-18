import { defineConfig } from "@playwright/test";

// e2e runs against the Vite dev server (auto-started if not already running).
// The Go API + Postgres must be up separately - see the DX section in the README.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: { baseURL: "http://localhost:5173" },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
