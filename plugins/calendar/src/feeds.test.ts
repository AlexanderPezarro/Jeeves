import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeedCache, type Fetcher } from "./feeds.js";
import { SettingsHolder } from "./settings.js";

const URL1 = "https://calendar.google.com/calendar/ical/me%40example.com/private-abc123secret/basic.ics";
const ICS = readFileSync(new URL("../test/fixtures/recurring.ics", import.meta.url), "utf8");
const ttl = 10 * 60_000;

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 24, 12, 0, 0) + clock);

function setup(fetcher: Fetcher, extra: Record<string, unknown> = {}) {
  const settings = new SettingsHolder();
  settings.set({ calendar_url_1: URL1, ...extra });
  return { settings, cache: new FeedCache({ settings, fetcher, now }) };
}

const ok = (body = ICS) => new Response(body, { status: 200 });

beforeEach(() => {
  clock = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("FeedCache", () => {
  it("fetches once and reuses the result within the TTL", async () => {
    const fetcher = vi.fn<Fetcher>(async () => ok());
    const { cache } = setup(fetcher);
    const first = await cache.get();
    clock = ttl - 1;
    const second = await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.calendars[0]).toMatchObject({ name: "Test", stale: false, fetched_at: "2026-11-24T12:00:00.000Z" });
    expect(second.calendars[0]!.parsed).toBe(first.calendars[0]!.parsed);
  });

  it("refetches after the TTL", async () => {
    const fetcher = vi.fn<Fetcher>(async () => ok());
    const { cache } = setup(fetcher);
    await cache.get();
    clock = ttl;
    const again = await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(again.calendars[0]!.fetched_at).toBe("2026-11-24T12:10:00.000Z");
  });

  it("serves the old result as stale when a refresh fails", async () => {
    let fail = false;
    const fetcher = vi.fn<Fetcher>(async () => (fail ? new Response("nope", { status: 503 }) : ok()));
    const { cache } = setup(fetcher);
    const first = await cache.get();
    fail = true;
    clock = ttl;
    const { calendars } = await cache.get();
    expect(calendars[0]).toMatchObject({ stale: true, error: "HTTP 503", fetched_at: first.calendars[0]!.fetched_at });
    expect(calendars[0]!.parsed).toBe(first.calendars[0]!.parsed);
  });

  it("recovers once the feed is back", async () => {
    let fail = true;
    const fetcher = vi.fn<Fetcher>(async () => (fail ? new Response("x", { status: 500 }) : ok()));
    const { cache } = setup(fetcher);
    await cache.get();
    fail = false;
    clock = 60_000;
    const { calendars } = await cache.get();
    expect(calendars[0]).toMatchObject({ stale: false, parsed: expect.anything() });
    expect(calendars[0]!.error).toBeUndefined();
  });

  it("does not hammer a failing feed on every call", async () => {
    const fetcher = vi.fn<Fetcher>(async () => new Response("x", { status: 500 }));
    const { cache } = setup(fetcher);
    await cache.get();
    clock = 5_000;
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock = 31_000;
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports no data and the error when the first fetch fails", async () => {
    const { cache } = setup(async () => new Response("", { status: 404 }));
    const { calendars } = await cache.get();
    expect(calendars[0]).toMatchObject({ parsed: null, fetched_at: null, stale: false, error: "HTTP 404", name: "Calendar 1" });
  });

  it("treats a network error as a failure", async () => {
    const { cache } = setup(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await cache.get()).calendars[0]).toMatchObject({ parsed: null, error: "request failed (fetch failed)" });
  });

  it("reports a timeout", async () => {
    const { cache } = setup(async () => {
      throw new DOMException("signal timed out", "TimeoutError");
    });
    expect((await cache.get()).calendars[0]!.error).toMatch(/timed out/);
  });

  it("treats an unparsable body as a failure", async () => {
    const { cache } = setup(async () => ok("<html>please sign in</html>"));
    expect((await cache.get()).calendars[0]).toMatchObject({ parsed: null, error: expect.stringMatching(/not an iCalendar/) });
  });

  it("treats a truncated body as a failure", async () => {
    const { cache } = setup(async () => ok(readFileSync(new URL("../test/fixtures/broken.ics", import.meta.url), "utf8")));
    expect((await cache.get()).calendars[0]!.error).toMatch(/truncated/);
  });

  it("rejects an oversized feed", async () => {
    const settings = new SettingsHolder();
    settings.set({ calendar_url_1: URL1 });
    const cache = new FeedCache({ settings, fetcher: async () => ok(), now, maxBytes: 100 });
    expect((await cache.get()).calendars[0]!.error).toMatch(/larger than/);
  });

  it("shares one in-flight fetch between concurrent callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetcher = vi.fn<Fetcher>(async () => {
      await gate;
      return ok();
    });
    const { cache } = setup(fetcher);
    const calls = [cache.get(), cache.get(), cache.get()];
    release();
    const results = await Promise.all(calls);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.calendars[0]!.parsed)).toBe(true);
  });

  it("clears the cache when settings change", async () => {
    const fetcher = vi.fn<Fetcher>(async () => ok());
    const { cache, settings } = setup(fetcher);
    await cache.get();
    settings.set({ calendar_url_1: URL1, timezone: "Europe/Paris" });
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns no calendars when none is configured", async () => {
    const settings = new SettingsHolder();
    const cache = new FeedCache({ settings, fetcher: async () => ok(), now });
    expect(await cache.get()).toEqual({ calendars: [] });
  });

  it("names calendars from settings, then the feed, then the slot", async () => {
    const settings = new SettingsHolder();
    settings.set({
      calendar_url_1: URL1,
      calendar_name_1: "Mine",
      calendar_url_2: "webcal://example.com/b.ics",
      calendar_url_3: "https://example.com/c.ics",
    });
    const urls: string[] = [];
    const cache = new FeedCache({
      settings,
      now,
      fetcher: async (url) => {
        urls.push(url);
        return url.endsWith("c.ics") ? ok(ICS.replace("X-WR-CALNAME:Test", "")) : ok();
      },
    });
    expect((await cache.get()).calendars.map((c) => c.name)).toEqual(["Mine", "Test", "Calendar 3"]);
    expect(urls).toContain("https://example.com/b.ics");
  });

  it("never puts the URL in errors, results or logs", async () => {
    const warn = vi.mocked(console.warn);
    const secretish = ["private-abc123secret", "me%40example.com"];
    for (const failure of [
      async () => {
        throw new Error(`connect ECONNREFUSED ${URL1}`);
      },
      async () => new Response("", { status: 403 }),
      async () => ok("garbage"),
    ] as Fetcher[]) {
      warn.mockClear();
      const { cache } = setup(failure);
      const dump = JSON.stringify((await cache.get()).calendars) + JSON.stringify(warn.mock.calls);
      for (const s of secretish) expect(dump).not.toContain(s);
    }
  });
});
