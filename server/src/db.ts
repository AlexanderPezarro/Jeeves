import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  fcm_token TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_type_time ON events (type, received_at);
CREATE TABLE IF NOT EXISTS rule_fires (
  rule_id TEXT NOT NULL,
  event_id INTEGER,
  fired_at TEXT NOT NULL,
  local_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  rule_id TEXT,
  event_id INTEGER,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT,
  transcript TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  error TEXT,
  local_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  text TEXT NOT NULL,
  items TEXT,
  run_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs (done_at, run_at);
`;

export interface Device {
  id: number;
  name: string;
  fcm_token: string | null;
}

export interface EventRow {
  id: number;
  device_id: number | null;
  type: string;
  payload: Record<string, unknown>;
  received_at: string;
}

/** One item in a plan sent to the phone. */
export interface PlanItem {
  task_id?: number;
  title: string;
  steps: string[];
  minutes?: number;
}

export interface MessageRow {
  id: number;
  direction: "in" | "out";
  text: string;
  items: PlanItem[] | null;
  run_id: number | null;
  created_at: string;
}

export interface Job {
  id: number;
  run_at: string;
  kind: string;
  payload: Record<string, unknown>;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class Db {
  readonly sql: Database.Database;

  constructor(path = ":memory:") {
    this.sql = new Database(path);
    this.sql.pragma("journal_mode = WAL");
    this.sql.exec(SCHEMA);
  }

  // Devices ---------------------------------------------------------------

  /** Creates a device and returns its bearer token (only the hash is stored). */
  createDevice(name: string, now = new Date()): { device: Device; token: string } {
    const token = randomBytes(32).toString("base64url");
    const info = this.sql
      .prepare("INSERT INTO devices (name, token_hash, created_at) VALUES (?, ?, ?)")
      .run(name, hash(token), now.toISOString());
    return { device: { id: Number(info.lastInsertRowid), name, fcm_token: null }, token };
  }

  deviceByToken(token: string): Device | undefined {
    return this.sql.prepare("SELECT id, name, fcm_token FROM devices WHERE token_hash = ?").get(hash(token)) as
      | Device
      | undefined;
  }

  setPushToken(deviceId: number, fcmToken: string | null): void {
    this.sql.prepare("UPDATE devices SET fcm_token = ? WHERE id = ?").run(fcmToken, deviceId);
  }

  pushTokens(): string[] {
    return (this.sql.prepare("SELECT fcm_token FROM devices WHERE fcm_token IS NOT NULL").all() as { fcm_token: string }[]).map(
      (r) => r.fcm_token,
    );
  }

  // Events ----------------------------------------------------------------

  insertEvent(type: string, payload: Record<string, unknown>, deviceId: number | null, now = new Date()): EventRow {
    const received_at = now.toISOString();
    const info = this.sql
      .prepare("INSERT INTO events (device_id, type, payload, received_at) VALUES (?, ?, ?, ?)")
      .run(deviceId, type, JSON.stringify(payload), received_at);
    return { id: Number(info.lastInsertRowid), device_id: deviceId, type, payload, received_at };
  }

  /** Most recent event of `type` before `before` whose payload has the given SSID (if any). */
  lastEvent(type: string, before: string, ssid?: string): EventRow | undefined {
    const rows = this.sql
      .prepare("SELECT * FROM events WHERE type = ? AND received_at < ? ORDER BY received_at DESC LIMIT 50")
      .all(type, before) as (Omit<EventRow, "payload"> & { payload: string })[];
    for (const r of rows) {
      const payload = JSON.parse(r.payload) as Record<string, unknown>;
      if (!ssid || payload.ssid === ssid) return { ...r, payload };
    }
    return undefined;
  }

  // Rule fires --------------------------------------------------------------

  recordFire(ruleId: string, eventId: number | null, localDate: string, now = new Date()): void {
    this.sql
      .prepare("INSERT INTO rule_fires (rule_id, event_id, fired_at, local_date) VALUES (?, ?, ?, ?)")
      .run(ruleId, eventId, now.toISOString(), localDate);
  }

  lastFire(ruleId: string): { fired_at: string; local_date: string } | undefined {
    return this.sql
      .prepare("SELECT fired_at, local_date FROM rule_fires WHERE rule_id = ? ORDER BY fired_at DESC LIMIT 1")
      .get(ruleId) as { fired_at: string; local_date: string } | undefined;
  }

  // Runs --------------------------------------------------------------------

  startRun(r: { kind: string; rule_id?: string; event_id?: number; model: string; input: string; local_date: string }, now = new Date()): number {
    const info = this.sql
      .prepare(
        "INSERT INTO runs (kind, rule_id, event_id, model, status, input, local_date, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)",
      )
      .run(r.kind, r.rule_id ?? null, r.event_id ?? null, r.model, r.input, r.local_date, now.toISOString());
    return Number(info.lastInsertRowid);
  }

  finishRun(
    id: number,
    r: { status: "ok" | "error" | "refused"; transcript?: unknown; input_tokens?: number; output_tokens?: number; error?: string },
    now = new Date(),
  ): void {
    this.sql
      .prepare(
        "UPDATE runs SET status = ?, transcript = ?, input_tokens = ?, output_tokens = ?, error = ?, finished_at = ? WHERE id = ?",
      )
      .run(
        r.status,
        r.transcript === undefined ? null : JSON.stringify(r.transcript),
        r.input_tokens ?? 0,
        r.output_tokens ?? 0,
        r.error ?? null,
        now.toISOString(),
        id,
      );
  }

  runsOn(localDate: string): number {
    return (this.sql.prepare("SELECT COUNT(*) AS n FROM runs WHERE local_date = ?").get(localDate) as { n: number }).n;
  }

  recentRuns(limit = 20): unknown[] {
    return this.sql
      .prepare(
        "SELECT id, kind, rule_id, event_id, model, status, input_tokens, output_tokens, error, created_at, finished_at FROM runs ORDER BY id DESC LIMIT ?",
      )
      .all(limit);
  }

  // Messages ----------------------------------------------------------------

  addMessage(direction: "in" | "out", text: string, items: PlanItem[] | null = null, runId: number | null = null, now = new Date()): MessageRow {
    const created_at = now.toISOString();
    const info = this.sql
      .prepare("INSERT INTO messages (direction, text, items, run_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(direction, text, items ? JSON.stringify(items) : null, runId, created_at);
    return { id: Number(info.lastInsertRowid), direction, text, items, run_id: runId, created_at };
  }

  messagesAfter(afterId: number, limit = 100): MessageRow[] {
    const rows = this.sql
      .prepare("SELECT * FROM messages WHERE id > ? ORDER BY id LIMIT ?")
      .all(afterId, limit) as (Omit<MessageRow, "items"> & { items: string | null })[];
    return rows.map((r) => ({ ...r, items: r.items ? (JSON.parse(r.items) as PlanItem[]) : null }));
  }

  /** The last few messages, oldest first, for conversational context in reply runs. */
  recentMessages(limit = 10): MessageRow[] {
    const rows = this.sql.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT ?").all(limit) as (Omit<MessageRow, "items"> & {
      items: string | null;
    })[];
    return rows.reverse().map((r) => ({ ...r, items: r.items ? (JSON.parse(r.items) as PlanItem[]) : null }));
  }

  // Jobs --------------------------------------------------------------------

  addJob(runAt: Date, kind: string, payload: Record<string, unknown>): number {
    const info = this.sql
      .prepare("INSERT INTO jobs (run_at, kind, payload) VALUES (?, ?, ?)")
      .run(runAt.toISOString(), kind, JSON.stringify(payload));
    return Number(info.lastInsertRowid);
  }

  /** Atomically claims due jobs so a job never runs twice. */
  claimDueJobs(now = new Date()): Job[] {
    const iso = now.toISOString();
    return this.sql.transaction(() => {
      const rows = this.sql
        .prepare("SELECT * FROM jobs WHERE done_at IS NULL AND run_at <= ? ORDER BY run_at")
        .all(iso) as (Omit<Job, "payload"> & { payload: string })[];
      const mark = this.sql.prepare("UPDATE jobs SET done_at = ? WHERE id = ?");
      for (const r of rows) mark.run(iso, r.id);
      return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> }));
    })();
  }

  /** Cancels pending follow-ups for a task, e.g. when it is marked done early. */
  cancelJobsForTask(taskId: number, now = new Date()): void {
    this.sql
      .prepare("UPDATE jobs SET done_at = ? WHERE done_at IS NULL AND json_extract(payload, '$.task_id') = ?")
      .run(now.toISOString(), taskId);
  }
}
