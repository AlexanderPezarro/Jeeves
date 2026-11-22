import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CalendarFeed, FeedCache } from "./feeds.js";
import { expandEvents, type CalEvent } from "./ical.js";
import { feedsOf, HHMM, type SettingsHolder } from "./settings.js";
import { freeSlots } from "./slots.js";
import { addDays, daysBetween, parseDate, startOfLocalDate, todayIn } from "./tz.js";
import { VERSION } from "./version.js";

export interface McpDeps {
  cache: FeedCache;
  settings: SettingsHolder;
  now?: () => Date;
}

/** Longest date range a tool call may cover, in days. */
export const MAX_RANGE_DAYS = 62;

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const fail = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

interface Source {
  calendar: string;
  fetched_at: string | null;
  stale: boolean;
  error?: string;
}

const sourceOf = (c: CalendarFeed): Source => ({
  calendar: c.name,
  fetched_at: c.fetched_at,
  stale: c.stale,
  ...(c.error ? { error: c.error } : {}),
});

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

/** Resolves optional from/to (to inclusive) against today in the configured zone. Throws a readable Error. */
function resolveRange(from: string | undefined, to: string | undefined, today: string): { from: string; to: string } {
  const start = from ?? today;
  parseDate(start);
  const end = to ?? addDays(start, 7);
  parseDate(end);
  if (daysBetween(start, end) < 0) throw new Error("to must not be before from");
  if (daysBetween(start, end) + 1 > MAX_RANGE_DAYS) throw new Error(`the range is limited to ${MAX_RANGE_DAYS} days`);
  return { from: start, to: end };
}

const timeArg = (d: string) => z.string().regex(HHMM).or(z.literal("24:00")).default(d);

/**
 * Builds the MCP server the Jeeves control plane talks to. A fresh server is built per request
 * (stateless HTTP), so this must stay cheap.
 */
export function buildMcpServer({ cache, settings, now = () => new Date() }: McpDeps): McpServer {
  const server = new McpServer({ name: "jeeves-calendar", version: VERSION });

  /** Fetches the feeds and expands them over [from, to]; or a tool error when there is nothing usable. */
  async function load(from: string | undefined, to: string | undefined) {
    const { timezone: timeZone } = settings.get();
    if (feedsOf(settings.get()).length === 0) {
      return { error: fail("No calendar is configured. Set a calendar address in the Calendar plugin settings.") };
    }
    const range = resolveRange(from, to, todayIn(now(), timeZone));
    const { calendars } = await cache.get();
    const usable = calendars.filter((c) => c.parsed);
    if (usable.length === 0) {
      const why = calendars.map((c) => `${c.name}: ${c.error ?? "no data"}`).join("; ");
      return { error: fail(`Calendar unavailable: ${why}`) };
    }
    const events: CalEvent[] = usable
      .flatMap((c) =>
        expandEvents(c.parsed!, {
          from: startOfLocalDate(range.from, timeZone),
          to: startOfLocalDate(addDays(range.to, 1), timeZone),
          calendar: c.name,
          timeZone,
        }),
      )
      .sort((a, b) => Date.parse(a.all_day ? `${a.start}T00:00:00Z` : a.start) - Date.parse(b.all_day ? `${b.start}T00:00:00Z` : b.start));
    return { events, range, timeZone, sources: calendars.map(sourceOf) };
  }

  server.registerTool(
    "list_events",
    {
      description:
        "List the user's calendar events from `from` to `to` (both YYYY-MM-DD, `to` inclusive; default today to a week ahead, max 62 days). " +
        "Times are local ISO times; all-day events have all_day true and date start/end (end exclusive). " +
        "`sources` says when each calendar was last fetched and whether it is stale.",
      inputSchema: {
        from: dateArg.optional().describe("YYYY-MM-DD; defaults to today"),
        to: dateArg.optional().describe("YYYY-MM-DD, inclusive; defaults to from + 7 days"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to }) => {
      try {
        const r = await load(from, to);
        if (r.error) return r.error;
        return json({ events: r.events, sources: r.sources });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "free_slots",
    {
      description:
        "Work out which evenings are free. For each day from `from` to `to` (YYYY-MM-DD, inclusive; default today to a week ahead, max 62 days) " +
        "returns the free gaps of at least `min_minutes` between `earliest` and `latest` (local HH:MM, defaults 17:00 to 22:00), " +
        "the timed events that make it busy, and the day's all-day events (not counted as busy; use judgement).",
      inputSchema: {
        from: dateArg.optional().describe("YYYY-MM-DD; defaults to today"),
        to: dateArg.optional().describe("YYYY-MM-DD, inclusive; defaults to from + 7 days"),
        earliest: timeArg("17:00").describe("Start of the window, HH:MM"),
        latest: timeArg("22:00").describe("End of the window, HH:MM (24:00 allowed)"),
        min_minutes: z.number().int().min(1).max(24 * 60).default(60).describe("Shortest gap worth reporting"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to, earliest, latest, min_minutes }) => {
      try {
        const r = await load(from, to);
        if (r.error) return r.error;
        const days = freeSlots(r.events, {
          from: r.range.from,
          to: r.range.to,
          earliest,
          latest,
          minMinutes: min_minutes,
          timeZone: r.timeZone,
        });
        return json({ days, sources: r.sources });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  return server;
}
