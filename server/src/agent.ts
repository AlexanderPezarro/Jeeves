import Anthropic from "@anthropic-ai/sdk";
import type { ConfigSource, Effort, ResolvedConfig } from "./config.js";
import type { Db, PlanItem, ReminderLevel } from "./db.js";
import type { Notifier } from "./notify.js";
import { splitToolName, type PluginHost, type PluginTool } from "./plugins.js";
import { localTime } from "./time.js";
import type { CliRunner } from "./cli.js";

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

/** The single Claude call the agent makes. Tests replace it with a scripted fake. */
export type CreateMessage = (params: CreateParams) => Promise<Message>;

export function anthropicCreate(client = new Anthropic()): CreateMessage {
  return (params) => client.beta.messages.create(params);
}

export interface AgentDeps {
  db: Db;
  config: ConfigSource;
  plugins: PluginHost;
  notifier: Notifier;
  /** API path. Ignored when `cli` is set. */
  create?: CreateMessage;
  /** Claude Code CLI path: uses the CLI's logged-in account instead of an API key. */
  cli?: CliRunner;
  now?: () => Date;
}

export interface RunRequest {
  /** Recorded with the run: "plan" for workflow steps; "reply" is kept for older runs. */
  kind: "plan" | "reply";
  prompt: string;
  /** Overrides the global model for this run. */
  model?: string;
  /** Overrides the global effort for this run. */
  effort?: Effort;
  /** Include the recent chat (last 8 messages) in the prompt. */
  history?: boolean;
  rule_id?: string;
  event_id?: number;
  workflow_run_id?: number;
  /** Allowlist of tool names (`<plugin>__<tool>`, `send_message`, `schedule_followup`). Absent = all. */
  tools?: string[];
  /** Record messages and follow-ups instead of sending them, and only offer read-only plugin tools. */
  dryRun?: boolean;
}

/** What a dry run would have done. */
export interface RecordedAction {
  kind: "message" | "followup";
  text: string;
  items?: PlanItem[];
  in_minutes?: number;
}

export interface RunResult {
  runId: number | null;
  status: "ok" | "error" | "refused" | "capped";
  messagesSent: number;
  error?: string;
  recorded?: RecordedAction[];
}

const MAX_TURNS = 12;

export const BUILTIN_TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: "send_message",
    description:
      "Send a message to the user's phone. Use items for a to-do list: one item per task, easiest first, " +
      "each with 2-4 short concrete steps. Use an empty items list for a plain reply. When an item is one of a " +
      "plugin's items (e.g. a to-do task), set plugin and item_id (the task id, as a string) so the phone shows " +
      "that plugin's buttons on it.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["text", "items"],
      properties: {
        text: { type: "string", description: "Short headline or reply, at most two sentences." },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["plugin", "item_id", "title", "steps", "minutes"],
            properties: {
              plugin: { type: ["string", "null"], description: "Plugin the item belongs to, e.g. todo, or null" },
              item_id: { type: ["string", "null"], description: "The item's id in that plugin (a to-do task id as a string), or null" },
              title: { type: "string" },
              steps: { type: "array", items: { type: "string" } },
              minutes: { type: ["integer", "null"] },
            },
          },
        },
      },
    },
  },
  {
    name: "schedule_followup",
    description:
      "Schedule a nudge to the user's phone after a number of minutes, e.g. to check on a task. Set plugin and " +
      "item_id when it is about a plugin's item: the nudge gets that plugin's buttons, and is dropped if the item is finished first.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["in_minutes", "message", "plugin", "item_id"],
      properties: {
        in_minutes: { type: "integer", minimum: 1, maximum: 1440 },
        message: { type: "string" },
        plugin: { type: ["string", "null"] },
        item_id: { type: ["string", "null"] },
      },
    },
  },
];

/** Guidance a plugin gives Claude about its tools (manifest `instructions`). */
export interface PluginInstructions {
  plugin: string;
  title: string;
  text: string;
}

/**
 * The system prompt: who Jeeves is and how it reaches the user, nothing domain-specific. What to do
 * comes from the workflow step's prompt; how to use a plugin's tools comes from that plugin.
 */
export function systemPrompt(config: ResolvedConfig, plugins: PluginInstructions[] = []): string {
  const common = [
    "You are Jeeves, a personal assistant that runs on the user's home server. You reach the user only",
    "through the send_message tool, which becomes a notification on their phone, so keep messages short,",
    "warm and practical. British English.",
    "",
    "Tools named `<plugin>__<tool>` belong to plugins. Only change things through them (for example, mark",
    "a task done) when the user has said so or the request clearly implies it.",
    "When a message item is one of a plugin's items, set its plugin and item_id so the user gets that",
    "plugin's buttons on it.",
    "If you finish without calling send_message, your final text is sent to the user instead.",
  ];
  const fromPlugins = plugins.flatMap((p) => ["", `## ${p.title} (plugin \`${p.plugin}\`)`, p.text.trim()]);
  const about = config.about_me ? ["", "## About the user", config.about_me.trim()] : [];
  return [...common, ...fromPlugins, ...about].join("\n");
}

