/**
 * A self-contained Jeeves for browser tests (Playwright) and local UI work: a tmp config dir, an
 * in-memory database, the real to-do and meals plugins in-process, a scripted Claude that always answers with
 * a short plan, and Remote-User trusted from localhost. Never use this in production.
 *
 *   npx tsx src/testserver.ts            # PORT=8090, prints "READY <url> <config dir>"
 *   JEEVES_CONFIG_DIR=/tmp/x npx tsx src/testserver.ts
 */
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Agent } from "./agent.js";
import { buildApp } from "./app.js";
import { ConfigStore } from "./configstore.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { McpPluginHost } from "./plugins.js";
import { RecordingNotifier, reply, toolUse } from "./testkit.js";
import { recordConfigActivity } from "./timeline.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

async function main() {
  const port = Number(process.env.PORT ?? 8090);
  const token = "test-plugin-token";

  const dir = process.env.JEEVES_CONFIG_DIR ?? mkdtempSync(join(tmpdir(), "jeeves-testserver-"));
  if (!existsSync(join(dir, "jeeves.yaml"))) cpSync(join(repo, "config.example"), dir, { recursive: true });

  // The real to-do plugin on an ephemeral port; Jeeves reaches it over MCP like in production.
  // Imported at runtime (tsx) so the server's own build doesn't pull in the plugin's sources.
  const load = (f: string) => import(pathToFileURL(join(repo, "plugins/todo/src", f)).href);
  const { buildApp: buildTodoApp } = await load("index.ts");
  const { seedFromFile } = await load("seed.ts");
  const { TodoStore } = await load("store.ts");
  const todoStore = new TodoStore();
  seedFromFile(todoStore, join(repo, "plugins/todo/chores.example.yaml"));
  const todo = buildTodoApp({
    store: todoStore,
    token,
    timeZone: "Europe/London",
    jeevesUrl: `http://127.0.0.1:${port}`,
    choresFile: join(repo, "plugins/todo/chores.example.yaml"),
  });
  const todoUrl: string = await todo.listen({ host: "127.0.0.1", port: 0 });

  // The real meals plugin too, so the Today views and the Recipes page have something to show.
  const loadMeals = (f: string) => import(pathToFileURL(join(repo, "plugins/meals/src", f)).href);
  const { buildApp: buildMealsApp } = await loadMeals("index.ts");
  const { MealsStore } = await loadMeals("store.ts");
  const meals = buildMealsApp({ store: new MealsStore(), token, timeZone: "Europe/London", jeevesUrl: `http://127.0.0.1:${port}` });
  const mealsUrl: string = await meals.listen({ host: "127.0.0.1", port: 0 });

  const store = new ConfigStore(dir);
  // Point the example's meals plugin at the in-process one.
  if (store.current.plugins.some((p) => p.name === "meals")) {
    store.editGlobals(undefined, (doc) => {
      const i = store.current.plugins.findIndex((p) => p.name === "meals");
      doc.setIn(["plugins", i, "url"], `${mealsUrl}/mcp`);
    });
  }
  // Point the example's todo plugin at the in-process one.
  if (store.current.plugins.some((p) => p.name === "todo")) {
    store.editGlobals(undefined, (doc) => {
      const i = store.current.plugins.findIndex((p) => p.name === "todo");
      doc.setIn(["plugins", i, "url"], `${todoUrl}/mcp`);
    });
  }
  store.watch();

  const db = new Db();
  recordConfigActivity(store, db);
  const env = { ...process.env, TODO_PLUGIN_TOKEN: token, MEALS_PLUGIN_TOKEN: token };
  const plugins = new McpPluginHost(store.current.plugins, {
    env,
    settingsFor: (name) => store.current.plugin_settings[name],
    onStatusChange: (name, ok, st) => db.addActivity(ok ? "plugin_connect" : "plugin_disconnect", name, { error: st.last_error }),
  });
  store.on("reload", () => plugins.setPlugins(store.current.plugins));

  // Scripted Claude: every run sends one short message.
  let n = 0;
  const create = async () => {
    n++;
    return n % 2 === 1
      ? reply("tool_use", [toolUse(`t${n}`, "send_message", { text: "Test plan: dishes first.", items: [] })])
      : reply("end_turn", []);
  };
  const notifier = new RecordingNotifier();
  const agent = new Agent({ db, config: store, plugins, notifier, create });
  const engine = new Engine(db, store, plugins, agent);
  engine.start();

  const app = buildApp({
    db,
    engine,
    pairingCode: "test-pairing-code",
    store,
    plugins,
    proxyAuth: { trust: true, trustedProxies: ["127.0.0.1", "::1"] },
    webDir: process.env.JEEVES_WEB_DIR ?? join(repo, "web/dist"),
  });
  const url = await app.listen({ host: "127.0.0.1", port });
  await plugins.listTools(); // connect, fetch the manifest, push settings
  console.log(`READY ${url} ${dir}`);

  const stop = async () => {
    store.close();
    await app.close();
    await engine.stop();
    await todo.close();
    await meals.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
