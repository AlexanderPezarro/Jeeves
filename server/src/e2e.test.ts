/**
 * End to end across both services: the real to-do plugin and the real Jeeves server, talking over
 * HTTP (MCP, the manifest, settings push, views, actions and plugin events). Only Claude and the clock are fake.
 */
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Agent } from "./agent.js";
import { buildApp } from "./app.js";
import { ConfigStore } from "./configstore.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { McpPluginHost } from "./plugins.js";
import { pair, RecordingNotifier, reply, scriptedClaude, tmpConfigDir, toolUse } from "./testkit.js";
import type { WorkflowInput } from "./config.js";
import { buildApp as buildTodoApp } from "../../plugins/todo/src/index.js";
import { seedFromFile } from "../../plugins/todo/src/seed.js";
import { TodoStore } from "../../plugins/todo/src/store.js";
import { mealActions } from "../../plugins/meals/src/actions.js";
import { buildApp as buildMealsApp } from "../../plugins/meals/src/index.js";
import { MealsStore } from "../../plugins/meals/src/store.js";
import { RECIPE_INPUTS, seedIngredients } from "../../plugins/meals/src/testdata.js";

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
    expect(host.manifest("todo")).toMatchObject({ events: ["task_started", "task_completed", "task_skipped"], views: [{ id: "today", title: "Today" }] });

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

const exampleWorkflow = (id: string) =>
  parseYaml(readFileSync(join(__dirname, `../../config.example/workflows/${id}.yaml`), "utf8")) as WorkflowInput;

/** The real meals plugin and the real server, with the example workflows from config.example. */
async function mealsSetup(workflows: string[], script: Parameters<typeof scriptedClaude>[0] = []) {
  const clock = { now: new Date("2026-11-16T16:00:00Z") }; // a Monday, 16:00 in London (winter)
  const now = () => clock.now;
  const dir = tmpConfigDir(
    { plugins: [{ name: "meals", url: "http://127.0.0.1:1/mcp", token_env: "MEALS_PLUGIN_TOKEN" }] },
    workflows.map(exampleWorkflow),
  );
  const store = new ConfigStore(dir, now);
  const db = new Db();
  const host = new McpPluginHost(store.current.plugins, { env: { MEALS_PLUGIN_TOKEN: TOKEN }, settingsFor: (n) => store.current.plugin_settings[n] });
  store.on("reload", () => host.setPlugins(store.current.plugins));
  const notifier = new RecordingNotifier();
  const claude = scriptedClaude(script);
  const agent = new Agent({ db, config: store, plugins: host, notifier, create: claude.create, now, titles: async () => null });
  const engine = new Engine(db, store, host, agent, now);
  const jeeves = buildApp({ db, engine, pairingCode: "pair-me-please", store, plugins: host, now });
  const jeevesUrl = await jeeves.listen({ host: "127.0.0.1", port: 0 });
  closers.push(() => jeeves.close(), async () => store.close(), () => engine.stop());

  const mealsStore = new MealsStore();
  seedIngredients(mealsStore);
  const meals = buildMealsApp({ store: mealsStore, token: TOKEN, timeZone: "Europe/London", now, jeevesUrl });
  const mealsUrl = await meals.listen({ host: "127.0.0.1", port: 0 });
  closers.push(() => meals.close());
  store.editGlobals(undefined, (doc) => doc.setIn(["plugins", 0, "url"], `${mealsUrl}/mcp`));
  await host.listTools();
  await host.idle();

  const actions = mealActions({ store: mealsStore, timeZone: "Europe/London", now });
  for (const r of Object.values(RECIPE_INPUTS)) actions.saveRecipe(r);
  return { clock, db, engine, jeeves, notifier, claude, host, actions, mealsStore };
}

