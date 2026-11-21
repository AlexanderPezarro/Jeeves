import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { peerMatcher } from "./auth.js";
import { pair, setup } from "./testkit.js";

function adminSetup(proxyAuth = { trust: true, trustedProxies: ["172.18.0.0/16"] }, webDir?: string) {
  const s = setup({ store: true });
  const app = buildApp({ db: s.db, engine: s.engine, pairingCode: "pair-me-please", store: s.store, config: s.config, plugins: s.plugins, now: () => s.clock.now, proxyAuth, webDir });
  return { ...s, app };
}

const CADDY = "172.18.0.5";

describe("web UI auth", () => {
  it("accepts Remote-User on /admin/api only from a trusted peer", async () => {
    const s = adminSetup();
    const ok = await s.app.inject({ method: "GET", url: "/admin/api/me", headers: { "remote-user": "alex" }, remoteAddress: CADDY });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ identity: { kind: "user", name: "alex" } });
    expect((await s.app.inject({ method: "GET", url: "/admin/api/workflows", headers: { "remote-user": "alex" }, remoteAddress: CADDY })).statusCode).toBe(200);

    // A direct hit on the published port (any other peer) cannot claim an identity.
    const spoof = await s.app.inject({ method: "GET", url: "/admin/api/workflows", headers: { "remote-user": "alex" }, remoteAddress: "192.168.1.20" });
    expect(spoof.statusCode).toBe(401);
    // Missing header from Caddy: still 401.
    expect((await s.app.inject({ method: "GET", url: "/admin/api/workflows", remoteAddress: CADDY })).statusCode).toBe(401);
    s.store!.close();
  });

  it("never trusts Remote-User when JEEVES_TRUST_PROXY_AUTH is off", async () => {
    const s = adminSetup({ trust: false, trustedProxies: ["172.18.0.0/16"] });
    expect((await s.app.inject({ method: "GET", url: "/admin/api/me", headers: { "remote-user": "alex" }, remoteAddress: CADDY })).statusCode).toBe(401);
    s.store!.close();
  });

  it("ignores Remote-User on the device path and device tokens on /admin/api", async () => {
    const s = adminSetup();
    expect((await s.app.inject({ method: "GET", url: "/workflows", headers: { "remote-user": "alex" }, remoteAddress: CADDY })).statusCode).toBe(401);
    const headers = await pair(s.app);
    expect((await s.app.inject({ method: "GET", url: "/admin/api/workflows", headers, remoteAddress: CADDY })).statusCode).toBe(401);
    expect((await s.app.inject({ method: "GET", url: "/workflows", headers })).statusCode).toBe(200);
    s.store!.close();
  });

  it("round-trips globals through PUT /admin/api/config/globals", async () => {
    const s = adminSetup();
    const h = { "remote-user": "alex" };
    const g = (await s.app.inject({ method: "GET", url: "/admin/api/config/globals", headers: h, remoteAddress: CADDY })).json();
    expect(g.parsed.max_runs_per_day).toBe(20);
    const put = await s.app.inject({
      method: "PUT",
      url: "/admin/api/config/globals",
      headers: h,
      remoteAddress: CADDY,
      payload: { patch: { max_runs_per_day: 7, about_me: "Night owl" }, hash: g.hash },
    });
    expect(put.statusCode).toBe(200);
    expect(s.store!.current).toMatchObject({ max_runs_per_day: 7, about_me: "Night owl" });
    expect(readFileSync(join(s.store!.dir, "jeeves.yaml"), "utf8")).toContain("max_runs_per_day: 7");
    const stale = await s.app.inject({ method: "PUT", url: "/admin/api/config/globals", headers: h, remoteAddress: CADDY, payload: { patch: { max_runs_per_day: 8 }, hash: g.hash } });
    expect(stale.statusCode).toBe(409);
    const bad = await s.app.inject({ method: "PUT", url: "/admin/api/config/globals", headers: h, remoteAddress: CADDY, payload: { patch: { effort: "huge" }, hash: put.json().hash } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues[0].path).toEqual(["effort"]);
    s.store!.close();
  });

  it("serves the SPA at /admin with a fallback to index.html, without swallowing the API", async () => {
    const web = mkdtempSync(join(tmpdir(), "jeeves-web-"));
    mkdirSync(join(web, "assets"));
    writeFileSync(join(web, "index.html"), "<!doctype html><title>Jeeves</title>");
    writeFileSync(join(web, "assets", "app.js"), "console.log(1)");
    const s = adminSetup(undefined, web);
    expect((await s.app.inject({ method: "GET", url: "/" })).headers.location).toBe("/admin/");
    expect((await s.app.inject({ method: "GET", url: "/admin" })).headers.location).toBe("/admin/");
    expect((await s.app.inject({ method: "GET", url: "/admin/" })).body).toContain("<title>Jeeves</title>");
    expect((await s.app.inject({ method: "GET", url: "/admin/workflows/arrive-home" })).body).toContain("<title>Jeeves</title>");
    const js = await s.app.inject({ method: "GET", url: "/admin/assets/app.js" });
    expect(js.body).toBe("console.log(1)");
    expect(js.headers["cache-control"]).toContain("immutable");
    expect((await s.app.inject({ method: "GET", url: "/admin/../package.json" })).body).not.toContain("jeeves-server");
    const missing = await s.app.inject({ method: "GET", url: "/admin/api/nope", headers: { "remote-user": "alex" }, remoteAddress: CADDY });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain("<title>");
    s.store!.close();
  });
});

