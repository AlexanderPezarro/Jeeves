import { z } from "zod";

/**
 * Plugin settings, pushed by Jeeves with `PUT /jeeves/settings` and stored in todo.db.
 *
 * The JSON Schema below is what Jeeves renders as a form (web and Android). It sticks to the subset
 * both renderers support (type, title, description, default, enum), so ranges are enforced here by
 * zod and described in the text rather than with minimum/maximum.
 */
export const LEVELS = ["notify", "loud", "alarm"] as const;
export type Level = (typeof LEVELS)[number];
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = (def: string) => z.string().regex(HHMM, "use HH:MM, 24 hour").default(def);

export const settingsSchema = z
  .object({
    carry_over_days: z.number().int().min(0).max(30).default(3),
    default_snooze_minutes: z.number().int().min(1).max(24 * 60).default(15),
    followup_nudges: z.boolean().default(true),
    emit_events: z.boolean().default(true),
    daily_due_enabled: z.boolean().default(true),
    daily_due_time: hhmm("09:00"),
    daily_due_level: z.enum(LEVELS).default("notify"),
    evening_update_enabled: z.boolean().default(true),
    evening_update_time: hhmm("21:00"),
    evening_update_level: z.enum(LEVELS).default("notify"),
    timer_level: z.enum(LEVELS).default("alarm"),
    chore_default_level: z.enum(LEVELS).default("notify"),
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
      description: "Schedule a chore's timer steps as reminders when it is started (e.g. move the washing to the dryer).",
      default: DEFAULT_SETTINGS.followup_nudges,
    },
    emit_events: {
      type: "boolean",
      title: "Send events to Jeeves",
      description: "Tell Jeeves when a task is started or completed (todo.task_started, todo.task_completed) so workflows can react.",
      default: DEFAULT_SETTINGS.emit_events,
    },
    daily_due_enabled: {
      type: "boolean",
      title: "Daily 'due today' reminder",
      description: "Remind me each morning of the chores due today.",
      default: DEFAULT_SETTINGS.daily_due_enabled,
    },
    daily_due_time: {
      type: "string",
      title: "Daily reminder time",
      description: "Local time as HH:MM (24 hour).",
      default: DEFAULT_SETTINGS.daily_due_time,
    },
    daily_due_level: {
      type: "string",
      title: "Daily reminder level",
      description: "Notify is a normal notification, loud rings like an alarm sound, alarm takes over the screen.",
      enum: [...LEVELS],
      default: DEFAULT_SETTINGS.daily_due_level,
    },
    evening_update_enabled: {
      type: "boolean",
      title: "Evening update reminder",
      description: "Prompt me in the evening to tick off what I did.",
      default: DEFAULT_SETTINGS.evening_update_enabled,
    },
    evening_update_time: {
      type: "string",
      title: "Evening update time",
      description: "Local time as HH:MM (24 hour).",
      default: DEFAULT_SETTINGS.evening_update_time,
    },
    evening_update_level: {
      type: "string",
      title: "Evening update level",
      description: "Notify is a normal notification, loud rings like an alarm sound, alarm takes over the screen.",
      enum: [...LEVELS],
      default: DEFAULT_SETTINGS.evening_update_level,
    },
    timer_level: {
      type: "string",
      title: "Timer step level",
      description: "Notify is a normal notification, loud rings like an alarm sound, alarm takes over the screen.",
      enum: [...LEVELS],
      default: DEFAULT_SETTINGS.timer_level,
    },
    chore_default_level: {
      type: "string",
      title: "Default chore reminder level",
      description: "Notify is a normal notification, loud rings like an alarm sound, alarm takes over the screen.",
      enum: [...LEVELS],
      default: DEFAULT_SETTINGS.chore_default_level,
    },
  },
} as const;
