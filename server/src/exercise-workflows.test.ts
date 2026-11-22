import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { workflowSchema, type WorkflowInput } from "./config.js";
import type { PluginHost, PluginTool, ToolResult } from "./plugins.js";
import { reply, setup, toolUse } from "./testkit.js";

/** The shipped example workflows, parsed with the real schema. */
const example = (id: string) => workflowSchema.parse(parse(readFileSync(new URL(`../../config.example/workflows/${id}.yaml`, import.meta.url), "utf8"))) as WorkflowInput;

const TOOLS = ["get_today", "get_week", "plan_sessions", "move_session", "mark_session"];

/** A stand-in for workout-app: get_today returns whatever `today` is set to. */
class FakeExercise implements PluginHost {
  calls: { tool: string; args: Record<string, unknown> }[] = [];
  today: Record<string, unknown> = { date: "2026-11-14", pending: [], week: { goal: 3, done: 0 } };
  async listTools(): Promise<PluginTool[]> {
    return TOOLS.map((tool) => ({
      name: `exercise__${tool}`,
      plugin: "exercise",
      tool,
      description: tool,
      input_schema: { type: "object", properties: {} },
      read_only: tool.startsWith("get_") || tool === "plan_sessions",
      title: null,
      output_schema: null,
      plugin_title: "Training",
    }));
  }
  async call(_plugin: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ tool, args });
    return { isError: false, text: JSON.stringify(tool === "get_today" ? this.today : { ok: true }) };
  }
}

const SESSION = { item_id: "2026-11-14|training", session_type: "training", label: "Upper body" };
const minutes = (s: ReturnType<typeof setup>, n: number) => (s.clock.now = new Date(s.clock.now.getTime() + n * 60_000));

function today(pending: unknown[]) {
  const plugin = new FakeExercise();
  plugin.today = { date: "2026-11-14", pending, week: { goal: 3, done: 1 } };
  const s = setup({ workflows: [example("training-today")], plugins: plugin });
  return { s, plugin };
}

const lastRun = (s: ReturnType<typeof setup>) => s.db.workflowRuns({ workflow_id: "training-today" })[0];

describe("training-today", () => {
  it("stops on a rest day without messaging", async () => {
    const { s } = today([]);
    s.engine.runNow("training-today");
    await s.engine.idle();
    expect(lastRun(s)).toMatchObject({ status: "stopped" });
    expect(s.notifier.sent).toEqual([]);
  });

  it("sends a heads-up, waits for session time, nudges, and stops on a matching session_done", async () => {
    const { s } = today([SESSION]);
    s.engine.runNow("training-today");
    await s.engine.idle();
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Today: Upper body (1/3 this week)"]);
    expect(s.notifier.sent[0].items?.[0]).toMatchObject({ plugin: "exercise", item_id: "2026-11-14|training" });
    expect(lastRun(s).status).toBe("waiting");

    minutes(s, 6 * 60 + 1); // 12:00 -> past 18:00 London
    await s.engine.runDueJobs();
    await s.engine.idle();
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Today: Upper body (1/3 this week)", "Time for Upper body"]);
    expect(s.notifier.sent[1].level).toBe("loud");
    expect(lastRun(s).status).toBe("waiting");

    // Another session's event doesn't end the nudge; the matching one does.
    s.engine.handleEvent("exercise.session_done", { ...SESSION, item_id: "2026-11-14|cardio:Saturday" }, null);
    await s.engine.idle();
    expect(lastRun(s).status).toBe("waiting");
    s.engine.handleEvent("exercise.session_done", SESSION, null);
    await s.engine.idle();
    // cancel_on also lists session_done (for the pre-nudge wait), so it ends the run as "cancelled".
    expect(lastRun(s).status).toBe("cancelled");
    expect(s.db.pendingJobs()).toHaveLength(0);
    minutes(s, 120);
    await s.engine.runDueJobs();
    expect(s.notifier.sent).toHaveLength(2);
  });

  it("is cancelled by a matching session_missed (skip) while waiting for session time", async () => {
    const { s } = today([SESSION]);
    s.engine.runNow("training-today");
    await s.engine.idle();
    s.engine.handleEvent("exercise.session_missed", { ...SESSION, reason: "skipped" }, null);
    await s.engine.idle();
    expect(lastRun(s).status).toBe("cancelled");
    minutes(s, 7 * 60);
    await s.engine.runDueJobs();
    expect(s.notifier.sent).toHaveLength(1);
  });

  it("is cancelled by a session_done that arrives before the nudge", async () => {
    const { s } = today([SESSION]);
    s.engine.runNow("training-today");
    await s.engine.idle();
    s.engine.handleEvent("exercise.session_done", SESSION, null);
    await s.engine.idle();
    expect(lastRun(s).status).toBe("cancelled");
    minutes(s, 7 * 60);
    await s.engine.runDueJobs();
    expect(s.notifier.sent).toHaveLength(1);
  });
});

describe("missed-session", () => {
  const missed = { ...SESSION, date: "2026-11-14", reason: "skipped", week_done: 1, week_goal: 3 };
  const script = () => [reply("tool_use", [toolUse("t1", "send_message", { text: "Thursday evening is free?", items: [] })]), reply("end_turn", [])];

  it("does not fire when the week is not behind", async () => {
    const s = setup({ workflows: [example("missed-session")], plugins: new FakeExercise(), script: script() });
    const { decisions } = s.engine.handleEvent("exercise.session_missed", { ...missed, behind: false }, null);
    await s.engine.idle();
    expect(decisions.find((d) => d.workflow_id === "missed-session")?.fired).toBe(false);
    expect(s.claude.requests).toHaveLength(0);
  });

  it("fires when behind, offers only the allowlisted tools, and works with no calendar plugin", async () => {
    const s = setup({ workflows: [example("missed-session")], plugins: new FakeExercise(), script: script() });
    const { decisions } = s.engine.handleEvent("exercise.session_missed", { ...missed, behind: true }, null);
    await s.engine.idle();
    expect(decisions.find((d) => d.workflow_id === "missed-session")?.fired).toBe(true);
    const names = s.claude.requests[0].tools!.map((t) => (t as { name: string }).name).sort();
    expect(names).toEqual(["exercise__get_week", "exercise__plan_sessions", "send_message"]);
    expect(JSON.stringify(s.claude.requests[0].messages[0].content)).toContain("Upper body on 2026-11-14 was skipped");
    expect(s.db.workflowRuns({ workflow_id: "missed-session" })[0].status).toBe("ok");
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Thursday evening is free?"]);
  });
});
