import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  use: { baseURL: "http://127.0.0.1:43110", trace: "on-first-retry" },
  webServer: {
    command: "node apps/server/dist/index.js",
    url: "http://127.0.0.1:43110/api/health",
    env: { NODE_ENV: "production", USHELF_ROOT: process.cwd() },
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"] } },
  ],
});
