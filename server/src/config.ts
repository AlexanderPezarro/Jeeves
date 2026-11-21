import { Cron } from "croner";
import { z } from "zod";

export const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof effortSchema>;

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "use HH:MM");
const weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const slug = z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes");

// ---------------------------------------------------------------------------
// Legacy rules (jeeves.yaml `rules:`). Only read by the one-time migration.

export const ruleSchema = z
  .object({
    id: slug,
    description: z.string().optional(),
    event: z.string().optional(),
    schedule: z.string().optional(),
    when: z
      .object({
        ssid: z.string().optional(),
        after: hhmm.optional(),
        before: hhmm.optional(),
        days: z.array(weekday).optional(),
        min_away_minutes: z.number().int().min(0).optional(),
      })
      .default({}),
    cooldown: z.union([z.literal("daily"), z.number().int().min(0)]).default("daily"),
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("plan"), prompt: z.string() }),
      z.object({ type: z.literal("message"), text: z.string() }),
    ]),
    enabled: z.boolean().default(true),
  })
  .refine((r) => r.event || r.schedule, "a rule needs an event or a schedule");

export type Rule = z.infer<typeof ruleSchema>;

// ---------------------------------------------------------------------------
// Globals (config/jeeves.yaml)

export const pluginSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/, "lowercase letters, digits and underscores"),
  url: z.string().url(),
  /** Name of the environment variable that holds the plugin's bearer token. */
  token_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "an environment variable name, e.g. TODO_PLUGIN_TOKEN"),
});

export type PluginConfig = z.infer<typeof pluginSchema>;

export const globalsSchema = z.object({
  timezone: z
    .string()
    .default("Europe/London")
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "unknown time zone"),
  model: z.string().default("claude-opus-5-5"),
  effort: effortSchema.default("low"),
  /** Hard cap on Claude runs per local day, as a cost guard. */
  max_runs_per_day: z.number().int().min(1).default(20),
  /** Extra context about you that every planning run sees. */
  about_me: z.string().default(""),
  /** How long evaluations, activity, finished workflow runs and events are kept. */
  activity_retention_days: z.number().int().min(1).default(90),
  plugins: z.array(pluginSchema).default([]),
  /**
   * Deprecated: which plugin owns tasks. Plugins now say so in their manifest (`today: true`);
   * this is only a fallback for plugins without a manifest and is removed once one is found.
   */
  todo_plugin: z.string().optional(),
  /** Legacy rules; migrated to workflows/ on startup. Ignored here. */
  rules: z.unknown().optional(),
});

export type Globals = z.infer<typeof globalsSchema>;

/** Keys the settings form may change. `plugins` goes through its own routes. */
export const GLOBAL_KEYS = ["timezone", "model", "effort", "max_runs_per_day", "about_me", "activity_retention_days"] as const;

// ---------------------------------------------------------------------------
// Workflows (config/workflows/<id>.yaml)

const conditionPath = z
  .string()
  .regex(/^(event|steps\.[a-z0-9-]+)(\.[A-Za-z0-9_-]+)*$/, 'a path like "event.ssid" or "steps.<id>.field"');

export const conditionSchema = z
  .object({
    path: conditionPath,
    eq: z.unknown().optional(),
    ne: z.unknown().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    contains: z.unknown().optional(),
    exists: z.boolean().optional(),
  })
  .strict();

export type Condition = z.infer<typeof conditionSchema>;

export type CondExpr = Condition | { all: CondExpr[] } | { any: CondExpr[] };

export const condExprSchema: z.ZodType<CondExpr> = z.lazy(() =>
  z.union([
    conditionSchema,
    z.object({ all: z.array(condExprSchema).min(1) }).strict(),
    z.object({ any: z.array(condExprSchema).min(1) }).strict(),
  ]),
);

export const whenSchema = z
  .object({
    /** One Wi-Fi name, or a list: the trigger matches if the event's SSID is any of them. */
    ssid: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
    after: hhmm.optional(),
    before: hhmm.optional(),
    days: z.array(weekday).optional(),
    /** Only fire if the phone was away from this Wi-Fi for at least this long. */
    min_away_minutes: z.number().int().min(0).optional(),
    /** Checks against the event payload, e.g. {path: "event.chore_id", eq: "laundry"}. */
    conditions: z.array(conditionSchema).optional(),
  })
  .strict();

export type When = z.infer<typeof whenSchema>;

/** `when.ssid` as a list (empty when unset), whether it was written as one name or a list. */
export function ssidList(ssid: When["ssid"]): string[] {
  if (ssid === undefined) return [];
  return (Array.isArray(ssid) ? ssid : [ssid]).filter((s) => s !== "");
}

const eventType = z.string().regex(/^[a-z0-9_.-]+$/, "an event type like wifi.connected or todo.task_started");
const eventTrigger = z.object({ event: eventType, when: whenSchema.optional() }).strict();

