import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { formatIssues, type ConfigSource } from "./config.js";
import { ConfigWriteError, type ConfigStore } from "./configstore.js";
import type { Db } from "./db.js";
import type { Engine } from "./engine.js";
import type { EventInfo } from "./manifest.js";
import type { PluginHost } from "./plugins.js";
import { activityFeed, health, runDetailById, upcoming } from "./timeline.js";

export interface ApiDeps {
  db: Db;
  engine: Engine;
  store: ConfigStore;
}

/** Maps ConfigStore write errors to 400 (issues), 404, 409 (stale, with the current file). */
export function sendWriteError(reply: FastifyReply, e: unknown) {
  if (e instanceof ConfigWriteError) {
    if (e.kind === "validation") return reply.code(400).send({ error: "validation", message: e.message, issues: e.detail.issues ?? [] });
    if (e.kind === "stale") return reply.code(409).send({ error: "stale", message: e.message, current: e.detail.current ?? null });
    if (e.kind === "not_found") return reply.code(404).send({ error: "not_found", message: e.message });
    return reply.code(409).send({ error: "conflict", message: e.message });
  }
  throw e;
}

const hashField = z.string().nullable().optional();

/**
 * Config and workflow routes. Registered under both auth scopes: `/` (device token, for the app)
 * and `/admin/api` (Authelia's Remote-User, for the web UI).
 */
export function registerConfigRoutes(app: FastifyInstance, { db, store }: ApiDeps) {
  app.get("/workflows", async () => {
    const last = db.lastWorkflowRuns();
    return {
      workflows: store.listWorkflows().map((w) => {
        const run = last[w.id];
        return { ...w, last_run: run ? { id: run.id, status: run.status, started_at: run.started_at, finished_at: run.finished_at, error: run.error } : null };
      }),
    };
  });

  app.get("/workflows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const wf = store.readWorkflow(id);
      if (!wf) return reply.code(404).send({ error: "not_found", message: `no workflow ${id}` });
      return wf;
    } catch (e) {
      return sendWriteError(reply, e);
    }
  });

  app.put("/workflows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ yaml: z.string().optional(), workflow: z.unknown().optional(), hash: hashField }).safeParse(req.body);
    if (!body.success || (body.data.yaml === undefined && body.data.workflow === undefined)) {
      return reply.code(400).send({ error: "validation", message: "send {yaml | workflow, hash}", issues: [] });
    }
    try {
      return store.writeWorkflow(id, { yaml: body.data.yaml, workflow: body.data.workflow }, body.data.hash);
    } catch (e) {
      return sendWriteError(reply, e);
    }
  });

  app.delete("/workflows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const hash = (req.query as { hash?: string }).hash ?? (req.body as { hash?: string } | undefined)?.hash;
    try {
      store.deleteWorkflow(id, hash ?? store.readWorkflow(id)?.hash);
      return { ok: true };
    } catch (e) {
      return sendWriteError(reply, e);
    }
  });

  app.patch("/workflows/:id/enabled", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ enabled: z.boolean(), hash: hashField }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation", message: "enabled (boolean) is required", issues: [] });
    try {
      return store.setWorkflowEnabled(id, body.data.enabled, body.data.hash);
    } catch (e) {
      return sendWriteError(reply, e);
    }
  });

  app.get("/config/errors", async () => ({ errors: store.errors }));

  /** Settings form: the globals in jeeves.yaml (plugins have their own routes). */
  app.get("/config/globals", async () => store.readGlobals());

  app.put("/config/globals", async (req, reply) => {
    const body = z.object({ patch: z.record(z.string(), z.unknown()), hash: hashField }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation", message: "send {patch, hash}", issues: [] });
    try {
      return store.writeGlobals(body.data.patch, body.data.hash);
    } catch (e) {
      return sendWriteError(reply, e);
    }
  });
}

type SourcedEventInfo = EventInfo & { source: string };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties });

