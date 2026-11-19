import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke tests against the real server (server/src/testserver.ts): a tmp config dir copied from
 * config.example, the in-process to-do plugin and a scripted Claude. Needs `npm run build` first,
 * because the server serves web/dist at /admin.
 *
 * The config dir is made here rather than in globalSetup so the webServer (which may start before
 * globalSetup) and the test workers agree on it: workers inherit the env var set on first load.
 */
process.env.JEEVES_E2E_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), "jeeves-e2e-"));
const port = Number(process.env.JEEVES_E2E_PORT ?? 8097);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${port}/admin/`,
    // What Caddy + Authelia add in production; the test server trusts it from localhost.
    extraHTTPHeaders: { "Remote-User": "e2e" },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx tsx src/testserver.ts",
    cwd: "../server",
    url: `http://127.0.0.1:${port}/admin/`,
    env: { PORT: String(port), JEEVES_CONFIG_DIR: process.env.JEEVES_E2E_CONFIG_DIR, NODE_ENV: "test" },
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
