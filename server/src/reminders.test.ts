import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { Db } from "./db.js";
import { McpPluginHost } from "./plugins.js";
import { setup } from "./testkit.js";
import { activityFeed, upcoming } from "./timeline.js";

const NOW = new Date("2026-11-14T12:00:00Z");
const PLUGINS = [
  { name: "todo", url: "http://127.0.0.1:1/mcp", token_env: "TODO_TOKEN" },
  { name: "other", url: "http://127.0.0.1:2/mcp", token_env: "OTHER_TOKEN" },
];
const todo = { authorization: "Bearer todo-token" };
const other = { authorization: "Bearer other-token" };

const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

function world() {
  const host = new McpPluginHost(PLUGINS, { env: { TODO_TOKEN: "todo-token", OTHER_TOKEN: "other-token" } });
  const s = setup({ store: true, globals: { plugins: PLUGINS }, plugins: host, clock: { now: NOW } });
  const put = (key: string, body: Record<string, unknown>, headers = todo) =>
    s.app.inject({ method: "PUT", url: `/plugin-reminders/${key}`, headers, payload: { level: "notify", text: "Hi", ...body } });
  const group = (g: string, reminders: Record<string, unknown>[], headers = todo) =>
    s.app.inject({ method: "PUT", url: `/plugin-reminders?group=${g}`, headers, payload: { reminders: reminders.map((r) => ({ level: "notify", text: "Hi", ...r })) } });
  const pending = () => s.db.pendingJobs("reminder");
  return { s, put, group, pending };
}

describe("plugin reminders: PUT", () => {
  it("creates a reminder, updates it in place, and the unique index rejects a raw duplicate", async () => {
    const { s, put, pending } = world();
    const first = await put("due:1", { at: at(60), text: "One" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ key: "due:1", status: "scheduled", at: at(60) });
    const second = await put("due:1", { at: at(90), text: "Two", level: "alarm" });
    expect(second.json()).toMatchObject({ status: "scheduled", job_id: first.json().job_id });
    expect(pending()).toHaveLength(1);
    expect(pending()[0]).toMatchObject({ run_at: at(90), plugin: "todo", reminder_key: "due:1", payload: { text: "Two", level: "alarm", items: [] } });
    expect((await put("due:1", { at: at(90), text: "Two", level: "alarm" })).json().status).toBe("unchanged");
    expect(() =>
      s.db.sql.prepare("INSERT INTO jobs (run_at, kind, payload, plugin, reminder_key) VALUES (?, 'reminder', '{}', 'todo', 'due:1')").run(at(5)),
    ).toThrow(/UNIQUE/);
  });

  it("validates the body and the key", async () => {
    const { put } = world();
    expect((await put("due:1", { at: "tomorrow" })).statusCode).toBe(400);
    expect((await put("due:1", { at: at(5), level: "siren" })).statusCode).toBe(400);
    expect((await put("due:1", { at: at(5), text: "" })).statusCode).toBe(400);
    expect((await put("bad key!", { at: at(5) })).statusCode).toBe(400);
  });

  it("refuses a time more than 5 minutes ago and fires one within 5 minutes straight away", async () => {
    const { s, put } = world();
    const late = await put("a", { at: at(-6) });
    expect(late.statusCode).toBe(400);
    expect(late.json().error).toBe("too_late");
    const recent = await put("b", { at: at(-2), text: "Now", level: "loud", items: [{ task_id: 4, title: "Dishes" }] });
    expect(recent.statusCode).toBe(200);
    expect(s.notifier.sent).toHaveLength(1);
    expect(s.notifier.sent[0]).toMatchObject({ text: "Now", level: "loud", due_at: at(-2), items: [{ plugin: "todo", item_id: "4", title: "Dishes", steps: [] }] });
  });

  it("does not re-arm a reminder that fired or that the user cancelled, but a new time schedules again", async () => {
    const { s, put, pending } = world();
    await put("x", { at: at(-1) }); // fires at once
    expect((await put("x", { at: at(-1) })).json()).toMatchObject({ status: "already_done", job_id: null });
    expect((await put("x", { at: at(30) })).json().status).toBe("scheduled");

    const y = await put("y", { at: at(60) });
    expect((await s.app.inject({ method: "DELETE", url: `/jobs/${y.json().job_id}`, headers: await pairHeaders(s) })).statusCode).toBe(200);
    expect((await put("y", { at: at(60) })).json().status).toBe("already_done");
    expect(pending().map((j) => j.reminder_key)).toEqual(["x"]);
    expect((await put("y", { at: at(61) })).json().status).toBe("scheduled");
  });
});