/** Built-in events the trigger picker always offers, with the payload the phone sends. */
export const BUILTIN_EVENT_INFO: SourcedEventInfo[] = [
  {
    type: "wifi.connected",
    title: "Joined a Wi-Fi network",
    description: "The phone joined one of the Wi-Fi networks it watches.",
    payload_schema: obj({
      ssid: { type: "string", description: "Network name" },
      away_minutes: { type: "integer", description: "Minutes since the phone last left this network" },
    }),
  },
  {
    type: "wifi.disconnected",
    title: "Left a Wi-Fi network",
    description: "The phone left one of the Wi-Fi networks it watches.",
    payload_schema: obj({ ssid: { type: "string", description: "Network name" } }),
  },
  { type: "location.arrived", title: "Arrived at a place", description: null, payload_schema: null },
  { type: "location.left", title: "Left a place", description: null, payload_schema: null },
  {
    type: "message.received",
    title: "Chat message",
    description: "You wrote to Jeeves in the app's chat.",
    payload_schema: obj({ text: { type: "string", description: "What you wrote" }, message_id: { type: "integer", description: "Stored message id" } }),
  },
  { type: "manual.plan", title: "Plan button", description: 'The app\'s "Plan my day" button.', payload_schema: obj({}) },
].map((e) => ({ ...e, source: "builtin" }));

/** Built-in event types the trigger picker always offers. */
export const BUILTIN_EVENTS = BUILTIN_EVENT_INFO.map((e) => e.type);

/** Observability, simulate and run-now routes. Registered under both auth scopes, like the config routes. */
export function registerObservabilityRoutes(
  app: FastifyInstance,
  { db, engine, config, store, plugins, now = () => new Date() }: { db: Db; engine: Engine; config: ConfigSource; store?: ConfigStore; plugins: PluginHost; now?: () => Date },
) {
  const deps = { db, config, plugins, store };

  app.get("/timeline/upcoming", async (req) => {
    const hours = Math.min(Math.max(Number((req.query as { hours?: string }).hours ?? 48) || 48, 1), 24 * 14);
    return upcoming(deps, hours, now());
  });

  app.get("/activity", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return activityFeed(deps, {
      from: q.from,
      to: q.to,
      workflow: q.workflow,
      kind: q.kind,
      status: q.status,
      limit: q.limit ? Number(q.limit) : undefined,
      cursor: q.cursor,
    });
  });

  app.get("/health/summary", async () => health(deps, now()));

  app.post("/simulate", async (req, reply) => {
    const body = z
      .object({ event_type: z.string().regex(/^[a-z0-9_.-]+$/), payload: z.record(z.string(), z.unknown()).default({}), at: z.string().datetime({ offset: true }).optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation", message: "invalid request", issues: formatIssues(body.error) });
    const at = body.data.at ? new Date(body.data.at) : now();
    return { at: at.toISOString(), decisions: engine.simulate(body.data.event_type, body.data.payload, at) };
  });

  app.post("/workflows/:id/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ dry_run: z.boolean().default(false), payload: z.record(z.string(), z.unknown()).default({}) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "validation", message: "invalid request", issues: formatIssues(body.error) });
    let run;
    try {
      run = engine.runNow(id, { dryRun: body.data.dry_run, payload: body.data.payload });
    } catch (e) {
      if ((e as { notFound?: boolean }).notFound) return reply.code(404).send({ error: "not_found", message: (e as Error).message });
      throw e;
    }
    // Dry runs finish straight away (waits are skipped), so the caller gets the whole result.
    if (body.data.dry_run) await run.done;
    return { workflow_run_id: run.workflowRunId, run: runDetailById(db, run.workflowRunId) };
  });

  app.get("/workflow-runs/:id", async (req, reply) => {
    const run = runDetailById(db, Number((req.params as { id: string }).id));
    return run ?? reply.code(404).send({ error: "not_found" });
  });

  app.get("/runs/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const run = db.getRun(id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    return { ...run, messages: db.messagesForRun(id) };
  });

  app.delete("/jobs/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!db.getJob(id)) return reply.code(404).send({ error: "not_found" });
    if (!engine.cancelJob(id)) return reply.code(409).send({ error: "conflict", message: "job already ran or was cancelled" });
    return { ok: true };
  });

  app.get("/tools", async () => ({ tools: await plugins.listTools() }));

  /**
   * `event_types`: every type a trigger can wait for (built-in, declared by plugins, or seen).
   * `events`: the described ones, with payload schemas for the editor's field suggestions.
   */
  app.get("/event-types", async () => {
    const seen = db.eventTypes().filter((t) => !t.startsWith("schedule.") && t !== "manual.run");
    const pluginEvents = (plugins as { manifestEventInfo?: () => SourcedEventInfo[] }).manifestEventInfo?.() ?? [];
    const events = [...BUILTIN_EVENT_INFO, ...pluginEvents];
    return { event_types: [...new Set([...events.map((e) => e.type), ...seen])], events };
  });
}
