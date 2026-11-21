import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { buildApp } from "./app.js";
import type { CliRunInput, CliRunner } from "./cli.js";
import { staticConfig } from "./config.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { ARRIVE_HOME, CHAT_REPLY, FakeTodo, MANUAL_PLAN, pair, RecordingNotifier, reply, setup, toolUse } from "./testkit.js";

describe("arrive home, end to end", () => {
  it("plans the evening and pushes an easiest-first list", async () => {
    const s = setup({
      script: [
        reply("tool_use", [toolUse("t1", "todo__list_due_tasks", {})]),
        reply("tool_use", [
          toolUse("t2", "send_message", {
            text: "Welcome home! Two quick ones tonight.",
            items: [
              { plugin: "todo", item_id: "1", title: "Wash the dishes", steps: ["Hot water", "Glasses first"], minutes: 10 },
              { plugin: "todo", item_id: "2", title: "Start the laundry", steps: ["Sort", "40 degrees"], minutes: 15 },
            ],
          }),
        ]),
        reply("end_turn", [{ type: "text", text: "Sent." }]),
      ],
    });
    const headers = await pair(s.app);

    await s.app.inject({ method: "POST", url: "/events", headers, payload: { type: "wifi.disconnected", payload: { ssid: "home" } } });
    s.clock.now = new Date("2026-11-14T18:20:00Z");
    const res = await s.app.inject({ method: "POST", url: "/events", headers, payload: { type: "wifi.connected", payload: { ssid: "home" } } });
    expect(res.json().rules).toEqual([{ id: "arrive-home", fired: true, reason: "conditions met" }]);
    expect(res.json().workflows).toEqual([{ workflow_id: "arrive-home", fired: true, reason: "conditions met" }]);
    await s.engine.idle();

    // The request uses the configured model, effort and server-side refusal fallbacks.
    const first = s.claude.requests[0];
    expect(first).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "low" } });
    expect(first.tools?.map((t) => (t as { name: string }).name)).toContain("todo__list_due_tasks");
    expect(JSON.stringify(first.messages[0].content)).toContain("sat 2026-11-14, 18:20");

    expect(s.notifier.sent).toHaveLength(1);
    expect(s.notifier.sent[0].items?.map((i) => i.item_id)).toEqual(["1", "2"]);
    // Items about a plugin's item get that plugin's buttons (its manifest item_actions).
    expect(s.notifier.sent[0].items?.[0].actions?.map((a) => a.id)).toEqual(["done", "skip"]);

    const msgs = await s.app.inject({ method: "GET", url: "/messages?after=0", headers });
    expect(msgs.json().messages[0].text).toBe("Welcome home! Two quick ones tonight.");

    const runs = s.db.recentRuns() as { status: string; input_tokens: number; workflow_run_id: number; rule_id: string }[];
    expect(runs[0]).toMatchObject({ status: "ok", input_tokens: 300, rule_id: "arrive-home" });

    // It ran as a workflow, with one Claude step linked to the run.
    const [wr] = s.db.workflowRuns();
    expect(wr).toMatchObject({ workflow_id: "arrive-home", trigger: "event", status: "ok" });
    expect(runs[0].workflow_run_id).toBe(wr.id);
    expect(s.db.stepRuns(wr.id)).toMatchObject([{ step_id: "plan", type: "claude", status: "ok", output: { messages_sent: 1 } }]);
  });

  it("does not call Claude when no workflow fires", async () => {
    const s = setup();
    const headers = await pair(s.app);
    s.clock.now = new Date("2026-11-14T10:00:00Z");
    await s.app.inject({ method: "POST", url: "/events", headers, payload: { type: "wifi.connected", payload: { ssid: "home" } } });
    await s.engine.idle();
    expect(s.claude.requests).toHaveLength(0);
    expect(s.db.workflowRuns()).toHaveLength(0);
  });
});

