import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { staticConfig, type WorkflowInput } from "./config.js";
import { Engine } from "./engine.js";
import { nextLocalTime, nextPath } from "./runner.js";
import { RecordingNotifier, reply, scriptedClaude, setup, toolUse } from "./testkit.js";

const wf = (steps: WorkflowInput["steps"], extra: Partial<WorkflowInput> = {}): WorkflowInput => ({
  id: "flow",
  cooldown: 0,
  triggers: [{ event: "test.go" }],
  steps,
  ...extra,
});

async function fire(s: ReturnType<typeof setup>, payload: Record<string, unknown> = {}) {
  const res = s.engine.handleEvent("test.go", payload, null);
  await s.engine.idle();
  const [run] = s.db.workflowRuns();
  return { res, run, steps: run ? s.db.stepRuns(run.id) : [] };
}

describe("runner step types", () => {
  it("calls a plugin tool with templated args and exposes its output to later steps", async () => {
    const s = setup({
      workflows: [
        wf([
          { id: "due", call: { plugin: "todo", tool: "list_due_tasks" } },
          { id: "go", call: { plugin: "todo", tool: "start_task", args: { task_id: "{{steps.due.1.id}}" } } },
          { id: "say", message: { text: "On {{event.ssid}}: started {{steps.go.task.id}}, first was {{steps.due.0.name}}" } },
        ]),
      ],
    });
    const { run, steps } = await fire(s, { ssid: "home" });
    expect(run.status).toBe("ok");
    expect(s.plugins.calls[1]).toEqual({ plugin: "todo", tool: "start_task", args: { task_id: 2 } });
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["On home: started 2, first was Wash the dishes"]);
    expect(steps.map((x) => [x.step_id, x.type, x.status, x.path])).toEqual([
      ["due", "call", "ok", "0"],
      ["go", "call", "ok", "1"],
      ["say", "message", "ok", "2"],
    ]);
  });

  it("takes the then branch or the else branch", async () => {
    const steps: WorkflowInput["steps"] = [
      {
        id: "check",
        if: { path: "event.ssid", eq: "home" },
        then: [{ id: "yes", message: { text: "home" } }],
        else: [{ id: "no", message: { text: "away" } }],
      },
      { id: "after", message: { text: "after" } },
    ];
    const home = setup({ workflows: [wf(steps)] });
    const a = await fire(home, { ssid: "home" });
    expect(home.notifier.sent.map((m) => m.text)).toEqual(["home", "after"]);
    expect(a.steps.map((x) => x.path)).toEqual(["0", "0.then.0", "1"]);

    const away = setup({ workflows: [wf(steps)] });
    const b = await fire(away, { ssid: "cafe" });
    expect(away.notifier.sent.map((m) => m.text)).toEqual(["away", "after"]);
    expect(b.steps.map((x) => x.path)).toEqual(["0", "0.else.0", "1"]);
    expect(b.steps[0].output).toEqual({ result: false, branch: "else" });
  });

  it("stops a run with stop", async () => {
    const s = setup({
      workflows: [wf([{ id: "halt", stop: { reason: "nothing to do for {{event.who}}" } }, { id: "never", message: { text: "x" } }])],
    });
    const { run, steps } = await fire(s, { who: "me" });
    expect(run).toMatchObject({ status: "stopped", error: "nothing to do for me" });
    expect(steps).toHaveLength(1);
    expect(s.notifier.sent).toHaveLength(0);
  });

  it("records unknown template paths as warnings on the step", async () => {
    const s = setup({ workflows: [wf([{ id: "say", message: { text: "Hi {{event.name}}" } }])] });
    const { steps } = await fire(s);
    expect(steps[0]).toMatchObject({ status: "ok", warnings: ["{{event.name}} is empty"], input: { text: "Hi " } });
  });

  it("passes the claude step's tool allowlist to Claude and links the run", async () => {
    const s = setup({
      workflows: [wf([{ id: "think", claude: { prompt: "Look at {{event.ssid}}", tools: ["todo__list_due_tasks", "send_message"] } }])],
      script: [reply("tool_use", [toolUse("t1", "send_message", { text: "Done", items: [] })]), reply("end_turn", [])],
    });
    const { run, steps } = await fire(s, { ssid: "home" });
    const names = s.claude.requests[0].tools!.map((t) => (t as { name: string }).name);
    expect(names.sort()).toEqual(["send_message", "todo__list_due_tasks"]);
    expect(JSON.stringify(s.claude.requests[0].messages[0].content)).toContain("Look at home");
    expect(steps[0]).toMatchObject({ status: "ok", output: { messages_sent: 1, status: "ok" } });
    expect(s.db.getRun(steps[0].run_id!)).toMatchObject({ workflow_run_id: run.id });
  });

  it("refuses tools outside the allowlist even if Claude asks", async () => {
    const s = setup({
      workflows: [wf([{ id: "think", claude: { prompt: "p", tools: ["send_message"] } }])],
      script: [reply("tool_use", [toolUse("t1", "todo__complete_task", { task_id: 1 })]), reply("end_turn", [{ type: "text", text: "ok" }])],
    });
    await fire(s);
    expect(s.plugins.calls).toEqual([]);
  });

  it("marks the step and run capped when the daily cap is hit, and stops", async () => {
    const s = setup({
      globals: { max_runs_per_day: 1 },
      workflows: [wf([{ id: "think", claude: { prompt: "p" } }, { id: "after", message: { text: "x" } }])],
    });
    s.db.startRun({ kind: "plan", model: "m", input: "", local_date: "2026-11-14" });
    const { run, steps } = await fire(s);
    expect(run.status).toBe("capped");
    expect(steps.map((x) => x.status)).toEqual(["capped"]);
    expect(s.notifier.sent).toHaveLength(0);
  });

  it("fails the run, notifies once and does not retry", async () => {
    const s = setup({ workflows: [wf([{ id: "boom", call: { plugin: "todo", tool: "explode" } }, { id: "after", message: { text: "x" } }])] });
    const { run, steps } = await fire(s);
    expect(run).toMatchObject({ status: "failed", error: "boom: kaboom" });
    expect(steps.map((x) => x.status)).toEqual(["failed"]);
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Workflow flow failed at boom: kaboom"]);
    s.clock.now = new Date(s.clock.now.getTime() + 3600_000);
    await s.engine.runDueJobs();
    expect(s.plugins.calls.filter((c) => c.tool === "explode")).toHaveLength(1);
    expect(s.notifier.sent).toHaveLength(1);
  });

  it("stays quiet on failure when notify_on_failure is off", async () => {
    const s = setup({ workflows: [wf([{ id: "boom", call: { plugin: "todo", tool: "explode" } }], { notify_on_failure: false })] });
    await fire(s);
    expect(s.notifier.sent).toHaveLength(0);
  });
});

