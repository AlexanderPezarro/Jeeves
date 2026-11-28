import Anthropic from "@anthropic-ai/sdk";
import type { ConfigSource, Effort, ResolvedConfig } from "./config.js";
import type { Db, PlanItem, ReminderLevel } from "./db.js";
import type { Notifier } from "./notify.js";
import { splitToolName, type PluginHost, type PluginTool } from "./plugins.js";
import { fromLocal, localTime } from "./time.js";
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
  /** Makes a short conversation title from its first message; null means "no title". Defaults to a small Claude call. */
  titles?: (firstText: string) => Promise<string | null>;
  /** Where the workflow tools read and write workflows (the ConfigStore). Without it they aren't offered. */
  workflows?: WorkflowStore;
  /** Event types a trigger can listen for, for list_workflows. */
  eventInfo?: () => { type: string; title?: string | null; description?: string | null; payload_schema?: unknown; source?: string }[];
}

/** The part of ConfigStore the workflow tools use. */
export interface WorkflowStore {
  listWorkflows(): { id: string; description: string | null; enabled: boolean; error: string | null; triggers: unknown[] }[];
  readWorkflow(id: string): { yaml: string; hash: string } | undefined;
  writeWorkflow(id: string, input: { yaml: string }, expectedHash: string | null | undefined): unknown;
}

/** Reminders set from a Claude run are stored as reminder jobs under this "plugin" name. */
export const CHAT_REMINDER_PLUGIN = "jeeves";

/** Cheap model for conversation titles. */
export const TITLE_MODEL = "claude-haiku-5-5";
const TITLE_SYSTEM = "You write short titles for chat conversations. Reply with the title only: 3 to 6 words, no quotes, no trailing punctuation.";

export function cleanTitle(raw: string): string | null {
  let t = raw.trim().split("\n")[0]?.trim() ?? "";
  t = t.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").replace(/[.!?:;,\s]+$/g, "").trim();
  if (t.length > 60) t = t.slice(0, 60).trimEnd();
  return t || null;
}

export interface RunRequest {
  /** Recorded with the run: "plan" for workflow steps; "reply" is kept for older runs. */
  kind: "plan" | "reply";
  prompt: string;
  /** Overrides the global model for this run. */
  model?: string;
  /** Overrides the global effort for this run. */
  effort?: Effort;
  /** Include every earlier message of the current conversation in the prompt. */
  history?: boolean;
  /** The conversation this run belongs to. Absent: the run's workflow run decides, creating one on its first message. */
  conversation_id?: number;
  /** The incoming chat message, already in the prompt, so history leaves it out. */
  exclude_message_id?: number;
  rule_id?: string;
  event_id?: number;
  workflow_run_id?: number;
  /** Allowlist of tool names (`<plugin>__<tool>` or a built-in). Absent = all. */
  tools?: string[];
  /** Also offer the workflow tools (list_workflows, get_workflow, save_workflow). */
  workflows?: boolean;
  /** Record messages and follow-ups instead of sending them, and only offer read-only plugin tools. */
  dryRun?: boolean;
}

/** What a dry run would have done. */
export interface RecordedAction {
  kind: "message" | "followup" | "reminder" | "workflow";
  text: string;
  items?: PlanItem[];
  in_minutes?: number;
  at?: string;
  workflow_id?: string;
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
  {
    name: "set_reminder",
    description:
      "Set a one-off reminder: at a given local date and time, the user's phone gets the text as a notification " +
      "(it shows under Coming up until then, and can be snoozed). Use it for anything the user asks to be reminded " +
      "of on a day, e.g. \"remind me to book a haircut on Friday at 9\". Any time in the future, days or months ahead. " +
      "If the user gives a day but no time, pick a sensible one (09:00) and say so in your reply.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["at", "text", "level"],
      properties: {
        at: { type: "string", description: "Local wall-clock time in the user's time zone, YYYY-MM-DDTHH:MM" },
        text: { type: "string", description: "What the notification says, e.g. \"Book a haircut\"" },
        level: {
          type: "string",
          enum: ["notify", "loud", "alarm"],
          description: "notify (normal notification), loud (makes a sound even when the phone is quiet) or alarm (rings like an alarm clock). Default to notify.",
        },
      },
    },
  },
  {
    name: "list_reminders",
    description: "List the one-off reminders still to come that were set with set_reminder, with their ids.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
  {
    name: "cancel_reminder",
    description: "Cancel a reminder set with set_reminder, by the id list_reminders or set_reminder gave.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
  },
];

