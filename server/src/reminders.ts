import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { formatIssues } from "./config.js";
import type { ConfigStore } from "./configstore.js";
import type { Db, ReminderPayload } from "./db.js";
import type { Engine } from "./engine.js";
import { pluginFromToken, type ManagedPluginHost } from "./pluginapi.js";

/** A reminder this far past its time is refused (single PUT) or dropped (group PUT). */
const TOO_LATE_MS = 5 * 60_000;

const ID = /^[A-Za-z0-9:._-]{1,128}$/;

const itemSchema = z.object({
  task_id: z.number().int().optional(),
  title: z.string().min(1).max(200),
  minutes: z.number().int().min(0).max(100_000).optional(),
  steps: z.array(z.string().max(500)).max(30).default([]),
});

const reminderFields = {
  at: z.iso.datetime({ offset: true }),
  level: z.enum(["notify", "loud", "alarm"]),
  text: z.string().min(1).max(500),
  items: z.array(itemSchema).max(50).optional(),
};

const putBody = z.object({ ...reminderFields, group: z.string().regex(ID).optional() });
const groupBody = z.object({
  reminders: z.array(z.object({ key: z.string().regex(ID), ...reminderFields })).max(200),
});

type ReminderInput = z.infer<typeof putBody>;

const toPayload = (r: Pick<ReminderInput, "text" | "level" | "items">): Omit<ReminderPayload, "snoozed_from"> => ({
  text: r.text,
  level: r.level,
  items: r.items ?? [],
});

export interface ReminderDeps {
  store: ConfigStore;
  plugins: ManagedPluginHost;
  db: Db;
  engine: Engine;
  now?: () => Date;
}

/**
 * Plugin reminders: `PUT/DELETE /plugin-reminders/:key` and `PUT /plugin-reminders?group=<g>`,
 * authenticated by the plugin's bearer token. Reminders are `reminder` jobs; the engine's tick
 * turns them into messages (with a level) when they come due.
 */
export function registerPluginReminders(app: FastifyInstance, { store, plugins, db, engine, now = () => new Date() }: ReminderDeps) {
  const keyParam = z.string().regex(ID);

  app.put("/plugin-reminders/:key", async (req, reply) => {
    const plugin = pluginFromToken(req, store, plugins);
    if (!plugin) return reply.code(401).send({ error: "unauthorized" });
    const key = keyParam.safeParse((req.params as { key: string }).key);
    const body = putBody.safeParse(req.body);
    if (!key.success || !body.success) {
      return reply.code(400).send({ error: "validation", issues: key.success ? formatIssues(body.error!) : [{ path: ["key"], message: "invalid key" }] });
    }
    const at = new Date(body.data.at);
    if (at.getTime() < now().getTime() - TOO_LATE_MS) return reply.code(400).send({ error: "too_late", message: "that time has already passed" });
    const res = db.upsertReminder(plugin.name, key.data, body.data.group ?? null, at, toPayload(body.data));
    if (res.status === "scheduled" && at.getTime() <= now().getTime()) await engine.runDueJobs();
    return { key: key.data, status: res.status, job_id: res.job_id, at: at.toISOString() };
  });

  app.delete("/plugin-reminders/:key", async (req, reply) => {
    const plugin = pluginFromToken(req, store, plugins);
    if (!plugin) return reply.code(401).send({ error: "unauthorized" });
    const key = keyParam.safeParse((req.params as { key: string }).key);
    if (!key.success) return reply.code(400).send({ error: "validation", issues: [{ path: ["key"], message: "invalid key" }] });
    return { cancelled: db.cancelReminder(plugin.name, key.data, "deleted", now()) };
  });

  app.put("/plugin-reminders", async (req, reply) => {
    const plugin = pluginFromToken(req, store, plugins);
    if (!plugin) return reply.code(401).send({ error: "unauthorized" });
    const group = keyParam.safeParse((req.query as { group?: string }).group);
    const body = groupBody.safeParse(req.body);
    if (!group.success || !body.success) {
      return reply.code(400).send({ error: "validation", issues: group.success ? formatIssues(body.error!) : [{ path: ["group"], message: "group is required" }] });
    }
    const keys = body.data.reminders.map((r) => r.key);
    if (new Set(keys).size !== keys.length) return reply.code(400).send({ error: "validation", issues: [{ path: ["reminders"], message: "duplicate keys" }] });

    const out = { scheduled: [] as string[], unchanged: [] as string[], dropped: [] as string[], cancelled: [] as string[] };
    const nowMs = now().getTime();
    let dueNow = false;
    db.sql.transaction(() => {
      for (const p of db.pendingRemindersInGroup(plugin.name, group.data)) {
        if (!keys.includes(p.reminder_key as string) && db.cancelReminder(plugin.name, p.reminder_key as string, "replaced", now())) {
          out.cancelled.push(p.reminder_key as string);
        }
      }
      for (const r of body.data.reminders) {
        const at = new Date(r.at);
        if (at.getTime() < nowMs - TOO_LATE_MS) {
          out.dropped.push(r.key);
          continue;
        }
        const res = db.upsertReminder(plugin.name, r.key, group.data, at, toPayload(r));
        if (res.status === "scheduled") {
          out.scheduled.push(r.key);
          if (at.getTime() <= nowMs) dueNow = true;
        } else out.unchanged.push(r.key);
      }
    })();
    if (dueNow) await engine.runDueJobs();
    return out;
  });
}
