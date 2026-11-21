import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { buildApp } from "./app.js";
import type { CliRunInput, CliRunner } from "./cli.js";
import { staticConfig } from "./config.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { ARRIVE_HOME, FakeTodo, MANUAL_PLAN, pair, RecordingNotifier, reply, setup, toolUse } from "./testkit.js";

describe("arrive home, end to end", () => {
  it("plans the evening and pushes an easiest-first list", async () => {
    const s = setup({
      script: [
        reply("tool_use", [toolUse("t1", "todo__list_due_tasks", {})]),
        reply("tool_use", [
          toolUse("t2", "send_message", {
            text: "Welcome home! Two quick ones tonight.",
            items: [
              { task_id: 1, title: "Wash the dishes", steps: ["Hot water", "Glasses first"], minutes: 10 },
              { task_id: 2, title: "Start the laundry", steps: ["Sort", "40 degrees"], minutes: 15 },
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
    expect(s.notifier.sent[0].items?.map((i) => i.task_id)).toEqual([1, 2]);

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
  it("starting laundry schedules the dryer nudge, and finishing early cancels it", async () => {
    const s = setup();
    const headers = await pair(s.app);
    const start = await s.app.inject({ method: "POST", url: "/tasks/2/action", headers, payload: { action: "start" } });
    expect(start.statusCode).toBe(200);

    s.clock.now = new Date("2026-11-14T13:16:00Z");
    await s.engine.runDueJobs();
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Move it to the dryer"]);
    expect(s.notifier.sent[0].items).toEqual([{ task_id: 2, title: "Move it to the dryer", steps: [] }]);

    // A second start, then done before the timer: no nudge.
    await s.app.inject({ method: "POST", url: "/tasks/2/action", headers, payload: { action: "start" } });
    await s.app.inject({ method: "POST", url: "/tasks/2/action", headers, payload: { action: "done" } });
    s.clock.now = new Date("2026-11-14T15:00:00Z");
    await s.engine.runDueJobs();
    expect(s.notifier.sent).toHaveLength(1);
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
    expect((await s.app.inject({ method: "GET", url: "/today" })).statusCode).toBe(401);
  });
});

describe("Claude Code CLI backend", () => {
  /** Scripted CLI: runs the given steps against Jeeves's tools, then returns the result. */
  function cliSetup(steps: (input: CliRunInput) => Promise<{ finalText?: string; error?: string }>) {
    const clock = { now: new Date("2026-11-14T18:20:00Z") };
    const now = () => clock.now;
    const db = new Db();
    const config = staticConfig({ timezone: "Europe/London" }, [ARRIVE_HOME, { ...MANUAL_PLAN, notify_on_failure: false }]);
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