describe("embedded web UI (/app)", () => {
  function embeddedSetup() {
    const web = mkdtempSync(join(tmpdir(), "jeeves-web-"));
    writeFileSync(join(web, "index.html"), "<!doctype html><html><head><title>Jeeves</title></head></html>");
    return adminSetup(undefined, web);
  }
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0];

  it("swaps a device's link token for a cookie that reaches /app/api, and nothing else", async () => {
    const s = embeddedSetup();
    const headers = await pair(s.app);
    expect((await s.app.inject({ method: "POST", url: "/app/session" })).statusCode).toBe(401);
    const session = await s.app.inject({ method: "POST", url: "/app/session", headers, payload: { path: "workflows/arrive-home" } });
    expect(session.statusCode).toBe(200);
    const { url } = session.json();
    expect(url).toMatch(/^\/app\/workflows\/arrive-home\?t=/);

    const open = await s.app.inject({ method: "GET", url });
    expect(open.statusCode).toBe(302);
    expect(open.headers.location).toBe("/app/workflows/arrive-home");
    expect(String(open.headers["set-cookie"])).toMatch(/Path=\/app\/; .*HttpOnly; SameSite=Strict/);
    const cookie = cookieOf(open);

    const list = await s.app.inject({ method: "GET", url: "/app/api/workflows", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().workflows.map((w: { id: string }) => w.id)).toContain("arrive-home");
    expect((await s.app.inject({ method: "GET", url: "/app/api/me", headers: { cookie } })).json()).toEqual({ identity: { kind: "device", name: "Pixel" } });

    // Without the cookie, or with it on the admin scope or as a bearer: refused.
    expect((await s.app.inject({ method: "GET", url: "/app/api/workflows" })).statusCode).toBe(401);
    expect((await s.app.inject({ method: "GET", url: "/admin/api/workflows", headers: { cookie }, remoteAddress: CADDY })).statusCode).toBe(401);
    // The device bearer does not work on /app/api either: only the cookie does.
    expect((await s.app.inject({ method: "GET", url: "/app/api/workflows", headers })).statusCode).toBe(401);
    s.store!.close();
  });

  it("serves index.html with a <base> and the mount for /app and /admin", async () => {
    const s = embeddedSetup();
    const app = (await s.app.inject({ method: "GET", url: "/app/workflows/x" })).body;
    expect(app).toContain('<base href="/app/" />');
    expect(app).toContain('window.__JEEVES__ = {"base":"/app/","embedded":true}');
    const admin = (await s.app.inject({ method: "GET", url: "/admin/" })).body;
    expect(admin).toContain('<base href="/admin/" />');
    expect(admin).toContain('"embedded":false');
    s.store!.close();
  });

  it("refuses bad link tokens and paths", async () => {
    const s = embeddedSetup();
    const headers = await pair(s.app);
    expect((await s.app.inject({ method: "POST", url: "/app/session", headers, payload: { path: "../admin" } })).statusCode).toBe(400);
    expect((await s.app.inject({ method: "POST", url: "/app/session", headers, payload: { path: "https://evil.example" } })).statusCode).toBe(400);
    const bad = await s.app.inject({ method: "GET", url: "/app/workflows?t=device:1.9999999999999.forged" });
    expect(bad.statusCode).toBe(302);
    expect(bad.headers["set-cookie"]).toBeUndefined();
    // A link expires after two minutes.
    const { url } = (await s.app.inject({ method: "POST", url: "/app/session", headers, payload: {} })).json();
    s.clock.now = new Date(s.clock.now.getTime() + 3 * 60_000);
    expect((await s.app.inject({ method: "GET", url })).headers["set-cookie"]).toBeUndefined();
    s.store!.close();
  });
});

describe("peerMatcher", () => {
  it("matches CIDRs, single addresses and IPv4-mapped IPv6", () => {
    const m = peerMatcher({ trust: true, trustedProxies: ["172.18.0.0/16", "10.0.0.7", "fd00::/8"] });
    expect(m("172.18.3.4")).toBe(true);
    expect(m("::ffff:172.18.3.4")).toBe(true);
    expect(m("10.0.0.7")).toBe(true);
    expect(m("10.0.0.8")).toBe(false);
    expect(m("fd12::1")).toBe(true);
    expect(m(undefined)).toBe(false);
    expect(() => peerMatcher({ trust: true, trustedProxies: ["nonsense"] })).toThrow();
  });
});
