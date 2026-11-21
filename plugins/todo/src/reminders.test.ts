import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    return true;
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
    expect(out[0].items?.map((i) => i.item_id).sort()).toEqual(open.map((t) => String(t.id)).sort());
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

  it("drops the update reminder once everything is done", () => {
    const { store, scheduler } = setup();
    expect(scheduler.computeDaily().map((r) => r.key.split(":")[0])).toEqual(["due", "update"]);
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

  it("sets dirty on failure and re-sends next time", async () => {
    const { client, scheduler } = setup();
    client.ok = false;
    await scheduler.sync();
    expect(scheduler.dirty).toBe(true);
    client.ok = true;
    await scheduler.sync();
    expect(scheduler.dirty).toBe(false);
    expect(client.groups).toHaveLength(1);

  });

  it("serialises overlapping syncs and re-runs once", async () => {
    const { client, scheduler } = setup();
    await Promise.all([scheduler.sync(), scheduler.sync(), scheduler.sync()]);
    expect(client.calls).toEqual(["group:daily", "group:daily"]);
  });
});

describe("reminder syncs over MCP and routes", () => {
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

  it("start, complete and skip only refresh the daily set (no per-task reminders)", async () => {
    const store = new TodoStore();
    seedFromFile(store, "chores.example.yaml");
    const client = new FakeClient();
    const { call } = await connect(client, store);
    const laundry = store.listDue("2026-11-15", SUNDAY).find((t) => t.chore_id === "laundry")!;

    expect(await call("start_task", { task_id: laundry.id })).toMatchObject({ id: laundry.id, state: "started" });
    expect(client.calls).toEqual(["group:daily"]);
    await call("complete_task", { task_id: laundry.id });
    await call("skip_task", { task_id: laundry.id });
    expect(client.calls).toEqual(["group:daily", "group:daily", "group:daily"]);
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

    const chore = { name: "Water the plants", recurrence: { every: "day" } };
    let res = await app.inject({ method: "POST", url: "/jeeves/ui/api/chores", headers: auth, payload: chore });
    expect(res.statusCode).toBe(201);
    expect(syncs()).toBe(2);

    res = await app.inject({
      method: "POST",
      url: "/jeeves/ui/api/chores/water-the-plants",
      headers: auth,
      payload: { ...chore, effort: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(syncs()).toBe(3);

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

describe("legacy chore fields", () => {
  it("are accepted from the API and the seed, dropped, and warned about", async () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new TodoStore();
      const app = buildApp({ store, token: "secret", timeZone: TZ });
      const auth = { authorization: "Bearer secret" };
      const body = {
        name: "Laundry",
        recurrence: { every: "week", on: ["mon"] },
        completion_mode: "timer",
        timer_steps: [{ after_minutes: 75, message: "Dryer" }],
        remind_at: "19:15",
        remind_level: "alarm",
      };
      const res = await app.inject({ method: "POST", url: "/jeeves/ui/api/chores", headers: auth, payload: body });
      expect(res.statusCode).toBe(201);
      expect(res.json().chore).toMatchObject({ completion_mode: "reply" });
      expect(res.json().chore).not.toHaveProperty("timer_steps");
      expect(res.json().chore).not.toHaveProperty("remind_at");

      const yaml = join(dir, "c.yaml");
      writeFileSync(yaml, 'chores:\n  - { id: x, name: X, recurrence: { every: day }, completion_mode: timer, timer_steps: [{ after_minutes: 5, message: hi }], remind_at: "08:05" }\n');
      const s2 = new TodoStore();
      seedFromFile(s2, yaml);
      expect(s2.getChore("x")).toMatchObject({ completion_mode: "reply" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Chore x has timer_steps"));
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("old rows load as reply chores, are flagged, and are cleaned when saved", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-"));
    try {
      const path = join(dir, "old.db");
      const old = new Database(path);
      old.exec(`CREATE TABLE chores (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, recurrence TEXT NOT NULL, effort INTEGER NOT NULL DEFAULT 2,
        est_minutes INTEGER NOT NULL DEFAULT 10, how_to TEXT NOT NULL DEFAULT '[]',
        completion_mode TEXT NOT NULL DEFAULT 'reply', timer_steps TEXT NOT NULL DEFAULT '[]', goal TEXT,
        active INTEGER NOT NULL DEFAULT 1);
        INSERT INTO chores (id, name, recurrence, completion_mode, timer_steps) VALUES ('old', 'Old chore', '{"every":"day"}', 'timer', '[{"after_minutes":5,"message":"x"}]');`);
      old.close();
      const store = new TodoStore(path);
      expect(store.getChore("old")).toMatchObject({ completion_mode: "reply" });
      expect(store.legacyTimerChores()).toEqual(["old"]);
      store.upsertChore(store.getChore("old")!);
      expect(store.legacyTimerChores()).toEqual([]);
      new TodoStore(path); // a second open must not try to ALTER again
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
