import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Agent, cleanTitle, TITLE_MODEL } from "./agent.js";
import { staticConfig } from "./config.js";
import { Db } from "./db.js";
import type { CliRunInput } from "./cli.js";
import { pushPayload } from "./notify.js";
import { ARRIVE_HOME, MANUAL_PLAN, RecordingNotifier, pair, reply, scriptedClaude, setup, toolUse } from "./testkit.js";

const send = (id: string, text: string) => reply("tool_use", [toolUse(id, "send_message", { text, items: [] })]);
const done = () => reply("end_turn", []);
const post = (s: ReturnType<typeof setup>, headers: object, payload: object) => s.app.inject({ method: "POST", url: "/messages", headers, payload });

describe("migration", () => {
  it("puts old messages in one 'Earlier chat' and does not repeat", () => {
    const path = join(mkdtempSync(join(tmpdir(), "jeeves-db-")), "old.db");
    const old = new Database(path);
    old.exec(
      "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT NOT NULL, text TEXT NOT NULL, items TEXT, run_id INTEGER, created_at TEXT NOT NULL);" +
        "INSERT INTO messages (direction, text, created_at) VALUES ('out', 'a', '2026-01-01T00:00:00Z'), ('in', 'b', '2026-01-03T00:00:00Z');",
    );
    old.close();
    const db = new Db(path);
    const list = db.listConversations({ archived: false });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "Earlier chat", created_at: "2026-01-01T00:00:00Z", last_message_at: "2026-01-03T00:00:00Z", message_count: 2 });
    expect(db.getMessage(1)?.conversation_id).toBe(list[0].id);
    expect(db.getMessage(2)?.conversation_id).toBe(list[0].id);
    db.sql.close();
    const again = new Db(path);
    expect(again.listConversations({ archived: false })).toHaveLength(1);
    expect(again.sql.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual({ n: 1 });
  });
});