describe("tasks and follow-ups", () => {
  it("a follow-up about a plugin item carries its buttons, and resolving the item cancels it", async () => {
    const s = setup({
      script: [
        reply("tool_use", [toolUse("t1", "schedule_followup", { in_minutes: 45, message: "Move it to the dryer", plugin: "todo", item_id: "2" })]),
        reply("tool_use", [toolUse("t2", "schedule_followup", { in_minutes: 45, message: "Check the oven", plugin: null, item_id: null })]),
        reply("end_turn", []),
      ],
    });
    const headers = await pair(s.app);
    await s.app.inject({ method: "POST", url: "/messages", headers, payload: { text: "laundry is in" } });
    await s.engine.idle();

    s.clock.now = new Date("2026-11-14T12:46:00Z");
    await s.engine.runDueJobs();
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Move it to the dryer", "Check the oven"]);
    expect(s.notifier.sent[0].items).toEqual([
      { plugin: "todo", item_id: "2", title: "Move it to the dryer", steps: [], actions: [{ id: "done", label: "Done", style: "primary" }, { id: "skip", label: "Skip" }] },
    ]);
    expect(s.notifier.sent[1].items).toBeNull();
  });

  it("cancels only the follow-ups about a resolved item", () => {
    const s = setup();
    s.db.addJob(new Date("2026-11-14T13:00:00Z"), "followup", { message: "a", plugin: "todo", item_id: "2" });
    s.db.addJob(new Date("2026-11-14T13:00:00Z"), "followup", { message: "b", plugin: "todo", item_id: "3" });
    s.db.addJob(new Date("2026-11-14T13:00:00Z"), "followup", { message: "c", plugin: "other", item_id: "2" });
    expect(s.db.cancelJobsForItem("todo", "2", s.clock.now)).toBe(1);
    expect(s.db.pendingJobs("followup").map((j) => j.payload.message)).toEqual(["b", "c"]);
  });

  it("a free-text reply marks tasks done through Claude", async () => {
    const s = setup({
      script: [
        reply("tool_use", [toolUse("t1", "todo__complete_task", { task_id: 1 })]),
        reply("tool_use", [toolUse("t2", "send_message", { text: "Nice one, dishes ticked off.", items: [] })]),
        reply("end_turn", []),
      ],
    });
    const headers = await pair(s.app);
    await s.app.inject({ method: "POST", url: "/messages", headers, payload: { text: "done with the dishes" } });
    await s.engine.idle();
    expect(s.plugins.calls).toContainEqual({ plugin: "todo", tool: "complete_task", args: { task_id: 1 } });
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Nice one, dishes ticked off."]);
  });

  it("records a refusal without messaging the phone", async () => {
    const s = setup({ script: [reply("refusal", [])] });
    const headers = await pair(s.app);
    await s.app.inject({ method: "POST", url: "/plan", headers });
    await s.engine.idle();
    // The refusal fails the workflow step, which notifies once about the failure (not the plan).
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Workflow manual-plan failed at plan: Claude refused"]);
    expect((s.db.recentRuns()[0] as { status: string }).status).toBe("refused");
  });
});

describe("auth", () => {
  it("rejects a wrong pairing code and missing tokens", async () => {
    const s = setup();
    expect((await s.app.inject({ method: "POST", url: "/pair", payload: { code: "nope", name: "x" } })).statusCode).toBe(403);
    expect((await s.app.inject({ method: "GET", url: "/messages" })).statusCode).toBe(401);
  });
});