describe("plugin reminders: group replace", () => {
  it("cancels missing keys, keeps others, and leaves other groups and plugins alone", async () => {
    const { s, put, group, pending } = world();
    await group("daily", [{ key: "a", at: at(60) }, { key: "b", at: at(70) }, { key: "c", at: at(80) }]);
    await group("weekly", [{ key: "w", at: at(90) }]);
    await put("other-key", { at: at(100) }, other);
    await group("daily", [{ key: "a", at: at(60) }, { key: "c", at: at(85) }], other); // other plugin's daily group
    const before = pending().find((j) => j.reminder_key === "a")!.id;
    const res = await group("daily", [{ key: "a", at: at(60) }, { key: "c", at: at(81) }]);
    expect(res.json()).toEqual({ scheduled: ["c"], unchanged: ["a"], dropped: [], cancelled: ["b"] });
    expect(pending().find((j) => j.plugin === "todo" && j.reminder_key === "a")!.id).toBe(before);
    expect(pending().map((j) => `${j.plugin}:${j.reminder_key}`).sort()).toEqual(
      ["other:a", "other:c", "other:other-key", "todo:a", "todo:c", "todo:w"],
    );
    const cancelled = s.db.sql.prepare("SELECT cancel_reason FROM jobs WHERE reminder_key = 'b'").get() as { cancel_reason: string };
    expect(cancelled.cancel_reason).toBe("replaced");
  });

  it("silently drops items that are too late and leaves an existing pending row for them alone", async () => {
    const { group, pending } = world();
    await group("daily", [{ key: "a", at: at(60) }]);
    const res = await group("daily", [{ key: "a", at: at(-30) }, { key: "n", at: at(-10) }, { key: "z", at: at(10) }]);
    expect(res.json()).toEqual({ scheduled: ["z"], unchanged: [], dropped: ["a", "n"], cancelled: [] });
    expect(pending().map((j) => [j.reminder_key, j.run_at])).toEqual([["z", at(10)], ["a", at(60)]]);
  });

  it("rejects duplicate keys and a missing group", async () => {
    const { s, group } = world();
    expect((await group("daily", [{ key: "a", at: at(5) }, { key: "a", at: at(6) }])).statusCode).toBe(400);
    expect((await s.app.inject({ method: "PUT", url: "/plugin-reminders", headers: todo, payload: { reminders: [] } })).statusCode).toBe(400);
  });
});

describe("plugin reminders: DELETE and auth", () => {
  it("cancels and is idempotent", async () => {
    const { s, put, pending } = world();
    await put("k", { at: at(60) });
    const del = () => s.app.inject({ method: "DELETE", url: "/plugin-reminders/k", headers: todo });
    expect((await del()).json()).toEqual({ cancelled: true });
    expect((await del()).json()).toEqual({ cancelled: false });
    expect(pending()).toEqual([]);
  });

  it("needs the plugin's own token; a device token does not work", async () => {
    const { s, put } = world();
    expect((await put("k", { at: at(60) }, { authorization: "Bearer nope" })).statusCode).toBe(401);
    expect((await s.app.inject({ method: "PUT", url: "/plugin-reminders/k", payload: { at: at(60), level: "notify", text: "x" } })).statusCode).toBe(401);
    expect((await put("k", { at: at(60) }, await pairHeaders(s))).statusCode).toBe(401);
    expect((await s.app.inject({ method: "DELETE", url: "/plugin-reminders/k", headers: await pairHeaders(s) })).statusCode).toBe(401);
  });
});