describe("waits", () => {
  const waitFlow = wf([
    { id: "hello", message: { text: "Starting {{event.name}}" } },
    { id: "pause", wait: { minutes: 30 } },
    { id: "check", message: { text: "How's {{event.name}} going? ({{steps.hello.text}})" } },
  ]);

  it("survive the engine being recreated and resume exactly once", async () => {
    const s = setup({ workflows: [waitFlow] });
    const { run } = await fire(s, { name: "laundry" });
    expect(s.db.getWorkflowRun(run.id)!.status).toBe("waiting");
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Starting laundry"]);

    // Throw the engine away; build a new one on the same database.
    await s.engine.stop();
    const config = staticConfig({ timezone: "Europe/London" }, [waitFlow]);
    const notifier = new RecordingNotifier();
    const now = () => s.clock.now;
    const agent = new Agent({ db: s.db, config, plugins: s.plugins, notifier, create: scriptedClaude([]).create, now });
    const engine = new Engine(s.db, config, s.plugins, agent, now);

    s.clock.now = new Date(s.clock.now.getTime() + 29 * 60_000);
    await engine.runDueJobs();
    expect(notifier.sent).toHaveLength(0);

    s.clock.now = new Date(s.clock.now.getTime() + 2 * 60_000);
    await engine.runDueJobs();
    await engine.runDueJobs();
    expect(notifier.sent.map((m) => m.text)).toEqual(["How's laundry going? (Starting laundry)"]);
    expect(s.db.getWorkflowRun(run.id)!.status).toBe("ok");
    expect(s.db.stepRuns(run.id).map((x) => [x.step_id, x.status])).toEqual([
      ["hello", "ok"],
      ["pause", "ok"],
      ["check", "ok"],
    ]);
  });

  it("can be cancelled, which cancels the run", async () => {
    const s = setup({ workflows: [waitFlow] });
    const { run } = await fire(s, { name: "laundry" });
    const [job] = s.db.pendingJobs("workflow_resume");
    expect(s.engine.cancelJob(job.id)).toBe(true);
    expect(s.db.getWorkflowRun(run.id)!.status).toBe("cancelled");
    s.clock.now = new Date(s.clock.now.getTime() + 60 * 60_000);
    await s.engine.runDueJobs();
    expect(s.notifier.sent).toHaveLength(1);
  });

  it("resume inside an if branch continues after the branch", async () => {
    const s = setup({
      workflows: [
        wf([
          { id: "check", if: { path: "event.go" }, then: [{ id: "pause", wait: { minutes: 5 } }, { id: "inner", message: { text: "inner" } }] },
          { id: "outer", message: { text: "outer" } },
        ]),
      ],
    });
    await fire(s, { go: true });
    s.clock.now = new Date(s.clock.now.getTime() + 6 * 60_000);
    await s.engine.runDueJobs();
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["inner", "outer"]);
  });

  it("until HH:MM rolls to tomorrow when the time has passed", () => {
    const now = new Date("2026-11-14T20:00:00Z"); // 20:00 in London
    expect(nextLocalTime("21:30", "Europe/London", now).toISOString()).toBe("2026-11-14T21:30:00.000Z");
    expect(nextLocalTime("07:00", "Europe/London", now).toISOString()).toBe("2026-11-15T07:00:00.000Z");
  });
});

