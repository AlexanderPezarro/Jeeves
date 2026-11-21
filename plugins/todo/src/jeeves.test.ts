import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "./index.js";
import { seedFromFile } from "./seed.js";
import { TodoStore } from "./store.js";
import { UI_HTML, UI_JS } from "./ui.js";
import type { TaskEventPayload, TaskEventType } from "./events.js";

const TOKEN = "secret";
const auth = { authorization: `Bearer ${TOKEN}` };
const SEED = "chores.example.yaml";

function setup(opts: { events?: (type: TaskEventType, payload: TaskEventPayload) => void } = {}) {
  const store = new TodoStore();
  seedFromFile(store, SEED);
  const app = buildApp({ store, token: TOKEN, timeZone: "Europe/London", choresFile: SEED, events: opts.events });
  return { store, app };
}

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const DEFAULTS = {
  carry_over_days: 3,
  default_snooze_minutes: 15,
  emit_events: true,
  daily_due_enabled: true,
  daily_due_time: "09:00",
  daily_due_level: "notify",
  evening_update_enabled: true,
  evening_update_time: "21:00",
  evening_update_level: "notify",
};

const newChore = {
  name: "Water the plants",
  recurrence: { every: "week", on: ["wed"] },
  effort: 1,
  est_minutes: 5,
  how_to: ["Fill the can", "Window sill first"],
};

describe("/jeeves manifest and auth", () => {
  it("returns the manifest", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/jeeves/manifest", headers: auth });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m).toMatchObject({
      name: "todo",
      display_name: "Chores",
      version: "0.1.0",
      ui: { path: "/jeeves/ui", title: "Chores" },
      events: [expect.objectContaining({ type: "task_started" }), expect.objectContaining({ type: "task_completed" }), expect.objectContaining({ type: "task_skipped" })],
      steps: expect.objectContaining({ list_due_tasks: expect.objectContaining({ title: "List due chores" }), get_task: expect.objectContaining({ title: "Get today's task for a chore" }) }),
      item_actions: expect.arrayContaining([expect.objectContaining({ id: "start" })]),
      views: [expect.objectContaining({ id: "today" })],
      settings_schema: { type: "object" },
    });
    expect(Object.keys(m.settings_schema.properties).sort()).toEqual(
      [
        "carry_over_days",
        "default_snooze_minutes",
        "emit_events",
        "daily_due_enabled",
        "daily_due_time",
        "daily_due_level",
        "evening_update_enabled",
        "evening_update_time",
        "evening_update_level",
      ].sort(),
    );
    for (const p of Object.values(m.settings_schema.properties) as Record<string, unknown>[]) {
      expect(["string", "number", "integer", "boolean"]).toContain(p.type);
      expect(p).toHaveProperty("title");
      expect(p).toHaveProperty("description");
      expect(p).toHaveProperty("default");
    }
  });

  it.each([
    ["GET", "/jeeves/manifest"],
    ["GET", "/jeeves/settings"],
    ["PUT", "/jeeves/settings"],
    ["GET", "/jeeves/ui"],
    ["GET", "/jeeves/ui/"],
    ["GET", "/jeeves/ui/app.js"],
    ["GET", "/jeeves/ui/app.css"],
    ["GET", "/jeeves/ui/api/chores"],
    ["POST", "/jeeves/ui/api/chores"],
    ["POST", "/jeeves/ui/api/chores/dishes"],
    ["POST", "/jeeves/ui/api/chores/dishes/delete"],
    ["POST", "/jeeves/ui/api/import"],
    ["GET", "/jeeves/api/chores"],
    ["POST", "/jeeves/api/chores"],
    ["PUT", "/jeeves/api/chores/dishes"],
    ["DELETE", "/jeeves/api/chores/dishes"],
  ] as const)("requires the bearer token for %s %s", async (method, url) => {
    const { app, store } = setup();
    for (const headers of [{}, { authorization: "Bearer wrong" }]) {
      const res = await app.inject({ method, url, headers });
      expect(res.statusCode).toBe(401);
    }
    expect(store.getChore("dishes")).toBeDefined();
  });
});

