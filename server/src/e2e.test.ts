/**
 * End to end across both services: the real to-do plugin and the real Jeeves server, talking over
 * HTTP (MCP, the manifest, settings push, views, actions and plugin events). Only Claude and the clock are fake.
 */
import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Agent } from "./agent.js";
import { buildApp } from "./app.js";
import { ConfigStore } from "./configstore.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { McpPluginHost } from "./plugins.js";
import { pair, RecordingNotifier, scriptedClaude, tmpConfigDir } from "./testkit.js";
import { buildApp as buildTodoApp } from "../../plugins/todo/src/index.js";
import { seedFromFile } from "../../plugins/todo/src/seed.js";
import { TodoStore } from "../../plugins/todo/src/store.js";

const TOKEN = "e2e-plugin-token";
const closers: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c();
});

async function until<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("e2e: todo.task_started -> wait -> message", () => {
  it("reacts to a chore being started through the real plugin", async () => {
    const clock = { now: new Date("2026-11-15T10:00:00Z") }; // a Sunday: laundry day
    const now = () => clock.now;

    // Jeeves first, on a real port, so the plugin can post events back to it.
    const dir = tmpConfigDir(
      { plugins: [{ name: "todo", url: "http://127.0.0.1:1/mcp", token_env: "TODO_PLUGIN_TOKEN" }] },
      [
        {
          id: "laundry-check",
          cooldown: 0,
          triggers: [{ event: "todo.task_started" }],
          steps: [
            { id: "pause", wait: { minutes: 10 } },
            { id: "ask", message: { text: "How's {{event.name}} going?" } },
          ],
        },
      ],
    );
    const store = new ConfigStore(dir, now);
    const db = new Db();
    const host = new McpPluginHost(store.current.plugins, { env: { TODO_PLUGIN_TOKEN: TOKEN }, settingsFor: (n) => store.current.plugin_settings[n] });
    store.on("reload", () => host.setPlugins(store.current.plugins));
    const notifier = new RecordingNotifier();
    const agent = new Agent({ db, config: store, plugins: host, notifier, create: scriptedClaude([]).create, now });
    const engine = new Engine(db, store, host, agent, now);
    const jeeves = buildApp({ db, engine, pairingCode: "pair-me-please", store, plugins: host, now });
    const jeevesUrl = await jeeves.listen({ host: "127.0.0.1", port: 0 });
    closers.push(() => jeeves.close(), async () => store.close(), () => engine.stop());

    // The real to-do plugin, seeded from the example chores, posting events to Jeeves.
    const todoStore = new TodoStore();
    seedFromFile(todoStore, join(__dirname, "../../plugins/todo/chores.example.yaml"));
    const todo = buildTodoApp({ store: todoStore, token: TOKEN, timeZone: "Europe/London", now, jeevesUrl });
    const todoUrl = await todo.listen({ host: "127.0.0.1", port: 0 });
    closers.push(() => todo.close());

    // Point Jeeves at it (a config edit, hot-applied to the plugin host).
    store.editGlobals(undefined, (doc) => doc.setIn(["plugins", 0, "url"], `${todoUrl}/mcp`));
    const tools = await host.listTools();
    expect(tools.find((t) => t.name === "todo__list_due_tasks")?.read_only).toBe(true);
    await host.idle();
    expect(host.manifest("todo")).toMatchObject({ events: ["task_started", "task_completed"], views: [{ id: "today", title: "Today" }] });

    // The app's Today tab: the plugin's view, relayed by Jeeves as generic items.
    const headers = await pair(jeeves);
    expect((await jeeves.inject({ method: "GET", url: "/views", headers })).json()).toEqual({
      views: [{ plugin: "todo", id: "today", title: "Today", empty_text: "Nothing due. Enjoy your evening." }],
    });
    const view = (await jeeves.inject({ method: "GET", url: "/views/todo/today", headers })).json();
    const laundry = view.items.find((i: { title: string }) => i.title === "Do a load of laundry");
    expect(laundry.actions.map((a: { id: string }) => a.id)).toEqual(["start", "done", "skip"]);

    // Tapping Start in the app goes to the plugin's /jeeves/actions.
    const start = await jeeves.inject({ method: "POST", url: "/plugins/todo/actions", headers, payload: { item: laundry.id, action: "start" } });
    expect(start.json()).toMatchObject({ ok: true, resolved: false });
    expect((await jeeves.inject({ method: "POST", url: "/plugins/todo/actions", headers, payload: { item: "999999", action: "done" } })).statusCode).toBe(404);

    // The plugin event arrives and the workflow starts waiting.
    const event = await until(() => db.lastEvent("todo.task_started", "9999"));
    expect(event.payload).toMatchObject({ task_id: Number(laundry.id), chore_id: "laundry", name: "Do a load of laundry" });
    await engine.idle();
    const [run] = db.workflowRuns();
    expect(run).toMatchObject({ workflow_id: "laundry-check", status: "waiting", event_id: event.id });

    clock.now = new Date(clock.now.getTime() + 9 * 60_000);
    await engine.runDueJobs();
    expect(notifier.sent).toHaveLength(0);
    clock.now = new Date(clock.now.getTime() + 2 * 60_000);
    await engine.runDueJobs();

    expect(db.getWorkflowRun(run.id)!.status).toBe("ok");
    expect(db.messagesAfter(0).map((m) => m.text)).toEqual(["How's Do a load of laundry going?"]);
    expect(notifier.sent).toHaveLength(1);
  });
});
