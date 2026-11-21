import { describe, expect, it } from "vitest";
import type { WorkflowInput } from "./config.js";
import { McpPluginHost } from "./plugins.js";
import { pair, reply, setup, toolUse } from "./testkit.js";
import { activityFeed, describeTrigger, health, upcoming } from "./timeline.js";

const WEEKEND: WorkflowInput = {
  id: "weekend-morning",
  triggers: [{ schedule: "0 9 * * sat,sun" }],
  steps: [{ id: "plan", claude: { prompt: "Morning" } }],
};

const FRIDAY_EVENING = new Date("2026-11-13T19:00:00Z");
const SATURDAY_EARLY = new Date("2026-11-14T07:00:00Z");

const deps = (s: ReturnType<typeof setup>) => ({ db: s.db, config: s.config });
const schedules = (s: ReturnType<typeof setup>, now: Date) => upcoming(deps(s), 48, now).items.filter((i) => i.kind === "schedule");

describe("timeline: upcoming", () => {
  it("shows the weekend cron from a Friday evening as will_run", () => {
    const s = setup({ workflows: [WEEKEND] });
    expect(schedules(s, FRIDAY_EVENING)).toEqual([
      { kind: "schedule", at: "2026-11-14T09:00:00.000Z", workflow_id: "weekend-morning", schedule: "0 9 * * sat,sun", status: "will_run", reason: null },
      { kind: "schedule", at: "2026-11-15T09:00:00.000Z", workflow_id: "weekend-morning", schedule: "0 9 * * sat,sun", status: "will_run", reason: null },
    ]);
  });

  it("marks today's slot as skipped after a fire today", () => {
    const s = setup({ workflows: [WEEKEND] });
    s.db.recordFire("weekend-morning", null, "2026-11-14", new Date("2026-11-14T06:30:00Z"));
    const [sat, sun] = schedules(s, SATURDAY_EARLY);
    expect(sat).toMatchObject({ status: "will_skip", reason: "already fired today" });
    expect(sun).toMatchObject({ status: "will_run" });
  });

  it("knows a later slot on the same day is skipped once an earlier one fires", () => {
    const s = setup({ workflows: [{ ...WEEKEND, triggers: [{ schedule: "0 9,12 * * sat" }] }] });
    expect(schedules(s, SATURDAY_EARLY).map((i) => (i as { status: string }).status)).toEqual(["will_run", "will_skip"]);
  });

  it("shows cap_reached when today's Claude runs are used up", () => {
    const s = setup({ workflows: [WEEKEND], globals: { max_runs_per_day: 1 } });
    s.db.startRun({ kind: "plan", model: "m", input: "", local_date: "2026-11-14" });
    const [sat, sun] = schedules(s, SATURDAY_EARLY);
    expect(sat).toMatchObject({ status: "cap_reached" });
    expect(sun).toMatchObject({ status: "will_run" });
  });

  it("shows a disabled workflow as disabled", () => {
    const s = setup({ workflows: [{ ...WEEKEND, enabled: false }] });
    expect(schedules(s, FRIDAY_EVENING).map((i) => (i as { status: string }).status)).toEqual(["disabled", "disabled"]);
  });

  it("lists waiting steps, pending follow-ups and the events workflows wait for", async () => {
    const s = setup({
      clock: { now: FRIDAY_EVENING },
      workflows: [
        {
          id: "laundry",
          cooldown: 0,
          triggers: [{ event: "todo.task_started", when: { conditions: [{ path: "event.chore_id", eq: "laundry" }] } }],
          steps: [{ id: "pause", wait: { minutes: 75 } }, { id: "nudge", message: { text: "Dryer time" } }],
        },
      ],
    });
    s.engine.handleEvent("todo.task_started", { chore_id: "laundry" }, null);
    await s.engine.idle();
    s.db.addJob(new Date("2026-11-13T20:00:00Z"), "followup", { message: "Check the oven", plugin: "todo", item_id: "3" });
    const t = upcoming(deps(s), 48, FRIDAY_EVENING);
    expect(t.items).toMatchObject([
      { kind: "followup", at: "2026-11-13T20:00:00.000Z", message: "Check the oven", plugin: "todo", item_id: "3" },
      { kind: "wait", at: "2026-11-13T20:15:00.000Z", workflow_id: "laundry", next_step: "nudge" },
    ]);
    expect(t.waiting_for).toEqual([
      { workflow_id: "laundry", enabled: true, event: "todo.task_started", description: 'Todo reports task started when event.chore_id is "laundry"' },
    ]);
  });
});

