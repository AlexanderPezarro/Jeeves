import { localDate, type DueTask, type TodoStore } from "./store.js";
import type { Level } from "./settings.js";

/** Same shape as the server's plan items (kept short: push payloads are size limited). `item_id` is the task id. */
export interface ReminderItem {
  item_id: string;
  title: string;
  minutes?: number;
  steps?: string[];
}

export interface Reminder {
  key: string;
  /** ISO datetime (UTC). */
  at: string;
  level: Level;
  text: string;
  items?: ReminderItem[];
}

/** Talks to Jeeves' /plugin-reminders API. Methods resolve to success and never throw. */
export interface ReminderClient {
  putGroup(group: string, reminders: Reminder[]): Promise<boolean>;
  put(key: string, reminder: Omit<Reminder, "key">): Promise<boolean>;
  delete(key: string): Promise<boolean>;
}

export function httpReminderClient(opts: { jeevesUrl: string; token: string; fetch?: typeof fetch }): ReminderClient {
  const base = `${opts.jeevesUrl.replace(/\/+$/, "")}/plugin-reminders`;
  const doFetch = opts.fetch ?? fetch;
  const call = async (what: string, url: string, method: string, body?: unknown): Promise<boolean> => {
    try {
      const res = await doFetch(url, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        console.warn(`Jeeves rejected reminder ${what}: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (e) {
      console.warn(`Could not send reminder ${what} to Jeeves: ${(e as Error).message}`);
      return false;
    }
  };
  return {
    putGroup: (group, reminders) =>
      call(`group ${group}`, `${base}?group=${encodeURIComponent(group)}`, "PUT", { reminders }),
    put: (key, r) => call(key, `${base}/${encodeURIComponent(key)}`, "PUT", r),
    delete: (key) => call(`delete ${key}`, `${base}/${encodeURIComponent(key)}`, "DELETE"),
  };
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Local wall time (`date` YYYY-MM-DD, `hhmm` HH:MM) in `timeZone` as a UTC Date. */
export function zonedTime(date: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  // Two passes handle offsets that differ between the guess and the real instant (DST changes).
  let guess = wall - zoneOffsetMs(new Date(wall), timeZone);
  guess = wall - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

const GROUP = "daily";
const HOUR_MS = 3_600_000;

export interface ReminderSchedulerOptions {
  store: TodoStore;
  client: ReminderClient;
  timeZone: string;
  now?: () => Date;
}

export class ReminderScheduler {
  private readonly store: TodoStore;
  private readonly client: ReminderClient;
  private readonly timeZone: string;
  private readonly now: () => Date;
  /** The last group PUT failed; the next sync re-sends everything. */
  dirty = false;
  private pendingDeletes = new Set<string>();
  private inFlight: Promise<void> | null = null;
  private rerun = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private midnight: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ReminderSchedulerOptions) {
    this.store = opts.store;
    this.client = opts.client;
    this.timeZone = opts.timeZone;
    this.now = opts.now ?? (() => new Date());
  }

  /** The reminders that should exist for today, from the current settings and open tasks. */
  computeDaily(): Reminder[] {
    const now = this.now();
    const s = this.store.settings();
    const today = localDate(now, this.timeZone);
    const open = this.store.listDue(today, now).filter((t) => t.state === "pending" || t.state === "started");
    const at = (hhmm: string) => zonedTime(today, hhmm, this.timeZone).toISOString();
    const brief = (t: DueTask): ReminderItem => ({ item_id: String(t.id), title: t.name, minutes: t.est_minutes });
    const out: Reminder[] = [];

    if (s.daily_due_enabled && open.length > 0) {
      out.push({
        key: `due:${today}`,
        at: at(s.daily_due_time),
        level: s.daily_due_level,
        text: `${open.length} ${open.length === 1 ? "chore" : "chores"} today`,
        items: open.map(brief),
      });
    }
    if (s.evening_update_enabled && open.length > 0) {
      out.push({
        key: `update:${today}`,
        at: at(s.evening_update_time),
        level: s.evening_update_level,
        text: "Tick off what you did today",
        items: open.map(brief),
      });
    }
    return out;
  }

  /** Push the daily set to Jeeves and retry queued deletes. Serialised; never throws. */
  sync(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    const run = (async () => {
      do {
        this.rerun = false;
        try {
          await this.syncOnce();
        } catch (e) {
          this.dirty = true;
          console.warn(`Reminder sync failed: ${(e as Error).message}`);
        }
      } while (this.rerun);
    })().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async syncOnce(): Promise<void> {
    for (const key of [...this.pendingDeletes]) {
      if (await this.client.delete(key)) this.pendingDeletes.delete(key);
    }
    const ok = await this.client.putGroup(GROUP, this.computeDaily());
    this.dirty = !ok;
  }

  start(): void {
    this.stop();
    void this.sync();
    this.interval = setInterval(() => void this.sync(), HOUR_MS);
    this.interval.unref?.();
    this.armMidnight();
  }

  private armMidnight(): void {
    const now = this.now();
    const today = localDate(now, this.timeZone);
    // Local midnight + 25h always falls on tomorrow's date, even on 23 and 25 hour days.
    const tomorrow = localDate(new Date(zonedTime(today, "00:00", this.timeZone).getTime() + 25 * HOUR_MS), this.timeZone);
    const target = zonedTime(tomorrow, "00:00", this.timeZone).getTime() + 30_000;
    this.midnight = setTimeout(() => {
      void this.sync();
      this.armMidnight();
    }, Math.max(target - now.getTime(), 1_000));
    this.midnight.unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.midnight) clearTimeout(this.midnight);
    this.interval = this.midnight = null;
  }
}
