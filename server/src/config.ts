import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "use HH:MM");
const weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export const ruleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string().optional(),
    /** Event type that fires this rule, e.g. "wifi.connected". */
    event: z.string().optional(),
    /** Cron expression (in the configured time zone) that fires this rule. */
    schedule: z.string().optional(),
    when: z
      .object({
        ssid: z.string().optional(),
        after: hhmm.optional(),
        before: hhmm.optional(),
        days: z.array(weekday).optional(),
        /** Only fire if the phone was away from this Wi-Fi for at least this long. */
        min_away_minutes: z.number().int().min(0).optional(),
      })
      .default({}),
    /** "daily" = at most once per local day; a number = minimum minutes between fires. */
    cooldown: z.union([z.literal("daily"), z.number().int().min(0)]).default("daily"),
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("plan"), prompt: z.string() }),
      z.object({ type: z.literal("message"), text: z.string() }),
    ]),
    enabled: z.boolean().default(true),
  })
  .refine((r) => r.event || r.schedule, "a rule needs an event or a schedule");

export type Rule = z.infer<typeof ruleSchema>;

const pluginSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/, "lowercase letters, digits and underscores"),
  url: z.string().url(),
  /** Name of the environment variable that holds the plugin's bearer token. */
  token_env: z.string(),
});

export type PluginConfig = z.infer<typeof pluginSchema>;

export const configSchema = z.object({
  timezone: z.string().default("Europe/London"),
  model: z.string().default("claude-opus-5-5"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  /** Hard cap on Claude runs per local day, as a cost guard. */
  max_runs_per_day: z.number().int().min(1).default(20),
  /** Extra context about you that every planning run sees. */
  about_me: z.string().default(""),
  plugins: z.array(pluginSchema).default([]),
  /** Which plugin owns tasks (used by the app's Today screen and task buttons). */
  todo_plugin: z.string().default("todo"),
  rules: z.array(ruleSchema).default([]),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(path: string): Config {
  return configSchema.parse(parse(readFileSync(path, "utf8")) ?? {});
}
