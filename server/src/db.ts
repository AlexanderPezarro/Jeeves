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
CREATE TABLE IF NOT EXISTS workflow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  event_id INTEGER,
  status TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  definition TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  local_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_runs_wf ON workflow_runs (workflow_id, started_at);
CREATE INDEX IF NOT EXISTS workflow_runs_time ON workflow_runs (started_at);
CREATE TABLE IF NOT EXISTS step_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_run_id INTEGER NOT NULL,
  step_id TEXT NOT NULL,
  path TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT,
  output TEXT,
  warnings TEXT,
  run_id INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS step_runs_run ON step_runs (workflow_run_id);
`;

/** Columns added after the first release, applied with a guarded ALTER TABLE. */
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ["jobs", "cancelled_at", "TEXT"],
  ["runs", "workflow_run_id", "INTEGER"],
];

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

export type WorkflowRunStatus = "running" | "waiting" | "ok" | "failed" | "stopped" | "capped" | "cancelled";
export type StepRunStatus = "running" | "ok" | "failed" | "skipped" | "capped" | "waiting" | "cancelled";
export type RunTrigger = "event" | "schedule" | "manual" | "simulate";

export interface WorkflowRunRow {
  id: number;
  workflow_id: string;
  trigger: RunTrigger;
  event_id: number | null;
  status: WorkflowRunStatus;
  dry_run: boolean;
  definition: unknown;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  local_date: string;
}

export interface StepRunRow {
  id: number;
  workflow_run_id: number;
  step_id: string;
  path: string;
  type: string;
  status: StepRunStatus;
  input: unknown;
  output: unknown;
  warnings: string[];
  run_id: number | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const parseJson = (s: unknown): unknown => (typeof s === "string" ? JSON.parse(s) : null);

function toWorkflowRun(r: Record<string, unknown>): WorkflowRunRow {
  return { ...(r as unknown as WorkflowRunRow), dry_run: r.dry_run === 1, definition: parseJson(r.definition) };
}

function toStepRun(r: Record<string, unknown>): StepRunRow {
  return {
    ...(r as unknown as StepRunRow),
    input: parseJson(r.input),
    output: parseJson(r.output),
    warnings: (parseJson(r.warnings) as string[] | null) ?? [],
  };
}

export class Db {
  readonly sql: Database.Database;

  constructor(path = ":memory:") {
    this.sql = new Database(path);
    this.sql.pragma("journal_mode = WAL");
    this.sql.exec(SCHEMA);
    for (const [table, column, type] of ADDED_COLUMNS) {
      const cols = this.sql.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
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

  getEvent(id: number): EventRow | undefined {
    const r = this.sql.prepare("SELECT * FROM events WHERE id = ?").get(id) as (Omit<EventRow, "payload"> & { payload: string }) | undefined;
    return r ? { ...r, payload: JSON.parse(r.payload) as Record<string, unknown> } : undefined;
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

  /** Distinct event types seen so far, for the trigger picker. */
  eventTypes(): string[] {
    return (this.sql.prepare("SELECT DISTINCT type FROM events ORDER BY type").all() as { type: string }[]).map((r) => r.type);
  }

  // Fires: the cooldown ledger, keyed by workflow id (formerly rule id) ----------

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

  startRun(
    r: { kind: string; rule_id?: string; event_id?: number; workflow_run_id?: number; model: string; input: string; local_date: string },
    now = new Date(),
  ): number {
    const info = this.sql
      .prepare(
        "INSERT INTO runs (kind, rule_id, event_id, workflow_run_id, model, status, input, local_date, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)",
      )
      .run(r.kind, r.rule_id ?? null, r.event_id ?? null, r.workflow_run_id ?? null, r.model, r.input, r.local_date, now.toISOString());
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
        "SELECT id, kind, rule_id, event_id, workflow_run_id, model, status, input_tokens, output_tokens, error, created_at, finished_at FROM runs ORDER BY id DESC LIMIT ?",
      )
      .all(limit);
  }

  getRun(id: number): Record<string, unknown> | undefined {
    const r = this.sql.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? { ...r, transcript: parseJson(r.transcript) } : undefined;
  }

  // Workflow runs -----------------------------------------------------------

  startWorkflowRun(
    r: { workflow_id: string; trigger: RunTrigger; event_id: number | null; dry_run: boolean; definition: unknown; local_date: string },
    now = new Date(),
  ): number {
    const info = this.sql
      .prepare(
        "INSERT INTO workflow_runs (workflow_id, trigger, event_id, status, dry_run, definition, started_at, local_date) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)",
      )
      .run(r.workflow_id, r.trigger, r.event_id, r.dry_run ? 1 : 0, JSON.stringify(r.definition), now.toISOString(), r.local_date);
    return Number(info.lastInsertRowid);
  }

  /** Sets a run's status. Final statuses also stamp finished_at; `waiting`/`running` clear it. */
  finishWorkflowRun(id: number, status: WorkflowRunStatus, error: string | null = null, now = new Date()): void {
    const final = status !== "running" && status !== "waiting";
    this.sql
      .prepare("UPDATE workflow_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?")
      .run(status, error, final ? now.toISOString() : null, id);
  }

  getWorkflowRun(id: number): WorkflowRunRow | undefined {
    const r = this.sql.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toWorkflowRun(r) : undefined;
  }

  workflowRuns(opts: { workflow_id?: string; limit?: number } = {}): WorkflowRunRow[] {
    const rows = opts.workflow_id
      ? this.sql.prepare("SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY id DESC LIMIT ?").all(opts.workflow_id, opts.limit ?? 50)
      : this.sql.prepare("SELECT * FROM workflow_runs ORDER BY id DESC LIMIT ?").all(opts.limit ?? 50);
    return (rows as Record<string, unknown>[]).map(toWorkflowRun);
  }

  /** Last real (not dry) run per workflow id, for list views. */
  lastWorkflowRuns(): Record<string, WorkflowRunRow> {
    const rows = this.sql
      .prepare("SELECT * FROM workflow_runs WHERE id IN (SELECT MAX(id) FROM workflow_runs WHERE dry_run = 0 GROUP BY workflow_id)")
      .all() as Record<string, unknown>[];
    return Object.fromEntries(rows.map((r) => [r.workflow_id as string, toWorkflowRun(r)]));
  }

  startStep(s: { workflow_run_id: number; step_id: string; path: string; type: string; input?: unknown }, now = new Date()): number {
    const info = this.sql
      .prepare("INSERT INTO step_runs (workflow_run_id, step_id, path, type, status, input, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?)")
      .run(s.workflow_run_id, s.step_id, s.path, s.type, s.input === undefined ? null : JSON.stringify(s.input), now.toISOString());
    return Number(info.lastInsertRowid);
  }

  finishStep(
    id: number,
    s: { status: StepRunStatus; output?: unknown; error?: string | null; run_id?: number | null; warnings?: string[]; input?: unknown },
    now = new Date(),
  ): void {
    const final = s.status !== "running" && s.status !== "waiting";
    this.sql
      .prepare(
        `UPDATE step_runs SET status = ?, output = COALESCE(?, output), error = ?, run_id = COALESCE(?, run_id),
           warnings = COALESCE(?, warnings), input = COALESCE(?, input), finished_at = ? WHERE id = ?`,
      )
      .run(
        s.status,
        s.output === undefined ? null : JSON.stringify(s.output),
        s.error ?? null,
        s.run_id ?? null,
        s.warnings?.length ? JSON.stringify(s.warnings) : null,
        s.input === undefined ? null : JSON.stringify(s.input),
        final ? now.toISOString() : null,
        id,
      );
  }

  stepRuns(workflowRunId: number): StepRunRow[] {
    return (this.sql.prepare("SELECT * FROM step_runs WHERE workflow_run_id = ? ORDER BY id").all(workflowRunId) as Record<string, unknown>[]).map(
      toStepRun,
    );
  }

  /** Outputs of finished steps keyed by step id: the `steps.*` template context when a run resumes. */
  stepOutputs(workflowRunId: number): Record<string, unknown> {
    const rows = this.sql
      .prepare("SELECT step_id, output FROM step_runs WHERE workflow_run_id = ? AND status IN ('ok', 'skipped') ORDER BY id")
      .all(workflowRunId) as { step_id: string; output: string | null }[];
    return Object.fromEntries(rows.map((r) => [r.step_id, parseJson(r.output)]));
  }

  /** The step run currently waiting in a workflow run, if any. */
  waitingStep(workflowRunId: number): StepRunRow | undefined {
    const r = this.sql
      .prepare("SELECT * FROM step_runs WHERE workflow_run_id = ? AND status = 'waiting' ORDER BY id DESC LIMIT 1")
      .get(workflowRunId) as Record<string, unknown> | undefined;
    return r ? toStepRun(r) : undefined;
  }

  waitingRuns(): WorkflowRunRow[] {
    return (this.sql.prepare("SELECT * FROM workflow_runs WHERE status = 'waiting' ORDER BY id").all() as Record<string, unknown>[]).map(toWorkflowRun);
  }

  /**
   * After a restart nothing is mid-step any more: steps (and their runs) still marked `running` were
   * cut off. Mark them failed so they are never run twice. Waiting runs keep their resume jobs.
   */
  markInterruptedSteps(now = new Date()): number {
    const iso = now.toISOString();
    return this.sql.transaction(() => {
      const steps = this.sql
        .prepare("UPDATE step_runs SET status = 'failed', error = 'interrupted by restart', finished_at = ? WHERE status = 'running'")
        .run(iso).changes;
      this.sql
        .prepare("UPDATE workflow_runs SET status = 'failed', error = 'interrupted by restart', finished_at = ? WHERE status = 'running'")
        .run(iso);
      this.sql.prepare("UPDATE runs SET status = 'error', error = 'interrupted by restart', finished_at = ? WHERE status = 'running'").run(iso);
      return steps;
    })();
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

  messagesForRun(runId: number): MessageRow[] {
    const rows = this.sql.prepare("SELECT * FROM messages WHERE run_id = ? ORDER BY id").all(runId) as (Omit<MessageRow, "items"> & {
      items: string | null;
    })[];
    return rows.map((r) => ({ ...r, items: r.items ? (JSON.parse(r.items) as PlanItem[]) : null }));
  }

  getMessage(id: number): MessageRow | undefined {
    const r = this.sql.prepare("SELECT * FROM messages WHERE id = ?").get(id) as (Omit<MessageRow, "items"> & { items: string | null }) | undefined;
    return r ? { ...r, items: r.items ? (JSON.parse(r.items) as PlanItem[]) : null } : undefined;
  }

  // Jobs --------------------------------------------------------------------

  addJob(runAt: Date, kind: string, payload: Record<string, unknown>): number {
    const info = this.sql
      .prepare("INSERT INTO jobs (run_at, kind, payload) VALUES (?, ?, ?)")
      .run(runAt.toISOString(), kind, JSON.stringify(payload));
    return Number(info.lastInsertRowid);
  }

  /** Atomically claims due jobs so a job never runs twice. Cancelled jobs are never returned. */
  claimDueJobs(now = new Date()): Job[] {
    const iso = now.toISOString();
    return this.sql.transaction(() => {
      const rows = this.sql
        .prepare("SELECT * FROM jobs WHERE done_at IS NULL AND cancelled_at IS NULL AND run_at <= ? ORDER BY run_at")
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

  getJob(id: number): (Job & { done_at: string | null; cancelled_at: string | null }) | undefined {
    const r = this.sql.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | (Omit<Job, "payload"> & { payload: string; done_at: string | null; cancelled_at: string | null })
      | undefined;
    return r ? { ...r, payload: JSON.parse(r.payload) as Record<string, unknown> } : undefined;
  }

  /** Pending (not done, not cancelled) jobs, optionally of one kind. */
  pendingJobs(kind?: string): Job[] {
    const rows = (
      kind
        ? this.sql.prepare("SELECT * FROM jobs WHERE done_at IS NULL AND cancelled_at IS NULL AND kind = ? ORDER BY run_at").all(kind)
        : this.sql.prepare("SELECT * FROM jobs WHERE done_at IS NULL AND cancelled_at IS NULL ORDER BY run_at").all()
    ) as (Omit<Job, "payload"> & { payload: string })[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  }

  /** Cancels a pending job. Returns false if it already ran or was cancelled. */
  cancelJob(id: number, now = new Date()): boolean {
    return (
      this.sql.prepare("UPDATE jobs SET cancelled_at = ? WHERE id = ? AND done_at IS NULL AND cancelled_at IS NULL").run(now.toISOString(), id)
        .changes > 0
    );
  }
}