describe("describeTrigger", () => {
  it("reads like a sentence", () => {
    expect(
      describeTrigger({ event: "wifi.connected", when: { ssid: "MyHomeWiFi", after: "17:00", before: "22:30", min_away_minutes: 120 } }, "daily"),
    ).toBe("Wi-Fi connects to MyHomeWiFi between 17:00 and 22:30 after 2h away, once a day");
    expect(describeTrigger({ event: "manual.plan" }, 5)).toBe('You tap "Plan my day", at most every 5 min');
    expect(describeTrigger({ schedule: "0 9 * * sat,sun", when: { days: ["sat"], before: "10:00" } }, 0)).toBe(
      'On schedule "0 9 * * sat,sun" on Sat before 10:00',
    );
    expect(describeTrigger({ event: "wifi.disconnected", when: { ssid: "home", min_away_minutes: 90 } }, 0)).toBe("Wi-Fi disconnects from home after 1h 30m away");
    expect(describeTrigger({ event: "wifi.connected", when: { ssid: ["home", "work"] } }, 0)).toBe("Wi-Fi connects to home or work");
  });
});

describe("evaluations, activity and retention", () => {
  it("persists an evaluation for every workflow considered, fired or skipped", async () => {
    const s = setup({ script: [reply("end_turn", [{ type: "text", text: "Plan." }])] });
    s.clock.now = new Date("2026-11-14T10:00:00Z");
    s.engine.handleEvent("wifi.connected", { ssid: "home" }, null);
    s.engine.handleEvent("manual.plan", {}, null);
    await s.engine.idle();
    const evals = s.db.evaluations({ limit: 10 });
    expect(evals.map((e) => [e.workflow_id, e.fired, e.reason])).toEqual([
      ["manual-plan", true, "conditions met"],
      ["arrive-home", false, "before 17:00"],
    ]);
    const feed = activityFeed(deps(s), {});
    expect(feed.items.map((i) => i.kind).sort()).toEqual(["evaluation", "evaluation", "workflow_run"]);
    const run = feed.items.find((i) => i.kind === "workflow_run") as { steps: { claude_run: { input_tokens: number }; messages: { text: string }[] }[] };
    expect(run.steps[0].claude_run.input_tokens).toBe(100);
    expect(run.steps[0].messages.map((m) => m.text)).toEqual(["Plan."]);
    expect(activityFeed(deps(s), { status: "skipped" }).items).toHaveLength(1);
    expect(activityFeed(deps(s), { workflow: "manual-plan", kind: "workflow_run" }).items).toHaveLength(1);
  });

  it("prunes rows older than the retention window and keeps the rest", async () => {
    const s = setup({ globals: { activity_retention_days: 30 } });
    const old = new Date("2026-09-01T10:00:00Z");
    const recent = new Date("2026-11-10T10:00:00Z");
    for (const at of [old, recent]) {
      s.db.recordEvaluation({ at: at.toISOString(), workflow_id: "w", trigger_kind: "event", event_id: null, fired: false, reason: "x", simulated: false });
      s.db.addActivity("config_reload", null, {}, at);
      const id = s.db.startWorkflowRun({ workflow_id: "w", trigger: "event", event_id: null, dry_run: false, definition: {}, local_date: "x" }, at);
      s.db.startStep({ workflow_run_id: id, step_id: "a", path: "0", type: "message" }, at);
      s.db.finishWorkflowRun(id, "ok", null, at);
      s.db.insertEvent("wifi.connected", {}, 1, at);
      s.db.finishRun(s.db.startRun({ kind: "plan", model: "m", input: "hi", local_date: "x" }, at), { status: "ok", transcript: ["t"] }, at);
    }
    s.db.insertEvent("wifi.connected", {}, 1, recent);
    const out = s.engine.prune(new Date("2026-11-19T00:00:00Z"));
    expect(out).toMatchObject({ evaluations: 1, activity: 1, workflow_runs: 1, step_runs: 1, events: 1, transcripts: 1 });
    expect(s.db.evaluations({ limit: 10 })).toHaveLength(1);
    expect(s.db.workflowRuns()).toHaveLength(1);
    expect((s.db.recentRuns() as unknown[]).length).toBe(2);
    expect(s.db.getRun(1)!.transcript).toBeNull();
    expect(s.db.getRun(2)!.transcript).toEqual(["t"]);
  });
});

