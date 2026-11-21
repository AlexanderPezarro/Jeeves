import Database from "better-sqlite3";
import { isDue, type Recurrence } from "./recurrence.js";
import { DEFAULT_SETTINGS, dropLegacy, settingsSchema, type Settings } from "./settings.js";

export interface Chore {
  id: string;
  name: string;
  recurrence: Recurrence;
  /** 1 (trivial) to 5 (hard). */
  effort: number;
  /** Estimated hands-on minutes. */
  est_minutes: number;
  how_to: string[];
  /** How completion is detected: user reply or a sensor event. */
  completion_mode: "reply" | "sensor";
  goal?: string;
  active: boolean;
}

export type TaskState = "pending" | "started" | "done" | "skipped";

export interface TaskInstance {
  id: number;
  chore_id: string;
  due_date: string;
  state: TaskState;
  started_at: string | null;
  done_at: string | null;
  snoozed_until: string | null;
}

export interface DueTask extends TaskInstance {
  name: string;
  effort: number;
  est_minutes: number;
  how_to: string[];
  completion_mode: Chore["completion_mode"];
  overdue_days: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  recurrence TEXT NOT NULL,
  effort INTEGER NOT NULL DEFAULT 2,
  est_minutes INTEGER NOT NULL DEFAULT 10,
  how_to TEXT NOT NULL DEFAULT '[]',
  completion_mode TEXT NOT NULL DEFAULT 'reply',
  timer_steps TEXT NOT NULL DEFAULT '[]',
  goal TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS task_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chore_id TEXT NOT NULL REFERENCES chores(id),
  due_date TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  done_at TEXT,
  snoozed_until TEXT,
  UNIQUE (chore_id, due_date)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Ids of chores deleted in the UI, so the chores.yaml seed does not bring them back on restart.
CREATE TABLE IF NOT EXISTS deleted_chores (
  id TEXT PRIMARY KEY
);
`;

/**
 * Columns added after the first release; applied with a guarded ALTER on old databases. remind_at,
 * remind_level and timer_steps are no longer used (timing lives in workflows) but stay in old databases.
 */
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ["chores", "remind_at", "TEXT"],
  ["chores", "remind_level", "TEXT"],
];

export class ChoreExistsError extends Error {}

export class TodoStore {
  readonly db: Database.Database;
  private cachedSettings: Settings;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    for (const [table, column, type] of ADDED_COLUMNS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    this.cachedSettings = this.loadSettings();
  }

  /** Current settings with defaults filled in. */
  settings(): Settings {
    return { ...this.cachedSettings };
  }

  /**
   * Replace all settings (missing keys fall back to defaults) and apply them immediately.
   * Throws a ZodError on unknown keys or bad values.
   */
  setSettings(values: unknown): Settings {
    const parsed = settingsSchema.parse(dropLegacy(values ?? {}));
    const insert = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM settings").run();
      for (const [k, v] of Object.entries(parsed)) insert.run(k, JSON.stringify(v));
    })();
    this.cachedSettings = parsed;
    return this.settings();
  }

  private loadSettings(): Settings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const raw: Record<string, unknown> = {};
    for (const r of rows) raw[r.key] = JSON.parse(r.value);
    const parsed = settingsSchema.safeParse(dropLegacy(raw));
    return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
  }

  /** Insert a new chore. Throws ChoreExistsError if the id is taken. Clears any delete tombstone. */
  createChore(c: Chore): Chore {
    if (this.getChore(c.id)) throw new ChoreExistsError(`A chore with id ${c.id} already exists`);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM deleted_chores WHERE id = ?").run(c.id);
      this.upsertChore(c);
    })();
    return this.getChore(c.id)!;
  }

  /** Replace an existing chore's fields. Returns undefined if there is no such chore. */
  updateChore(c: Chore): Chore | undefined {
    if (!this.getChore(c.id)) return undefined;
    this.upsertChore(c);
    return this.getChore(c.id)!;
  }

  /**
   * Delete a chore together with its task history, and remember the id so the chores.yaml seed does
   * not re-create it on the next start. To keep the history, set the chore inactive instead.
   * Returns false if there is no such chore.
   */
  deleteChore(id: string): boolean {
    if (!this.getChore(id)) return false;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM task_instances WHERE chore_id = ?").run(id);
      this.db.prepare("DELETE FROM chores WHERE id = ?").run(id);
      this.db.prepare("INSERT OR IGNORE INTO deleted_chores (id) VALUES (?)").run(id);
    })();
    return true;
  }

  /** True if the id belongs to a chore in the DB or one deleted in the UI. Used by the seed. */
  knowsChore(id: string): boolean {
    return !!this.getChore(id) || !!this.db.prepare("SELECT 1 FROM deleted_chores WHERE id = ?").get(id);
  }

  upsertChore(c: Chore): void {
    this.db
      .prepare(
        `INSERT INTO chores (id, name, recurrence, effort, est_minutes, how_to, completion_mode, goal, active)
         VALUES (@id, @name, @recurrence, @effort, @est_minutes, @how_to, @completion_mode, @goal, @active)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, recurrence=excluded.recurrence, effort=excluded.effort,
           est_minutes=excluded.est_minutes, how_to=excluded.how_to, completion_mode=excluded.completion_mode,
           goal=excluded.goal, active=excluded.active, timer_steps='[]', remind_at=NULL, remind_level=NULL`,
      )
      .run({
        id: c.id,
        name: c.name,
        effort: c.effort,
        est_minutes: c.est_minutes,
        completion_mode: c.completion_mode,
        recurrence: JSON.stringify(c.recurrence),
        how_to: JSON.stringify(c.how_to),
        goal: c.goal ?? null,
        active: c.active ? 1 : 0,
      });
  }

  /** Ids of chores still carrying legacy timer steps (written by an older version). */
  legacyTimerChores(): string[] {
    return (this.db.prepare("SELECT id FROM chores WHERE timer_steps IS NOT NULL AND timer_steps NOT IN ('', '[]')").all() as { id: string }[]).map((r) => r.id);
  }

  getChore(id: string): Chore | undefined {
    const row = this.db.prepare("SELECT * FROM chores WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToChore(row) : undefined;
  }

  listChores(): Chore[] {
    return (this.db.prepare("SELECT * FROM chores ORDER BY name").all() as Record<string, unknown>[]).map(rowToChore);
  }

  /**
   * The instance for one chore on `date`, in the shape of listDue rows, whatever its state (so a
   * workflow can branch on done/skipped). Creates it if the chore is active and due that day;
   * null if there is no such instance.
   */
  getTaskFor(choreId: string, date: string): DueTask | null {
    const chore = this.getChore(choreId);
    if (!chore) return null;
    if (chore.active && isDue(chore.recurrence, date)) {
      this.db.prepare("INSERT OR IGNORE INTO task_instances (chore_id, due_date) VALUES (?, ?)").run(choreId, date);
    }
    const r = this.db
      .prepare(
        `SELECT t.*, c.name, c.effort, c.est_minutes, c.how_to, c.completion_mode,
                CAST(julianday(?) - julianday(t.due_date) AS INTEGER) AS overdue_days
         FROM task_instances t JOIN chores c ON c.id = t.chore_id WHERE t.chore_id = ? AND t.due_date = ?`,
      )
      .get(date, choreId, date) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { ...(r as unknown as DueTask), how_to: JSON.parse(r.how_to as string) as string[], completion_mode: r.completion_mode === "sensor" ? "sensor" : "reply" };
  }

  getTask(id: number): TaskInstance | undefined {
    return this.db.prepare("SELECT * FROM task_instances WHERE id = ?").get(id) as TaskInstance | undefined;
  }

  /**
   * Tasks for `date`: creates today's instances for chores that are due, and includes unfinished
   * instances from the last few days. Ordered easiest first (effort, then minutes).
   */
  listDue(date: string, now: Date = new Date()): DueTask[] {
    const insert = this.db.prepare("INSERT OR IGNORE INTO task_instances (chore_id, due_date) VALUES (?, ?)");
    for (const chore of this.listChores()) {
      if (chore.active && isDue(chore.recurrence, date)) insert.run(chore.id, date);
    }

    const rows = this.db
      .prepare(
        `SELECT t.*, c.name, c.effort, c.est_minutes, c.how_to, c.completion_mode,
                CAST(julianday(?) - julianday(t.due_date) AS INTEGER) AS overdue_days
         FROM task_instances t JOIN chores c ON c.id = t.chore_id
         WHERE t.due_date <= ? AND julianday(?) - julianday(t.due_date) <= ?
           AND (t.state IN ('pending', 'started') OR (t.due_date = ? AND t.state IN ('done', 'skipped')))
         ORDER BY CASE WHEN t.state IN ('done', 'skipped') THEN 1 ELSE 0 END, c.effort, c.est_minutes, c.name`,
      )
      .all(date, date, date, this.cachedSettings.carry_over_days, date) as Record<string, unknown>[];

    const nowIso = now.toISOString();
    return rows
      .map((r) => ({ ...(r as unknown as DueTask), how_to: JSON.parse(r.how_to as string) as string[] }))
      .filter((t) => !t.snoozed_until || t.snoozed_until <= nowIso || t.state === "done" || t.state === "skipped");
  }

  setState(id: number, state: TaskState, now: Date = new Date()): TaskInstance {
    const task = this.getTask(id);
    if (!task) throw new Error(`No task with id ${id}`);
    const iso = now.toISOString();
    this.db
      .prepare(
        `UPDATE task_instances SET state = ?,
           started_at = CASE WHEN ? = 'started' AND started_at IS NULL THEN ? ELSE started_at END,
           done_at = CASE WHEN ? IN ('done', 'skipped') THEN ? ELSE NULL END,
           snoozed_until = NULL
         WHERE id = ?`,
      )
      .run(state, state, iso, state, iso, id);
    return this.getTask(id)!;
  }

  snooze(id: number, minutes: number, now: Date = new Date()): TaskInstance {
    const task = this.getTask(id);
    if (!task) throw new Error(`No task with id ${id}`);
    const until = new Date(now.getTime() + minutes * 60_000).toISOString();
    this.db.prepare("UPDATE task_instances SET snoozed_until = ? WHERE id = ?").run(until, id);
    return this.getTask(id)!;
  }

  /** Completion history used by the planner to spot chores that keep slipping. */
  history(choreId: string, limit = 10): TaskInstance[] {
    return this.db
      .prepare("SELECT * FROM task_instances WHERE chore_id = ? ORDER BY due_date DESC LIMIT ?")
      .all(choreId, limit) as TaskInstance[];
  }
}

function rowToChore(row: Record<string, unknown>): Chore {
  return {
    id: row.id as string,
    name: row.name as string,
    recurrence: JSON.parse(row.recurrence as string),
    effort: row.effort as number,
    est_minutes: row.est_minutes as number,
    how_to: JSON.parse(row.how_to as string),
    // A stored "timer" (older versions) is a plain reply chore now.
    completion_mode: row.completion_mode === "sensor" ? "sensor" : "reply",
    goal: (row.goal as string | null) ?? undefined,
    active: row.active === 1,
  };
}

/** Local calendar date (YYYY-MM-DD) for `now` in the given IANA time zone. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
