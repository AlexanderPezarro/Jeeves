import { z } from "zod";

/**
 * Plugin settings, pushed by Jeeves with `PUT /jeeves/settings` and stored in meals.db.
 *
 * The JSON Schema below is what Jeeves renders as a form (web and Android). It sticks to the subset
 * both renderers support (type, title, description, default, enum), so ranges are enforced here by
 * zod and described in the text rather than with minimum/maximum.
 */
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export const settingsSchema = z
  .object({
    weekly_budget: z.number().min(0).max(100000).default(50),
    default_dinner_time: z.string().regex(HHMM, "use HH:MM, 24 hour").default("18:30"),
    planning_day: z.enum(DAYS).default("sun"),
    leftover_max_days: z.number().int().min(1).max(14).default(3),
    emit_events: z.boolean().default(true),
    currency: z.string().max(8).default("£"),
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

export const settingsJsonSchema = {
  type: "object",
  properties: {
    weekly_budget: {
      type: "number",
      title: "Weekly food budget",
      description: "What a week of dinner shopping should cost, in the currency below. Going over is flagged, never refused.",
      default: DEFAULT_SETTINGS.weekly_budget,
    },
    default_dinner_time: {
      type: "string",
      title: "Default dinner time",
      description: "Local time as HH:MM (24 hour), used when a night has no start time of its own.",
      default: DEFAULT_SETTINGS.default_dinner_time,
    },
    planning_day: {
      type: "string",
      title: "Planning day",
      description: "The day of the week I plan the next week's dinners.",
      enum: [...DAYS],
      default: DEFAULT_SETTINGS.planning_day,
    },
    leftover_max_days: {
      type: "integer",
      title: "Leftover days",
      description: "How many days cooked portions keep, counting the cook night. 1 to 14.",
      default: DEFAULT_SETTINGS.leftover_max_days,
    },
    emit_events: {
      type: "boolean",
      title: "Send events to Jeeves",
      description: "Tell Jeeves when dinner is cooked, a shop is finished or a plan is set (meals.cooked, meals.shop_finished, meals.plan_set) so workflows can react.",
      default: DEFAULT_SETTINGS.emit_events,
    },
    currency: {
      type: "string",
      title: "Currency symbol",
      description: "Shown in front of prices.",
      default: DEFAULT_SETTINGS.currency,
    },
  },
} as const;