describe("Claude Code CLI backend", () => {
  /** Scripted CLI: runs the given steps against Jeeves's tools, then returns the result. */
  function cliSetup(steps: (input: CliRunInput) => Promise<{ finalText?: string; error?: string }>) {
    const clock = { now: new Date("2026-11-14T18:20:00Z") };
    const now = () => clock.now;
    const db = new Db();
    const config = staticConfig({ timezone: "Europe/London" }, [ARRIVE_HOME, { ...MANUAL_PLAN, notify_on_failure: false }, CHAT_REPLY]);
    const plugins = new FakeTodo(clock);
    const notifier = new RecordingNotifier();
    const inputs: CliRunInput[] = [];
    const cli: CliRunner = async (input) => {
      inputs.push(input);
      const out = await steps(input);
      return { transcript: [], inputTokens: 120, outputTokens: 30, finalText: out.finalText ?? "", ...(out.error ? { error: out.error } : {}) };
    };
    const agent = new Agent({ db, config, plugins, notifier, cli, now });
    const engine = new Engine(db, config, plugins, agent, now);
    return { db, plugins, notifier, engine, inputs };
  }

  it("plans through the CLI with the same tools and records the run", async () => {
    const s = cliSetup(async (input) => {
      await input.callTool("todo__list_due_tasks", {});
      await input.callTool("send_message", {
        text: "Two quick ones tonight.",
        items: [{ task_id: 1, title: "Wash the dishes", steps: ["Hot water"], minutes: 10 }],
      });
      return { finalText: "Sent." };
    });
    s.engine.handleEvent("manual.plan", {}, null);
    await s.engine.idle();

    const input = s.inputs[0];
    expect(input).toMatchObject({ model: "claude-opus-5-5", effort: "low" });
    expect(input.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["todo__list_due_tasks", "send_message"]));
    expect(input.prompt).toContain("sat 2026-11-14, 18:20");
    expect(s.plugins.calls.map((c) => c.tool)).toContain("list_due_tasks");
    // The final text is not sent again when send_message was already used.
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Two quick ones tonight."]);
    expect(s.db.recentRuns()[0]).toMatchObject({ status: "ok", input_tokens: 120, output_tokens: 30 });
  });

  it("sends the final text when Claude answers without send_message", async () => {
    const s = cliSetup(async () => ({ finalText: "Nothing due tonight, enjoy." }));
    s.engine.handleUserMessage("anything to do?");
    await s.engine.idle();
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Nothing due tonight, enjoy."]);
  });

  it("records a CLI error without messaging the phone", async () => {
    const s = cliSetup(async () => ({ finalText: "partial", error: "error_max_turns" }));
    s.engine.handleEvent("manual.plan", {}, null);
    await s.engine.idle();
    expect(s.notifier.sent).toHaveLength(0);
    expect(s.db.recentRuns()[0]).toMatchObject({ status: "error", error: "error_max_turns" });
    expect(s.db.workflowRuns()[0]).toMatchObject({ status: "failed", error: "plan: Claude run failed: error_max_turns" });
  });

  it("records a run that throws as an error", async () => {
    const s = cliSetup(async () => {
      throw new Error("CLI not logged in");
    });
    s.engine.handleEvent("manual.plan", {}, null);
    await s.engine.idle();
    expect(s.db.recentRuns()[0]).toMatchObject({ status: "error", error: "CLI not logged in" });
  });
});

describe("push registration", () => {
  const sub = { endpoint: "https://ntfy.example/upABC", p256dh: "BPk-_abc", auth: "au_th-1" };

  it("stores and clears a web push subscription, and still accepts fcm_token", async () => {
    const s = setup();
    const headers = await pair(s.app);
    const put = (payload: unknown) => s.app.inject({ method: "PUT", url: "/devices/me/push", headers, payload: payload as object });

    expect((await put(sub)).statusCode).toBe(200);
    expect(s.db.webPushSubscriptions()).toMatchObject([sub]);

    expect((await put({ endpoint: null })).statusCode).toBe(200);
    expect(s.db.webPushSubscriptions()).toEqual([]);

    expect((await put({ fcm_token: "tok" })).statusCode).toBe(200);
    expect(s.db.pushTokens()).toEqual(["tok"]);
  });

  it("rejects bad bodies with 400", async () => {
    const s = setup();
    const headers = await pair(s.app);
    for (const payload of [{}, { endpoint: "not a url", p256dh: "a", auth: "b" }, { endpoint: sub.endpoint }, { endpoint: sub.endpoint, p256dh: "a b", auth: "c" }]) {
      expect((await s.app.inject({ method: "PUT", url: "/devices/me/push", headers, payload })).statusCode).toBe(400);
    }
  });

  it("serves the VAPID public key, 404 when push is off, 401 without a token", async () => {
    const s = setup();
    const headers = await pair(s.app);
    const off = await s.app.inject({ method: "GET", url: "/push/vapid-key", headers });
    expect(off.statusCode).toBe(404);
    expect(off.json()).toEqual({ error: "push_off" });

    const on = buildApp({ db: s.db, engine: s.engine, pairingCode: "pair-me-please", store: s.store, config: s.config, vapidPublicKey: "PUBKEY" });
    const res = await on.inject({ method: "GET", url: "/push/vapid-key", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ public_key: "PUBKEY" });
    expect((await on.inject({ method: "GET", url: "/push/vapid-key" })).statusCode).toBe(401);
  });
});

