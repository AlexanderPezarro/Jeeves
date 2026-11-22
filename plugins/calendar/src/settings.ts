import { z } from "zod";
import { isValidTimeZone } from "./tz.js";

/**
 * Plugin settings, pushed by Jeeves with `PUT /jeeves/settings` on every (re)connect and held in
 * memory only.
 *
 * The JSON Schema below is what Jeeves renders as a form (web and Android). It sticks to the subset
 * both renderers support (type, title, description, default, enum) plus `format: "secret"` on
 * top-level strings, so the feed URLs (which are bearer secrets) are three fixed secret slots.
 */
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const SLOTS = [1, 2, 3] as const;

/** Accepts https: and webcal: (rewritten to https:). An empty string means "not set". */
const feedUrl = z
  .string()
  .trim()
  .transform((s, ctx) => {
    if (s === "") return undefined;
    const rewritten = s.replace(/^webcal:/i, "https:");
    let url: URL;
    try {
      url = new URL(rewritten);
    } catch {
      ctx.addIssue({ code: "custom", message: "not a valid URL" });
      return z.NEVER;
    }
    if (url.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "the calendar address must be https: (or webcal:)" });
      return z.NEVER;
    }
    return url.toString();
  })
  .optional();

const calendarName = z
  .string()
  .trim()
  .max(80)
  .transform((s) => (s === "" ? undefined : s))
  .optional();

export const settingsSchema = z
  .object({
    calendar_url_1: feedUrl,
    calendar_name_1: calendarName,
    calendar_url_2: feedUrl,
    calendar_name_2: calendarName,
    calendar_url_3: feedUrl,
    calendar_name_3: calendarName,
    timezone: z
      .string()
      .refine(isValidTimeZone, "not a known IANA time zone, e.g. Europe/London")
      .default("Europe/London"),
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;

export interface FeedConfig {
  /** The secret iCal address. Never log or return it. */
  url: string;
  /** Configured label, or undefined to use the feed's own name. */
  name: string | undefined;
  /** "Calendar 1" etc, the last-resort label. */
  fallbackName: string;
}

export function feedsOf(s: Settings): FeedConfig[] {
  const feeds: FeedConfig[] = [];
  for (const n of SLOTS) {
    const url = s[`calendar_url_${n}` as const];
    if (url) feeds.push({ url, name: s[`calendar_name_${n}` as const], fallbackName: `Calendar ${n}` });
  }
  return feeds;
}

/** Settings as returned to callers: feed URLs are replaced by "set". */
export function redact(s: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = { ...s };
  for (const n of SLOTS) {
    if (out[`calendar_url_${n}`]) out[`calendar_url_${n}`] = "set";
  }
  return out;
}

export class SettingsHolder {
  private current: Settings;
  private listeners: (() => void)[] = [];

  /** `fallbackTimeZone` (the container's TZ) applies when settings don't say. */
  constructor(private readonly fallbackTimeZone = "Europe/London") {
    this.current = settingsSchema.parse({ timezone: isValidTimeZone(fallbackTimeZone) ? fallbackTimeZone : undefined });
  }

  get(): Settings {
    return this.current;
  }

  /** Replaces all settings (missing keys fall back to defaults) and tells listeners. Throws ZodError. */
  set(values: unknown): Settings {
    const given = values && typeof values === "object" && !Array.isArray(values) ? (values as Record<string, unknown>) : {};
    const withFallback = given.timezone === undefined && isValidTimeZone(this.fallbackTimeZone) ? { ...given, timezone: this.fallbackTimeZone } : given;
    this.current = settingsSchema.parse(values === undefined || values === null ? {} : withFallback);
    for (const l of this.listeners) l();
    return this.current;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }
}

const urlField = (n: number) => ({
  type: "string",
  format: "secret",
  title: `Calendar ${n} address`,
  description:
    n === 1
      ? "Google Calendar > Settings > Integrate calendar > Secret address in iCal format. Anyone with this address can read the calendar."
      : "Optional. Secret iCal address of another calendar.",
});

const nameField = (n: number) => ({
  type: "string",
  title: `Calendar ${n} name`,
  description: `Optional label shown with its events. Defaults to the calendar's own name, else "Calendar ${n}".`,
});

export const settingsJsonSchema = {
  type: "object",
  properties: {
    calendar_url_1: urlField(1),
    calendar_name_1: nameField(1),
    calendar_url_2: urlField(2),
    calendar_name_2: nameField(2),
    calendar_url_3: urlField(3),
    calendar_name_3: nameField(3),
    timezone: {
      type: "string",
      title: "Time zone",
      description: "IANA zone used for evenings and for events without a zone, e.g. Europe/London.",
      default: "Europe/London",
    },
  },
} as const;
