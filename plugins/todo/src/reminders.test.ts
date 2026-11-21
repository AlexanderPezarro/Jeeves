import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "./index.js";
import { httpReminderClient, ReminderScheduler, zonedTime, type Reminder, type ReminderClient } from "./reminders.js";
import { seedFromFile } from "./seed.js";
import { TodoStore } from "./store.js";

const TZ = "Europe/London";
const SUNDAY = new Date("2026-11-15T07:00:00Z"); // GMT; laundry (wed, sun) is due

class FakeClient implements ReminderClient {
  calls: string[] = [];
  groups: Reminder[][] = [];
  puts: { key: string; at: string; level: string; text: string }[] = [];
  ok = true;
  failDeletes = false;
  async putGroup(group: string, reminders: Reminder[]) {
    this.calls.push(`group:${group}`);
    if (this.ok) this.groups.push(reminders);
    return this.ok;
  }
  async put(key: string, r: Omit<Reminder, "key">) {
    this.calls.push(`put:${key}`);
    if (this.ok) this.puts.push({ key, ...r });
    return this.ok;
  }
  async delete(key: string) {
    this.calls.push(`delete:${key}`);
    return !this.failDeletes;
  }
}

function setup(now = SUNDAY) {
  const store = new TodoStore();
  seedFromFile(store, "chores.example.yaml");
  const client = new FakeClient();
  const scheduler = new ReminderScheduler({ store, client, timeZone: TZ, now: () => now });
  return { store, client, scheduler };
}

describe("zonedTime", () => {
  it.each([
    ["2026-11-15", "09:00", "2026-11-15T09:00:00.000Z"], // GMT
    ["2026-07-12", "09:00", "2026-07-12T08:00:00.000Z"], // BST
    ["2026-03-29", "09:00", "2026-03-29T08:00:00.000Z"], // spring forward day
    ["2026-10-25", "09:00", "2026-10-25T09:00:00.000Z"], // fall back day
    ["2026-03-29", "00:30", "2026-03-29T00:30:00.000Z"], // before the change, still GMT
  ])("%s %s in London is %s", (date, hhmm, iso) => {
    expect(zonedTime(date, hhmm, TZ).toISOString()).toBe(iso);
  });
});

describe("ReminderScheduler.computeDaily", () => {
  it("builds the due and evening reminders at local times", () => {
    const { store, scheduler } = setup();
    const open = store.listDue("2026-11-15", SUNDAY).filter((t) => t.state === "pending");
    expect(open.length).toBeGreaterThan(1);
    const out = scheduler.computeDaily();
    expect(out.map((r) => r.key)).toEqual(["due:2026-11-15", "update:2026-11-15"]);
    expect(out[0]).toMatchObject({
      at: "2026-11-15T09:00:00.000Z",
      level: "notify",
      text: `${open.length} chores today`,
    });
    expect(out[0].items?.map((i) => i.task_id).sort()).toEqual(open.map((t) => t.id).sort());
    expect(out[1]).toMatchObject({ at: "2026-11-15T21:00:00.000Z", text: "Tick off what you did today" });
  });

  it("uses the right UTC time in BST", () => {
    const { scheduler } = setup(new Date("2026-07-12T06:00:00Z"));
    const out = scheduler.computeDaily();
    expect(out.find((r) => r.key === "due:2026-07-12")!.at).toBe("2026-07-12T08:00:00.000Z");
    expect(out.find((r) => r.key === "update:2026-07-12")!.at).toBe("2026-07-12T20:00:00.000Z");
  });

  it("handles the DST change days", () => {
    const spring = setup(new Date("2026-03-29T05:00:00Z")).scheduler.computeDaily();
    expect(spring.find((r) => r.key.startsWith("due:"))!.at).toBe("2026-03-29T08:00:00.000Z");
    const fall = setup(new Date("2026-10-25T05:00:00Z")).scheduler.computeDaily();
    expect(fall.find((r) => r.key.startsWith("due:"))!.at).toBe("2026-10-25T09:00:00.000Z");
  });

  it("adds chore reminders only for open tasks with remind_at, with level fallback", () => {
    const { store, scheduler } = setup();
    const laundry = store.getChore("laundry")!;
    store.upsertChore({ ...laundry, remind_at: "18:00" });
    const dishes = store.getChore("dishes")!;
    store.upsertChore({ ...dishes, remind_at: "19:30", remind_level: "loud" });
    store.setSettings({ chore_default_level: "alarm" });

    const out = scheduler.computeDaily();
    const lt = store.listDue("2026-11-15", SUNDAY);
    const laundryTask = lt.find((t) => t.chore_id === "laundry")!;
    const dishesTask = lt.find((t) => t.chore_id === "dishes")!;
    expect(out.filter((r) => r.key.startsWith("chore:")).map((r) => r.key).sort()).toEqual(
      [`chore:${laundryTask.id}`, `chore:${dishesTask.id}`].sort(),
    );
    expect(out.find((r) => r.key === `chore:${laundryTask.id}`)).toMatchObject({
      at: "2026-11-15T18:00:00.000Z",
      level: "alarm",
      items: [{ task_id: laundryTask.id }],
    });
    expect(out.find((r) => r.key === `chore:${dishesTask.id}`)).toMatchObject({ level: "loud" });
  });

  it("drops chore and update reminders once everything is done", () => {
    const { store, scheduler } = setup();
    store.upsertChore({ ...store.getChore("laundry")!, remind_at: "18:00" });
    expect(scheduler.computeDaily().map((r) => r.key.split(":")[0])).toEqual(["due", "chore", "update"]);
    for (const t of store.listDue("2026-11-15", SUNDAY)) store.setState(t.id, t.id % 2 ? "done" : "skipped", SUNDAY);
    expect(scheduler.computeDaily()).toEqual([]);
  });

  it("omits disabled reminders", () => {
    const { store, scheduler } = setup();
    store.setSettings({ daily_due_enabled: false, evening_update_enabled: false });
    expect(scheduler.computeDaily()).toEqual([]);
    store.setSettings({ daily_due_enabled: false, daily_due_time: "07:30", evening_update_level: "loud" });
    expect(scheduler.computeDaily().map((r) => [r.key, r.level])).toEqual([["update:2026-11-15", "loud"]]);
  });
});

