import { rmSync } from "node:fs";

/** Removes the tmp config dir playwright.config.ts created (unless asked to keep it for debugging). */
export default function globalTeardown() {
  const dir = process.env.JEEVES_E2E_CONFIG_DIR;
  if (dir && !process.env.JEEVES_E2E_KEEP) rmSync(dir, { recursive: true, force: true });
}
