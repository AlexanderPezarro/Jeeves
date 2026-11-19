import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { Agent } from "./agent.js";
import { buildApp } from "./app.js";
import { UiTokens } from "./auth.js";
import { ConfigStore } from "./configstore.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import type { Manifest } from "./manifest.js";
import { McpPluginHost } from "./plugins.js";
import { pair, RecordingNotifier, scriptedClaude, tmpConfigDir } from "./testkit.js";

const TOKEN = "fake-plugin-token";

const MANIFEST: Manifest = {
  name: "fake",
  display_name: "Fake",
  version: "1.0.0",
  settings_schema: {
    type: "object",
    properties: {
      greeting: { type: "string" },
      volume: { type: "integer", minimum: 0, maximum: 10 },
      api_key: { type: "string", format: "secret" },
    },
    additionalProperties: false,
  },
  ui: { path: "/jeeves/ui", title: "Fake page" },
  events: ["thing_happened"],
  today: true,
};

/** A plugin that only speaks the /jeeves contract (no MCP), recording what Jeeves sends it. */
async function fakePlugin(manifest: Manifest | null = MANIFEST) {
  const seen = { settings: [] as unknown[], ui: [] as { url: string; headers: Record<string, unknown>; body: string }[] };
  const app = Fastify();
  app.addContentTypeParser("*", { parseAs: "string" }, (_r, b, d) => d(null, b));
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply.code(401).send({ error: "unauthorized" });
  });
  app.get("/jeeves/manifest", async (_req, reply) => (manifest ? manifest : reply.code(404).send({ error: "no manifest" })));
  app.put("/jeeves/settings", async (req) => {
    seen.settings.push(req.body);
    return { ok: true };
  });
  app.route({
    method: ["GET", "POST", "PUT"],
    url: "/jeeves/ui/*",
    handler: async (req, reply) => {
      seen.ui.push({ url: req.url, headers: req.headers, body: typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? "") });
      if (req.url.startsWith("/jeeves/ui/go")) return reply.redirect("/jeeves/ui/landed");
      reply.header("set-cookie", "plugin=evil").header("x-secret", "nope").type("text/html");
      return `<p>page ${req.url}</p>`;
    },
  });
  app.get("/elsewhere", async () => "outside ui path");
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, url, seen };
}

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function world(manifest: Manifest | null = MANIFEST) {
  const plugin = await fakePlugin(manifest);
  const dir = tmpConfigDir({ plugins: [{ name: "fake", url: `${plugin.url}/mcp`, token_env: "FAKE_TOKEN" }] });
  const store = new ConfigStore(dir);
  const env = { FAKE_TOKEN: TOKEN, FAKE_API_KEY: "s3cret" };
  const host = new McpPluginHost(store.current.plugins, { env, settingsFor: (n) => store.current.plugin_settings[n] });
  store.on("reload", () => host.setPlugins(store.current.plugins));
  const db = new Db();
  const agent = new Agent({ db, config: store, plugins: host, notifier: new RecordingNotifier(), create: scriptedClaude([]).create });
  const engine = new Engine(db, store, host, agent);
  const tokens = new UiTokens();
  const app = buildApp({ db, engine, pairingCode: "pair-me-please", store, plugins: host, uiTokens: tokens, proxyAuth: { trust: true, trustedProxies: ["127.0.0.1"] } });
  closers.push(() => plugin.app.close(), async () => store.close());
  const headers = await pair(app);
  return { plugin, store, host, db, engine, app, headers, tokens };
}

describe("plugin manifest", () => {
  it("fetches and caches the manifest, and picks the today: true plugin", async () => {
    const w = await world();
    expect(await w.host.refreshManifest("fake")).toMatchObject({ display_name: "Fake", today: true });
    expect(w.host.manifestEvents()).toEqual(["fake.thing_happened"]);
    expect(w.engine.todayPlugin()).toBe("fake");
    const list = (await w.app.inject({ method: "GET", url: "/plugins", headers: w.headers })).json();
    expect(list.plugins[0]).toMatchObject({ name: "fake", manifest: { ui: { title: "Fake page" } } });
  });

  it("treats a plugin without a manifest as tools-only", async () => {
    const w = await world(null);
    expect(await w.host.refreshManifest("fake")).toBeNull();
    expect(w.engine.todayPlugin()).toBeNull();
    expect((await w.app.inject({ method: "GET", url: "/today", headers: w.headers })).json()).toEqual({ error: "no Today plugin" });
  });
});