/** Offered only to steps with `workflows: true` (the chat), since they change the user's automations. */
export const WORKFLOW_TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: "list_workflows",
    description:
      "List the user's workflows (id, description, triggers, enabled) and every event type a trigger can listen for, " +
      "with the fields each event carries. Call this before saying whether a workflow is possible.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
  {
    name: "get_workflow",
    description: "Read one workflow's YAML file.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
  },
  {
    name: "save_workflow",
    description:
      "Create a workflow, or replace one (replace: true), from its full YAML. The server validates it and refuses " +
      "invalid YAML with the reasons, so fix and retry. The workflow is live as soon as it is saved.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "yaml", "replace"],
      properties: {
        id: { type: "string", description: "Lowercase letters, digits and dashes; must equal the id: in the YAML" },
        yaml: { type: "string", description: "The whole workflow file" },
        replace: { type: "boolean", description: "true to overwrite an existing workflow with this id" },
      },
    },
  },
];

const WORKFLOW_TOOL_NAMES = new Set(WORKFLOW_TOOLS.map((t) => t.name));

/** What Claude is told about workflows when it may write them. Kept in step with the README. */
export const WORKFLOW_GUIDE = `## Workflows
You can read and write the user's workflows (list_workflows, get_workflow, save_workflow). A workflow is
a YAML file that fires on events and runs steps in order, without Claude deciding whether it fires.
When the user asks for an automation, check list_workflows for the events available, then describe the
workflow you'd create in a sentence or two and ask before saving, unless they've clearly asked you to
go ahead. After saving, say what it does in plain words.

\`\`\`yaml
id: work-go-home                # lowercase, digits, dashes; equals the file name
description: Nudge me to go home 8 hours after I get to work
cooldown: daily                 # "daily" (default: fires at most once a local day) or minutes between fires, 0 for none
triggers:
  - event: wifi.connected       # or wifi.disconnected, message.received, manual.plan, a plugin event, ...
    when:                       # all optional
      ssid: Office WiFi         # a network name or a list (wifi events only)
      after: "07:00"            # local HH:MM
      before: "12:00"
      days: [mon, tue, wed, thu, fri]
      min_away_minutes: 120     # wifi.connected: away from that network at least this long
      conditions: [{ path: event.ssid, eq: Office WiFi }]
  - schedule: "0 9 * * sat"     # cron, local time
cancel_on:                      # optional: while the run is waiting, this event ends it
  - event: wifi.disconnected
    conditions: [{ path: event.ssid, eq: Office WiFi }]
steps:
  - id: wait
    wait: { minutes: 480 }      # or { until: "18:00" } (next local occurrence)
  - id: nudge
    message: { text: "Time to head home", level: loud }   # level: notify | loud | alarm
\`\`\`

Other steps: \`call: {plugin, tool, args}\` (a plugin tool; its output is \`steps.<id>.*\`),
\`claude: {prompt, tools?, history?}\` (ask you to do something then, with the tools),
\`message: {text, level?, until: {event, conditions?}, repeat: {every_minutes, max?}}\` (nag until an event),
\`if: <condition>\` with \`then: [steps]\` / \`else: [steps]\`, \`stop: {reason}\`,
\`phone: {action: dnd, on: true} | {action: volume, stream: media|ring|alarm, percent} | {action: media, command: play|pause|next}\`.
Conditions: \`{path, eq|ne|gt|gte|lt|lte|contains|exists}\`, or \`{all: [...]}\` / \`{any: [...]}\`.
Templates in text and prompts: \`{{event.<field>}}\` and \`{{steps.<id>.<field>}}\` only.
The phone only reports Wi-Fi networks it is set to watch (the app's Wi-Fi trigger settings), so if a new
workflow uses a network, remind the user to add it there if they haven't. Ask for the exact network name
if you don't know it. Don't edit the workflow that is answering the user (chat-reply) unless they ask.`;

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
export function systemPrompt(config: ResolvedConfig, plugins: PluginInstructions[] = [], opts: { workflows?: boolean } = {}): string {
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
    "For a reminder at a particular time, use set_reminder (any time ahead); schedule_followup is for nudges",
    "within the next 24 hours about something in progress.",
  ];
  const fromPlugins = plugins.flatMap((p) => ["", `## ${p.title} (plugin \`${p.plugin}\`)`, p.text.trim()]);
  const workflows = opts.workflows ? ["", WORKFLOW_GUIDE] : [];
  const about = config.about_me ? ["", "## About the user", config.about_me.trim()] : [];
  return [...common, ...fromPlugins, ...workflows, ...about].join("\n");
}

