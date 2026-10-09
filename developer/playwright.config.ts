import { defineConfig } from "@playwright/test";

// E2E_PORT picks the dev server's port (default 8620), so a run never collides with a local stack.
const port = Number(process.env.E2E_PORT || 8620);

export default defineConfig({
  testDir: "./e2e", timeout: 45_000, fullyParallel: true, workers: 3,
  use: {baseURL: `http://127.0.0.1:${port}`, headless: true, viewport: {width: 1440, height: 1000}, trace: "retain-on-failure"},
  webServer: {command: `PORT=${port} NEXT_DIST_DIR=.next-e2e pnpm dev`, url: `http://127.0.0.1:${port}/sign-in`, reuseExistingServer: !process.env.CI, timeout: 120_000},
});