describe("plugin settings", () => {
  it("validates with the manifest schema, stores secrets as env references and pushes resolved values", async () => {
    const w = await world();
    const get = (await w.app.inject({ method: "GET", url: "/plugins/fake/settings", headers: w.headers })).json();
    expect(get).toMatchObject({ values: {}, hash: "", secrets: ["api_key"] });

    const bad = await w.app.inject({ method: "PUT", url: "/plugins/fake/settings", headers: w.headers, payload: { values: { volume: 99 }, hash: null } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues[0].path).toEqual(["values", "volume"]);
    const literal = await w.app.inject({ method: "PUT", url: "/plugins/fake/settings", headers: w.headers, payload: { values: { api_key: "plaintext" }, hash: null } });
    expect(literal.statusCode).toBe(400);
    expect(literal.json().issues[0].message).toMatch(/env/);

    const ok = await w.app.inject({
      method: "PUT",
      url: "/plugins/fake/settings",
      headers: w.headers,
      payload: { values: { greeting: "hi", volume: 3, api_key: { env: "FAKE_API_KEY" } }, hash: null },
    });
    expect(ok.statusCode).toBe(200);
    expect(w.store.readPluginSettings("fake").yaml).toContain("env: FAKE_API_KEY");
    expect(w.store.readPluginSettings("fake").yaml).not.toContain("s3cret");
    expect(w.plugin.seen.settings).toEqual([{ greeting: "hi", volume: 3, api_key: "s3cret" }]);

    // A stale hash is refused.
    const stale = await w.app.inject({ method: "PUT", url: "/plugins/fake/settings", headers: w.headers, payload: { values: { volume: 4 }, hash: null } });
    expect(stale.statusCode).toBe(409);
  });

  it("re-pushes stored settings when the plugin comes back", async () => {
    const w = await world();
    w.store.writePluginSettings("fake", { volume: 5 }, null);
    const mark = (ok: boolean) => (w.host as unknown as { markStatus(n: string, ok: boolean): void }).markStatus("fake", ok);
    mark(true);
    await w.host.idle();
    mark(true); // still up: no push
    mark(false);
    mark(true);
    await w.host.idle();
    expect(w.plugin.seen.settings).toEqual([{ volume: 5 }, { volume: 5 }]);
  });
});

describe("plugin UI proxy", () => {
  it("injects the plugin token, strips client auth and cookies, and stays under ui.path", async () => {
    const w = await world();
    const h = { "remote-user": "alex", cookie: "authelia_session=abc", authorization: "Bearer client" };
    const res = await w.app.inject({ method: "GET", url: "/admin/api/plugins/fake/ui/page?x=1", headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("<p>page /jeeves/ui/page?x=1</p>");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["x-secret"]).toBeUndefined();
    const seen = w.plugin.seen.ui[0];
    expect(seen.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers["remote-user"]).toBeUndefined();

    const post = await w.app.inject({ method: "POST", url: "/admin/api/plugins/fake/ui/api/x", headers: { ...h, "content-type": "application/json" }, payload: '{"a":1}' });
    expect(post.statusCode).toBe(200);
    expect(w.plugin.seen.ui[1].body).toBe('{"a":1}');

    expect((await w.app.inject({ method: "PUT", url: "/admin/api/plugins/fake/ui/x", headers: h })).statusCode).toBe(404);
    expect((await w.app.inject({ method: "GET", url: "/admin/api/plugins/fake/ui/..%2f..%2felsewhere", headers: h })).statusCode).toBe(400);
    const redirect = await w.app.inject({ method: "GET", url: "/admin/api/plugins/fake/ui/go", headers: h });
    expect(redirect.headers.location).toBe("/admin/api/plugins/fake/ui/landed");
    // Without the Authelia identity there is no access.
    expect((await w.app.inject({ method: "GET", url: "/admin/api/plugins/fake/ui/page" })).statusCode).toBe(401);
  });

  it("lets the app's WebView in with a short-lived token, then a scoped cookie", async () => {
    const w = await world();
    expect((await w.app.inject({ method: "GET", url: "/plugins/fake/ui/" })).statusCode).toBe(401);
    const t = (await w.app.inject({ method: "POST", url: "/plugins/fake/ui-token", headers: w.headers })).json();
    expect(t.url).toMatch(/^\/plugins\/fake\/ui\/\?t=/);
    const first = await w.app.inject({ method: "GET", url: t.url });
    expect(first.statusCode).toBe(200);
    expect(w.plugin.seen.ui[0].url).toBe("/jeeves/ui/"); // the token is not passed on
    const cookie = String(first.headers["set-cookie"]);
    expect(cookie).toMatch(/^jeeves_ui_fake=.*Path=\/plugins\/fake\/ui\/.*HttpOnly/);
    const sub = await w.app.inject({ method: "GET", url: "/plugins/fake/ui/app.js", headers: { cookie: cookie.split(";")[0] } });
    expect(sub.statusCode).toBe(200);
    expect((await w.app.inject({ method: "GET", url: "/plugins/fake/ui/?t=forged.123.abc" })).statusCode).toBe(401);
    // A token for one plugin does not open another.
    expect(w.tokens.verify(t.token, "other")).toBe(false);
  });
});

describe("plugin events", () => {
  it("accepts declared events from the plugin's token, prefixed with its name", async () => {
    const w = await world();
    w.store.writeWorkflow("react", { workflow: { cooldown: 0, triggers: [{ event: "fake.thing_happened" }], steps: [{ id: "s", stop: null }] } }, null);
    const ok = await w.app.inject({ method: "POST", url: "/plugin-events", headers: { authorization: `Bearer ${TOKEN}` }, payload: { type: "thing_happened", payload: { n: 1 } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ type: "fake.thing_happened", workflows: [{ workflow_id: "react", fired: true }] });
    expect(w.db.getEvent(ok.json().event_id)).toMatchObject({ device_id: null, payload: { n: 1 } });

    expect((await w.app.inject({ method: "POST", url: "/plugin-events", headers: { authorization: "Bearer wrong" }, payload: { type: "thing_happened" } })).statusCode).toBe(401);
    expect((await w.app.inject({ method: "POST", url: "/plugin-events", headers: w.headers, payload: { type: "thing_happened" } })).statusCode).toBe(401);
    const unknown = await w.app.inject({ method: "POST", url: "/plugin-events", headers: { authorization: `Bearer ${TOKEN}` }, payload: { type: "thing_hapened" } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe("unknown_event");
    await w.engine.idle();
  });

  it("adds and removes plugins in jeeves.yaml", async () => {
    const w = await world();
    const add = await w.app.inject({ method: "POST", url: "/plugins", headers: w.headers, payload: { name: "calendar", url: "http://cal:8082/mcp", token_env: "CAL_TOKEN" } });
    expect(add.statusCode).toBe(201);
    expect(w.store.current.plugins.map((p) => p.name)).toEqual(["fake", "calendar"]);
    expect(w.host.pluginConfig("calendar")).toBeDefined();
    expect((await w.app.inject({ method: "POST", url: "/plugins", headers: w.headers, payload: { name: "calendar", url: "http://x/mcp", token_env: "X" } })).statusCode).toBe(409);
    expect((await w.app.inject({ method: "DELETE", url: "/plugins/calendar", headers: w.headers })).statusCode).toBe(200);
    expect(w.store.current.plugins.map((p) => p.name)).toEqual(["fake"]);
  });
});