/** Per-run state: which tools are allowed and, in a dry run, what would have been sent. */
interface RunScope {
  runId: number;
  dryRun: boolean;
  allowed: Set<string>;
  recorded: RecordedAction[];
  conversationId?: number;
  workflowRunId?: number;
  workflowId?: string;
}

/**
 * Runs one Claude conversation with plugin tools plus the built-in messaging tools.
 * Everything Claude does reaches the phone only through send_message, so a malformed
 * reply can never push garbage to the user.
 */
export class Agent {
  private readonly now: () => Date;
  private readonly titling = new Set<number>();
  /** In-flight title calls, so tests and shutdown can wait for them. */
  readonly pendingTitles = new Set<Promise<unknown>>();

  get notifier(): Notifier {
    return this.deps.notifier;
  }

  constructor(private readonly deps: AgentDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private get config(): ResolvedConfig {
    return this.deps.config.current;
  }

  /** Tools offered to Claude for this request: builtins plus plugin tools, filtered by allowlist and dry run. */
  toolsFor(pluginTools: PluginTool[], req: Pick<RunRequest, "tools" | "dryRun" | "workflows">): Anthropic.Beta.Messages.BetaTool[] {
    const allow = req.tools ? new Set(req.tools) : null;
    return [
      ...BUILTIN_TOOLS,
      ...(req.workflows && this.deps.workflows ? WORKFLOW_TOOLS : []),
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
    const system = systemPrompt(config, (plugins.instructions?.() ?? []).filter((p) => offered.has(p.plugin)), {
      workflows: tools.some((t) => WORKFLOW_TOOL_NAMES.has(t.name)),
    });

    const context = `It is ${local.weekday} ${local.date}, ${local.time} (${config.timezone}).`;
    const conversationId = req.conversation_id ?? (req.workflow_run_id !== undefined ? db.conversationForWorkflowRun(req.workflow_run_id) ?? undefined : undefined);
    const history =
      req.history && conversationId
        ? db
            .conversationMessages(conversationId, { excludeId: req.exclude_message_id })
            .map((m) => `${m.direction === "in" ? "User" : "Jeeves"}: ${m.text}`)
            .join("\n")
        : "";
    const userText = [context, history && `Conversation so far:\n${history}`, req.prompt].filter(Boolean).join("\n\n");

    const runId = db.startRun({
      kind: req.kind,
      rule_id: req.rule_id,
      event_id: req.event_id,
      workflow_run_id: req.workflow_run_id,
      model,
      input: userText,
      local_date: local.date,
    });
    const scope: RunScope = { runId, dryRun: !!req.dryRun, allowed: new Set(tools.map((t) => t.name)), recorded: [], conversationId, workflowRunId: req.workflow_run_id, workflowId: req.rule_id };
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
        // With a workflow run, the conversation resolves when the follow-up fires, so none is created for nothing.
        const where = scope.workflowRunId !== undefined ? { workflow_run_id: scope.workflowRunId } : { conversation_id: this.resolveConversation(scope) };
        this.deps.db.addJob(at, "followup", { message: input.message, ...about, ...where });
      }
      return { text: `Scheduled for ${at.toISOString()}.`, isError: false };
    }
    if (name === "set_reminder" || name === "list_reminders" || name === "cancel_reminder") return this.reminderTool(name, input, scope);
    if (WORKFLOW_TOOL_NAMES.has(name)) return this.workflowTool(name, input, scope);
    const target = splitToolName(name);
    if (!target) return { text: `Unknown tool ${name}`, isError: true };
    return this.deps.plugins.call(target.plugin, target.tool, input);
  }

