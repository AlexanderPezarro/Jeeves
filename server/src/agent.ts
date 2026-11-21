import Anthropic from "@anthropic-ai/sdk";
import type { ConfigSource, ResolvedConfig } from "./config.js";
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
  /** "plan": a trigger fired. "reply": the user wrote to Jeeves. */
  kind: "plan" | "reply";
  prompt: string;
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
      "Send a message to Alexander's phone. Use items for a to-do list: one item per task, easiest first, " +
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
      "Schedule a nudge to Alexander's phone after a number of minutes, e.g. to check on a task. Set plugin and " +
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

function systemPrompt(config: ResolvedConfig, kind: RunRequest["kind"]): string {
  const common = [
    "You are Jeeves, Alexander's household assistant. You help him get through chores and goals",
    "with as little friction as possible. You talk to him through notifications on his phone, so",
    "keep messages short, warm and practical. British English.",
    "",
    "Tools named `<plugin>__<tool>` belong to plugins; the `todo` plugin owns his chores and tasks.",
    "Only change task state (start, complete, skip, snooze) when he has said so or the trigger implies it.",
  ];
  const plan = [
    "",
    "When a trigger fires: look at the due tasks, then call send_message exactly once with a to-do list.",
    "Order it easiest first so he builds momentum. Leave out anything that does not fit the time he has.",
    "Give each item 2-4 concrete steps taken from the chore's how-to notes. Mention overdue tasks gently.",
    "If nothing is due, send a short message saying so instead of inventing work.",
  ];
  const reply = [
    "",
    "When he writes to you: work out what he means (for example 'done with dishes, laundry is in'),",
    "update the matching tasks with the plugin tools, then call send_message once with a short reply.",
    "Starting a timed chore schedules its follow-ups automatically; do not schedule them again.",
  ];
  const about = config.about_me ? ["", "About Alexander:", config.about_me] : [];
  return [...common, ...(kind === "plan" ? plan : reply), ...about].join("\n");
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

    const context = `It is ${local.weekday} ${local.date}, ${local.time} (${config.timezone}).`;
    const history =
      req.kind === "reply"
        ? db
            .recentMessages(8)
            .map((m) => `${m.direction === "in" ? "Alexander" : "Jeeves"}: ${m.text}`)
            .join("\n")
        : "";
    const userText = [context, history && `Recent conversation:\n${history}`, req.prompt].filter(Boolean).join("\n\n");

    const runId = db.startRun({
      kind: req.kind,
      rule_id: req.rule_id,
      event_id: req.event_id,
      workflow_run_id: req.workflow_run_id,
      model: config.model,
      input: userText,
      local_date: local.date,
    });
    const scope: RunScope = { runId, dryRun: !!req.dryRun, allowed: new Set(tools.map((t) => t.name)), recorded: [] };
    const withRecorded = (r: RunResult): RunResult => (scope.dryRun ? { ...r, recorded: scope.recorded } : r);

    if (this.deps.cli) return withRecorded(await this.runCli(req, scope, userText, tools));
    if (!create) throw new Error("Agent has neither an API client nor a CLI runner");

    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: userText }];
    let inputTokens = 0;
    let outputTokens = 0;
    let sent = 0;

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const res = await create({
          model: config.model,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: config.effort },
          system: systemPrompt(config, req.kind),
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

      // A plan run that ended without messaging the phone still owes Alexander something.
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

  private async runCli(req: RunRequest, scope: RunScope, userText: string, tools: Anthropic.Beta.Messages.BetaTool[]): Promise<RunResult> {
    const { db } = this.deps;
    const config = this.config;
    const runId = scope.runId;
    let sent = 0;
    let out;
    try {
      out = await this.deps.cli!({
        model: config.model,
        effort: config.effort as "low",
        system: systemPrompt(config, req.kind),
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
