import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "./index.js";
import type { Fetcher } from "./feeds.js";

const TOKEN = "secret";
const auth = { authorization: `Bearer ${TOKEN}` };
const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");

const URL_A = "https://calendar.google.com/calendar/ical/a/private-aaa111/basic.ics";
const URL_B = "https://calendar.google.com/calendar/ical/b/private-bbb222/basic.ics";

const NOW = new Date("2026-11-23T12:00:00Z"); // a Monday

/** Serves fixtures by URL; anything else is a 404. */
function fakeFetcher(feeds: Record<string, string | number>): Fetcher {
  return async (url) => {
    const body = feeds[url];
    if (typeof body === "number") return new Response("", { status: body });
    if (body === undefined) return new Response("", { status: 404 });
    return new Response(body, { status: 200 });
  };
}

function setup(feeds: Record<string, string | number> = { [URL_A]: fixture("recurring.ics"), [URL_B]: fixture("allday.ics") }) {
  const app = buildApp({ token: TOKEN, timeZone: "Europe/London", now: () => NOW, fetcher: fakeFetcher(feeds) });
  return { app };
}

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const put = (app: ReturnType<typeof setup>["app"], payload: unknown) =>
  app.inject({ method: "PUT", url: "/jeeves/settings", headers: auth, payload: payload as object });

describe("/jeeves manifest and auth", () => {
  it("returns the manifest", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/jeeves/manifest", headers: auth });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m).toMatchObject({
      name: "calendar",
      display_name: "Calendar",
      version: "0.1.0",
      events: [],
      steps: {
        list_events: { title: "List calendar events" },
        free_slots: { title: "Find free evenings" },
      },
    });
    expect(m).not.toHaveProperty("ui");
    expect(m).not.toHaveProperty("views");
    expect(m).not.toHaveProperty("item_actions");
    expect(m.instructions).toMatch(/read-only/);
    const props = m.settings_schema.properties;
    expect(Object.keys(props).sort()).toEqual(
      ["calendar_url_1", "calendar_name_1", "calendar_url_2", "calendar_name_2", "calendar_url_3", "calendar_name_3", "timezone"].sort(),
    );
    for (const n of [1, 2, 3]) {
      expect(props[`calendar_url_${n}`]).toMatchObject({ type: "string", format: "secret" });
      expect(props[`calendar_name_${n}`].format).toBeUndefined();
    }
    for (const p of Object.values(props) as Record<string, unknown>[]) {
      expect(p.type).toBe("string");
      expect(p).toHaveProperty("title");
      expect(p).toHaveProperty("description");
    }
    expect(props.timezone.default).toBe("Europe/London");
  });

  it.each([
    ["GET", "/jeeves/manifest"],
    ["GET", "/jeeves/settings"],
    ["PUT", "/jeeves/settings"],
    ["POST", "/mcp"],
  ] as const)("requires the bearer token for %s %s", async (method, url) => {
    const { app } = setup();
    for (const headers of [{}, { authorization: "Bearer wrong" }]) {
      const res = await app.inject({ method, url, headers });
      expect(res.statusCode).toBe(401);
    }
  });

  it("answers /health without auth and refuses GET/DELETE on /mcp", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: "/mcp" })).statusCode).toBe(405);
    expect((await app.inject({ method: "DELETE", url: "/mcp" })).statusCode).toBe(405);
  });

  it("has no UI, views or actions routes", async () => {
    const { app } = setup();
    for (const url of ["/jeeves/ui", "/jeeves/views/today", "/jeeves/actions"]) {
      expect((await app.inject({ method: "GET", url, headers: auth })).statusCode).toBe(404);
    }
  });
});

describe("/jeeves/settings", () => {
  it("starts with the fallback time zone and no calendars", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/jeeves/settings", headers: auth });
    expect(res.json()).toEqual({ timezone: "Europe/London" });
  });

  it("accepts a valid push and redacts the URLs in every response", async () => {
    const { app } = setup();
    const res = await put(app, { calendar_url_1: URL_A, calendar_name_1: "Me", timezone: "Europe/Paris" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, values: { calendar_url_1: "set", calendar_name_1: "Me", timezone: "Europe/Paris" } });
    const get = await app.inject({ method: "GET", url: "/jeeves/settings", headers: auth });
    expect(get.json()).toEqual({ calendar_url_1: "set", calendar_name_1: "Me", timezone: "Europe/Paris" });
    expect(get.body).not.toContain("private-aaa111");
    expect(res.body).not.toContain("private-aaa111");
  });

  it("treats an empty push as defaults and blank values as unset", async () => {
    const { app } = setup();
    await put(app, { calendar_url_1: URL_A });
    const res = await put(app, { calendar_url_1: "", calendar_name_1: "  " });
    expect(res.json()).toEqual({ ok: true, values: { timezone: "Europe/London" } });
  });

  it("rewrites webcal: to https:", async () => {
    const { app } = setup({ [URL_A]: fixture("recurring.ics") });
    await put(app, { calendar_url_1: URL_A.replace("https:", "webcal:") });
    const { client } = await connect(app);
    const res = await client.callTool({ name: "list_events", arguments: { from: "2026-11-23", to: "2026-11-23" } });
    expect(res.isError).toBeFalsy();
  });

  it.each([
    [{ calendar_url_1: "http://example.com/a.ics" }, "calendar_url_1"],
    [{ calendar_url_1: "not a url" }, "calendar_url_1"],
    [{ timezone: "Mars/Olympus" }, "timezone"],
    [{ surprise: 1 }, ""],
  ])("rejects %j with 400 and issues", async (payload, path) => {
    const { app } = setup();
    const res = await put(app, payload);
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("invalid request");
    expect(body.issues.length).toBeGreaterThan(0);
    if (path) expect(body.issues[0].path).toEqual([path]);
  });

  it("does not echo a rejected URL", async () => {
    const { app } = setup();
    const res = await put(app, { calendar_url_1: "http://example.com/private-zzz999.ics" });
    expect(res.body).not.toContain("private-zzz999");
  });
});