describe("e2e: meals plugin", () => {
  it("dinner-tonight rings loudly at dinner time until Cooked is tapped in the app", async () => {
    const s = await mealsSetup(["dinner-tonight"]);
    s.actions.setPlan({ nights: [{ date: "2026-11-16", recipe_id: "pasta" }] });
    expect(s.host.manifest("meals")).toMatchObject({ events: ["cooked", "shop_finished", "plan_set"], views: [{ id: "tonight" }, { id: "shopping" }] });

    const { workflowRunId, done } = s.engine.runNow("dinner-tonight");
    expect((await done).status).toBe("waiting"); // until 18:30
    expect(s.notifier.sent).toHaveLength(0);

    s.clock.now = new Date("2026-11-16T18:31:00Z");
    await s.engine.runDueJobs();
    await s.engine.idle();
    expect(s.notifier.sent).toHaveLength(1);
    const msg = s.notifier.sent[0];
    expect(msg).toMatchObject({ level: "loud", items: [{ plugin: "meals", item_id: "2026-11-16", title: "Tomato pasta" }] });
    expect(msg.text).toContain("Tomato pasta");
    expect(s.db.getWorkflowRun(workflowRunId)!.status).toBe("waiting"); // repeating until cooked

    // The app shows tonight with Cooked / Skip, and Cooked goes to the plugin.
    const headers = await pair(s.jeeves);
    const view = (await s.jeeves.inject({ method: "GET", url: "/views/meals/tonight", headers })).json();
    expect(view.items[0]).toMatchObject({ id: "2026-11-16", title: "Tomato pasta", actions: [{ id: "cooked" }, { id: "skip" }] });
    const tap = await s.jeeves.inject({ method: "POST", url: "/plugins/meals/actions", headers, payload: { item: "2026-11-16", action: "cooked" } });
    expect(tap.json()).toMatchObject({ ok: true, resolved: true });

    // meals.cooked reaches Jeeves and ends the repeat.
    const event = await until(() => s.db.lastEvent("meals.cooked", "9999"));
    expect(event.payload).toMatchObject({ date: "2026-11-16", recipe_id: "pasta", name: "Tomato pasta", leftover_nights: 0 });
    await s.engine.idle();
    expect(s.db.getWorkflowRun(workflowRunId)!.status).not.toBe("waiting");
    s.clock.now = new Date("2026-11-16T19:00:00Z");
    await s.engine.runDueJobs();
    expect(s.notifier.sent).toHaveLength(1); // no more nags
  });

  it("dinner-tonight stays quiet on an out night", async () => {
    const s = await mealsSetup(["dinner-tonight"]);
    s.actions.markOut("2026-11-16");
    const { done } = s.engine.runNow("dinner-tonight");
    expect(await done).toMatchObject({ status: "stopped" });
    expect(s.notifier.sent).toHaveLength(0);
  });

  it("plan-my-week offers only the meals tools when no calendar or exercise plugin is configured", async () => {
    const s = await mealsSetup(
      ["plan-my-week"],
      [
        reply("tool_use", [toolUse("t1", "meals__preview_plan", { from: "2026-11-17", nights: [{ date: "2026-11-17", recipe_id: "curry" }] })]),
        reply("tool_use", [toolUse("t2", "send_message", { text: "Tue curry, shop Tuesday, about 7.50 of 50.", items: [] })]),
        reply("end_turn", []),
      ],
    );
    const { done } = s.engine.runNow("plan-my-week");
    expect((await done).status).toBe("ok");

    const offered = s.claude.requests[0].tools!.map((t) => (t as { name: string }).name);
    expect(offered.filter((n) => n.includes("__")).every((n) => n.startsWith("meals__"))).toBe(true);
    expect(offered).toEqual(expect.arrayContaining(["meals__preview_plan", "meals__get_pantry", "send_message"]));
    expect(offered).not.toContain("meals__set_plan"); // the draft writes nothing
    expect(offered.some((n) => n.startsWith("calendar__") || n.startsWith("exercise__"))).toBe(false);
    expect(JSON.stringify(s.claude.requests[0].system)).toContain("preview_plan"); // the meals instructions

    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Tue curry, shop Tuesday, about 7.50 of 50."]);
    // The preview really ran against the plugin and wrote nothing.
    expect(s.mealsStore.planRange("2026-11-01", "2026-12-31")).toEqual([]);
  });

  it("shop-reminder only speaks when the open shop is due", async () => {
    const s = await mealsSetup(["shop-reminder"]);
    expect((await s.engine.runNow("shop-reminder").done).status).toBe("stopped"); // no shop open
    s.actions.setPlan({ nights: [{ date: "2026-11-17", recipe_id: "curry" }] });
    s.actions.createShop({ date: "2026-11-17", from: "2026-11-16" });
    expect((await s.engine.runNow("shop-reminder").done).status).toBe("stopped"); // due tomorrow
    s.clock.now = new Date("2026-11-17T09:00:00Z");
    expect((await s.engine.runNow("shop-reminder").done).status).toBe("ok");
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Shop day: 7.5 estimated. Tick things off in the Shopping list on Today."]);
  });
});