/** An event a paused run waits for: `until` on a message step, or `cancel_on` on a workflow. */
export const listenerSchema = z.object({ event: eventType, conditions: z.array(conditionSchema).optional() }).strict();
export type Listener = z.infer<typeof listenerSchema>;
export const messageLevelSchema = z.enum(["notify", "loud", "alarm"]);
const scheduleTrigger = z
  .object({
    schedule: z
      .string()
      .min(1)
      .refine((expr) => {
        try {
          new Cron(expr, { paused: true }).stop();
          return true;
        } catch {
          return false;
        }
      }, "not a valid cron expression"),
    when: whenSchema.optional(),
  })
  .strict();

export const triggerSchema = z.union([eventTrigger, scheduleTrigger]);
export type Trigger = z.infer<typeof triggerSchema>;
export type EventTrigger = z.infer<typeof eventTrigger>;
export type ScheduleTrigger = z.infer<typeof scheduleTrigger>;
export const isSchedule = (t: Trigger): t is ScheduleTrigger => "schedule" in t;

const planItemSchema = z.object({
  /** With item_id: which plugin item this is about, so the notification gets that plugin's buttons. */
  plugin: z.string().optional(),
  /** A string, or a template such as "{{event.task_id}}" (rendered values are turned into strings). */
  item_id: z.union([z.string(), z.number()]).optional(),
  title: z.string(),
  steps: z.array(z.string()).default([]),
  minutes: z.number().int().optional(),
});

export type Step =
  | { id: string; call: { plugin: string; tool: string; args?: Record<string, unknown> } }
  | { id: string; claude: { prompt: string; tools?: string[]; model?: string; effort?: Effort; history?: boolean } }
  | {
      id: string;
      message: {
        text: string;
        items?: { plugin?: string; item_id?: string | number; title: string; steps?: string[]; minutes?: number }[];
        level?: "notify" | "loud" | "alarm";
        repeat?: { every_minutes: number; max?: number };
        until?: Listener;
      };
    }
  | { id: string; wait: { minutes: number } | { until: string } }
  | { id: string; if: CondExpr; then: Step[]; else?: Step[] }
  | { id: string; stop: { reason?: string } | null };

export type StepType = "call" | "claude" | "message" | "wait" | "if" | "stop";
export const STEP_TYPES: StepType[] = ["call", "claude", "message", "wait", "if", "stop"];

export function stepType(step: Step): StepType {
  for (const t of STEP_TYPES) if (t in step) return t;
  throw new Error(`Step ${step.id} has no type`);
}

const stepId = slug;
const pluginName = z.string().regex(/^[a-z0-9_]+$/, "a plugin name");
const toolName = z.string().regex(/^[A-Za-z0-9_-]+$/, "a tool name");
const claudeTool = z
  .string()
  .regex(/^([a-z0-9_]+__[A-Za-z0-9_-]+|send_message|schedule_followup)$/, '"<plugin>__<tool>", "send_message" or "schedule_followup"');

export const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.union([
    z.object({ id: stepId, call: z.object({ plugin: pluginName, tool: toolName, args: z.record(z.string(), z.unknown()).optional() }).strict() }).strict(),
    z
      .object({
        id: stepId,
        claude: z
          .object({
            prompt: z.string().min(1),
            tools: z.array(claudeTool).optional(),
            /** Overrides the global model for this step. */
            model: z.string().regex(/^claude-[a-z0-9.-]+$/, "a Claude model id, e.g. claude-sonnet-5-5").optional(),
            /** Overrides the global effort for this step. */
            effort: effortSchema.optional(),
            /** Show Claude the recent chat (last 8 messages). */
            history: z.boolean().optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        id: stepId,
        message: z
          .object({
            text: z.string().min(1),
            items: z.array(planItemSchema).optional(),
            level: messageLevelSchema.optional(),
            /** Send again every N minutes until the `until` event arrives (or `max` sends). */
            repeat: z.object({ every_minutes: z.number().int().min(1).max(24 * 60), max: z.number().int().min(1).optional() }).strict().optional(),
            /** Pause the run after sending until this event arrives. */
            until: listenerSchema.optional(),
          })
          .strict()
          .superRefine((m, ctx) => {
            if (m.repeat && !m.until) ctx.addIssue({ code: "custom", path: ["repeat"], message: "repeat needs until" });
          }),
      })
      .strict(),
    z
      .object({
        id: stepId,
        wait: z.union([z.object({ minutes: z.number().int().min(1).max(7 * 24 * 60) }).strict(), z.object({ until: hhmm }).strict()]),
      })
      .strict(),
    z.object({ id: stepId, if: condExprSchema, then: z.array(stepSchema), else: z.array(stepSchema).optional() }).strict(),
    z.object({ id: stepId, stop: z.object({ reason: z.string().optional() }).strict().nullable() }).strict(),
  ]),
) as z.ZodType<Step>;

const TEMPLATE_RE = /\{\{\s*([^}]*?)\s*\}\}/g;

