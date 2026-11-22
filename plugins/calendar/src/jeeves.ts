import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import { redact, settingsJsonSchema, type SettingsHolder } from "./settings.js";
import { VERSION } from "./version.js";

export interface JeevesRoutesOptions {
  settings: SettingsHolder;
  token: string;
}

const str = (description: string) => ({ type: "string", description });

const sourcesSchema = {
  type: "array",
  description: "Per calendar: when it was last fetched and whether that data is stale",
  items: {
    type: "object",
    properties: {
      calendar: str("Calendar name"),
      fetched_at: str("ISO time of the last successful fetch"),
      stale: { type: "boolean", description: "The latest refresh failed; the data is from an earlier fetch" },
      error: str("Why the latest refresh failed"),
    },
  },
};

const eventSchema = {
  type: "object",
  properties: {
    start: str("Local ISO time, or YYYY-MM-DD for an all-day event"),
    end: str("Local ISO time, or the exclusive end date for an all-day event"),
    all_day: { type: "boolean" },
    title: str("Event title; (busy) when the calendar shares none"),
    location: str("Location, may be empty"),
    calendar: str("Which calendar it came from"),
  },
};

const daySchema = {
  type: "object",
  properties: {
    date: str("YYYY-MM-DD"),
    weekday: str("Monday .. Sunday"),
    free: {
      type: "array",
      items: {
        type: "object",
        properties: { start: str("HH:MM"), end: str("HH:MM"), minutes: { type: "integer" } },
      },
    },
    busy: {
      type: "array",
      items: { type: "object", properties: { start: str("HH:MM"), end: str("HH:MM"), title: str("Event title") } },
    },
    all_day: { type: "array", items: { type: "string" }, description: "Titles of all-day events that day" },
  },
};

export const manifest = {
  name: "calendar",
  display_name: "Calendar",
  version: VERSION,
  settings_schema: settingsJsonSchema,
  events: [],
  steps: {
    list_events: {
      title: "List calendar events",
      output_schema: {
        type: "object",
        properties: { events: { type: "array", items: eventSchema }, sources: sourcesSchema },
      },
    },
    free_slots: {
      title: "Find free evenings",
      output_schema: {
        type: "object",
        properties: { days: { type: "array", items: daySchema }, sources: sourcesSchema },
      },
    },
  },
  // Added to Claude's system prompt whenever this plugin's tools are offered.
  instructions: [
    "This plugin reads the user's Google calendars (read-only). Treat every timed event as busy;",
    "all-day events are listed separately: use judgement (a holiday or trip is busy, a birthday is not).",
    "Use free_slots for 'which evenings are free' and list_events for detail. Times are local.",
    "Google's feed can lag edits by some hours, so do not promise real-time accuracy.",
    "If a tool fails or a source is stale, say so briefly and ask the user which evenings are busy",
    "instead of assuming they are free. Never invent events.",
  ].join("\n"),
};

function badRequest(reply: FastifyReply, e: ZodError) {
  return reply.code(400).send({
    error: "invalid request",
    issues: e.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
  });
}

/** Everything Jeeves talks to besides MCP: the manifest and settings. Guarded by the same bearer token as /mcp. */
export async function jeevesRoutes(app: FastifyInstance, { settings, token }: JeevesRoutesOptions) {
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/manifest", async () => manifest);

  // The feed URLs are bearer secrets: they are never returned.
  app.get("/settings", async () => redact(settings.get()));
  app.put("/settings", async (req, reply) => {
    try {
      return { ok: true, values: redact(settings.set(req.body ?? {})) };
    } catch (e) {
      if (e instanceof ZodError) return badRequest(reply, e);
      throw e;
    }
  });
}
