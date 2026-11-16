import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Agent, anthropicCreate } from "./agent.js";
import { claudeCliRun } from "./cli.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { makeNotifier } from "./notify.js";
import { McpPluginHost } from "./plugins.js";

async function main() {
  const config = loadConfig(process.env.JEEVES_CONFIG ?? "./jeeves.yaml");
  const pairingCode = process.env.JEEVES_PAIRING_CODE;
  if (!pairingCode || pairingCode.length < 8) throw new Error("JEEVES_PAIRING_CODE must be set (8+ characters)");

  const dbPath = process.env.JEEVES_DB_PATH ?? "./data/jeeves.db";
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Db(dbPath);

  const plugins = new McpPluginHost(config.plugins);
  const notifier = makeNotifier(db);
  const agent = new Agent({ db, config, plugins, notifier, ...(process.env.JEEVES_CLAUDE_BACKEND === "api" ? { create: anthropicCreate() } : { cli: claudeCliRun }) });
  const engine = new Engine(db, config, plugins, agent);
  engine.start();

  const app = buildApp({ db, engine, pairingCode });
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });

  const shutdown = async () => {
    await app.close();
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