describe("ReminderScheduler.sync", () => {
  it("sends the daily group, and a smaller one after tasks are completed", async () => {
    const { store, client, scheduler } = setup();
    await scheduler.sync();
    expect(client.groups[0].map((r) => r.key)).toEqual(["due:2026-11-15", "update:2026-11-15"]);
    expect(client.groups[0][0].items!.length).toBeGreaterThan(1);
    const open = store.listDue("2026-11-15", SUNDAY);
    for (const t of open.slice(1)) store.setState(t.id, "done", SUNDAY);
    await scheduler.sync();
    expect(client.groups[1][0].items).toHaveLength(1);
    for (const t of open) store.setState(t.id, "done", SUNDAY);
    await scheduler.sync();
    expect(client.groups[2]).toEqual([]);
  });

  it("sets dirty on failure and re-sends next time; retries queued deletes", async () => {
    const { store, client, scheduler } = setup();
    client.ok = false;
    await scheduler.sync();
    expect(scheduler.dirty).toBe(true);
    client.ok = true;
    await scheduler.sync();
    expect(scheduler.dirty).toBe(false);
    expect(client.groups).toHaveLength(1);

    const task = store.listDue("2026-11-15", SUNDAY).find((t) => t.chore_id === "laundry")!;
    client.failDeletes = true;
    await scheduler.cancelTimers(task, store.getChore("laundry")!);
    client.calls = [];
    client.failDeletes = false;
    await scheduler.sync();
    expect(client.calls).toEqual([`delete:timer:${task.id}:1`, `delete:timer:${task.id}:2`, "group:daily"]);
    client.calls = [];
    await scheduler.sync();
    expect(client.calls).toEqual(["group:daily"]);
  });

  it("serialises overlapping syncs and re-runs once", async () => {
    const { client, scheduler } = setup();
    await Promise.all([scheduler.sync(), scheduler.sync(), scheduler.sync()]);
    expect(client.calls).toEqual(["group:daily", "group:daily"]);
  });
});