describe("routing", () => {
  it("creates a conversation for a message without one, and the reply lands in it", async () => {
    const s = setup({ script: [send("t1", "Hi"), done()] });
    const headers = await pair(s.app);
    const res = await post(s, headers, { text: "hello" });
    const id = res.json().conversation_id;
    expect(id).toEqual(expect.any(Number));
    await s.engine.idle();
    expect(s.db.lastEvent("message.received", "9999")?.payload).toMatchObject({ conversation_id: id, text: "hello" });
    expect(s.db.conversationMessages(id).map((m) => m.text)).toEqual(["hello", "Hi"]);
    expect(s.db.listConversations({ archived: false })).toHaveLength(1);
  });

  it("keeps messages in the named conversation, and 404s an unknown one", async () => {
    const s = setup({ script: [send("t1", "A1"), done(), send("t2", "A2"), done()] });
    const headers = await pair(s.app);
    const id = (await post(s, headers, { text: "one" })).json().conversation_id;
    await s.engine.idle();
    const second = await post(s, headers, { text: "two", conversation_id: id });
    expect(second.json().conversation_id).toBe(id);
    await s.engine.idle();
    expect(s.db.conversationMessages(id).map((m) => m.text)).toEqual(["one", "A1", "two", "A2"]);
    expect(s.db.listConversations({ archived: false })).toHaveLength(1);
    expect((await post(s, headers, { text: "x", conversation_id: 999 })).statusCode).toBe(404);
    const scoped = await s.app.inject({ method: "GET", url: `/messages?conversation_id=${id}&after=2`, headers });
    expect(scoped.json().messages.map((m: { text: string }) => m.text)).toEqual(["two", "A2"]);
    const all = await s.app.inject({ method: "GET", url: "/messages", headers });
    expect(all.json().messages).toHaveLength(4);
  });

  it("puts a whole non-chat run in one conversation, and the next run in another", async () => {
    const s = setup({ workflows: [ARRIVE_HOME, MANUAL_PLAN], script: [send("a", "one"), send("b", "two"), done(), send("c", "three"), done()] });
    await s.engine.runNow("arrive-home").done;
    await s.engine.runNow("manual-plan").done;
    const list = s.db.listConversations({ archived: false });
    expect(list).toHaveLength(2);
    const [second, first] = list;
    expect(s.db.conversationMessages(first.id).map((m) => m.text)).toEqual(["one", "two"]);
    expect(first.source_workflow_id).toBe("arrive-home");
    expect(second.source_workflow_id).toBe("manual-plan");
  });

  it("shares one conversation between message steps, nags and the failure notice of a run", async () => {
    const s = setup({
      workflows: [
        {
          id: "nagger",
          cooldown: 0,
          notify_on_failure: true,
          triggers: [{ event: "go" }],
          steps: [
            { id: "a", message: { text: "first" } },
            { id: "b", message: { text: "nag", repeat: { every_minutes: 10, max: 2 }, until: { event: "never.happens" } } },
          ],
        },
        {
          id: "breaker",
          cooldown: 0,
          notify_on_failure: true,
          triggers: [{ event: "break" }],
          steps: [
            { id: "m", message: { text: "before" } },
            { id: "x", call: { plugin: "todo", tool: "explode" } },
          ],
        },
      ],
    });
    s.engine.handleEvent("go", {}, null);
    await s.engine.idle();
    s.clock.now = new Date(s.clock.now.getTime() + 11 * 60_000);
    await s.engine.runDueJobs();
    expect(s.db.listConversations({ archived: false })).toHaveLength(1);
    expect(s.db.listConversations({ archived: false })[0].message_count).toBe(3);
    s.engine.handleEvent("break", {}, null);
    await s.engine.idle();
    const list = s.db.listConversations({ archived: false });
    expect(list).toHaveLength(2);
    expect(s.db.conversationMessages(list[0].id).map((m) => m.text)).toEqual(["before", expect.stringContaining("failed at x")]);
  });

  it("sends a bare agent message to a new conversation each time", async () => {
    const s = setup();
    await s.agent.sendMessage("a", []);
    await s.agent.sendMessage("b", []);
    expect(s.db.listConversations({ archived: false })).toHaveLength(2);
  });

  it("sends the 'nothing answered' notice to the user's conversation", async () => {
    const s = setup({ workflows: [ARRIVE_HOME] });
    const headers = await pair(s.app);
    const id = (await post(s, headers, { text: "hello?" })).json().conversation_id;
    await s.engine.idle();
    expect(s.db.conversationMessages(id).map((m) => m.text)).toEqual(["hello?", expect.stringContaining("Nothing answered")]);
  });

  it("does not create conversations in a dry run", async () => {
    const s = setup({ workflows: [MANUAL_PLAN], script: [send("a", "one"), done()] });
    await s.engine.runNow("manual-plan", { dryRun: true }).done;
    expect(s.db.sql.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual({ n: 0 });
  });
});

describe("history scoping", () => {
  it("shows every earlier message of this conversation, oldest first, and none of another", async () => {
    const s = setup({ script: [done()] });
    const headers = await pair(s.app);
    const a = s.db.createConversation({ now: s.clock.now }).id;
    const b = s.db.createConversation({ now: s.clock.now }).id;
    for (let i = 0; i < 12; i++) s.db.addMessage(i % 2 ? "out" : "in", `a${i}`, null, null, s.clock.now, { conversation_id: a });
    s.db.addMessage("in", "other-thread", null, null, s.clock.now, { conversation_id: b });
    await post(s, headers, { text: "now", conversation_id: a });
    await s.engine.idle();
    const input = JSON.stringify(s.claude.requests[0].messages[0].content);
    expect(input).toContain("Conversation so far:");
    const seen = [...input.matchAll(/a(\d+)/g)].map((m) => Number(m[1]));
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(input).not.toContain("other-thread");
    expect(input).not.toContain("User: now");
  });
});

describe("follow-ups", () => {
  it("land in the conversation of the run, and bring an archived one back", async () => {
    const s = setup({
      script: [reply("tool_use", [toolUse("f", "schedule_followup", { in_minutes: 30, message: "Check in", plugin: null, item_id: null })]), done()],
    });
    const headers = await pair(s.app);
    const id = (await post(s, headers, { text: "remind me" })).json().conversation_id;
    await s.engine.idle();
    expect(s.db.pendingJobs("followup")[0].payload).toMatchObject({ workflow_run_id: expect.any(Number) });
    await s.app.inject({ method: "PATCH", url: `/conversations/${id}`, headers, payload: { archived: true } });
    expect(s.db.getConversation(id)?.archived_at).not.toBeNull();
    s.clock.now = new Date(s.clock.now.getTime() + 31 * 60_000);
    await s.engine.runDueJobs();
    expect(s.db.conversationMessages(id).map((m) => m.text)).toEqual(["remind me", "Check in"]);
    expect(s.db.getConversation(id)?.archived_at).toBeNull();
    expect(s.db.listConversations({ archived: false })).toHaveLength(1);
  });
});

describe("conversation API", () => {
  it("archives, renames, revives on new messages and validates", async () => {
    const s = setup({ script: [send("r", "reply"), done()] });
    const headers = await pair(s.app);
    const id = s.db.createConversation({ now: s.clock.now }).id;
    s.db.addMessage("out", "hi", null, null, s.clock.now, { conversation_id: id });
    const get = async (archived: boolean) =>
      (await s.app.inject({ method: "GET", url: `/conversations?archived=${archived}`, headers })).json().conversations as { id: number; title: string | null; first_line: string }[];
    expect(await get(false)).toMatchObject([{ id, first_line: "hi", title: null }]);
    const patched = await s.app.inject({ method: "PATCH", url: `/conversations/${id}`, headers, payload: { archived: true, title: "Mine" } });
    expect(patched.json()).toMatchObject({ id, title: "Mine" });
    expect(await get(false)).toEqual([]);
    expect(await get(true)).toMatchObject([{ id }]);
    await post(s, headers, { text: "back", conversation_id: id });
    await s.engine.idle();
    expect(await get(true)).toEqual([]);
    expect(await get(false)).toMatchObject([{ id, title: "Mine" }]);
    for (const payload of [{ title: "" }, { title: "x".repeat(81) }, { archived: "yes" }]) {
      expect((await s.app.inject({ method: "PATCH", url: `/conversations/${id}`, headers, payload })).statusCode).toBe(400);
    }
    expect((await s.app.inject({ method: "PATCH", url: "/conversations/999", headers, payload: { title: "x" } })).statusCode).toBe(404);
    const made = await s.app.inject({ method: "POST", url: "/conversations", headers, payload: { title: "Empty" } });
    expect(made.json().title).toBe("Empty");
    expect(await get(false)).toHaveLength(1); // empty conversations stay out of the list
  });
});

describe("titles", () => {
  it("sets a cleaned title once per conversation", async () => {
    const calls: string[] = [];
    const s = setup({ script: [send("a", "x"), done(), send("b", "y"), done()], titles: async (t) => (calls.push(t), '"Washing up plans."') });
    const headers = await pair(s.app);
    const id = (await post(s, headers, { text: "the dishes" })).json().conversation_id;
    await s.engine.idle();
    await post(s, headers, { text: "more", conversation_id: id });
    await s.engine.idle();
    expect(calls).toEqual(["the dishes"]);
    expect(s.db.getConversation(id)?.title).toBe("Washing up plans");
  });

  it("does not overwrite a rename made while generating", async () => {
    let release!: (t: string) => void;
    const s = setup({ script: [done()], titles: () => new Promise((r) => (release = r)) });
    const headers = await pair(s.app);
    const id = (await post(s, headers, { text: "hi" })).json().conversation_id;
    s.db.updateConversation(id, { title: "Mine" });
    release("Generated");
    await s.engine.idle();
    expect(s.db.getConversation(id)?.title).toBe("Mine");
  });

  it("leaves the title null when none comes back, and the list has a first line", async () => {
    const s = setup({ script: [done()] });
    const headers = await pair(s.app);
    const id = (await post(s, headers, { text: "first line\nsecond" })).json().conversation_id;
    await s.engine.idle();
    expect(s.db.getConversation(id)?.title).toBeNull();
    expect(s.db.listConversations({ archived: false })[0].first_line).toBe("first line");
  });

  it("is skipped when the daily cap is reached", async () => {
    const calls: string[] = [];
    const s = setup({ globals: { max_runs_per_day: 1 }, script: [done()], titles: async (t) => (calls.push(t), "T") });
    const headers = await pair(s.app);
    await post(s, headers, { text: "one" }); // chat-reply uses the day's only run
    await s.engine.idle();
    await post(s, headers, { text: "two" });
    await s.engine.idle();
    expect(calls.length).toBeLessThanOrEqual(1);
    const second = s.db.listConversations({ archived: false })[0];
    expect(second.title).toBeNull();
  });

  it("the default API path records a title run that does not count toward the cap", async () => {
    const db = new Db();
    const claude = scriptedClaude([reply("end_turn", [{ type: "text", text: "Dishes and laundry." }])]);
    const config = staticConfig({ timezone: "Europe/London" }, []);
    const now = () => new Date("2026-11-14T12:00:00Z");
    const agent = new Agent({ db, config, plugins: { listTools: async () => [], call: async () => ({ text: "", isError: true }) }, notifier: new RecordingNotifier(), create: claude.create, now });
    const msg = await agent.sendMessage("I need to do dishes and laundry", []);
    await Promise.all(agent.pendingTitles);
    expect(db.getConversation(msg.conversation_id!)?.title).toBe("Dishes and laundry");
    expect(claude.requests[0]).toMatchObject({ model: TITLE_MODEL, tools: [], max_tokens: 50 });
    expect(db.recentRuns()[0]).toMatchObject({ kind: "title", status: "ok", input_tokens: 100 });
    expect(db.runsOn("2026-11-14")).toBe(0);
  });

  it("the CLI path uses the final text", async () => {
    const db = new Db();
    const seen: CliRunInput[] = [];
    const cli = async (i: CliRunInput) => (seen.push(i), { transcript: [], inputTokens: 5, outputTokens: 2, finalText: "Evening plan" });
    const config = staticConfig({ timezone: "Europe/London" }, []);
    const agent = new Agent({ db, config, plugins: { listTools: async () => [], call: async () => ({ text: "", isError: true }) }, notifier: new RecordingNotifier(), cli });
    const msg = await agent.sendMessage("plan my evening", []);
    await Promise.all(agent.pendingTitles);
    expect(db.getConversation(msg.conversation_id!)?.title).toBe("Evening plan");
    expect(seen[0]).toMatchObject({ model: TITLE_MODEL, effort: "low", tools: [], maxTurns: 1 });
  });

  it("cleans titles", () => {
    expect(cleanTitle(' "Hello there!" \nextra')).toBe("Hello there");
    expect(cleanTitle("x".repeat(100))).toHaveLength(60);
    expect(cleanTitle('  ""  ')).toBeNull();
  });
});

describe("push payload", () => {
  it("carries the conversation id", () => {
    const db = new Db();
    const c = db.createConversation();
    const m = db.addMessage("out", "x", null, null, new Date(), { conversation_id: c.id });
    expect(pushPayload(m)).toMatchObject({ conversation_id: c.id });
  });
});