describe("simulate", () => {
  it("returns decisions without inserting events, evaluations or running anything", async () => {
    const s = setup();
    const headers = await pair(s.app);
    s.db.insertEvent("wifi.disconnected", { ssid: "home" }, 1, new Date("2026-11-14T09:00:00Z"));
    const res = await s.app.inject({
      method: "POST",
      url: "/simulate",
      headers,
      payload: { event_type: "wifi.connected", payload: { ssid: "home" }, at: "2026-11-14T18:20:00Z" },
    });
    expect(res.json()).toEqual({ at: "2026-11-14T18:20:00.000Z", decisions: [{ workflow_id: "arrive-home", fired: true, reason: "conditions met" }] });
    expect(s.db.sql.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
    expect(s.db.evaluations({ limit: 10 })).toEqual([]);
    await s.engine.idle();
    expect(s.db.workflowRuns()).toEqual([]);
    expect(s.claude.requests).toEqual([]);
  });
});

describe("dry run", () => {
  const flow: WorkflowInput = {
    id: "flow",
    triggers: [{ event: "manual.plan" }],
    steps: [
      { id: "due", call: { plugin: "todo", tool: "list_due_tasks" } },
      { id: "start", call: { plugin: "todo", tool: "start_task", args: { task_id: 1 } } },
      { id: "pause", wait: { minutes: 30 } },
      { id: "say", message: { text: "First: {{steps.due.0.name}}" } },
      { id: "think", claude: { prompt: "Plan" } },
    ],
  };

  it("records messages instead of sending, skips non-read-only calls and waits, runs read-only calls", async () => {
    const s = setup({
      workflows: [flow],
      script: [
        reply("tool_use", [toolUse("t1", "todo__start_task", { task_id: 2 }), toolUse("t2", "send_message", { text: "Would send", items: [] })]),
        reply("end_turn", []),
      ],
    });
    const headers = await pair(s.app);
    const res = await s.app.inject({ method: "POST", url: "/workflows/flow/run", headers, payload: { dry_run: true } });
    expect(res.statusCode).toBe(200);
    const run = res.json().run;
    expect(run).toMatchObject({ status: "ok", dry_run: true, trigger: "manual" });
    expect(run.steps.map((x: { step_id: string; status: string }) => [x.step_id, x.status])).toEqual([
      ["due", "ok"],
      ["start", "skipped"],
      ["pause", "skipped"],
      ["say", "ok"],
      ["think", "ok"],
    ]);
    expect(run.steps[1].error).toBe("not read-only");
    expect(run.steps[3].output).toEqual({ dry_run: true, text: "First: Wash the dishes", items: [] });
    expect(run.steps[4].output.recorded).toEqual([{ kind: "message", text: "Would send" }]);
    // Claude was only offered read-only plugin tools, and the write it asked for never happened.
    const offered = s.claude.requests[0].tools!.map((t) => (t as { name: string }).name);
    expect(offered).toContain("todo__list_due_tasks");
    expect(offered).not.toContain("todo__start_task");
    expect(s.plugins.calls.map((c) => c.tool)).toEqual(["list_due_tasks"]);
    expect(s.notifier.sent).toEqual([]);
    expect(s.db.pendingJobs()).toEqual([]);
    expect(s.db.messagesAfter(0)).toEqual([]);
  });

  it("a real manual run bypasses cooldown and returns at once", async () => {
    const s = setup({ workflows: [{ ...flow, steps: [{ id: "say", message: { text: "Hi {{event.who}}" } }] }] });
    const headers = await pair(s.app);
    s.db.recordFire("flow", null, "2026-11-14", s.clock.now);
    const res = await s.app.inject({ method: "POST", url: "/workflows/flow/run", headers, payload: { payload: { who: "Alex" } } });
    expect(res.json().workflow_run_id).toBe(1);
    await s.engine.idle();
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Hi Alex"]);
    expect((await s.app.inject({ method: "POST", url: "/workflows/nope/run", headers, payload: {} })).statusCode).toBe(404);
  });
});

describe("observability API", () => {
  it("serves upcoming, health, activity and job cancellation", async () => {
    const s = setup({ workflows: [WEEKEND] });
    const headers = await pair(s.app);
    const job = s.db.addJob(new Date("2026-11-14T13:00:00Z"), "followup", { message: "Dryer", plugin: "todo", item_id: "2" });
    const up = (await s.app.inject({ method: "GET", url: "/timeline/upcoming?hours=24", headers })).json();
    expect(up.items.map((i: { kind: string }) => i.kind)).toEqual(["followup", "schedule"]);

    const del = await s.app.inject({ method: "DELETE", url: `/jobs/${job}`, headers });
    expect(del.statusCode).toBe(200);
    expect((await s.app.inject({ method: "DELETE", url: `/jobs/${job}`, headers })).statusCode).toBe(409);
    s.clock.now = new Date("2026-11-14T14:00:00Z");
    await s.engine.runDueJobs();
    expect(s.notifier.sent).toEqual([]);

    s.engine.handleEvent("wifi.connected", { ssid: "home" }, 1);
    const h = (await s.app.inject({ method: "GET", url: "/health/summary", headers })).json();
    expect(h).toMatchObject({ runs_today: 0, max_runs_per_day: 20, workflows: { total: 1, enabled: 1 } });
    expect(h.devices).toEqual([{ device_id: 1, name: "Pixel", last_event_type: "wifi.connected", last_event_at: "2026-11-14T14:00:00.000Z" }]);

    const tools = (await s.app.inject({ method: "GET", url: "/tools", headers })).json();
    expect(tools.tools.find((t: { name: string }) => t.name === "todo__get_chore").read_only).toBe(true);
    const types = (await s.app.inject({ method: "GET", url: "/event-types", headers })).json();
    expect(types.event_types).toEqual(expect.arrayContaining(["wifi.connected", "manual.plan"]));
  });

  it("tracks plugin reachability and reports transitions", async () => {
    const changes: [string, boolean][] = [];
    const host = new McpPluginHost([{ name: "ghost", url: "http://127.0.0.1:1/mcp", token_env: "GHOST_TOKEN" }], {
      env: { GHOST_TOKEN: "x" },
      onStatusChange: (name, ok) => changes.push([name, ok]),
    });
    expect(host.status()[0].reachable).toBeNull();
    expect(await host.listTools()).toEqual([]);
    await host.call("ghost", "anything", {});
    expect(host.status()[0]).toMatchObject({ name: "ghost", reachable: false, tool_count: 0 });
    expect(host.status()[0].last_error).toBeTruthy();
    expect(changes).toEqual([["ghost", false]]);
    const s = setup();
    expect(health({ db: s.db, config: s.config, plugins: host }).plugins[0].name).toBe("ghost");
  });
});
