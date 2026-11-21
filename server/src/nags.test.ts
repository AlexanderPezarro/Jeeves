import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { staticConfig, workflowSchema, type WorkflowInput } from "./config.js";
import { Engine } from "./engine.js";
import { RecordingNotifier, scriptedClaude, setup } from "./testkit.js";

const min = (n: number) => n * 60_000;
const advance = (s: ReturnType<typeof setup>, minutes: number) => (s.clock.now = new Date(s.clock.now.getTime() + min(minutes)));

const item = { plugin: "todo", item_id: "{{steps.task.id}}", title: "Laundry" };
const taskEvent = (type: string, task_id: number) => ({ type, task_id });

/** The laundry flow from config.example, with short numbers. */
const laundry = (over: Partial<WorkflowInput> = {}): WorkflowInput => ({
  id: "laundry",
  cooldown: 0,
  triggers: [{ event: "wifi.connected" }],
  cancel_on: [
    { event: "wifi.disconnected", conditions: [{ path: "event.ssid", eq: "home" }] },
    { event: "todo.task_skipped", conditions: [{ path: "event.task_id", eq: "{{steps.task.id}}" }] },
  ],
  steps: [
    { id: "task", call: { plugin: "todo", tool: "get_task", args: { chore_id: "laundry" } } },
    { id: "settle", wait: { minutes: 20 } },
    {
      id: "put-on",
      message: {
        text: "Put a wash on",
        level: "alarm",
        items: [item],
        repeat: { every_minutes: 10, max: 3 },
        until: { event: "todo.task_started", conditions: [{ path: "event.task_id", eq: "{{steps.task.id}}" }] },
      },
    },
    { id: "cycle", wait: { minutes: 140 } },
    { id: "hang-up", message: { text: "Hang up the washing", until: { event: "todo.task_completed", conditions: [{ path: "event.task_id", eq: "{{steps.task.id}}" }] } } },
  ],
  ...over,
});

const arrive = (s: ReturnType<typeof setup>) => {
  const r = s.engine.handleEvent("wifi.connected", { ssid: "home" }, null);
  return r;
};
const status = (s: ReturnType<typeof setup>, i = 0) => s.db.workflowRuns({ workflow_id: "laundry" }).reverse()[i]?.status;

async function toNag(s: ReturnType<typeof setup>) {
  arrive(s);
  await s.engine.idle();
  advance(s, 21);
  await s.engine.runDueJobs();
}

describe("config", () => {
  const base = { id: "w", triggers: [{ event: "a.b" }] };
  const parse = (steps: unknown, extra: object = {}) => workflowSchema.safeParse({ ...base, steps, ...extra });
  it("rejects repeat without until", () => {
    const r = parse([{ id: "m", message: { text: "x", repeat: { every_minutes: 5 } } }]);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain("repeat needs until");
  });
  it("allows until without repeat", () => {
    expect(parse([{ id: "m", message: { text: "x", until: { event: "a.b" } } }]).success).toBe(true);
  });
  it("only lets listener conditions check event.*", () => {
    const steps = [{ id: "c", call: { plugin: "p", tool: "t" } }, { id: "m", message: { text: "x", until: { event: "a.b", conditions: [{ path: "steps.c.x", eq: 1 }] } } }];
    expect(parse(steps).success).toBe(false);
    expect(parse(steps.slice(1), { cancel_on: [{ event: "a.b", conditions: [{ path: "steps.c.x", eq: 1 }] }] }).success).toBe(false);
  });
  it("checks template refs in until against earlier steps", () => {
    const until = { event: "a.b", conditions: [{ path: "event.id", eq: "{{steps.later.id}}" }] };
    const later = { id: "later", call: { plugin: "p", tool: "t" } };
    expect(parse([{ id: "m", message: { text: "x", until } }, later]).success).toBe(false);
    expect(parse([later, { id: "m", message: { text: "x", until } }]).success).toBe(true);
  });
  it("accepts cancel_on, and rejects refs to unknown steps", () => {
    const steps = [{ id: "task", call: { plugin: "p", tool: "t" } }];
    expect(parse(steps, { cancel_on: [{ event: "x.y", conditions: [{ path: "event.id", eq: "{{steps.task.id}}" }] }] }).success).toBe(true);
    expect(parse(steps, { cancel_on: [{ event: "x.y", conditions: [{ path: "event.id", eq: "{{steps.nope.id}}" }] }] }).success).toBe(false);
  });
});

