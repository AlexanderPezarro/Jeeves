import { readFileSync } from "node:fs";

// package.json sits one level up from both src/ (dev, tests) and dist/ (the Docker image).
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export const VERSION: string = pkg.version;
