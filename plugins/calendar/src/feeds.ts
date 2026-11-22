import { parseFeed, type ParsedFeed } from "./ical.js";
import { feedsOf, type FeedConfig, type SettingsHolder } from "./settings.js";

export type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export interface FeedOptions {
  settings: SettingsHolder;
  fetcher?: Fetcher;
  now?: () => Date;
  ttlMs?: number;
  /** How long a failed refresh is remembered before the next attempt. */
  retryMs?: number;
  timeoutMs?: number;
  /** Largest feed body accepted. */
  maxBytes?: number;
}

export interface CalendarFeed {
  /** Display name: configured, else the feed's own, else "Calendar n". */
  name: string;
  parsed: ParsedFeed | null;
  /** ISO time of the last successful fetch, null if there never was one. */
  fetched_at: string | null;
  /** True when the last refresh failed and `parsed` is from an earlier fetch. */
  stale: boolean;
  error?: string;
}

interface Entry {
  /** When the last attempt (successful or not) finished. */
  attemptedAt: number;
  parsed: ParsedFeed | null;
  fetchedAt: number | null;
  stale: boolean;
  error?: string;
}

export const DEFAULT_TTL_MS = 10 * 60_000;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Fetches and parses the configured iCal feeds, reusing a result for `ttlMs`. A failed refresh keeps
 * the previous result and marks it stale. The feed URL is a bearer secret: it is never logged or put
 * in an error message.
 */
export class FeedCache {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<void>>();
  private generation = 0;
  private readonly fetcher: Fetcher;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly settings: SettingsHolder;

  constructor(opts: FeedOptions) {
    this.settings = opts.settings;
    this.fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.retryMs = opts.retryMs ?? 30_000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    opts.settings.onChange(() => this.clear());
  }

  /** Drops everything, including in-flight results (they would belong to old settings). */
  clear(): void {
    this.generation++;
    this.entries.clear();
    this.inflight.clear();
  }

  async get(): Promise<{ calendars: CalendarFeed[] }> {
    const feeds = feedsOf(this.settings.get());
    await Promise.all(feeds.map((f) => this.refresh(f)));
    return {
      calendars: feeds.map((f) => {
        const e = this.entries.get(f.url)!;
        return {
          name: f.name ?? e.parsed?.name ?? f.fallbackName,
          parsed: e.parsed,
          fetched_at: e.fetchedAt === null ? null : new Date(e.fetchedAt).toISOString(),
          stale: e.stale,
          ...(e.error ? { error: e.error } : {}),
        };
      }),
    };
  }

  private refresh(feed: FeedConfig): Promise<void> {
    const entry = this.entries.get(feed.url);
    // After a failure, don't hammer the feed on every call: wait retryMs before trying again.
    const reuseFor = entry?.error ? this.retryMs : this.ttlMs;
    if (entry && this.now().getTime() - entry.attemptedAt < reuseFor) {
      return Promise.resolve();
    }
    const pending = this.inflight.get(feed.url);
    if (pending) return pending;
    const generation = this.generation;
    const p = this.fetchOne(feed).finally(() => {
      if (this.generation === generation) this.inflight.delete(feed.url);
    });
    this.inflight.set(feed.url, p);
    return p;
  }

  private async fetchOne(feed: FeedConfig): Promise<void> {
    const label = feed.name ?? feed.fallbackName;
    const previous = this.entries.get(feed.url);
    let next: Entry;
    try {
      const parsed = await this.download(feed.url);
      const at = this.now().getTime();
      next = { attemptedAt: at, parsed, fetchedAt: at, stale: false };
    } catch (e) {
      const error = scrub((e as Error).message, feed.url);
      console.warn(`Calendar "${label}": refresh failed: ${error}`);
      next = { attemptedAt: this.now().getTime(), parsed: previous?.parsed ?? null, fetchedAt: previous?.fetchedAt ?? null, stale: previous?.parsed != null, error };
    }
    // Keyed by URL, so a result that lands after a settings change is still correct for that URL.
    this.entries.set(feed.url, next);
  }

  private async download(url: string): Promise<ParsedFeed> {
    let res: Response;
    try {
      res = await this.fetcher(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "text/calendar, text/plain;q=0.9, */*;q=0.1" },
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") throw new Error(`timed out after ${this.timeoutMs / 1000}s`);
      throw new Error(`request failed (${err.message || "network error"})`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length"));
    if (declared > this.maxBytes) throw new Error(`feed is larger than ${this.maxBytes} bytes`);
    const text = await res.text();
    if (text.length > this.maxBytes) throw new Error(`feed is larger than ${this.maxBytes} bytes`);
    return parseFeed(text);
  }
}

/** Removes the URL (and its secret path/query) from a message. */
function scrub(message: string, url: string): string {
  let out = message.split(url).join("<calendar address>");
  try {
    const u = new URL(url);
    out = out.split(u.pathname).join("<path>");
    if (u.search) out = out.split(u.search).join("");
  } catch {
    // not a URL; nothing more to remove
  }
  return out;
}