describe("timer reminders over MCP", () => {
  const closers: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });

  async function connect(client: FakeClient, store: TodoStore) {
    const reminders = new ReminderScheduler({ store, client, timeZone: TZ, now: () => SUNDAY });
    const app = buildApp({ store, token: "secret", timeZone: TZ, now: () => SUNDAY, reminders });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer secret" } },
      }),
    );
    closers.push(() => mcp.close(), () => app.close());
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await mcp.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    return { call, app };
  }

  it("start_task PUTs timer reminders and complete_task / skip_task delete them", async () => {
    const store = new TodoStore();
    seedFromFile(store, "chores.example.yaml");
    const client = new FakeClient();
    const { call } = await connect(client, store);
    const laundry = store.listDue("2026-11-15", SUNDAY).find((t) => t.chore_id === "laundry")!;

    const { followups } = await call("start_task", { task_id: laundry.id });
    expect(followups).toEqual([
      { at: "2026-11-15T08:15:00.000Z", message: expect.stringContaining("dryer"), scheduled: true },
      { at: "2026-11-15T09:15:00.000Z", message: expect.stringContaining("fold"), scheduled: true },
    ]);
    expect(client.puts.map((p) => [p.key, p.at, p.level])).toEqual([
      [`timer:${laundry.id}:1`, "2026-11-15T08:15:00.000Z", "alarm"],
      [`timer:${laundry.id}:2`, "2026-11-15T09:15:00.000Z", "alarm"],
    ]);
    expect(client.calls.at(-1)).toBe("group:daily");

    client.calls = [];
    await call("complete_task", { task_id: laundry.id });
    expect(client.calls).toEqual([`delete:timer:${laundry.id}:1`, `delete:timer:${laundry.id}:2`, "group:daily"]);

    client.calls = [];
    await call("skip_task", { task_id: laundry.id });
    expect(client.calls.filter((c) => c.startsWith("delete:"))).toHaveLength(2);
  });

  it("returns scheduled: false when the PUT fails, and does not retry", async () => {
    const store = new TodoStore();
    seedFromFile(store, "chores.example.yaml");
    const client = new FakeClient();
    client.ok = false;
    const { call } = await connect(client, store);
    const laundry = store.listDue("2026-11-15", SUNDAY).find((t) => t.chore_id === "laundry")!;
    const { followups } = await call("start_task", { task_id: laundry.id });
    expect(followups.map((f: { scheduled: boolean }) => f.scheduled)).toEqual([false, false]);
    expect(client.calls.filter((c) => c.startsWith("put:"))).toHaveLength(2);
  });

  it("schedules nothing when followup_nudges is off", async () => {
    const store = new TodoStore();
    seedFromFile(store, "chores.example.yaml");
    store.setSettings({ followup_nudges: false });
    const client = new FakeClient();
    const { call } = await connect(client, store);
    const laundry = store.listDue("2026-11-15", SUNDAY).find((t) => t.chore_id === "laundry")!;
    const { followups } = await call("start_task", { task_id: laundry.id });
    expect(followups).toEqual([]);
    expect(client.puts).toEqual([]);
  });

  it("settings and chore route changes trigger a sync", async () => {
    const store = new TodoStore();
    seedFromFile(store, "chores.example.yaml");
    const client = new FakeClient();
    const { app } = await connect(client, store);
    const auth = { authorization: "Bearer secret" };
    const syncs = () => client.calls.filter((c) => c === "group:daily").length;

    await app.inject({ method: "PUT", url: "/jeeves/settings", headers: auth, payload: { daily_due_time: "08:00" } });
    expect(syncs()).toBe(1);
    expect(client.groups[0].find((r) => r.key.startsWith("due:"))!.at).toBe("2026-11-15T08:00:00.000Z");

    const chore = {
      name: "Water the plants",
      recurrence: { every: "day" },
      remind_at: "17:00",
      remind_level: "loud",
    };
    let res = await app.inject({ method: "POST", url: "/jeeves/ui/api/chores", headers: auth, payload: chore });
    expect(res.statusCode).toBe(201);
    expect(syncs()).toBe(2);
    expect(client.groups[1].some((r) => r.key.startsWith("chore:") && r.level === "loud")).toBe(true);

    res = await app.inject({
      method: "POST",
      url: "/jeeves/ui/api/chores/water-the-plants",
      headers: auth,
      payload: { ...chore, remind_at: null },
    });
    expect(res.statusCode).toBe(200);
    expect(syncs()).toBe(3);
    expect(client.groups[2].some((r) => r.key.startsWith("chore:"))).toBe(false);

    await app.inject({ method: "POST", url: "/jeeves/ui/api/chores/water-the-plants/delete", headers: auth });
    expect(syncs()).toBe(4);
    await app.inject({ method: "POST", url: "/jeeves/ui/api/import", headers: auth });
    // No choresFile configured: 404, no sync.
    expect(syncs()).toBe(4);
  });
});

