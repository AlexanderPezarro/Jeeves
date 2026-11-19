import { z } from "zod";

/**
 * Plugin settings, pushed by Jeeves with `PUT /jeeves/settings` and stored in todo.db.
 *
 * The JSON Schema below is what Jeeves renders as a form (web and Android). It sticks to the subset
 * both renderers support (type, title, description, default, enum), so ranges are enforced here by
 * zod and described in the text rather than with minimum/maximum.
 */
export const settingsSchema = z
  .object({
    carry_over_days: z.number().int().min(0).max(30).default(3),
    default_snooze_minutes: z.number().int().min(1).max(24 * 60).default(15),
    followup_nudges: z.boolean().default(true),
    emit_events: z.boolean().default(true),
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

export const settingsJsonSchema = {
  type: "object",
  properties: {
    carry_over_days: {
      type: "integer",
      title: "Carry-over days",
      description: "How many days an unfinished chore keeps showing up (as overdue) before it is dropped. 0 to 30.",
      default: DEFAULT_SETTINGS.carry_over_days,
    },
    default_snooze_minutes: {
      type: "integer",
      title: "Default snooze (minutes)",
      description: "How long a task is hidden when it is snoozed without saying for how long. 1 to 1440.",
      default: DEFAULT_SETTINGS.default_snooze_minutes,
    },
    followup_nudges: {
      type: "boolean",
      title: "Timer follow-ups",
      description: "Return a chore's timer steps when it is started, so Jeeves can nudge you (e.g. move the washing to the dryer).",
      default: DEFAULT_SETTINGS.followup_nudges,
    },
    emit_events: {
      type: "boolean",
      title: "Send events to Jeeves",
      description: "Tell Jeeves when a task is started or completed (todo.task_started, todo.task_completed) so workflows can react.",
      default: DEFAULT_SETTINGS.emit_events,
    },
  },
} as const;