describe("message nags", () => {
  it("sends at the level, repeats, and ends at the limit after a grace period", async () => {
    const s = setup({ workflows: [laundry()] });
    await toNag(s);
    expect(s.notifier.sent.map((m) => [m.text, m.level])).toEqual([["Put a wash on", "alarm"]]);
    expect(s.notifier.sent[0].items?.[0]).toMatchObject({ plugin: "todo", item_id: "12" });
    expect(status(s)).toBe("waiting");
    for (const n of [2, 3]) {
      advance(s, 10);
      await s.engine.runDueJobs();
      expect(s.notifier.sent).toHaveLength(n);
    }
    // After the 3rd send there is one more interval to respond, then the run ends.
    advance(s, 10);
    await s.engine.runDueJobs();
    expect(s.notifier.sent).toHaveLength(3);
    expect(s.db.workflowRuns()[0]).toMatchObject({ status: "stopped", error: "nag limit reached" });
    expect(s.db.pendingJobs()).toHaveLength(0);
    expect(s.db.listenersFor("todo.task_started")).toHaveLength(0);
  });

  it("resumes on the matching event (number vs rendered template) and not on another task", async () => {
    const s = setup({ workflows: [laundry()] });
    await toNag(s);
    s.engine.handleEvent("todo.task_started", taskEvent("x", 99), null);
    await s.engine.idle();
    expect(status(s)).toBe("waiting");
    s.engine.handleEvent("todo.task_started", { task_id: 12 }, null);
    await s.engine.idle();
    expect(status(s)).toBe("waiting"); // now at the 140 min wait
    const run = s.db.workflowRuns()[0];
    expect(s.db.stepRuns(run.id).find((x) => x.step_id === "put-on")!.status).toBe("ok");
    expect(s.db.pendingJobs("workflow_nag")).toHaveLength(0);
    expect(s.db.listenersFor("todo.task_started")).toHaveLength(0);
    advance(s, 141);
    await s.engine.runDueJobs();
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Put a wash on", "Hang up the washing"]);
    s.engine.handleEvent("todo.task_completed", { task_id: 12 }, null);
    await s.engine.idle();
    expect(status(s)).toBe("ok");
  });

  it("cancel_on ends a run paused in a wait or in a nag, cleaning up jobs and listeners", async () => {
    const s = setup({ workflows: [laundry()] });
    arrive(s);
    await s.engine.idle();
    expect(s.db.pendingJobs("workflow_resume")).toHaveLength(1);
    s.engine.handleEvent("wifi.disconnected", { ssid: "other" }, null);
    expect(status(s)).toBe("waiting");
    s.engine.handleEvent("wifi.disconnected", { ssid: "home" }, null);
    expect(s.db.workflowRuns()[0]).toMatchObject({ status: "cancelled", error: "cancelled by wifi.disconnected" });
    expect(s.db.pendingJobs()).toHaveLength(0);
    expect(s.db.hasListeners(s.db.workflowRuns()[0].id, "cancel")).toBe(false);

    const t = setup({ workflows: [laundry()] });
    await toNag(t);
    t.engine.handleEvent("todo.task_skipped", { task_id: 12 }, null);
    expect(status(t)).toBe("cancelled");
    expect(t.db.pendingJobs()).toHaveLength(0);
    advance(t, 60);
    await t.engine.runDueJobs();
    expect(t.notifier.sent).toHaveLength(1);
  });

  it("allows only one waiting run per workflow", async () => {
    const s = setup({ workflows: [laundry()] });
    expect(arrive(s).decisions[0]).toMatchObject({ fired: true });
    await s.engine.idle();
    expect(arrive(s).decisions[0]).toMatchObject({ fired: false, reason: "already waiting" });
    s.engine.handleEvent("wifi.disconnected", { ssid: "home" }, null);
    expect(arrive(s).decisions[0]).toMatchObject({ fired: true });
  });

  it("DELETE /jobs/:id on a nag cancels the run", async () => {
    const s = setup({ workflows: [laundry()] });
    await toNag(s);
    const [job] = s.db.pendingJobs("workflow_nag");
    expect(s.engine.cancelJob(job.id)).toBe(true);
    expect(status(s)).toBe("cancelled");
  });

  it("survives a restart: nag ticks and until events still work", async () => {
    const s = setup({ workflows: [laundry()] });
    await toNag(s);
    await s.engine.stop();
    const config = staticConfig({ timezone: "Europe/London" }, [laundry()]);
    const notifier = new RecordingNotifier();
    const now = () => s.clock.now;
    const agent = new Agent({ db: s.db, config, plugins: s.plugins, notifier, create: scriptedClaude([]).create, now });
    const engine = new Engine(s.db, config, s.plugins, agent, now);
    advance(s, 10);
    await engine.runDueJobs();
    expect(notifier.sent.map((m) => m.text)).toEqual(["Put a wash on"]);
    engine.handleEvent("todo.task_started", { task_id: 12 }, null);
    await engine.idle();
    expect(s.db.pendingJobs("workflow_nag")).toHaveLength(0);
    expect(s.db.pendingJobs("workflow_resume")).toHaveLength(1);
  });

  it("until without repeat sends once and waits for the event", async () => {
    const s = setup({
      workflows: [{ id: "once", cooldown: 0, triggers: [{ event: "test.go" }], steps: [{ id: "m", message: { text: "go", until: { event: "test.done" } } }, { id: "after", message: { text: "after" } }] }],
    });
    s.engine.handleEvent("test.go", {}, null);
    await s.engine.idle();
    expect(s.db.pendingJobs()).toHaveLength(0);
    s.engine.handleEvent("test.done", {}, null);
    await s.engine.idle();
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["go", "after"]);
  });

  it("a dry run sends nothing and registers nothing", async () => {
    const s = setup({ workflows: [laundry()] });
    const { done } = s.engine.runNow("laundry", { dryRun: true });
    await done;
    expect(s.notifier.sent).toHaveLength(0);
    expect(s.db.pendingJobs()).toHaveLength(0);
    expect(s.db.listenersFor("todo.task_started")).toHaveLength(0);
  });

  it("doesn't block a chat workflow that never waits", async () => {
    const s = setup({ workflows: [{ id: "chat", cooldown: 0, triggers: [{ event: "test.go" }], steps: [{ id: "m", message: { text: "hi" } }] }] });
    for (let i = 0; i < 2; i++) {
      expect(s.engine.handleEvent("test.go", {}, null).decisions[0].fired).toBe(true);
      await s.engine.idle();
    }
  });
});