describe("httpReminderClient", () => {
  it("calls the plugin-reminders endpoints with the token and never throws", async () => {
    const seen: { url: string; method: string; body?: string; auth: string }[] = [];
    let status = 200;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({
        url,
        method: init.method!,
        body: init.body as string | undefined,
        auth: (init.headers as Record<string, string>).Authorization,
      });
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
    const c = httpReminderClient({ jeevesUrl: "http://server:8080/", token: "t", fetch: fakeFetch });
    const r = { at: "2026-11-15T09:00:00.000Z", level: "notify" as const, text: "hi" };
    expect(await c.put("timer:1:1", r)).toBe(true);
    expect(await c.putGroup("daily", [{ key: "due:x", ...r }])).toBe(true);
    expect(await c.delete("timer:1:1")).toBe(true);
    expect(seen.map((s) => [s.method, s.url])).toEqual([
      ["PUT", "http://server:8080/plugin-reminders/timer%3A1%3A1"],
      ["PUT", "http://server:8080/plugin-reminders?group=daily"],
      ["DELETE", "http://server:8080/plugin-reminders/timer%3A1%3A1"],
    ]);
    expect(seen.every((s) => s.auth === "Bearer t")).toBe(true);
    expect(JSON.parse(seen[1].body!)).toEqual({ reminders: [{ key: "due:x", ...r }] });
    status = 400;
    expect(await c.put("k", r)).toBe(false);
    const broken = httpReminderClient({
      jeevesUrl: "http://x",
      token: "t",
      fetch: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    });
    expect(await broken.delete("k")).toBe(false);
  });
});

describe("chore reminder fields", () => {
  it("round-trip through the API and the seed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-"));
    try {
      const store = new TodoStore();
      const app = buildApp({ store, token: "secret", timeZone: TZ });
      const auth = { authorization: "Bearer secret" };
      const body = { name: "Bins", recurrence: { every: "week", on: ["mon"] }, remind_at: "19:15", remind_level: "alarm" };
      let res = await app.inject({ method: "POST", url: "/jeeves/ui/api/chores", headers: auth, payload: body });
      expect(res.statusCode).toBe(201);
      expect(res.json().chore).toMatchObject({ remind_at: "19:15", remind_level: "alarm" });
      res = await app.inject({ method: "POST", url: "/jeeves/ui/api/chores", headers: auth, payload: { ...body, name: "Bad", remind_at: "7pm" } });
      expect(res.statusCode).toBe(400);
      res = await app.inject({ method: "POST", url: "/jeeves/ui/api/chores", headers: auth, payload: { ...body, name: "Bad2", remind_level: "siren" } });
      expect(res.statusCode).toBe(400);
      res = await app.inject({ method: "GET", url: "/jeeves/api/chores", headers: auth });
      expect(res.json().chores[0]).toMatchObject({ remind_at: "19:15", remind_level: "alarm" });

      const yaml = join(dir, "c.yaml");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(yaml, 'chores:\n  - { id: x, name: X, recurrence: { every: day }, remind_at: "08:05", remind_level: loud }\n');
      const s2 = new TodoStore();
      seedFromFile(s2, yaml);
      expect(s2.getChore("x")).toMatchObject({ remind_at: "08:05", remind_level: "loud" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("are added to an old database by the guarded ALTER", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-"));
    try {
      const path = join(dir, "old.db");
      const old = new Database(path);
      old.exec(`CREATE TABLE chores (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, recurrence TEXT NOT NULL, effort INTEGER NOT NULL DEFAULT 2,
        est_minutes INTEGER NOT NULL DEFAULT 10, how_to TEXT NOT NULL DEFAULT '[]',
        completion_mode TEXT NOT NULL DEFAULT 'reply', timer_steps TEXT NOT NULL DEFAULT '[]', goal TEXT,
        active INTEGER NOT NULL DEFAULT 1);
        INSERT INTO chores (id, name, recurrence) VALUES ('old', 'Old chore', '{"every":"day"}');`);
      old.close();
      const store = new TodoStore(path);
      expect(store.getChore("old")).toMatchObject({ remind_at: null, remind_level: null });
      store.upsertChore({ ...store.getChore("old")!, remind_at: "10:00", remind_level: "loud" });
      expect(store.getChore("old")).toMatchObject({ remind_at: "10:00", remind_level: "loud" });
      new TodoStore(path); // a second open must not try to ALTER again
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
