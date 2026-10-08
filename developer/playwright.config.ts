import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", timeout: 45_000, fullyParallel: true, workers: 3,
  use: {baseURL: "http://127.0.0.1:8620", headless: true, viewport: {width: 1440, height: 1000}, trace: "retain-on-failure"},
  webServer: {command: "PORT=8620 NEXT_DIST_DIR=.next-e2e pnpm dev", url: "http://127.0.0.1:8620/sign-in", reuseExistingServer: !process.env.CI, timeout: 120_000},
});
