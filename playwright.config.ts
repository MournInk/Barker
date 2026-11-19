import { defineConfig } from "@playwright/test";

const port = process.env.BARKER_BROWSER_PORT || "3129";
export default defineConfig({
  testDir: "./tests/browser",
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  projects: [{ name: "chromium", use: { browserName: "chromium" } }, { name: "webkit", use: { browserName: "webkit" } }],
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: { command: "node scripts/browser-server.mjs", url: `http://127.0.0.1:${port}/api/session`, timeout: 90_000, reuseExistingServer: false, gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 } },
});
