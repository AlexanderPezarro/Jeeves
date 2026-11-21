import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Fastify from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { httpEventPoster, type EventPoster } from "./events.js";
import { taskActions } from "./actions.js";
import { jeevesRoutes } from "./jeeves.js";
import { buildMcpServer } from "./mcp.js";
import { httpReminderClient, ReminderScheduler } from "./reminders.js";
import { seedFromFile } from "./seed.js";
import { TodoStore } from "./store.js";

export interface AppOptions {
  store: TodoStore;
  token: string;
  timeZone: string;
  now?: () => Date;
  /** Jeeves server base URL (e.g. http://server:8080); task events are posted to <url>/plugin-events. */
  jeevesUrl?: string;
  /** Overrides the HTTP event poster built from jeevesUrl (tests). */
  events?: EventPoster;
  /** chores.yaml for the UI's "Import from chores.yaml" button. */
  choresFile?: string;
  /** Overrides the scheduler built from jeevesUrl (tests). Not started by buildApp. */
  reminders?: ReminderScheduler;
}

export function buildApp({ store, token, timeZone, now, jeevesUrl, events, choresFile, reminders: injected }: AppOptions) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const poster = events ?? httpEventPoster({ jeevesUrl, token });

  const reminders =
    injected ??
    (jeevesUrl
      ? new ReminderScheduler({ store, client: httpReminderClient({ jeevesUrl, token }), timeZone, now })
      : undefined);
  app.addHook("onClose", async () => reminders?.stop());
  // Exposed so main() can start it once the server listens.
  (app as unknown as { reminders?: ReminderScheduler }).reminders = reminders;

  app.get("/health", async () => ({ ok: true }));

  const actions = taskActions({ store, timeZone, now, events: poster, reminders });
  app.register(jeevesRoutes, { prefix: "/jeeves", store, token, choresFile, reminders, actions });

  // Stateless MCP over Streamable HTTP: one server + transport per request.
  app.post("/mcp", async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const server = buildMcpServer({ store, timeZone, now, events: poster, reminders });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // GET/DELETE are only used by stateful MCP sessions, which this plugin does not keep.
  app.get("/mcp", async (_req, reply) => reply.code(405).send({ error: "method not allowed" }));
  app.delete("/mcp", async (_req, reply) => reply.code(405).send({ error: "method not allowed" }));

  return app;
}

async function main() {
  const token = process.env.TODO_PLUGIN_TOKEN;
  if (!token) throw new Error("TODO_PLUGIN_TOKEN must be set");
  const dbPath = process.env.TODO_DB_PATH ?? "./data/todo.db";
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new TodoStore(dbPath);
  for (const id of store.legacyTimerChores()) {
    console.warn(`Chore ${id} has timer_steps, which are no longer used; move the timing into a workflow`);
  }
  const seedPath = process.env.TODO_CHORES_FILE ?? "./chores.yaml";
  if (existsSync(seedPath)) {
    // Seed only: chores already in the DB (or deleted in the UI) are left alone.
    const { inserted, skipped } = seedFromFile(store, seedPath);
    console.log(`Seeded ${inserted} new chores from ${seedPath} (${skipped} already in the database)`);
  }
  const jeevesUrl = process.env.JEEVES_URL || undefined;
  if (!jeevesUrl) console.log("JEEVES_URL is not set; task events will not be sent");
  const app = buildApp({
    store,
    token,
    timeZone: process.env.TZ ?? "Europe/London",
    jeevesUrl,
    choresFile: seedPath,
  });
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8081) });
  (app as unknown as { reminders?: ReminderScheduler }).reminders?.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