describe("/jeeves/settings", () => {
  it("round trips with defaults filled and applies carry_over_days live", async () => {
    const { app, store } = setup();
    const now = new Date("2026-11-14T18:20:00Z");
    store.listDue("2026-11-12", now); // Thursday's run is never done
    const overdueRun = () =>
      store.listDue("2026-11-14", now).some((t) => t.chore_id === "run" && t.due_date === "2026-11-12");
    expect(overdueRun()).toBe(true);

    let res = await app.inject({ method: "GET", url: "/jeeves/settings", headers: auth });
    expect(res.json()).toEqual(DEFAULTS);

    res = await app.inject({ method: "PUT", url: "/jeeves/settings", headers: auth, payload: { carry_over_days: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      values: { ...DEFAULTS, carry_over_days: 1 },
    });
    expect(overdueRun()).toBe(false);

    res = await app.inject({ method: "GET", url: "/jeeves/settings", headers: auth });
    expect(res.json().carry_over_days).toBe(1);
  });

  it("persists settings in todo.db", async () => {
    const { store } = setup();
    store.setSettings({ default_snooze_minutes: 40 });
    const raw = store.db.prepare("SELECT value FROM settings WHERE key = 'default_snooze_minutes'").get() as {
      value: string;
    };
    expect(JSON.parse(raw.value)).toBe(40);
  });

  it.each([
    [{ carry_over_days: "3" }],
    [{ carry_over_days: 2.5 }],
    [{ default_snooze_minutes: 0 }],
    [{ surprise: true }],
    [{ daily_due_time: "25:00" }],
    [{ evening_update_time: "9:00" }],
  ])("rejects %j with 400 and keeps the old values", async (payload) => {
    const { app, store } = setup();
    const res = await app.inject({ method: "PUT", url: "/jeeves/settings", headers: auth, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeDefined();
    expect(store.settings().carry_over_days).toBe(3);
  });
});

describe("legacy settings", () => {
  it("are accepted and dropped without resetting the other values", async () => {
    const { app, store } = setup();
    const res = await app.inject({
      method: "PUT",
      url: "/jeeves/settings",
      headers: auth,
      payload: { timer_level: "alarm", followup_nudges: true, chore_default_level: "loud", carry_over_days: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().values).toMatchObject({ carry_over_days: 5 });
    expect(res.json().values).not.toHaveProperty("timer_level");
    expect(store.settings().carry_over_days).toBe(5);
  });

  it("stored legacy rows do not reset the rest to defaults on load", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-"));
    try {
      const path = join(dir, "t.db");
      const first = new TodoStore(path);
      first.db.prepare("INSERT INTO settings (key, value) VALUES ('timer_level', '\"alarm\"'), ('carry_over_days', '7')").run();
      first.db.close();
      expect(new TodoStore(path).settings().carry_over_days).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("chore manager UI", () => {
  it("serves the page with relative URLs only", async () => {
    const { app } = setup();
    const page = await app.inject({ method: "GET", url: "/jeeves/ui/", headers: auth });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain('src="app.js"');
    expect(page.body).toContain('href="app.css"');
    expect(page.body).not.toMatch(/(src|href|action)="\//);
    expect(UI_JS).not.toMatch(/["']\/(jeeves|api)/);
    expect(UI_JS).not.toMatch(/"(PUT|DELETE|PATCH)"/);
    // The script is shipped as a string, so make sure it at least parses.
    expect(() => new Function(UI_JS)).not.toThrow();
    expect(UI_HTML).toContain('name="viewport"');

    const js = await app.inject({ method: "GET", url: "/jeeves/ui/app.js", headers: auth });
    expect(js.headers["content-type"]).toContain("javascript");
    const css = await app.inject({ method: "GET", url: "/jeeves/ui/app.css", headers: auth });
    expect(css.headers["content-type"]).toContain("text/css");
    expect(css.body).toContain("prefers-color-scheme: dark");

    const bare = await app.inject({ method: "GET", url: "/jeeves/ui", headers: auth });
    expect(bare.statusCode).toBe(302);
    expect(bare.headers.location).toBe("ui/");
  });

  it("lists, creates, updates and deletes chores over the GET/POST API", async () => {
    const { app, store } = setup();
    let res = await app.inject({ method: "GET", url: "/jeeves/ui/api/chores", headers: auth });
    expect(res.json().chores.map((c: { id: string }) => c.id)).toContain("dishes");

    res = await app.inject({ method: "POST", url: "/jeeves/ui/api/chores", headers: auth, payload: newChore });
    expect(res.statusCode).toBe(201);
    expect(res.json().chore).toMatchObject({
      id: "water-the-plants",
      completion_mode: "reply",
      active: true,
    });

    res = await app.inject({ method: "POST", url: "/jeeves/ui/api/chores", headers: auth, payload: newChore });
    expect(res.statusCode).toBe(409);

    res = await app.inject({
      method: "POST",
      url: "/jeeves/ui/api/chores/water-the-plants",
      headers: auth,
      payload: { ...newChore, effort: 2, recurrence: { every: "days", interval: 3, start: "2026-11-01" } },
    });
    expect(res.statusCode).toBe(200);
    expect(store.getChore("water-the-plants")).toMatchObject({
      effort: 2,
      recurrence: { every: "days", interval: 3, start: "2026-11-01" },
    });

    res = await app.inject({ method: "POST", url: "/jeeves/ui/api/chores/nope", headers: auth, payload: newChore });
    expect(res.statusCode).toBe(404);

    res = await app.inject({
      method: "POST",
      url: "/jeeves/ui/api/chores/water-the-plants",
      headers: auth,
      payload: { ...newChore, effort: 9 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toEqual(["effort"]);

    res = await app.inject({ method: "POST", url: "/jeeves/ui/api/chores/water-the-plants/delete", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(store.getChore("water-the-plants")).toBeUndefined();
    res = await app.inject({ method: "POST", url: "/jeeves/ui/api/chores/water-the-plants/delete", headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it("offers the REST form with the same handlers", async () => {
    const { app, store } = setup();
    let res = await app.inject({
      method: "POST",
      url: "/jeeves/api/chores",
      headers: auth,
      payload: { ...newChore, id: "plants" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().chore.id).toBe("plants");

    res = await app.inject({ method: "POST", url: "/jeeves/api/chores", headers: auth, payload: { ...newChore, id: "Bad Id" } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: "PUT",
      url: "/jeeves/api/chores/plants",
      headers: auth,
      payload: { ...newChore, name: "Water the plants (all)", active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(store.getChore("plants")).toMatchObject({ name: "Water the plants (all)", active: false });

    res = await app.inject({ method: "PUT", url: "/jeeves/api/chores/plants", headers: auth, payload: { ...newChore, id: "other" } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: "GET", url: "/jeeves/api/chores", headers: auth });
    expect(res.json().chores.find((c: { id: string }) => c.id === "plants").name).toBe("Water the plants (all)");

    res = await app.inject({ method: "DELETE", url: "/jeeves/api/chores/plants", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(store.getChore("plants")).toBeUndefined();
  });

  it("deletes a chore's task history with it", async () => {
    const { app, store } = setup();
    const [task] = store.listDue("2026-11-14").filter((t) => t.chore_id === "dishes");
    store.setState(task.id, "done");
    await app.inject({ method: "POST", url: "/jeeves/ui/api/chores/dishes/delete", headers: auth });
    expect(store.getTask(task.id)).toBeUndefined();
    expect(store.listDue("2026-11-14").some((t) => t.chore_id === "dishes")).toBe(false);
  });
});

describe("chores.yaml seed/import", () => {
  it("never overwrites edited chores or revives deleted ones", async () => {
    const { app, store } = setup();
    await app.inject({
      method: "POST",
      url: "/jeeves/ui/api/chores/dishes",
      headers: auth,
      payload: { name: "Dishes (edited)", recurrence: { every: "day" }, effort: 3 },
    });
    await app.inject({ method: "POST", url: "/jeeves/ui/api/chores/bins/delete", headers: auth });

    expect(seedFromFile(store, SEED)).toEqual({ inserted: 0, skipped: 5 });
    expect(store.getChore("dishes")).toMatchObject({ name: "Dishes (edited)", effort: 3 });
    expect(store.getChore("bins")).toBeUndefined();

    // Re-creating a deleted chore explicitly works, and the import button reports counts.
    store.db.prepare("DELETE FROM chores WHERE id = 'hoover'").run();
    const res = await app.inject({ method: "POST", url: "/jeeves/ui/api/import", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ inserted: 1, skipped: 4 });
    expect(store.getChore("hoover")).toBeDefined();

    const created = await app.inject({
      method: "POST",
      url: "/jeeves/api/chores",
      headers: auth,
      payload: { id: "bins", name: "Bins", recurrence: { every: "week", on: ["mon"] } },
    });
    expect(created.statusCode).toBe(201);
  });

  it("seeds an empty database fully", () => {
    expect(seedFromFile(new TodoStore(), SEED)).toEqual({ inserted: 5, skipped: 0 });
  });

  it("reports a missing chores file", async () => {
    const store = new TodoStore();
    const app = buildApp({ store, token: TOKEN, timeZone: "Europe/London", choresFile: "/nonexistent/chores.yaml" });
    const res = await app.inject({ method: "POST", url: "/jeeves/ui/api/import", headers: auth });
    expect(res.statusCode).toBe(404);
  });
});

describe("task events", () => {
  async function fakeJeeves() {
    const received: { auth?: string; body: unknown }[] = [];
    const jeeves = Fastify();
    jeeves.post("/plugin-events", async (req) => {
      received.push({ auth: req.headers.authorization, body: req.body });
      return { ok: true };
    });
    const url = await jeeves.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => jeeves.close());
    return { url, received };
  }

  async function todoWithMcp(jeevesUrl: string) {
    const store = new TodoStore();
    seedFromFile(store, SEED);
    const now = () => new Date("2026-11-15T10:00:00Z"); // Sunday: laundry day
    const app = buildApp({ store, token: TOKEN, timeZone: "Europe/London", now, jeevesUrl });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => app.close());
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    closers.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      return JSON.parse((res.content as { text: string }[])[0].text);
    };
    const laundry = (await call("list_due_tasks")).find((t: { chore_id: string }) => t.chore_id === "laundry");
    return { store, app, call, laundry };
  }

  async function waitFor(cond: () => boolean) {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  }

  it("posts task_skipped when a task is skipped", async () => {
    const seen: [TaskEventType, TaskEventPayload][] = [];
    const { app } = setup({ events: (t, p) => seen.push([t, p]) });
    const [first] = (await app.inject({ method: "GET", url: "/jeeves/views/today", headers: auth })).json().items;
    await app.inject({ method: "POST", url: "/jeeves/actions", headers: auth, payload: { item: first.id, action: "skip" } });
    expect(seen.map(([t, p]) => [t, String(p.task_id)])).toEqual([["task_skipped", first.id]]);
  });

  it("posts task_started and task_completed to Jeeves with the plugin token", async () => {
    const jeeves = await fakeJeeves();
    const { call, laundry } = await todoWithMcp(jeeves.url);

    await call("start_task", { task_id: laundry.id });
    await call("complete_task", { task_id: laundry.id });
    await waitFor(() => jeeves.received.length >= 2);

    expect(jeeves.received).toEqual([
      {
        auth: `Bearer ${TOKEN}`,
        body: { type: "task_started", payload: { task_id: laundry.id, chore_id: "laundry", name: "Do a load of laundry" } },
      },
      {
        auth: `Bearer ${TOKEN}`,
        body: { type: "task_completed", payload: { task_id: laundry.id, chore_id: "laundry", name: "Do a load of laundry" } },
      },
    ]);
  });

  it("does not send events when emit_events is off", async () => {
    const jeeves = await fakeJeeves();
    const { app, call, laundry } = await todoWithMcp(jeeves.url);
    const res = await app.inject({
      method: "PUT",
      url: "/jeeves/settings",
      headers: auth,
      payload: { emit_events: false },
    });
    expect(res.statusCode).toBe(200);

    const started = await call("start_task", { task_id: laundry.id });
    expect(started.state).toBe("started");
    await call("complete_task", { task_id: laundry.id });
    await new Promise((r) => setTimeout(r, 100));
    expect(jeeves.received).toEqual([]);
  });

  it("uses default_snooze_minutes when snooze_task has no minutes", async () => {
    const jeeves = await fakeJeeves();
    const { store, call, laundry } = await todoWithMcp(jeeves.url);
    store.setSettings({ default_snooze_minutes: 45 });
    const task = await call("snooze_task", { task_id: laundry.id });
    expect(task.snoozed_until).toBe("2026-11-15T10:45:00.000Z");
  });

  it("does not fail the tool call when Jeeves is unreachable", async () => {
    const { call, laundry } = await todoWithMcp("http://127.0.0.1:1");
    const started = await call("start_task", { task_id: laundry.id });
    expect(started.state).toBe("started");
  });

  it("uses an injected poster", async () => {
    const seen: [TaskEventType, TaskEventPayload][] = [];
    const { app, store } = setup({ events: (type, payload) => seen.push([type, payload]) });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => app.close());
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    closers.push(() => client.close());
    const [task] = store.listDue("2026-11-14");
    await client.callTool({ name: "complete_task", arguments: { task_id: task.id } });
    expect(seen).toEqual([["task_completed", { task_id: task.id, chore_id: task.chore_id, name: task.name }]]);
  });
});

describe("/jeeves views and actions", () => {
  it("serves today's tasks as generic items with their buttons", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/jeeves/views/today", headers: auth });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toMatchObject({ id: expect.stringMatching(/^\d+$/), title: expect.any(String), finished: false });
    expect(items[0].actions.map((a: { id: string }) => a.id)).toEqual(["start", "done", "skip"]);
    expect((await app.inject({ method: "GET", url: "/jeeves/views/nope", headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/jeeves/views/today" })).statusCode).toBe(401);
  });

  it("runs actions with the same side effects as the tools, and says when an item is resolved", async () => {
    const seen: [TaskEventType, TaskEventPayload][] = [];
    const { app } = setup({ events: (t, p) => seen.push([t, p]) });
    const [first] = (await app.inject({ method: "GET", url: "/jeeves/views/today", headers: auth })).json().items;
    const act = (action: string, item = first.id, args?: object) =>
      app.inject({ method: "POST", url: "/jeeves/actions", headers: auth, payload: { item, action, ...(args ? { args } : {}) } });

    expect((await act("start")).json()).toMatchObject({ ok: true, resolved: false });
    expect(seen.map(([t]) => t)).toEqual(["task_started"]);
    const view = (await app.inject({ method: "GET", url: "/jeeves/views/today", headers: auth })).json().items;
    expect(view.find((i: { id: string }) => i.id === first.id).actions.map((a: { id: string }) => a.id)).toEqual(["done", "skip"]);

    expect((await act("done")).json()).toMatchObject({ ok: true, resolved: true });
    expect(seen.map(([t]) => t)).toEqual(["task_started", "task_completed"]);
    expect((await act("snooze", first.id, { minutes: 30 })).statusCode).toBe(200);

    expect((await act("done", "999999")).statusCode).toBe(404);
    expect((await act("explode")).statusCode).toBe(400);
  });
});
