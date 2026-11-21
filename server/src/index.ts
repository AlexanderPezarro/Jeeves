import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Agent, anthropicCreate } from "./agent.js";
import { claudeCliRun } from "./cli.js";
import { buildApp } from "./app.js";
import { ConfigStore } from "./configstore.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { migrateRules } from "./migrate.js";
import { makeNotifier } from "./notify.js";
import { printVapidKeys } from "./vapid.js";
import { McpPluginHost } from "./plugins.js";
import { proxyAuthFromEnv } from "./auth.js";
import { recordConfigActivity } from "./timeline.js";

function configDir(): string {
  const dir = process.env.JEEVES_CONFIG_DIR ?? "./config";
  if (existsSync(resolve(dir, "jeeves.yaml"))) return dir;
  const legacy = process.env.JEEVES_CONFIG;
  if (legacy && existsSync(legacy)) {
    throw new Error(
      `Config now lives in a directory (JEEVES_CONFIG_DIR=${dir}) with jeeves.yaml, workflows/ and plugins/. ` +
        `Found the old single file at ${legacy}. Move it once by hand, e.g. on the host: ` +
        "`mkdir -p config && cp server/jeeves.yaml config/`, and mount ./config at /config (read-write).",
    );
  }
  throw new Error(`No ${resolve(dir, "jeeves.yaml")}. Copy config.example/ to config/ and edit it.`);
}

async function main() {
  const pairingCode = process.env.JEEVES_PAIRING_CODE;
  if (!pairingCode || pairingCode.length < 8) throw new Error("JEEVES_PAIRING_CODE must be set (8+ characters)");

  const dir = configDir();
  const migrated = migrateRules(dir);
  if (migrated.written.length) console.log(`Migrated rules to workflows/: ${migrated.written.join(", ")}`);
  const store = new ConfigStore(dir);
  for (const e of store.errors) console.error(`Config error in ${e.file}: ${e.error}`);
  store.watch();

  const dbPath = process.env.JEEVES_DB_PATH ?? "./data/jeeves.db";
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Db(dbPath);

  recordConfigActivity(store, db);
  const plugins = new McpPluginHost(store.current.plugins, {
    onStatusChange: (name, reachable, status) =>
      db.addActivity(reachable ? "plugin_connect" : "plugin_disconnect", name, { error: status.last_error, tool_count: status.tool_count }),
    settingsFor: (name) => store.current.plugin_settings[name],
    onManifest: (name, manifest) => {
      // todo_plugin is superseded by a manifest with today: true; drop the key once one is found.
      if (manifest?.today && store.current.todo_plugin !== undefined) {
        try {
          store.editGlobals(undefined, (doc) => {
            doc.deleteIn(["todo_plugin"]);
          });
          console.log(`Removed todo_plugin from jeeves.yaml: ${name} serves the Today list (manifest today: true)`);
        } catch (e) {
          console.warn(`Could not remove todo_plugin: ${(e as Error).message}`);
        }
      }
    },
  });
  store.on("reload", (diff) => {
    console.log("Config reloaded", JSON.stringify(diff));
    plugins.setPlugins(store.current.plugins);
  });
  store.on("errors", (errors) => console.error("Config errors", JSON.stringify(errors)));

  const notifier = makeNotifier(db);
  const agent = new Agent({
    db,
    config: store,
    plugins,
    notifier,
    ...(process.env.JEEVES_CLAUDE_BACKEND === "api" ? { create: anthropicCreate() } : { cli: claudeCliRun }),
  });
  const engine = new Engine(db, store, plugins, agent);
  engine.start();

  const proxyAuth = proxyAuthFromEnv();
  if (proxyAuth.trust) console.log(`Trusting Remote-User on /admin/api from ${proxyAuth.trustedProxies.join(", ") || "(nobody: set JEEVES_TRUSTED_PROXY)"}`);
  const webDir = resolve(process.env.JEEVES_WEB_DIR ?? "web");
  const app = buildApp({ db, engine, pairingCode, store, plugins, proxyAuth, webDir, vapidPublicKey: process.env.VAPID_PUBLIC_KEY || undefined });
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });

  // Contact plugins now and every 5 minutes: keeps status fresh, fetches manifests and
  // re-pushes settings whenever a plugin comes (back) up.
  const probe = () => void plugins.listTools().catch((e) => console.warn("Plugin probe failed", e));
  probe();
  const probeTimer = setInterval(probe, 5 * 60_000);

  const shutdown = async () => {
    clearInterval(probeTimer);
    store.close();
    await app.close();
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[2] === "vapid") {
  printVapidKeys();
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
