import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "./db.js";
import { viewItemSchema } from "./manifest.js";
import type { ManagedPluginHost } from "./pluginapi.js";

const ID = /^[a-z0-9_.-]{1,64}$/;

/**
 * Plugin views and item actions for the app (device scope). The server knows nothing about what
 * the items are: it lists the views plugins declare, relays `GET <plugin>/jeeves/views/<id>`, and
 * forwards button taps to `POST <plugin>/jeeves/actions`. When the plugin answers `resolved: true`
 * (e.g. a task is done), pending follow-ups about that item are cancelled.
 */
export function registerViewRoutes(app: FastifyInstance, {
    plugins,
    db,
    now = () => new Date(),
    cancelRun,
  }: { plugins: ManagedPluginHost; db: Db; now?: () => Date; cancelRun?: (runId: number, reason: string) => unknown },
) {
  app.get("/views", async () => ({ views: plugins.views() }));

  app.get("/views/:plugin/:id", async (req, reply) => {
    const { plugin, id } = req.params as { plugin: string; id: string };
    const view = plugins.views().find((v) => v.plugin === plugin && v.id === id);
    if (!view) return reply.code(404).send({ error: "not_found", message: `no view ${plugin}/${id}` });
    try {
      const res = await plugins.jeevesRequest(plugin, "GET", `/views/${encodeURIComponent(id)}`);
      if (res.status !== 200) return reply.code(502).send({ error: "plugin_error", message: `${plugin} answered ${res.status}`, detail: res.body });
      const items = z.object({ items: z.array(viewItemSchema) }).safeParse(res.body);
      if (!items.success) return reply.code(502).send({ error: "plugin_error", message: `${plugin} sent an invalid view: ${items.error.message}` });
      return { ...view, items: items.data.items };
    } catch (e) {
      return reply.code(502).send({ error: "plugin_unreachable", message: (e as Error).message });
    }
  });

  app.post("/plugins/:plugin/actions", async (req, reply) => {
    const { plugin } = req.params as { plugin: string };
    const body = z
      .object({ item: z.string().min(1).max(128), action: z.string().regex(ID), args: z.record(z.string(), z.unknown()).default({}) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation", message: "send {item, action, args?}" });
    if (!plugins.pluginConfig(plugin)) return reply.code(404).send({ error: "not_found", message: `no plugin ${plugin}` });
    try {
      const res = await plugins.jeevesRequest(plugin, "POST", "/actions", body.data);
      const answer = (res.body && typeof res.body === "object" ? res.body : {}) as { resolved?: unknown; message?: unknown; error?: unknown };
      if (res.status >= 400) {
        // The plugin's own 4xx (unknown item, bad transition) is passed on; anything else is a 502.
        return reply.code(res.status < 500 ? res.status : 502).send({ error: "plugin_error", message: String(answer.error ?? `${plugin} answered ${res.status}`) });
      }
      let cancelled = 0;
      if (answer.resolved === true) {
        cancelled = db.cancelJobsForItem(plugin, body.data.item, now());
        // A workflow nagging about this item has nothing left to wait for: end it, or it would block its
        // workflow for good ("already waiting"). If the matching todo.* event arrives at the same moment and
        // resumes the run first, the run ends either way, so whichever lands first wins.
        for (const n of db.nagRunsForItem(plugin, body.data.item)) cancelRun?.(n.run_id, "item resolved");
      }
      db.addActivity("item_action", plugin, { item: body.data.item, action: body.data.action, cancelled_followups: cancelled }, now());
      return { ok: true, message: typeof answer.message === "string" ? answer.message : null, resolved: answer.resolved === true };
    } catch (e) {
      return reply.code(502).send({ error: "plugin_unreachable", message: (e as Error).message });
    }
  });
}