/** Per-run state: which tools are allowed and, in a dry run, what would have been sent. */
interface RunScope {
  runId: number;
  dryRun: boolean;
  allowed: Set<string>;
  recorded: RecordedAction[];
}

/**
 * Runs one Claude conversation with plugin tools plus the built-in messaging tools.
 * Everything Claude does reaches the phone only through send_message, so a malformed
 * reply can never push garbage to the user.
 */
export class Agent {
  private readonly now: () => Date;

  constructor(private readonly deps: AgentDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private get config(): ResolvedConfig {
    return this.deps.config.current;
  }

  /** Tools offered to Claude for this request: builtins plus plugin tools, filtered by allowlist and dry run. */
  toolsFor(pluginTools: PluginTool[], req: Pick<RunRequest, "tools" | "dryRun">): Anthropic.Beta.Messages.BetaTool[] {
    const allow = req.tools ? new Set(req.tools) : null;
    return [
      ...BUILTIN_TOOLS,
      ...pluginTools
        .filter((t) => !req.dryRun || t.read_only)
        .map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Beta.Messages.BetaTool.InputSchema,
        })),
    ].filter((t) => !allow || allow.has(t.name));
  }

  async run(req: RunRequest): Promise<RunResult> {
    const { db, plugins, create } = this.deps;
    const config = this.config;
    const local = localTime(this.now(), config.timezone);

    if (db.runsOn(local.date) >= config.max_runs_per_day) {
      console.warn(`Daily run cap (${config.max_runs_per_day}) reached; skipping ${req.kind} run`);
      return { runId: null, status: "capped", messagesSent: 0 };
    }

    const tools = this.toolsFor(await plugins.listTools(), req);
    const model = req.model ?? config.model;
    const effort = req.effort ?? config.effort;
    // Only the plugins whose tools this run can use get to add their instructions.
    const offered = new Set(tools.map((t) => t.name.split("__")[0]));
    const system = systemPrompt(config, (plugins.instructions?.() ?? []).filter((p) => offered.has(p.plugin)));

    const context = `It is ${local.weekday} ${local.date}, ${local.time} (${config.timezone}).`;
    const history = req.history
      ? db
          .recentMessages(8)
          .map((m) => `${m.direction === "in" ? "User" : "Jeeves"}: ${m.text}`)
          .join("\n")
      : "";
    const userText = [context, history && `Recent conversation:\n${history}`, req.prompt].filter(Boolean).join("\n\n");

    const runId = db.startRun({
      kind: req.kind,
      rule_id: req.rule_id,
      event_id: req.event_id,
      workflow_run_id: req.workflow_run_id,
      model,
      input: userText,
      local_date: local.date,
    });
    const scope: RunScope = { runId, dryRun: !!req.dryRun, allowed: new Set(tools.map((t) => t.name)), recorded: [] };
    const withRecorded = (r: RunResult): RunResult => (scope.dryRun ? { ...r, recorded: scope.recorded } : r);

    if (this.deps.cli) return withRecorded(await this.runCli({ model, effort, system }, scope, userText, tools));
    if (!create) throw new Error("Agent has neither an API client nor a CLI runner");

    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: userText }];
    let inputTokens = 0;
    let outputTokens = 0;
    let sent = 0;

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const res = await create({
          model,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort },
          system,
          tools,
          messages,
        });
        inputTokens += res.usage.input_tokens;
        outputTokens += res.usage.output_tokens;
        messages.push({ role: "assistant", content: res.content });

        if (res.stop_reason === "refusal") {
          db.finishRun(runId, { status: "refused", transcript: messages, input_tokens: inputTokens, output_tokens: outputTokens });
          return withRecorded({ runId, status: "refused", messagesSent: sent });
        }
        if (res.stop_reason === "pause_turn") continue;
        if (res.stop_reason !== "tool_use") break;

        const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
        for (const block of res.content) {
          if (block.type !== "tool_use") continue;
          const out = await this.callTool(block.name, block.input as Record<string, unknown>, scope);
          if (block.name === "send_message" && !out.isError) sent++;
          results.push({ type: "tool_result", tool_use_id: block.id, content: out.text, is_error: out.isError });
        }
        messages.push({ role: "user", content: results });
      }

      // A run that ended without messaging the phone still owes the user something.
      if (sent === 0) {
        const last = messages.at(-1);
        const text =
          last?.role === "assistant" && Array.isArray(last.content)
            ? last.content
                .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
                .map((b) => b.text)
                .join("\n")
                .trim()
            : "";
        if (text) {
          await this.deliver(text, [], scope);
          sent++;
        }
      }

      db.finishRun(runId, { status: "ok", transcript: messages, input_tokens: inputTokens, output_tokens: outputTokens });
      return withRecorded({ runId, status: "ok", messagesSent: sent });
    } catch (e) {
      db.finishRun(runId, {
        status: "error",
        transcript: messages,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        error: (e as Error).message,
      });
      throw e;
    }
  }

  private async runCli(
    run: { model: string; effort: Effort; system: string },
    scope: RunScope,
    userText: string,
    tools: Anthropic.Beta.Messages.BetaTool[],
  ): Promise<RunResult> {
    const { db } = this.deps;
    const runId = scope.runId;
    let sent = 0;
    let out;
    try {
      out = await this.deps.cli!({
        model: run.model,
        effort: run.effort as "low",
        system: run.system,
        prompt: userText,
        maxTurns: MAX_TURNS,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          input_schema: t.input_schema as Record<string, unknown>,
        })),
        callTool: async (name, input) => {
          const res = await this.callTool(name, input, scope);
          if (name === "send_message" && !res.isError) sent++;
          return res;
        },
      });
    } catch (e) {
      db.finishRun(runId, { status: "error", transcript: [], input_tokens: 0, output_tokens: 0, error: (e as Error).message });
      throw e;
    }
    if (sent === 0 && out.finalText && !out.error) {
      await this.deliver(out.finalText, [], scope);
      sent++;
    }
    const status = out.error ? "error" : "ok";
    db.finishRun(runId, {
      status,
      transcript: out.transcript,
      input_tokens: out.inputTokens,
      output_tokens: out.outputTokens,
      ...(out.error ? { error: out.error } : {}),
    });
    if (out.error) console.warn(`Claude CLI run ${runId} failed: ${out.error}`);
    return { runId, status, messagesSent: sent, ...(out.error ? { error: out.error } : {}) };
  }

  private async callTool(name: string, input: Record<string, unknown>, scope: RunScope) {
    if (!scope.allowed.has(name)) return { text: `Tool ${name} is not available in this run`, isError: true };
    if (name === "send_message") {
      type In = { title: string; steps: string[]; plugin?: string | null; item_id?: string | number | null; minutes?: number | null };
      const items: PlanItem[] = ((input.items ?? []) as In[]).map((i) => ({
        title: i.title,
        steps: i.steps,
        ...(i.plugin && i.item_id !== null && i.item_id !== undefined ? { plugin: i.plugin, item_id: String(i.item_id) } : {}),
        ...(i.minutes !== null && i.minutes !== undefined ? { minutes: i.minutes } : {}),
      }));
      await this.deliver(String(input.text), items, scope);
      return { text: scope.dryRun ? "Sent (dry run: recorded, not delivered)." : "Sent.", isError: false };
    }
    if (name === "schedule_followup") {
      const at = new Date(this.now().getTime() + Number(input.in_minutes) * 60_000);
      if (scope.dryRun) {
        scope.recorded.push({ kind: "followup", text: String(input.message), in_minutes: Number(input.in_minutes) });
      } else {
        const about = typeof input.plugin === "string" && input.item_id !== null && input.item_id !== undefined ? { plugin: input.plugin, item_id: String(input.item_id) } : {};
        this.deps.db.addJob(at, "followup", { message: input.message, ...about });
      }
      return { text: `Scheduled for ${at.toISOString()}.`, isError: false };
    }
    const target = splitToolName(name);
    if (!target) return { text: `Unknown tool ${name}`, isError: true };
    return this.deps.plugins.call(target.plugin, target.tool, input);
  }

  private async deliver(text: string, items: PlanItem[], scope: RunScope) {
    if (scope.dryRun) {
      scope.recorded.push({ kind: "message", text, ...(items.length ? { items } : {}) });
      return;
    }
    await this.sendMessage(text, items, scope.runId);
  }

  /** An item about a plugin's item gets that plugin's notification buttons (manifest `item_actions`). */
  private withActions(item: PlanItem): PlanItem {
    if (!item.plugin || !item.item_id || item.actions) return item;
    const actions = this.deps.plugins.itemActions?.(item.plugin) ?? [];
    return actions.length ? { ...item, actions } : item;
  }

  async sendMessage(
    text: string,
    items: PlanItem[],
    runId: number | null = null,
    extra: { level?: ReminderLevel | null; due_at?: string | null; job_id?: number | null } = {},
  ) {
    const withActions = items.map((i) => this.withActions(i));
    const msg = this.deps.db.addMessage("out", text, withActions.length ? withActions : null, runId, this.now(), extra);
    try {
      await this.deps.notifier.notify(msg);
    } catch (e) {
      // The message is stored, so the app still sees it when it next polls.
      console.warn(`Push failed for message ${msg.id}: ${(e as Error).message}`);
    }
    return msg;
  }
}