  private reminderTool(name: string, input: Record<string, unknown>, scope: RunScope): { text: string; isError: boolean } {
    const { db } = this.deps;
    const tz = this.config.timezone;
    const show = (iso: string) => {
      const l = localTime(new Date(iso), tz);
      return `${l.weekday} ${l.date} ${l.time}`;
    };
    if (name === "list_reminders") {
      const pending = db.pendingJobs("reminder").filter((j) => j.plugin === CHAT_REMINDER_PLUGIN);
      if (!pending.length) return { text: "No reminders set.", isError: false };
      return { text: pending.map((j) => `${j.reminder_key}: ${show(j.run_at)} (${j.payload.level}) ${j.payload.text}`).join("\n"), isError: false };
    }
    if (name === "cancel_reminder") {
      const id = String(input.id);
      if (scope.dryRun) return { text: `Would cancel ${id} (dry run).`, isError: false };
      return db.cancelReminder(CHAT_REMINDER_PLUGIN, id, "deleted", this.now())
        ? { text: `Cancelled ${id}.`, isError: false }
        : { text: `No pending reminder ${id}; call list_reminders for the ids.`, isError: true };
    }
    let at: Date;
    try {
      at = fromLocal(String(input.at).trim(), tz);
    } catch (e) {
      return { text: `${(e as Error).message}. Give the local time as YYYY-MM-DDTHH:MM.`, isError: true };
    }
    if (at.getTime() <= this.now().getTime()) return { text: `${show(at.toISOString())} has already passed. Pick a time in the future.`, isError: true };
    const text = String(input.text).trim().slice(0, 500);
    if (!text) return { text: "text is empty", isError: true };
    const level = (["notify", "loud", "alarm"] as const).find((l) => l === input.level) ?? "notify";
    if (scope.dryRun) {
      scope.recorded.push({ kind: "reminder", text, at: at.toISOString() });
      return { text: `Would remind at ${show(at.toISOString())} (dry run).`, isError: false };
    }
    const key = `r-${at.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    db.upsertReminder(CHAT_REMINDER_PLUGIN, key, null, at, { text, level, items: [] });
    return { text: `Reminder ${key} set for ${show(at.toISOString())}.`, isError: false };
  }

  private workflowTool(name: string, input: Record<string, unknown>, scope: RunScope): { text: string; isError: boolean } {
    const store = this.deps.workflows!;
    if (name === "list_workflows") {
      const workflows = store.listWorkflows().map((w) => ({ id: w.id, description: w.description, enabled: w.enabled, triggers: w.triggers, ...(w.error ? { error: w.error } : {}) }));
      const events = (this.deps.eventInfo?.() ?? []).map((e) => ({
        type: e.type,
        ...(e.title ? { title: e.title } : {}),
        ...(e.description ? { description: e.description } : {}),
        ...(e.payload_schema ? { fields: e.payload_schema } : {}),
      }));
      return { text: JSON.stringify({ workflows, event_types: events }), isError: false };
    }
    const id = String(input.id);
    let current;
    try {
      current = store.readWorkflow(id);
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
    if (name === "get_workflow") return current ? { text: current.yaml, isError: false } : { text: `No workflow ${id}.`, isError: true };

    if (current && !input.replace) return { text: `Workflow ${id} already exists. Pick another id, or set replace: true to overwrite it.`, isError: true };
    if (id === scope.workflowId) return { text: `${id} is the workflow running this conversation; the user has to edit it in the app.`, isError: true };
    const yaml = String(input.yaml);
    if (scope.dryRun) {
      scope.recorded.push({ kind: "workflow", text: yaml, workflow_id: id });
      return { text: `Would save ${id} (dry run).`, isError: false };
    }
    try {
      store.writeWorkflow(id, { yaml }, current?.hash ?? null);
    } catch (e) {
      const issues = (e as { detail?: { issues?: { path: unknown[]; message: string }[] } }).detail?.issues;
      const detail = issues?.length ? `\n${issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}` : "";
      return { text: `Not saved: ${(e as Error).message}${detail}`, isError: true };
    }
    return { text: `Saved workflow ${id}; it is live now.`, isError: false };
  }

  private async deliver(text: string, items: PlanItem[], scope: RunScope) {
    if (scope.dryRun) {
      scope.recorded.push({ kind: "message", text, ...(items.length ? { items } : {}) });
      return;
    }
    await this.sendMessage(text, items, scope.runId, { conversation_id: this.resolveConversation(scope) });
  }

  /** The conversation a run's messages go to; created on first use. */
  private resolveConversation(scope: RunScope): number {
    if (scope.conversationId !== undefined) return scope.conversationId;
    const { db } = this.deps;
    if (scope.workflowRunId !== undefined) scope.conversationId = db.conversationFor(scope.workflowRunId, scope.workflowId ?? null, this.now());
    else scope.conversationId = db.createConversation({ source_workflow_id: scope.workflowId ?? null, now: this.now() }).id;
    return scope.conversationId;
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
    extra: { level?: ReminderLevel | null; due_at?: string | null; job_id?: number | null; conversation_id?: number | null } = {},
  ) {
    const withActions = items.map((i) => this.withActions(i));
    // No conversation given: this message starts its own (e.g. a plugin reminder).
    const conversation_id = extra.conversation_id ?? this.deps.db.createConversation({ now: this.now() }).id;
    const msg = this.deps.db.addMessage("out", text, withActions.length ? withActions : null, runId, this.now(), { ...extra, conversation_id });
    this.maybeTitle(conversation_id);
    try {
      await this.deps.notifier.notify(msg);
    } catch (e) {
      // The message is stored, so the app still sees it when it next polls.
      console.warn(`Push failed for message ${msg.id}: ${(e as Error).message}`);
    }
    return msg;
  }

  /** Fire-and-forget: gives a conversation a title from its first message. Never throws. */
  maybeTitle(convId: number): void {
    const p = this.title(convId)
      .catch((e) => console.warn(`Title for conversation ${convId} failed: ${(e as Error).message}`))
      .finally(() => this.pendingTitles.delete(p));
    this.pendingTitles.add(p);
  }

  private async title(convId: number): Promise<void> {
    const { db } = this.deps;
    if (this.titling.has(convId) || db.getConversation(convId)?.title) return;
    const local = localTime(this.now(), this.config.timezone);
    if (db.runsOn(local.date) >= this.config.max_runs_per_day) return;
    const first = db.conversationMessages(convId, { limit: 1 })[0];
    if (!first) return;
    this.titling.add(convId);
    try {
      const raw = await (this.deps.titles ?? ((t: string) => this.generateTitle(t, local.date)))(first.text);
      const title = raw ? cleanTitle(raw) : null;
      if (title) db.setTitleIfUnset(convId, title);
    } finally {
      this.titling.delete(convId);
    }
  }

  /** The default title generator: one tool-less turn on a small model, recorded as a "title" run. */
  private async generateTitle(firstText: string, localDate: string): Promise<string | null> {
    const { db, create, cli } = this.deps;
    if (!cli && !create) return null;
    const prompt = `Give a 3-6 word title for a chat that starts with:\n\n${firstText.slice(0, 1000)}\n\nReply with the title only.`;
    const runId = db.startRun({ kind: "title", model: TITLE_MODEL, input: prompt, local_date: localDate });
    try {
      if (cli) {
        const out = await cli({
          model: TITLE_MODEL,
          effort: "low",
          system: TITLE_SYSTEM,
          prompt,
          tools: [],
          maxTurns: 1,
          callTool: async () => ({ text: "No tools available", isError: true }),
        });
        db.finishRun(runId, { status: out.error ? "error" : "ok", transcript: out.transcript, input_tokens: out.inputTokens, output_tokens: out.outputTokens, ...(out.error ? { error: out.error } : {}) });
        return out.error ? null : out.finalText;
      }
      const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: prompt }];
      const res = await create!({ model: TITLE_MODEL, max_tokens: 50, output_config: { effort: "low" }, system: TITLE_SYSTEM, tools: [], messages });
      db.finishRun(runId, { status: "ok", transcript: [...messages, { role: "assistant", content: res.content }], input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens });
      return res.content
        .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    } catch (e) {
      db.finishRun(runId, { status: "error", transcript: [], input_tokens: 0, output_tokens: 0, error: (e as Error).message });
      throw e;
    }
  }
}
