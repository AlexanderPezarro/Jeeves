import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { sendWriteError } from "./api.js";
import type { UiTokens } from "./auth.js";
import { formatIssues, pluginSchema } from "./config.js";
import type { ConfigStore } from "./configstore.js";
import type { Engine } from "./engine.js";
import { secretKeys, validateSettings, type Manifest } from "./manifest.js";
import type { McpPluginHost } from "./plugins.js";

/** The parts of McpPluginHost the plugin routes need (tests can pass the real host). */
export type ManagedPluginHost = Pick<
  McpPluginHost,
  "status" | "pluginConfig" | "token" | "baseUrl" | "manifest" | "refreshManifest" | "pushSettings" | "listTools"
>;

export const isManagedHost = (p: unknown): p is ManagedPluginHost => !!p && typeof (p as ManagedPluginHost).pushSettings === "function";

export interface PluginRouteDeps {
  store: ConfigStore;
  plugins: ManagedPluginHost;
  tokens: UiTokens;
  /** Path the WebView loads, e.g. "/plugins" on the device scope. */
  uiMount: string;
  now?: () => Date;
}

const UI_TOKEN_TTL = 5 * 60_000;
const UI_COOKIE_TTL = 8 * 3600_000;
const UI_COOKIE = "jeeves_ui";

async function manifestOf(plugins: ManagedPluginHost, name: string): Promise<Manifest | null> {
  const cached = plugins.manifest(name);
  return cached === undefined ? plugins.refreshManifest(name) : cached;
}

/** Plugin list, settings, add/remove, UI tokens. Registered under both auth scopes. */
export function registerPluginRoutes(app: FastifyInstance, { store, plugins, tokens, uiMount, now = () => new Date() }: PluginRouteDeps) {
  app.get("/plugins", async () => {
    const status = new Map(plugins.status().map((s) => [s.name, s]));
    const list = [];
    for (const p of store.current.plugins) {
      list.push({ ...p, manifest: (await manifestOf(plugins, p.name).catch(() => null)) ?? null, status: status.get(p.name) ?? null });
    }
    return { plugins: list, hash: store.readGlobals().hash };
  });

  app.post("/plugins", async (req, reply) => {
    const body = pluginSchema.extend({ hash: z.string().nullable().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation", message: "name, url and token_env are required", issues: formatIssues(body.error) });
    const { hash, ...plugin } = body.data;
    try {
      store.addPlugin(plugin, hash);
    } catch (e) {
      return sendWriteError(reply, e);
    }
    return reply.code(201).send({ plugin });
  });

  app.delete("/plugins/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      store.removePlugin(name, (req.query as { hash?: string }).hash);
    } catch (e) {
      return sendWriteError(reply, e);
    }
    return { ok: true };
  });

  app.get("/plugins/:name/settings", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!plugins.pluginConfig(name)) return reply.code(404).send({ error: "not_found", message: `no plugin ${name}` });
    const manifest = await manifestOf(plugins, name);
    const view = store.readPluginSettings(name);
    return { values: view.parsed, hash: view.hash, schema: manifest?.settings_schema ?? null, secrets: secretKeys(manifest?.settings_schema) };
  });

  app.put("/plugins/:name/settings", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!plugins.pluginConfig(name)) return reply.code(404).send({ error: "not_found", message: `no plugin ${name}` });
    const body = z.object({ values: z.record(z.string(), z.unknown()), hash: z.string().nullable().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation", message: "send {values, hash}", issues: formatIssues(body.error) });
    const manifest = await manifestOf(plugins, name);
    if (!manifest?.settings_schema) return reply.code(400).send({ error: "validation", message: `plugin ${name} has no settings`, issues: [] });
    const issues = validateSettings(manifest.settings_schema, body.data.values).map((i) => ({ path: ["values", ...i.path], message: i.message }));
    if (issues.length) return reply.code(400).send({ error: "validation", message: "invalid settings", issues });
    let saved;
    try {
      saved = store.writePluginSettings(name, body.data.values, body.data.hash);
    } catch (e) {
      return sendWriteError(reply, e);
    }
    try {
      await plugins.pushSettings(name, body.data.values);
    } catch (e) {
      return reply.code(502).send({ error: "push_failed", message: `Saved, but ${name} did not accept them: ${(e as Error).message}`, hash: saved.hash });
    }
    return { values: saved.parsed, hash: saved.hash, schema: manifest.settings_schema, secrets: secretKeys(manifest.settings_schema) };
  });

  app.post("/plugins/:name/ui-token", async (req, reply) => {
    const { name } = req.params as { name: string };
    const manifest = plugins.pluginConfig(name) ? await manifestOf(plugins, name) : null;
    if (!manifest?.ui) return reply.code(404).send({ error: "not_found", message: `plugin ${name} has no UI` });
    const t = tokens.mint(name, UI_TOKEN_TTL, now());
    return { ...t, url: `${uiMount}/${name}/ui/?t=${encodeURIComponent(t.token)}` };
  });
}

