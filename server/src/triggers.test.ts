import { beforeEach, describe, expect, it } from "vitest";
import { workflowSchema, type WorkflowInput } from "./config.js";
import { evalCondExpr } from "./conditions.js";
import { render, renderDeep } from "./template.js";
import { ARRIVE_HOME, setup } from "./testkit.js";
import { evaluateWorkflows } from "./triggers.js";

describe("triggers", () => {
  let s: ReturnType<typeof setup>;
  const wfs = () => s.config.current.workflows;
  beforeEach(() => {
    s = setup();
  });

  const arrive = (iso: string, ssid = "home") => {
    s.clock.now = new Date(iso);
    const event = s.db.insertEvent("wifi.connected", { ssid }, 1, s.clock.now);
    return evaluateWorkflows(wfs(), event, s.db, "Europe/London", s.clock.now)[0];
  };

  it("fires when home after 17:00 and away for over two hours", () => {
    s.db.insertEvent("wifi.disconnected", { ssid: "home" }, 1, new Date("2026-11-14T09:00:00Z"));
    expect(arrive("2026-11-14T18:20:00Z")).toMatchObject({ fired: true, workflow_id: "arrive-home" });
  });

  it("does not fire too early, after a short trip, or on another network", () => {
    s.db.insertEvent("wifi.disconnected", { ssid: "home" }, 1, new Date("2026-11-14T09:00:00Z"));
    expect(arrive("2026-11-14T16:00:00Z").reason).toBe("before 17:00");
    s.db.insertEvent("wifi.disconnected", { ssid: "home" }, 1, new Date("2026-11-14T17:50:00Z"));
    expect(arrive("2026-11-14T18:20:00Z").reason).toBe("away 30 min, needs 120");
    expect(arrive("2026-11-14T18:20:00Z", "cafe").reason).toMatch(/SSID cafe/);
  });

  it("uses the phone's away_minutes when the disconnect was missed", () => {
    s.clock.now = new Date("2026-11-14T18:20:00Z");
    const event = s.db.insertEvent("wifi.connected", { ssid: "home", away_minutes: 300 }, 1, s.clock.now);
    expect(evaluateWorkflows(wfs(), event, s.db, "Europe/London", s.clock.now)[0].fired).toBe(true);
  });

  it("fires at most once a day", () => {
    s.db.insertEvent("wifi.disconnected", { ssid: "home" }, 1, new Date("2026-11-14T09:00:00Z"));
    s.db.recordFire("arrive-home", null, "2026-11-14", new Date("2026-11-14T18:00:00Z"));
    expect(arrive("2026-11-14T19:30:00Z").reason).toBe("already fired today");
  });

  it("fires if any trigger passes, and checks plugin-event conditions against the payload", () => {
    const wf = workflowSchema.parse({
      id: "laundry-check",
      cooldown: 0,
      triggers: [
        { event: "todo.task_started", when: { conditions: [{ path: "event.chore_id", eq: "dishes" }] } },
        { event: "todo.task_started", when: { conditions: [{ path: "event.chore_id", eq: "laundry" }] } },
      ],
      steps: [{ id: "m", message: { text: "x" } }],
    } satisfies WorkflowInput);
    const ev = (chore: string) => s.db.insertEvent("todo.task_started", { chore_id: chore }, null, s.clock.now);
    expect(evaluateWorkflows([wf], ev("laundry"), s.db, "Europe/London", s.clock.now)[0]).toMatchObject({ fired: true, trigger_index: 1 });
    expect(evaluateWorkflows([wf], ev("bins"), s.db, "Europe/London", s.clock.now)[0]).toMatchObject({
      fired: false,
      reason: 'condition not met: event.chore_id is "dishes"',
    });
  });

  it("ignores disabled workflows", () => {
    const off = workflowSchema.parse({ ...ARRIVE_HOME, enabled: false });
    const event = s.db.insertEvent("wifi.connected", { ssid: "home", away_minutes: 300 }, 1, new Date("2026-11-14T18:20:00Z"));
    expect(evaluateWorkflows([off], event, s.db, "Europe/London", new Date("2026-11-14T18:20:00Z"))).toEqual([]);
  });
});

describe("workflow schema", () => {
  const base = { id: "w", triggers: [{ event: "manual.plan" }] };

  it("rejects duplicate step ids, including inside branches", () => {
    const r = workflowSchema.safeParse({
      ...base,
      steps: [{ id: "a", message: { text: "x" } }, { id: "b", if: { path: "event.x", eq: 1 }, then: [{ id: "a", stop: {} }] }],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.message)).toContain('duplicate step id "a"');
  });

  it("only allows references to the event and to earlier steps", () => {
    const later = workflowSchema.safeParse({
      ...base,
      steps: [
        { id: "a", message: { text: "{{steps.b.text}}" } },
        { id: "b", message: { text: "hi" } },
      ],
    });
    expect(later.error!.issues[0].message).toMatch(/does not run before/);
    const bad = workflowSchema.safeParse({ ...base, steps: [{ id: "a", message: { text: "{{env.HOME}}" } }] });
    expect(bad.success).toBe(false);
    const ok = workflowSchema.safeParse({
      ...base,
      steps: [
        { id: "a", call: { plugin: "todo", tool: "list_due_tasks" } },
        { id: "b", message: { text: "{{event.ssid}} {{steps.a.0.name}}" } },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("checks tool names and cron expressions", () => {
    expect(workflowSchema.safeParse({ ...base, steps: [{ id: "a", claude: { prompt: "p", tools: ["rm -rf"] } }] }).success).toBe(false);
    expect(workflowSchema.safeParse({ id: "w", triggers: [{ schedule: "not cron" }], steps: [{ id: "a", stop: {} }] }).success).toBe(false);
    expect(workflowSchema.safeParse({ id: "w", triggers: [{ schedule: "0 9 * * sat,sun" }], steps: [{ id: "a", stop: null }] }).success).toBe(true);
  });
});

describe("templates and conditions", () => {
  const ctx = { event: { ssid: "home", n: 3, tags: ["a", "b"] }, steps: { a: { id: 7, items: [{ name: "Dishes" }] } } };

  it("renders event and step values, JSON-stringifying non-strings, and warns on unknown paths", () => {
    const warnings: string[] = [];
    expect(render("On {{event.ssid}}, task {{steps.a.id}}, {{steps.a.items.0}} {{event.nope}}", ctx, warnings)).toBe(
      'On home, task 7, {"name":"Dishes"} ',
    );
    expect(warnings).toEqual(["{{event.nope}} is empty"]);
    expect(renderDeep({ task_id: "{{steps.a.id}}", label: "#{{steps.a.id}}" }, ctx)).toEqual({ task_id: 7, label: "#7" });
  });

  it("evaluates operators, all/any and truthiness", () => {
    expect(evalCondExpr({ path: "event.n", gt: 2, lte: 3 }, ctx)).toBe(true);
    expect(evalCondExpr({ path: "event.tags", contains: "b" }, ctx)).toBe(true);
    expect(evalCondExpr({ any: [{ path: "event.ssid", eq: "cafe" }, { path: "steps.a.id", exists: true }] }, ctx)).toBe(true);
    expect(evalCondExpr({ all: [{ path: "event.ssid", ne: "home" }, { path: "event.n" }] }, ctx)).toBe(false);
    expect(evalCondExpr({ path: "event.missing" }, ctx)).toBe(false);
  });
});