async function connect(app: ReturnType<typeof setup>["app"]) {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  closers.push(() => app.close());
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  );
  closers.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]!.text;
    return { isError: res.isError === true, text, json: res.isError ? undefined : JSON.parse(text) };
  };
  return { client, call };
}

describe("MCP round trip", () => {
  it("lists both read-only tools", async () => {
    const { app } = setup();
    const { client } = await connect(app);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["free_slots", "list_events"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("list_events expands recurring and all-day events across calendars", async () => {
    const { app } = setup();
    await put(app, { calendar_url_1: URL_A, calendar_url_2: URL_B, calendar_name_2: "Days" });
    const { call } = await connect(app);
    const r = await call("list_events", { from: "2026-11-23", to: "2026-11-24" });
    expect(r.isError).toBe(false);
    expect(r.json.events.map((e: { calendar: string; title: string; start: string }) => [e.calendar, e.title, e.start])).toEqual([
      ["Test", "Choir", "2026-11-23T19:00:00+00:00"],
      ["Days", "Birthday", "2026-11-24"],
    ]);
    expect(r.json.sources).toEqual([
      { calendar: "Test", fetched_at: expect.any(String), stale: false },
      { calendar: "Days", fetched_at: expect.any(String), stale: false },
    ]);
    expect(r.text).not.toContain("private-");
  });

  it("list_events defaults to today plus a week", async () => {
    const { app } = setup();
    await put(app, { calendar_url_1: URL_A });
    const { call } = await connect(app);
    const r = await call("list_events");
    // Mon 23 Nov .. Mon 30 Nov: Choir on the 23rd, (30th is cancelled)
    expect(r.json.events.filter((e: { title: string }) => e.title === "Choir").map((e: { start: string }) => e.start)).toEqual([
      "2026-11-23T19:00:00+00:00",
    ]);
  });

  it("free_slots works out the free evenings", async () => {
    const { app } = setup();
    await put(app, { calendar_url_1: URL_A, calendar_url_2: URL_B });
    const { call } = await connect(app);
    const r = await call("free_slots", { from: "2026-11-23", to: "2026-11-24" });
    expect(r.isError).toBe(false);
    expect(r.json.days).toEqual([
      {
        date: "2026-11-23",
        weekday: "Monday",
        free: [
          { start: "17:00", end: "19:00", minutes: 120 },
          { start: "20:00", end: "22:00", minutes: 120 },
        ],
        busy: [{ start: "19:00", end: "20:00", title: "Choir" }],
        all_day: [],
      },
      {
        date: "2026-11-24",
        weekday: "Tuesday",
        free: [{ start: "17:00", end: "22:00", minutes: 300 }],
        busy: [],
        all_day: ["Birthday"],
      },
    ]);
  });

  it("free_slots takes a custom window", async () => {
    const { app } = setup();
    await put(app, { calendar_url_1: URL_A });
    const { call } = await connect(app);
    const r = await call("free_slots", { from: "2026-11-23", to: "2026-11-23", earliest: "18:00", latest: "24:00", min_minutes: 150 });
    expect(r.json.days[0].free).toEqual([{ start: "20:00", end: "24:00", minutes: 240 }]);
  });

  it("reports a bad range as a tool error", async () => {
    const { app } = setup();
    await put(app, { calendar_url_1: URL_A });
    const { call } = await connect(app);
    expect((await call("list_events", { from: "2026-11-24", to: "2026-11-23" })).text).toMatch(/before from/);
    expect((await call("list_events", { from: "2026-01-01", to: "2026-12-31" })).text).toMatch(/limited to 62 days/);
    expect((await call("list_events", { from: "2026-02-30" })).isError).toBe(true);
    expect((await call("free_slots", { earliest: "22:00", latest: "21:00" })).text).toMatch(/after earliest/);
  });

  it("fails clearly when no calendar is configured", async () => {
    const { app } = setup();
    const { call } = await connect(app);
    for (const tool of ["list_events", "free_slots"]) {
      const r = await call(tool);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/No calendar is configured/);
    }
  });

  it("fails when every calendar failed and nothing is cached", async () => {
    const { app } = setup({ [URL_A]: 500, [URL_B]: "<html>login</html>" });
    await put(app, { calendar_url_1: URL_A, calendar_url_2: URL_B, calendar_name_2: "Other" });
    const { call } = await connect(app);
    const r = await call("free_slots");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Calendar unavailable: Calendar 1: HTTP 500; Other: .*not an iCalendar/);
    expect(r.text).not.toContain("private-");
  });

  it("still answers, naming the failure, when only some calendars failed", async () => {
    const { app } = setup({ [URL_A]: fixture("recurring.ics"), [URL_B]: 503 });
    await put(app, { calendar_url_1: URL_A, calendar_url_2: URL_B });
    const { call } = await connect(app);
    const r = await call("list_events", { from: "2026-11-23", to: "2026-11-23" });
    expect(r.isError).toBe(false);
    expect(r.json.events).toHaveLength(1);
    expect(r.json.sources[1]).toEqual({ calendar: "Calendar 2", fetched_at: null, stale: false, error: "HTTP 503" });
  });
});
