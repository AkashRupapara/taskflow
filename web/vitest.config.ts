import { defineConfig } from "vitest/config";

// Unit tests only (src). Playwright e2e specs under /e2e run via `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