async function pairHeaders(s: ReturnType<typeof world>["s"]) {
  const res = await s.app.inject({ method: "POST", url: "/pair", payload: { code: "pair-me-please", name: "Pixel" } });
  return { authorization: `Bearer ${res.json().token}` };
}

describe("plugin reminders: firing", () => {
  it("creates a message with level, due_at and job_id, notifies, and records activity", async () => {
    const { s, put, pending } = world();
    const r = await put("timer:3:1", { at: at(10), text: "Move it", level: "alarm", items: [{ task_id: 3, title: "Laundry", minutes: 5, steps: ["Dryer"] }] });
    s.clock.now = new Date(NOW.getTime() + 11 * 60_000);
    await s.engine.runDueJobs();
    expect(pending()).toEqual([]);
    expect(s.notifier.sent).toHaveLength(1);
    const m = s.notifier.sent[0];
    expect(m).toMatchObject({ direction: "out", text: "Move it", level: "alarm", due_at: at(10), job_id: r.json().job_id });
    expect(s.db.getMessage(m.id)).toMatchObject({ level: "alarm", due_at: at(10), job_id: r.json().job_id });
    const feed = activityFeed({ db: s.db, config: s.config }, { kind: "reminder" });
    expect(feed.items).toMatchObject([{ kind: "reminder_fired", subject: "todo", detail: { key: "timer:3:1", level: "alarm", message_id: m.id } }]);
    expect(activityFeed({ db: s.db, config: s.config }).items.map((i) => i.kind)).toContain("reminder_fired");
  });

  it("pushes level and due_at in the push payload", async () => {
    const { pushPayload } = await import("./notify.js");
    const db = new Db();
    const m = db.addMessage("out", "x", null, null, NOW, { level: "loud", due_at: at(0), job_id: 1 });
    expect(pushPayload(m)).toEqual({ message_id: m.id, text: "x", items: [], level: "loud", due_at: at(0) });
    expect(pushPayload(db.addMessage("out", "y"))).toEqual({ message_id: 2, text: "y", items: [] });
  });
});

describe("plugin reminders: snooze", () => {
  it("requeues under the same key and survives a later group sync with the original time", async () => {
    const { s, group, pending } = world();
    const headers = await pairHeaders(s);
    await group("daily", [{ key: "due:d", at: at(10), text: "Chores", level: "loud" }]);
    s.clock.now = new Date(NOW.getTime() + 11 * 60_000);
    await s.engine.runDueJobs();
    const msg = s.notifier.sent[0];
    const snooze = await s.app.inject({ method: "POST", url: `/messages/${msg.id}/snooze`, headers, payload: { minutes: 10 } });
    expect(snooze.statusCode).toBe(200);
    const snoozedAt = new Date(s.clock.now.getTime() + 10 * 60_000).toISOString();
    expect(snooze.json()).toMatchObject({ at: snoozedAt });
    expect(pending()).toHaveLength(1);
    expect(pending()[0]).toMatchObject({ run_at: snoozedAt, plugin: "todo", reminder_key: "due:d", reminder_group: "daily", payload: { text: "Chores", level: "loud", snoozed_from: at(10) } });

    // The plugin re-syncs the original time (now within the grace window): the snooze stays.
    s.clock.now = new Date(NOW.getTime() + 12 * 60_000);
    const res = await group("daily", [{ key: "due:d", at: at(10), text: "Chores (updated)", level: "loud" }]);
    expect(res.json()).toMatchObject({ unchanged: ["due:d"], scheduled: [] });
    expect(pending()[0]).toMatchObject({ run_at: snoozedAt, payload: { text: "Chores (updated)", snoozed_from: at(10) } });

    // The snoozed one fires, then can be snoozed again and still remembers the original time.
    s.clock.now = new Date(new Date(snoozedAt).getTime() + 1000);
    await s.engine.runDueJobs();
    expect(s.notifier.sent).toHaveLength(2);
    expect(s.notifier.sent[1].due_at).toBe(snoozedAt);
    await s.app.inject({ method: "POST", url: `/messages/${s.notifier.sent[1].id}/snooze`, headers, payload: { minutes: 5 } });
    expect(pending()[0].payload.snoozed_from).toBe(at(10));
    // Re-sending the original time after everything fired does not re-arm it.
    await s.engine.runDueJobs();
    expect(s.db.getJob(1)).toBeDefined();
  });

  it("rejects non-reminder messages and unknown ids", async () => {
    const { s } = world();
    const headers = await pairHeaders(s);
    const plain = s.db.addMessage("out", "plain");
    const res = await s.app.inject({ method: "POST", url: `/messages/${plain.id}/snooze`, headers, payload: { minutes: 10 } });
    expect(res.statusCode).toBe(400);
    expect((await s.app.inject({ method: "POST", url: "/messages/999/snooze", headers, payload: { minutes: 10 } })).statusCode).toBe(404);
    expect((await s.app.inject({ method: "POST", url: `/messages/${plain.id}/snooze`, headers, payload: { minutes: 0 } })).statusCode).toBe(400);
    const followup = s.db.addJob(NOW, "followup", { message: "x" });
    const msg = s.db.addMessage("out", "f", null, null, NOW, { job_id: followup });
    expect((await s.app.inject({ method: "POST", url: `/messages/${msg.id}/snooze`, headers, payload: { minutes: 10 } })).statusCode).toBe(400);
  });
});