describe("crash recovery", () => {
  it("marks a step left running as failed on start and never re-runs it", async () => {
    const s = setup({ workflows: [wf([{ id: "say", message: { text: "x" } }])] });
    const id = s.db.startWorkflowRun({ workflow_id: "flow", trigger: "event", event_id: null, dry_run: false, definition: {}, local_date: "2026-11-14" });
    const step = s.db.startStep({ workflow_run_id: id, step_id: "say", path: "0", type: "message" });
    s.engine.start();
    await s.engine.stop();
    expect(s.db.stepRuns(id)[0]).toMatchObject({ id: step, status: "failed", error: "interrupted by restart" });
    expect(s.db.getWorkflowRun(id)!.status).toBe("failed");
    expect(s.notifier.sent).toHaveLength(0);
  });
});

describe("nextPath", () => {
  const steps = [
    { id: "a", stop: null },
    { id: "b", if: { path: "event.x" }, then: [{ id: "c", stop: null }, { id: "d", stop: null }], else: [{ id: "e", stop: null }] },
  ] as WorkflowInput["steps"];
  it("walks siblings and climbs out of branches", () => {
    expect(nextPath(steps as never, "0")).toBe("1");
    expect(nextPath(steps as never, "1.then.0")).toBe("1.then.1");
    expect(nextPath(steps as never, "1.then.1")).toBe(null);
    expect(nextPath(steps as never, "1.else.0")).toBe(null);
    expect(nextPath(steps as never, "1")).toBe(null);
  });
});
