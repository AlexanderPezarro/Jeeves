import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Fastify from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mealActions } from "./actions.js";
import { httpEventPoster, type EventPoster } from "./events.js";
import { jeevesRoutes } from "./jeeves.js";
import { buildMcpServer } from "./mcp.js";
import { MealsStore } from "./store.js";

export interface AppOptions {
  store: MealsStore;
  token: string;
  timeZone: string;
  now?: () => Date;
  /** Jeeves server base URL (e.g. http://server:8080); meal events are posted to <url>/plugin-events. */
  jeevesUrl?: string;
  /** Overrides the HTTP event poster built from jeevesUrl (tests). */
  events?: EventPoster;
}

export function buildApp({ store, token, timeZone, now, jeevesUrl, events }: AppOptions) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const poster = events ?? httpEventPoster({ jeevesUrl, token });

  app.get("/health", async () => ({ ok: true }));

  const actions = mealActions({ store, timeZone, now, events: poster });
  app.register(jeevesRoutes, { prefix: "/jeeves", store, token, actions, now });

  // Stateless MCP over Streamable HTTP: one server + transport per request.
  app.post("/mcp", async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const server = buildMcpServer({ store, timeZone, now, events: poster });
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
  const token = process.env.MEALS_PLUGIN_TOKEN;
  if (!token) throw new Error("MEALS_PLUGIN_TOKEN must be set");
  const dbPath = process.env.MEALS_DB_PATH ?? "./data/meals.db";
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new MealsStore(dbPath);
  const jeevesUrl = process.env.JEEVES_URL || undefined;
  if (!jeevesUrl) console.log("JEEVES_URL is not set; meal events will not be sent");
  const app = buildApp({ store, token, timeZone: process.env.TZ ?? "Europe/London", jeevesUrl });
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8082) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
