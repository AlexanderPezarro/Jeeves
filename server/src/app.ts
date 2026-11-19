import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import { registerConfigRoutes } from "./api.js";
import type { ConfigStore } from "./configstore.js";
import type { Db, Device } from "./db.js";
import type { Engine } from "./engine.js";

export interface AppDeps {
  db: Db;
  engine: Engine;
  /** Live config; enables the workflow and config routes. */
  store?: ConfigStore;
  /** One-time code typed into the app to pair a phone. */
  pairingCode: string;
}

declare module "fastify" {
  interface FastifyRequest {
    device?: Device;
  }
}

const eventBody = z.object({
  type: z.string().regex(/^[a-z0-9_.-]+$/),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export function buildApp({ db, engine, pairingCode, store }: AppDeps) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get("/health", async () => ({ ok: true }));

  /** Exchanges the pairing code for a long-lived device token. */
  app.post("/pair", async (req, reply) => {
    const body = z.object({ code: z.string(), name: z.string().min(1).max(64) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "code and name are required" });
    if (body.data.code !== pairingCode) return reply.code(403).send({ error: "wrong pairing code" });
    const { device, token } = db.createDevice(body.data.name);
    return { device_id: device.id, token };
  });

  // Everything below needs a device token.
  app.register(async (authed) => {
    authed.addHook("onRequest", async (req: FastifyRequest, reply) => {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      const device = token ? db.deviceByToken(token) : undefined;
      if (!device) return reply.code(401).send({ error: "unauthorized" });
      req.device = device;
    });

    authed.put("/devices/me/push", async (req, reply) => {
      const body = z.object({ fcm_token: z.string().nullable() }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "fcm_token is required" });
      db.setPushToken(req.device!.id, body.data.fcm_token);
      return { ok: true };
    });

    /** Trigger events from the phone, e.g. {type: "wifi.connected", payload: {ssid: "home"}}. */
    authed.post("/events", async (req, reply) => {
      const body = eventBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { event, decisions } = engine.handleEvent(body.data.type, body.data.payload, req.device!.id);
      return {
        event_id: event.id,
        // `rules` is kept for app versions that predate workflows.
        rules: decisions.map((d) => ({ id: d.workflow_id, fired: d.fired, reason: d.reason })),
        workflows: decisions,
      };
    });

    /** The "Plan my day" button. */
    authed.post("/plan", async (req) => {
      const { event, decisions } = engine.handleEvent("manual.plan", {}, req.device!.id);
      return { event_id: event.id, fired: decisions.some((d) => d.fired) };
    });

    authed.get("/today", async (_req, reply) => {
      try {
        return { tasks: await engine.today() };
      } catch (e) {
        return reply.code((e as { notFound?: boolean }).notFound ? 404 : 502).send({ error: (e as Error).message });
      }
    });

    authed.post("/tasks/:id/action", async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const body = z
        .object({ action: z.enum(["start", "done", "skip", "snooze"]), minutes: z.number().int().min(1).max(1440).optional() })
        .safeParse(req.body);
      if (!Number.isInteger(id) || !body.success) return reply.code(400).send({ error: "invalid task action" });
      const res = await engine.taskAction(id, body.data.action, body.data.minutes);
      if (res.isError) return reply.code((res as { notFound?: boolean }).notFound ? 404 : 502).send({ error: res.text });
      return JSON.parse(res.text);
    });

    authed.get("/messages", async (req) => {
      const after = Number((req.query as { after?: string }).after ?? 0) || 0;
      return { messages: db.messagesAfter(after) };
    });

    authed.post("/messages", async (req, reply) => {
      const body = z.object({ text: z.string().min(1).max(2000) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "text is required" });
      return engine.handleUserMessage(body.data.text);
    });

    authed.get("/runs", async () => ({ runs: db.recentRuns() }));

    if (store) registerConfigRoutes(authed, { db, engine, store });
  });

  return app;
}