describe("plugin reminders: timeline", () => {
  it("lists pending reminders and DELETE /jobs/:id cancels one with reason user", async () => {
    const { s, put, pending } = world();
    const headers = await pairHeaders(s);
    const r = await put("chore:7", { at: at(60), text: "Bins", level: "loud", items: [{ task_id: 7, title: "Bins" }] });
    await put("due:d", { at: at(30), text: "Chores", items: [{ item_id: "1", title: "a" }, { item_id: "2", title: "b" }] });
    const up = upcoming({ db: s.db, config: s.config }, 24, NOW).items.filter((i) => i.kind === "reminder");
    expect(up).toEqual([
      { kind: "reminder", at: at(30), job_id: expect.any(Number), plugin: "todo", key: "due:d", level: "notify", text: "Chores", item_id: null },
      { kind: "reminder", at: at(60), job_id: r.json().job_id, plugin: "todo", key: "chore:7", level: "loud", text: "Bins", item_id: "7" },
    ]);
    const http = (await s.app.inject({ method: "GET", url: "/timeline/upcoming?hours=24", headers })).json();
    expect(http.items.filter((i: { kind: string }) => i.kind === "reminder")).toHaveLength(2);
    expect((await s.app.inject({ method: "DELETE", url: `/jobs/${r.json().job_id}`, headers })).statusCode).toBe(200);
    expect(pending().map((j) => j.reminder_key)).toEqual(["due:d"]);
    expect(s.db.getJob(r.json().job_id)).toMatchObject({ cancel_reason: "user" });
  });
});

describe("database migration", () => {
  it("adds the reminder columns and index to an old database", () => {
    const path = join(mkdtempSync(join(tmpdir(), "jeeves-db-")), "old.db");
    const old = new Database(path);
    old.exec(
      "CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_at TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', done_at TEXT);" +
        "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT NOT NULL, text TEXT NOT NULL, items TEXT, run_id INTEGER, created_at TEXT NOT NULL);" +
        "INSERT INTO messages (direction, text, created_at) VALUES ('out', 'old', '2026-01-01T00:00:00Z');",
    );
    old.close();
    const db = new Db(path);
    expect(db.getMessage(1)).toMatchObject({ text: "old", level: null, due_at: null, job_id: null });
    expect(db.upsertReminder("todo", "k", null, new Date(NOW.getTime() + 60_000), { text: "x", level: "notify", items: [] }).status).toBe("scheduled");
    expect(() => db.sql.prepare("INSERT INTO jobs (run_at, kind, plugin, reminder_key) VALUES ('t', 'reminder', 'todo', 'k')").run()).toThrow(/UNIQUE/);
  });
});
