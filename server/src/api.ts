import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ConfigWriteError, type ConfigStore } from "./configstore.js";
import type { Db } from "./db.js";
import type { Engine } from "./engine.js";

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
}