function cookies(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const FORWARD_REQUEST = ["accept", "accept-language", "content-type", "if-none-match", "if-modified-since"];
const FORWARD_RESPONSE = ["content-type", "cache-control", "etag", "last-modified", "content-disposition"];

/**
 * Reverse-proxies `<mount>/:name/ui/*` to `<plugin base><manifest.ui.path>/*`, adding the plugin's
 * bearer token. Only GET/HEAD/POST, only under the manifest's ui.path, no client auth or cookies
 * passed on and no plugin cookies passed back.
 *
 * `authorize` decides whether the request may see the page; on the device mount it checks the
 * short-lived `?t=` token and swaps it for a cookie scoped to the plugin's UI path.
 */
export function registerUiProxy(
  app: FastifyInstance,
  opts: { plugins: ManagedPluginHost; mount: string; authorize?: (req: FastifyRequest, reply: FastifyReply, name: string) => boolean },
) {
  const { plugins, mount } = opts;
  app.register(async (scope) => {
    // Bodies are forwarded byte for byte.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

    scope.get("/plugins/:name/ui", async (req, reply) => {
      const q = req.raw.url!.includes("?") ? req.raw.url!.slice(req.raw.url!.indexOf("?")) : "";
      return reply.redirect(`${mount}/${(req.params as { name: string }).name}/ui/${q}`);
    });

    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const { name } = req.params as { name: string };
      if (opts.authorize && !opts.authorize(req, reply, name)) return reply.code(401).send({ error: "unauthorized" });
      if (!plugins.pluginConfig(name)) return reply.code(404).send({ error: "not_found" });
      const manifest = await manifestOf(plugins, name);
      if (!manifest?.ui) return reply.code(404).send({ error: "not_found", message: `plugin ${name} has no UI` });

      const raw = req.raw.url!;
      const marker = `/plugins/${name}/ui/`;
      const restWithQuery = raw.slice(raw.indexOf(marker) + marker.length);
      const [restPath, query = ""] = restWithQuery.split(/\?(.*)/s, 2);
      const params = new URLSearchParams(query);
      params.delete("t");
      let decoded: string;
      try {
        decoded = decodeURIComponent(restPath);
      } catch {
        return reply.code(400).send({ error: "bad path" });
      }
      if (decoded.split("/").some((seg) => seg === ".." || seg === ".") || decoded.includes("\\")) return reply.code(400).send({ error: "bad path" });
      const prefix = manifest.ui.path.replace(/\/+$/, "");
      const target = new URL(`${prefix}/${restPath}`, `${plugins.baseUrl(name)}/`);
      if (!target.pathname.startsWith(`${prefix}/`)) return reply.code(400).send({ error: "bad path" });
      const qs = params.toString();
      if (qs) target.search = qs;

      const headers: Record<string, string> = { Authorization: `Bearer ${plugins.token(name) ?? ""}` };
      for (const h of FORWARD_REQUEST) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }
      let res: Response;
      try {
        res = await fetch(target, {
          method: req.method,
          headers,
          body: req.method === "POST" && Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : undefined,
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        return reply.code(502).send({ error: "plugin_unreachable", message: (e as Error).message });
      }
      reply.code(res.status);
      for (const h of FORWARD_RESPONSE) {
        const v = res.headers.get(h);
        if (v) reply.header(h, v);
      }
      const location = res.headers.get("location");
      if (location && !/^[a-z]+:|^\/\//i.test(location)) {
        // Relative redirects stay relative; absolute paths under ui.path are mapped onto the mount.
        reply.header("location", location.startsWith(`${prefix}/`) ? `${mount}/${name}/ui/${location.slice(prefix.length + 1)}` : location.startsWith("/") ? `${mount}/${name}/ui/` : location);
      }
      reply.header("content-security-policy", "frame-ancestors 'self'");
      reply.header("x-content-type-options", "nosniff");
      return reply.send(Buffer.from(await res.arrayBuffer()));
    };
    scope.route({ method: ["GET", "HEAD", "POST"], url: "/plugins/:name/ui/*", handler });
  });
}

/** Device-mount authorizer: a valid `?t=` token (swapped for a scoped cookie) or that cookie. */
export function tokenAuthorizer(tokens: UiTokens, mount: string, now: () => Date = () => new Date()) {
  return (req: FastifyRequest, reply: FastifyReply, name: string): boolean => {
    const t = (req.query as { t?: string }).t;
    if (t && tokens.verify(t, name, now())) {
      const long = tokens.mint(name, UI_COOKIE_TTL, now());
      const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      reply.header(
        "set-cookie",
        `${UI_COOKIE}_${name}=${encodeURIComponent(long.token)}; Path=${mount}/${name}/ui/; Max-Age=${UI_COOKIE_TTL / 1000}; HttpOnly; SameSite=Lax${secure}`,
      );
      return true;
    }
    return tokens.verify(cookies(req)[`${UI_COOKIE}_${name}`], name, now());
  };
}

/** The configured plugin whose bearer token the request carries, if any. */
export function pluginFromToken(req: FastifyRequest, store: ConfigStore, plugins: ManagedPluginHost) {
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  return token ? store.current.plugins.find((p) => plugins.token(p.name) === token) : undefined;
}

/**
 * `POST /plugin-events {type, payload}` from plugins, authenticated by matching the bearer against
 * each configured plugin's token. Stored as `<plugin>.<type>`; types not in the manifest are refused.
 */
export function registerPluginEvents(app: FastifyInstance, { store, plugins, engine }: { store: ConfigStore; plugins: ManagedPluginHost; engine: Engine }) {
  app.post("/plugin-events", async (req, reply) => {
    const plugin = pluginFromToken(req, store, plugins);
    if (!plugin) return reply.code(401).send({ error: "unauthorized" });
    const body = z
      .object({ type: z.string().regex(/^[a-z0-9_-]+$/), payload: z.record(z.string(), z.unknown()).default({}) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation", issues: formatIssues(body.error) });
    const manifest = await manifestOf(plugins, plugin.name);
    if (!manifest?.events.includes(body.data.type)) {
      return reply.code(400).send({ error: "unknown_event", message: `${plugin.name} does not declare event "${body.data.type}" in its manifest` });
    }
    const { event, decisions } = engine.handleEvent(`${plugin.name}.${body.data.type}`, body.data.payload, null);
    return { event_id: event.id, type: event.type, workflows: decisions };
  });
}
