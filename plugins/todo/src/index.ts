import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Fastify from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp.js";
import { seedFromFile } from "./seed.js";
import { TodoStore } from "./store.js";

export interface AppOptions {
  store: TodoStore;
  token: string;
  timeZone: string;
  now?: () => Date;
}

export function buildApp({ store, token, timeZone, now }: AppOptions) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get("/health", async () => ({ ok: true }));

  // Stateless MCP over Streamable HTTP: one server + transport per request.
  app.post("/mcp", async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const server = buildMcpServer({ store, timeZone, now });
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
  const seedPath = process.env.TODO_CHORES_FILE ?? "./chores.yaml";
  if (existsSync(seedPath)) {
    const n = seedFromFile(store, seedPath);
    console.log(`Loaded ${n} chores from ${seedPath}`);
  }
  const app = buildApp({ store, token, timeZone: process.env.TZ ?? "Europe/London" });
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8081) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
