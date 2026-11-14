import Database from "better-sqlite3";
import { isDue, type Recurrence } from "./recurrence.js";

export interface TimerStep {
  /** Minutes after the previous step (or after the task was started). */
  after_minutes: number;
  /** What to tell the user when this step is due, e.g. "Move the washing to the dryer". */
  message: string;
}

export interface Chore {
  id: string;
  name: string;
  recurrence: Recurrence;
  /** 1 (trivial) to 5 (hard). */
  effort: number;
  /** Estimated hands-on minutes. */
  est_minutes: number;
  how_to: string[];
  /** How completion is detected: user reply, timed follow-ups, or a sensor event. */
  completion_mode: "reply" | "timer" | "sensor";
  timer_steps: TimerStep[];
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
`;

/** How many days an unfinished task keeps rolling forward before it is dropped. */
const CARRY_OVER_DAYS = 3;

export class TodoStore {
  readonly db: Database.Database;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  upsertChore(c: Chore): void {
    this.db
      .prepare(
        `INSERT INTO chores (id, name, recurrence, effort, est_minutes, how_to, completion_mode, timer_steps, goal, active)
         VALUES (@id, @name, @recurrence, @effort, @est_minutes, @how_to, @completion_mode, @timer_steps, @goal, @active)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, recurrence=excluded.recurrence, effort=excluded.effort,
           est_minutes=excluded.est_minutes, how_to=excluded.how_to, completion_mode=excluded.completion_mode,
           timer_steps=excluded.timer_steps, goal=excluded.goal, active=excluded.active`,
      )
      .run({
        ...c,
        recurrence: JSON.stringify(c.recurrence),
        how_to: JSON.stringify(c.how_to),
        timer_steps: JSON.stringify(c.timer_steps),
        goal: c.goal ?? null,
        active: c.active ? 1 : 0,
      });
  }

  getChore(id: string): Chore | undefined {
    const row = this.db.prepare("SELECT * FROM chores WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToChore(row) : undefined;
  }

  listChores(): Chore[] {
    return (this.db.prepare("SELECT * FROM chores ORDER BY name").all() as Record<string, unknown>[]).map(rowToChore);
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
      .all(date, date, date, CARRY_OVER_DAYS, date) as Record<string, unknown>[];

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
    completion_mode: row.completion_mode as Chore["completion_mode"],
    timer_steps: JSON.parse(row.timer_steps as string),
    goal: (row.goal as string | null) ?? undefined,
    active: row.active === 1,
  };
}

/** Local calendar date (YYYY-MM-DD) for `now` in the given IANA time zone. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
