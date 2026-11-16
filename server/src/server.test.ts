import { beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { Agent, type CreateMessage } from "./agent.js";
import type { CliRunInput, CliRunner } from "./cli.js";
import { buildApp } from "./app.js";
import { configSchema, type Config } from "./config.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import type { MessageRow } from "./db.js";
import type { Notifier } from "./notify.js";
import type { PluginHost, PluginTool, ToolResult } from "./plugins.js";
import { evaluateRules } from "./rules.js";

type Message = Anthropic.Beta.Messages.BetaMessage;
type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

const config: Config = configSchema.parse({
  timezone: "Europe/London",
  plugins: [],
  rules: [
    {
      id: "arrive-home",
      event: "wifi.connected",
      when: { ssid: "home", after: "17:00", before: "22:30", min_away_minutes: 120 },
      action: { type: "plan", prompt: "I'm home. Plan my evening." },
    },
    { id: "manual-plan", event: "manual.plan", cooldown: 5, action: { type: "plan", prompt: "Plan now." } },
  ],
});

/** A to-do plugin stand-in with two tasks; laundry has a timed follow-up. */
class FakeTodo implements PluginHost {
  calls: { tool: string; args: Record<string, unknown> }[] = [];
  constructor(private readonly clock: { now: Date }) {}
  async listTools(): Promise<PluginTool[]> {
    return ["list_due_tasks", "start_task", "complete_task"].map((tool) => ({
      name: `todo__${tool}`,
      plugin: "todo",
      tool,
      description: tool,
      input_schema: { type: "object", properties: {} },
    }));
  }
  async call(_plugin: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ tool, args });
    if (tool === "list_due_tasks") {
      return {
        isError: false,
        text: JSON.stringify([
          { id: 1, name: "Wash the dishes", effort: 1, est_minutes: 10, how_to: ["Hot water", "Glasses first"] },
          { id: 2, name: "Laundry", effort: 2, est_minutes: 15, how_to: ["Sort", "40 degrees"] },
        ]),
      };
    }
    if (tool === "start_task") {
      const at = new Date(this.clock.now.getTime() + 75 * 60_000).toISOString();
      return { isError: false, text: JSON.stringify({ task: { id: args.task_id }, followups: [{ at, message: "Move it to the dryer" }] }) };
    }
    return { isError: false, text: JSON.stringify({ id: args.task_id, state: "done" }) };
  }
}

class RecordingNotifier implements Notifier {
  sent: MessageRow[] = [];
  async notify(m: MessageRow) {
    this.sent.push(m);
  }
}

function reply(stop_reason: Message["stop_reason"], content: unknown[]): Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    usage: { input_tokens: 100, output_tokens: 20 },
  } as unknown as Message;
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

/** Scripted Claude: returns the queued replies in order and records every request. */
function scriptedClaude(script: Message[]) {
  const requests: Params[] = [];
  const create: CreateMessage = async (params) => {
    requests.push(structuredClone(params));
    const next = script.shift();
    if (!next) throw new Error("Script ran out");
    return next;
  };
  return { create, requests };
}

function setup(script: Message[] = []) {
  const clock = { now: new Date("2026-11-14T12:00:00Z") };
  const now = () => clock.now;
  const db = new Db();
  const plugins = new FakeTodo(clock);
  const notifier = new RecordingNotifier();
  const claude = scriptedClaude(script);
  const agent = new Agent({ db, config, plugins, notifier, create: claude.create, now });
  const engine = new Engine(db, config, plugins, agent, now);
  const app = buildApp({ db, engine, pairingCode: "pair-me-please" });
  return { clock, db, plugins, notifier, claude, engine, app };
}

async function pair(app: ReturnType<typeof setup>["app"]) {
  const res = await app.inject({ method: "POST", url: "/pair", payload: { code: "pair-me-please", name: "Pixel" } });
  expect(res.statusCode).toBe(200);
  return { authorization: `Bearer ${res.json().token}` };
}

describe("rules", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  const arrive = (iso: string, ssid = "home") => {
    s.clock.now = new Date(iso);
    const event = s.db.insertEvent("wifi.connected", { ssid }, 1, s.clock.now);
    return evaluateRules(config.rules, event, s.db, config.timezone, s.clock.now)[0];
  };

  it("fires when home after 17:00 and away for over two hours", () => {
    s.db.insertEvent("wifi.disconnected", { ssid: "home" }, 1, new Date("2026-11-14T09:00:00Z"));
    expect(arrive("2026-11-14T18:20:00Z")).toMatchObject({ fire: true });
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
    expect(evaluateRules(config.rules, event, s.db, config.timezone, s.clock.now)[0].fire).toBe(true);
  });

  it("fires at most once a day", () => {
    s.db.insertEvent("wifi.disconnected", { ssid: "home" }, 1, new Date("2026-11-14T09:00:00Z"));
    s.db.recordFire("arrive-home", null, "2026-11-14", new Date("2026-11-14T18:00:00Z"));
    expect(arrive("2026-11-14T19:30:00Z").reason).toBe("already fired today");
  });
});

describe("arrive home, end to end", () => {
  it("plans the evening and pushes an easiest-first list", async () => {
    const s = setup([
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
    ]);
    const headers = await pair(s.app);

    await s.app.inject({ method: "POST", url: "/events", headers, payload: { type: "wifi.disconnected", payload: { ssid: "home" } } });
    s.clock.now = new Date("2026-11-14T18:20:00Z");
    const res = await s.app.inject({ method: "POST", url: "/events", headers, payload: { type: "wifi.connected", payload: { ssid: "home" } } });
    expect(res.json().rules).toEqual([{ id: "arrive-home", fired: true, reason: "conditions met" }]);
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

    const runs = s.db.recentRuns() as { status: string; input_tokens: number }[];
    expect(runs[0]).toMatchObject({ status: "ok", input_tokens: 300 });
  });

  it("does not call Claude when no rule fires", async () => {
    const s = setup();
    const headers = await pair(s.app);
    s.clock.now = new Date("2026-11-14T10:00:00Z");
    await s.app.inject({ method: "POST", url: "/events", headers, payload: { type: "wifi.connected", payload: { ssid: "home" } } });
    await s.engine.idle();
    expect(s.claude.requests).toHaveLength(0);
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
    const s = setup([
      reply("tool_use", [toolUse("t1", "todo__complete_task", { task_id: 1 })]),
      reply("tool_use", [toolUse("t2", "send_message", { text: "Nice one, dishes ticked off.", items: [] })]),
      reply("end_turn", []),
    ]);
    const headers = await pair(s.app);
    await s.app.inject({ method: "POST", url: "/messages", headers, payload: { text: "done with the dishes" } });
    await s.engine.idle();
    expect(s.plugins.calls).toContainEqual({ tool: "complete_task", args: { task_id: 1 } });
    expect(s.notifier.sent.map((m) => m.text)).toEqual(["Nice one, dishes ticked off."]);
  });

  it("records a refusal without messaging the phone", async () => {
    const s = setup([reply("refusal", [])]);
    const headers = await pair(s.app);
    await s.app.inject({ method: "POST", url: "/plan", headers });
    await s.engine.idle();
    expect(s.notifier.sent).toHaveLength(0);
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
