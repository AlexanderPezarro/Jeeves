import Fastify from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { FeedCache, type Fetcher } from "./feeds.js";
import { jeevesRoutes } from "./jeeves.js";
import { buildMcpServer } from "./mcp.js";
import { SettingsHolder } from "./settings.js";

export interface AppOptions {
  token: string;
  /** Fallback time zone until Jeeves pushes settings (the container's TZ). */
  timeZone: string;
  now?: () => Date;
  /** Fetches calendar feeds; defaults to the global fetch. Tests inject a fake. */
  fetcher?: Fetcher;
  /** Overrides the default 10 minute freshness of a fetched feed (tests). */
  ttlMs?: number;
}

export function buildApp({ token, timeZone, now, fetcher, ttlMs }: AppOptions) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const settings = new SettingsHolder(timeZone);
  const cache = new FeedCache({ settings, fetcher, now, ttlMs });

  app.get("/health", async () => ({ ok: true }));

  app.register(jeevesRoutes, { prefix: "/jeeves", settings, token });

  // Stateless MCP over Streamable HTTP: one server + transport per request.
  app.post("/mcp", async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const server = buildMcpServer({ cache, settings, now });
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
  const token = process.env.CALENDAR_PLUGIN_TOKEN;
  if (!token) throw new Error("CALENDAR_PLUGIN_TOKEN must be set");
  const app = buildApp({ token, timeZone: process.env.TZ ?? "Europe/London" });
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8083) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
