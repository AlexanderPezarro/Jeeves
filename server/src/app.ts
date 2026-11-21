import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { registerConfigRoutes, registerObservabilityRoutes } from "./api.js";
import { IDENTITY_HEADERS, peerMatcher, UiTokens, type ProxyAuthConfig } from "./auth.js";
import type { ConfigSource } from "./config.js";
import type { ConfigStore } from "./configstore.js";
import type { Db, Device } from "./db.js";
import type { Engine } from "./engine.js";
import { isManagedHost, registerPluginEvents, registerPluginRoutes, registerUiProxy, tokenAuthorizer } from "./pluginapi.js";
import type { PluginHost } from "./plugins.js";

export interface AppDeps {
  db: Db;
  engine: Engine;
  /** Live config; enables the workflow, config and plugin routes. */
  store?: ConfigStore;
  /** Defaults to `store`. Tests pass a static config. */
  config?: ConfigSource;
  plugins?: PluginHost;
  now?: () => Date;
  /** One-time code typed into the app to pair a phone. */
  pairingCode: string;
  /** When and from whom to trust Authelia's Remote-User header (the /admin/api scope). */
  proxyAuth?: ProxyAuthConfig;
  /** Built web UI (web/dist), served at /admin/. */
  webDir?: string;
  uiTokens?: UiTokens;
  /** VAPID public key (base64url) served to the app so it can register for Web Push. Unset: push is off. */
  vapidPublicKey?: string;
}

export interface Identity {
  kind: "device" | "user";
  name: string;
}

declare module "fastify" {
  interface FastifyRequest {
    device?: Device;
    identity?: Identity;
  }
}

const eventBody = z.object({
  type: z.string().regex(/^[a-z0-9_.-]+$/),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export function buildApp({ db, engine, pairingCode, store, config = store, plugins, now, proxyAuth, webDir, uiTokens = new UiTokens(), vapidPublicKey }: AppDeps) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const trustedPeer = peerMatcher(proxyAuth ?? { trust: false, trustedProxies: [] });
  const managed = isManagedHost(plugins) ? plugins : undefined;

  // Identity headers only count when Caddy (a trusted peer) set them; from anyone else they are dropped.
  app.addHook("onRequest", async (req) => {
    if (!trustedPeer(req.socket.remoteAddress)) for (const h of IDENTITY_HEADERS) delete req.headers[h];
  });

  /** Routes shared by the app (device token) and the web UI (Authelia user). */
  const shared = (scope: FastifyInstance, uiMount: string) => {
    if (store) registerConfigRoutes(scope, { db, engine, store });
    if (config && plugins) registerObservabilityRoutes(scope, { db, engine, config, store, plugins, now });
    if (store && managed) registerPluginRoutes(scope, { store, plugins: managed, tokens: uiTokens, uiMount, now });
  };

  app.get("/health", async () => ({ ok: true }));

  /** Exchanges the pairing code for a long-lived device token. */
  app.post("/pair", async (req, reply) => {
    const body = z.object({ code: z.string(), name: z.string().min(1).max(64) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "code and name are required" });
    if (body.data.code !== pairingCode) return reply.code(403).send({ error: "wrong pairing code" });
    const { device, token } = db.createDevice(body.data.name);
    return { device_id: device.id, token };
  });

  // Everything in this scope needs a device token. Remote-User is never looked at here.
  app.register(async (authed) => {
    authed.addHook("onRequest", async (req: FastifyRequest, reply) => {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      const device = token ? db.deviceByToken(token) : undefined;
      if (!device) return reply.code(401).send({ error: "unauthorized" });
      req.device = device;
      req.identity = { kind: "device", name: device.name };
    });

    authed.put("/devices/me/push", async (req, reply) => {
      const b64url = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/);
      const body = z
        .union([
          z.object({ fcm_token: z.string().nullable() }),
          z.object({ endpoint: z.url(), p256dh: b64url, auth: b64url }),
          z.object({ endpoint: z.null() }),
        ])
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "expected fcm_token, or endpoint with p256dh and auth, or endpoint: null" });
      const data = body.data;
      if ("fcm_token" in data) db.setPushToken(req.device!.id, data.fcm_token);
      else if (data.endpoint === null) db.setWebPush(req.device!.id, null);
      else db.setWebPush(req.device!.id, { endpoint: data.endpoint, p256dh: data.p256dh, auth: data.auth });
      return { ok: true };
    });

    /** The public VAPID key the app passes to UnifiedPush.register. */
    authed.get("/push/vapid-key", async (_req, reply) => {
      if (!vapidPublicKey) return reply.code(404).send({ error: "push_off" });
      return { public_key: vapidPublicKey };
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

    shared(authed, "/plugins");
  });

  if (managed && store) {
    // The app's WebView: authenticated by a short-lived ?t= token, then a path-scoped cookie.
    registerUiProxy(app, { plugins: managed, mount: "/plugins", authorize: tokenAuthorizer(uiTokens, "/plugins", now) });
    registerPluginEvents(app, { store, plugins: managed, engine });
  }

  // The web UI's API: only via Caddy + Authelia, which set Remote-User. Device tokens don't work here.
  app.register(
    async (admin) => {
      admin.addHook("onRequest", async (req, reply) => {
        const user = req.headers["remote-user"];
        if (typeof user !== "string" || !user) return reply.code(401).send({ error: "unauthorized", message: "sign in through /admin" });
        req.identity = { kind: "user", name: user };
      });
      admin.get("/me", async (req) => ({ identity: req.identity }));
      shared(admin, "/admin/api/plugins");
      if (managed) registerUiProxy(admin, { plugins: managed, mount: "/admin/api/plugins" });
    },
    { prefix: "/admin/api" },
  );

  if (webDir && existsSync(join(webDir, "index.html"))) {
    // Static files need no auth of their own: Authelia gates /admin in Caddy. SPA fallback to index.html.
    app.register(fastifyStatic, { root: resolve(webDir), serve: false });
    app.get("/", async (_req, reply) => reply.redirect("/admin/"));
    app.get("/admin", async (_req, reply) => reply.redirect("/admin/"));
    app.get("/admin/*", async (req, reply) => {
      const rel = normalize((req.params as { "*": string })["*"] || "index.html");
      if (rel.startsWith("..") || rel.startsWith("api/") || rel === "api") return reply.code(404).send({ error: "not_found" });
      const file = join(webDir, rel);
      const isFile = existsSync(file) && statSync(file).isFile();
      if (!isFile) reply.header("cache-control", "no-cache");
      else if (rel.startsWith("assets/")) reply.header("cache-control", "public, max-age=31536000, immutable");
      return reply.sendFile(isFile ? rel : "index.html", { cacheControl: false });
    });
  }

  return app;
}