/** Every `{{ … }}` reference in any string nested in `value`. */
export function templateRefs(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") for (const m of value.matchAll(TEMPLATE_RE)) out.push(m[1]);
  else if (Array.isArray(value)) value.forEach((v) => templateRefs(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => templateRefs(v, out));
  return out;
}

function condPaths(c: CondExpr, out: string[] = []): string[] {
  if ("all" in c) c.all.forEach((x) => condPaths(x, out));
  else if ("any" in c) c.any.forEach((x) => condPaths(x, out));
  else out.push(c.path);
  return out;
}

export const workflowSchema = z
  .object({
    id: slug,
    description: z.string().optional(),
    enabled: z.boolean().default(true),
    /** "daily" = at most once per local day; a number = minimum minutes between fires. */
    cooldown: z.union([z.literal("daily"), z.number().int().min(0)]).default("daily"),
    notify_on_failure: z.boolean().default(true),
    triggers: z.array(triggerSchema).min(1),
    /** Events that end a paused run (e.g. leaving the Wi-Fi). Registered when the run first pauses. */
    cancel_on: z.array(listenerSchema).optional(),
    steps: z.array(stepSchema).min(1),
  })
  .strict()
  .superRefine((wf, ctx) => {
    const seen = new Set<string>();
    const walk = (steps: Step[], path: (string | number)[]) => {
      steps.forEach((step, i) => {
        const here = [...path, i];
        // References must point at the event or at a step that ran before this one.
        const refs = [...templateRefs(step)];
        if ("if" in step) refs.push(...condPaths(step.if));
        for (const ref of refs) {
          const m = /^steps\.([a-z0-9-]+)(\.|$)/.exec(ref);
          if (ref === "event" || ref.startsWith("event.")) continue;
          if (m && seen.has(m[1])) continue;
          ctx.addIssue({
            code: "custom",
            path: here,
            message: m
              ? `"${ref}" refers to step "${m[1]}", which does not run before this step`
              : `"${ref}" must start with event. or steps.<id>.`,
          });
        }
        if (seen.has(step.id)) ctx.addIssue({ code: "custom", path: [...here, "id"], message: `duplicate step id "${step.id}"` });
        seen.add(step.id);
        if ("if" in step) {
          walk(step.then, [...here, "then"]);
          if (step.else) walk(step.else, [...here, "else"]);
        }
      });
    };
    walk(wf.steps, ["steps"]);
    const ids = new Set<string>();
    const collect = (steps: Step[]) =>
      steps.forEach((st) => {
        ids.add(st.id);
        if ("if" in st) {
          collect(st.then);
          collect(st.else ?? []);
        }
      });
    collect(wf.steps);
    const checkListener = (l: Listener, path: (string | number)[], anyStep: boolean) => {
      l.conditions?.forEach((c, ci) => {
        if (!c.path.startsWith("event")) ctx.addIssue({ code: "custom", path: [...path, "conditions", ci, "path"], message: "listener conditions can only check event.*" });
      });
      if (!anyStep) return;
      for (const ref of templateRefs(l)) {
        const m = /^steps\.([a-z0-9-]+)(\.|$)/.exec(ref);
        if (ref === "event" || ref.startsWith("event.") || (m && ids.has(m[1]))) continue;
        ctx.addIssue({ code: "custom", path, message: `"${ref}" must start with event. or steps.<id> of a step in this workflow` });
      }
    };
    wf.cancel_on?.forEach((l, i) => checkListener(l, ["cancel_on", i], true));
    const walkUntil = (steps: Step[], path: (string | number)[]) =>
      steps.forEach((st, i) => {
        if ("message" in st && st.message.until) checkListener(st.message.until, [...path, i, "message", "until"], false);
        if ("if" in st) {
          walkUntil(st.then, [...path, i, "then"]);
          walkUntil(st.else ?? [], [...path, i, "else"]);
        }
      });
    walkUntil(wf.steps, ["steps"]);
    wf.triggers.forEach((t, i) => {
      for (const c of t.when?.conditions ?? []) {
        if (!c.path.startsWith("event")) ctx.addIssue({ code: "custom", path: ["triggers", i, "when", "conditions"], message: "trigger conditions can only check event.*" });
      }
    });
  });

export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowInput = z.input<typeof workflowSchema>;

/** Everything the server runs on: globals plus workflows and per-plugin settings. */
export type ResolvedConfig = Globals & {
  workflows: Workflow[];
  plugin_settings: Record<string, Record<string, unknown>>;
};

/** Anything that holds the live config. ConfigStore is the real one; tests use staticConfig(). */
export interface ConfigSource {
  readonly current: ResolvedConfig;
}

export function staticConfig(globals: Partial<z.input<typeof globalsSchema>> = {}, workflows: WorkflowInput[] = []): ConfigSource & { current: ResolvedConfig } {
  return {
    current: { ...globalsSchema.parse(globals), workflows: workflows.map((w) => workflowSchema.parse(w)), plugin_settings: {} },
  };
}

/** Zod issues as `{path, message}` pairs the UI can show next to fields. */
export function formatIssues(err: z.ZodError): { path: (string | number)[]; message: string }[] {
  return err.issues.map((i) => ({ path: i.path as (string | number)[], message: i.message }));
}