describe("the LLM step and chat", () => {
  const systemOf = (req: { system?: unknown }) => String(req.system);

  it("uses a generic system prompt plus the instructions of plugins whose tools are offered", async () => {
    const s = setup({
      workflows: [
        { id: "all-tools", cooldown: 0, triggers: [{ event: "manual.plan" }], steps: [{ id: "a", claude: { prompt: "Plan." } }] },
        { id: "no-plugins", cooldown: 0, triggers: [{ event: "manual.plan" }], steps: [{ id: "b", claude: { prompt: "Hi.", tools: ["send_message"] } }] },
      ],
      script: [reply("end_turn", [{ type: "text", text: "one" }]), reply("end_turn", [{ type: "text", text: "two" }])],
    });
    s.engine.handleEvent("manual.plan", {}, null);
    await s.engine.idle();
    const [withTodo, without] = s.claude.requests;
    expect(systemOf(withTodo)).toContain("## Chores (plugin `todo`)\nPlan easiest first.");
    expect(systemOf(without)).not.toMatch(/Plan easiest first|chore/i);
    for (const r of [withTodo, without]) {
      expect(systemOf(r)).toContain("You are Jeeves");
      expect(systemOf(r)).not.toMatch(/Alexander/);
    }
  });

  it("lets a step pick its model and effort, and include the recent chat", async () => {
    const s = setup({
      workflows: [
        {
          id: "deep",
          cooldown: 0,
          triggers: [{ event: "manual.plan" }],
          steps: [{ id: "think", claude: { prompt: "Think hard.", model: "claude-fable-5-2", effort: "high", history: true } }],
        },
      ],
      script: [reply("end_turn", [{ type: "text", text: "done" }])],
    });
    s.db.addMessage("out", "Earlier reply", null, null, s.clock.now);
    s.engine.handleEvent("manual.plan", {}, null);
    await s.engine.idle();
    const [req] = s.claude.requests;
    expect(req).toMatchObject({ model: "claude-fable-5-2", output_config: { effort: "high" } });
    expect(JSON.stringify(req.messages[0].content)).toContain("Jeeves: Earlier reply");
    expect(s.db.recentRuns()[0]).toMatchObject({ model: "claude-fable-5-2" });
  });

  it("turns a chat message into message.received, answered by the chat workflow", async () => {
    const s = setup({ script: [reply("tool_use", [toolUse("t1", "send_message", { text: "On it.", items: [] })]), reply("end_turn", [])] });
    const headers = await pair(s.app);
    await s.app.inject({ method: "POST", url: "/messages", headers, payload: { text: "dishes done" } });
    await s.engine.idle();
    const ev = s.db.lastEvent("message.received", "9999");
    expect(ev?.payload).toMatchObject({ text: "dishes done" });
    expect(s.db.workflowRuns()[0]).toMatchObject({ workflow_id: "chat-reply", status: "ok" });
    const input = JSON.stringify(s.claude.requests[0].messages[0].content);
    expect(input).toContain('I wrote: \\"dishes done\\"');
    expect(input).toContain("User: dishes done");
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["On it."]);
  });

  it("says so when no workflow answers a chat message", async () => {
    const s = setup({ workflows: [ARRIVE_HOME] });
    s.engine.handleUserMessage("hello?");
    await s.engine.idle();
    expect(s.claude.requests).toHaveLength(0);
    expect(s.notifier.sent[0].text).toMatch(/Nothing answered that message .*message\.received/);
  });
});
