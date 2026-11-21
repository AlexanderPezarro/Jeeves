/**
 * Test doubles shared by the server tests and the Playwright test server: a fake to-do plugin,
 * a recording notifier and a scripted Claude. Nothing here talks to the network.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { stringify } from "yaml";
import { Agent, type CreateMessage } from "./agent.js";
import { buildApp } from "./app.js";
import { staticConfig, type ConfigSource, type WorkflowInput } from "./config.js";
import { ConfigStore } from "./configstore.js";
import { Db, type MessageRow, type PhoneCommandRow } from "./db.js";
import { Engine } from "./engine.js";
import type { Notifier } from "./notify.js";
import type { PluginHost, PluginTool, ToolResult } from "./plugins.js";

export type Message = Anthropic.Beta.Messages.BetaMessage;
export type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** The two legacy rules every scenario test used, as workflows. */
export const ARRIVE_HOME: WorkflowInput = {
  id: "arrive-home",
  triggers: [{ event: "wifi.connected", when: { ssid: "home", after: "17:00", before: "22:30", min_away_minutes: 120 } }],
  steps: [{ id: "plan", claude: { prompt: "I'm home. Plan my evening." } }],
};
export const MANUAL_PLAN: WorkflowInput = {
  id: "manual-plan",
  cooldown: 5,
  triggers: [{ event: "manual.plan" }],
  steps: [{ id: "plan", claude: { prompt: "Plan now." } }],
};

/** The default chat workflow: a chat message becomes message.received, answered by Claude with the recent chat. */
export const CHAT_REPLY: WorkflowInput = {
  id: "chat-reply",
  cooldown: 0,
  triggers: [{ event: "message.received" }],
  steps: [{ id: "reply", claude: { prompt: 'I wrote: "{{event.text}}". Reply once.', history: true } }],
};

const READ_ONLY = new Set(["list_due_tasks", "get_chore"]);

/** A to-do plugin stand-in with two tasks; laundry has a timed follow-up. */
export class FakeTodo implements PluginHost {
  calls: { plugin: string; tool: string; args: Record<string, unknown> }[] = [];
  constructor(private readonly clock: { now: Date }) {}
  async listTools(): Promise<PluginTool[]> {
    return ["list_due_tasks", "get_chore", "start_task", "complete_task", "skip_task", "snooze_task"].map((tool) => ({
      name: `todo__${tool}`,
      plugin: "todo",
      tool,
      description: tool,
      input_schema: { type: "object", properties: tool === "list_due_tasks" ? {} : { task_id: { type: "integer" } } },
      read_only: READ_ONLY.has(tool),
      title: null,
      output_schema: null,
      plugin_title: "Chores",
    }));
  }
  instructions() {
    return [{ plugin: "todo", title: "Chores", text: "Plan easiest first." }];
  }
  itemActions(plugin: string) {
    return plugin === "todo" ? [{ id: "done", label: "Done", style: "primary" as const }, { id: "skip", label: "Skip" }] : [];
  }
  async call(plugin: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ plugin, tool, args });
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
    if (tool === "explode") return { isError: true, text: "kaboom" };
    return { isError: false, text: JSON.stringify({ id: args.task_id, state: "done" }) };
  }
}

export class RecordingNotifier implements Notifier {
  sent: MessageRow[] = [];
  commands: PhoneCommandRow[] = [];
  /** How many devices a command "reaches"; 0 simulates no push set up. */
  devices = 1;
  async notify(m: MessageRow) {
    this.sent.push(m);
  }
  async command(row: PhoneCommandRow) {
    this.commands.push(row);
    return this.devices;
  }
}

export function reply(stop_reason: Message["stop_reason"], content: unknown[]): Message {
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

export const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

/** Scripted Claude: returns the queued replies in order and records every request. */
export function scriptedClaude(script: Message[]) {
  const requests: Params[] = [];
  const create: CreateMessage = async (params) => {
    requests.push(structuredClone(params));
    const next = script.shift();
    if (!next) throw new Error("Script ran out");
    return next;
  };
  return { create, requests, script };
}

/** A tmp config dir with jeeves.yaml (globals) and one file per workflow. */
export function tmpConfigDir(globals: Record<string, unknown> = {}, workflows: WorkflowInput[] = [], jeevesYaml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jeeves-config-"));
  mkdirSync(join(dir, "workflows"));
  writeFileSync(join(dir, "jeeves.yaml"), jeevesYaml ?? stringify({ timezone: "Europe/London", ...globals }));
  for (const wf of workflows) writeFileSync(join(dir, "workflows", `${wf.id}.yaml`), stringify(wf));
  return dir;
}

export interface SetupOptions {
  script?: Message[];
  workflows?: WorkflowInput[];
  globals?: Record<string, unknown>;
  /** Use a real ConfigStore on a tmp dir instead of a static config. */
  store?: boolean;
  db?: Db;
  clock?: { now: Date };
  plugins?: PluginHost;
}

export function setup(opts: SetupOptions = {}) {
  const clock = opts.clock ?? { now: new Date("2026-11-14T12:00:00Z") };
  const now = () => clock.now;
  const db = opts.db ?? new Db();
  const workflows = opts.workflows ?? [ARRIVE_HOME, MANUAL_PLAN, CHAT_REPLY];
  let config: ConfigSource;
  let store: ConfigStore | undefined;
  if (opts.store) {
    store = new ConfigStore(tmpConfigDir({ todo_plugin: "todo", ...opts.globals }, workflows), now);
    config = store;
  } else {
    config = staticConfig({ timezone: "Europe/London", todo_plugin: "todo", ...opts.globals }, workflows);
  }
  const fake = new FakeTodo(clock);
  const plugins = opts.plugins ?? fake;
  const notifier = new RecordingNotifier();
  const claude = scriptedClaude(opts.script ?? []);
  const agent = new Agent({ db, config, plugins, notifier, create: claude.create, now });
  const engine = new Engine(db, config, plugins, agent, now);
  const app = buildApp({ db, engine, pairingCode: "pair-me-please", store, config, plugins, now });
  return { clock, db, plugins: fake, notifier, claude, agent, engine, app, store, config };
}

export async function pair(app: ReturnType<typeof setup>["app"]) {
  const res = await app.inject({ method: "POST", url: "/pair", payload: { code: "pair-me-please", name: "Pixel" } });
  if (res.statusCode !== 200) throw new Error(`pair failed: ${res.statusCode}`);
  return { authorization: `Bearer ${res.json().token}` };
}
