import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type { Condition, PhoneAction } from "./config.js";

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
CREATE TABLE IF NOT EXISTS run_listeners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_run_id INTEGER NOT NULL,
  step_path TEXT,
  kind TEXT NOT NULL,
  event_type TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_listeners_type ON run_listeners (event_type);
CREATE INDEX IF NOT EXISTS run_listeners_run ON run_listeners (workflow_run_id);
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
CREATE TABLE IF NOT EXISTS phone_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_run_id INTEGER NOT NULL,
  step_run_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT
);
CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  event_id INTEGER,
  fired INTEGER NOT NULL,
  reason TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS evaluations_time ON evaluations (at);
CREATE INDEX IF NOT EXISTS evaluations_wf ON evaluations (workflow_id, at);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS activity_time ON activity (at);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_time ON events (received_at);
`;

/** Columns added after the first release, applied with a guarded ALTER TABLE. */
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ["jobs", "cancelled_at", "TEXT"],
  ["runs", "workflow_run_id", "INTEGER"],
  ["devices", "push_endpoint", "TEXT"],
  ["devices", "push_p256dh", "TEXT"],
  ["devices", "push_auth", "TEXT"],
  ["jobs", "plugin", "TEXT"],
  ["jobs", "reminder_key", "TEXT"],
  ["jobs", "reminder_group", "TEXT"],
  ["jobs", "cancel_reason", "TEXT"],
  ["messages", "level", "TEXT"],
  ["messages", "due_at", "TEXT"],
  ["messages", "job_id", "INTEGER"],
];

/** Indexes on added columns: these can't live in SCHEMA because old databases get the columns later. */
const ADDED_INDEXES = [
  // One pending reminder per plugin and key; upserts update it in place.
  `CREATE UNIQUE INDEX IF NOT EXISTS jobs_reminder_pending ON jobs (plugin, reminder_key)
     WHERE kind = 'reminder' AND done_at IS NULL AND cancelled_at IS NULL`,
];

export type ReminderLevel = "notify" | "loud" | "alarm";
export type CancelReason = "user" | "replaced" | "deleted" | "run ended";

export interface ListenerRow {
  id: number;
  workflow_run_id: number;
  step_path: string | null;
  kind: "until" | "cancel";
  event_type: string;
  conditions: Condition[];
}

export interface ReminderPayload {
  text: string;
  level: ReminderLevel;
  items: PlanItem[];
  /** Set on a snoozed reminder: the time the plugin originally asked for, so a re-sync doesn't undo the snooze. */
  snoozed_from?: string;
}

export type UpsertStatus = "scheduled" | "unchanged" | "kept_snooze" | "already_done";

export interface Device {
  id: number;
  name: string;
  fcm_token: string | null;
  /** Web Push (UnifiedPush) endpoint, or null when the device hasn't registered one. */
  push_endpoint: string | null;
}

export interface WebPushSubscription {
  device_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface EventRow {
  id: number;
  device_id: number | null;
  type: string;
  payload: Record<string, unknown>;
  received_at: string;
}

/** A button the app shows on an item; tapping it posts `{item, action: id, args}` to the item's plugin. */
export interface ItemAction {
  id: string;
  label: string;
  style?: "primary" | "secondary" | "text";
  args?: Record<string, unknown>;
}

/**
 * One item in a message sent to the phone. `plugin` + `item_id` say what it is about (e.g. a to-do
 * task); the server fills `actions` from that plugin's manifest `item_actions`.
 */
export interface PlanItem {
  plugin?: string;
  item_id?: string;
  title: string;
  steps: string[];
  minutes?: number;
  actions?: ItemAction[];
}

export interface MessageRow {
  id: number;
  direction: "in" | "out";
  text: string;
  items: PlanItem[] | null;
  run_id: number | null;
  created_at: string;
  /** How loudly the phone should announce it (reminders only). */
  level: ReminderLevel | null;
  /** When a reminder was meant to ring; the phone downgrades an alarm that is much later than this. */
  due_at: string | null;
  /** The reminder job that produced this message. */
  job_id: number | null;
}

export interface Job {
  id: number;
  run_at: string;
  kind: string;
  payload: Record<string, unknown>;
  plugin?: string | null;
  reminder_key?: string | null;
  reminder_group?: string | null;
  cancel_reason?: CancelReason | null;
}

export interface EvaluationRow {
  id: number;
  at: string;
  workflow_id: string;
  trigger_kind: "event" | "schedule";
  event_id: number | null;
  fired: boolean;
  reason: string;
  simulated: boolean;
}

export type ActivityKind = "config_reload" | "config_error" | "plugin_connect" | "plugin_disconnect" | "reminder_fired" | "item_action";

export interface ActivityRow {
  id: number;
  at: string;
  kind: ActivityKind;
  subject: string | null;
  detail: unknown;
}

/** Filters shared by the activity feed queries. `before` is an exclusive upper bound used as the page cursor. */
export interface FeedQuery {
  from?: string;
  to?: string;
  before?: string;
  workflow_id?: string;
  limit: number;
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

export interface PhoneCommandRow {
  id: number;
  workflow_run_id: number;
  step_run_id: number;
  payload: PhoneAction;
  created_at: string;
  expires_at: string;
  status: "pending" | "ok" | "failed" | "expired";
  result: { ok?: boolean; error?: string; device_id?: number } | null;
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
    for (const ddl of ADDED_INDEXES) this.sql.exec(ddl);
  }

  // Meta: one-off markers such as "this upgrade step has run" ------------------

  getMeta(key: string): string | undefined {
    return (this.sql.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.sql.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // Devices ---------------------------------------------------------------

  /** Creates a device and returns its bearer token (only the hash is stored). */
  createDevice(name: string, now = new Date()): { device: Device; token: string } {
    const token = randomBytes(32).toString("base64url");
    const info = this.sql
      .prepare("INSERT INTO devices (name, token_hash, created_at) VALUES (?, ?, ?)")
      .run(name, hash(token), now.toISOString());
    return { device: { id: Number(info.lastInsertRowid), name, fcm_token: null, push_endpoint: null }, token };
  }

  deviceByToken(token: string): Device | undefined {
    return this.sql.prepare("SELECT id, name, fcm_token, push_endpoint FROM devices WHERE token_hash = ?").get(hash(token)) as
      | Device
      | undefined;
  }

  deviceById(id: number): Device | undefined {
    return this.sql.prepare("SELECT id, name, fcm_token, push_endpoint FROM devices WHERE id = ?").get(id) as Device | undefined;
  }

  setPushToken(deviceId: number, fcmToken: string | null): void {
    this.sql.prepare("UPDATE devices SET fcm_token = ? WHERE id = ?").run(fcmToken, deviceId);
  }

  pushTokens(): string[] {
    return (this.sql.prepare("SELECT fcm_token FROM devices WHERE fcm_token IS NOT NULL").all() as { fcm_token: string }[]).map(
      (r) => r.fcm_token,
    );
  }

  setWebPush(deviceId: number, sub: { endpoint: string; p256dh: string; auth: string } | null): void {
    this.sql
      .prepare("UPDATE devices SET push_endpoint = ?, push_p256dh = ?, push_auth = ? WHERE id = ?")
      .run(sub?.endpoint ?? null, sub?.p256dh ?? null, sub?.auth ?? null, deviceId);
  }

  webPushSubscriptions(): WebPushSubscription[] {
    return this.sql
      .prepare(
        "SELECT id AS device_id, push_endpoint AS endpoint, push_p256dh AS p256dh, push_auth AS auth FROM devices " +
          "WHERE push_endpoint IS NOT NULL AND push_p256dh IS NOT NULL AND push_auth IS NOT NULL",
      )
      .all() as WebPushSubscription[];
  }

  /** Called when the push service says the subscription is gone (404/410). */
  clearWebPushByEndpoint(endpoint: string): void {
    this.sql
      .prepare("UPDATE devices SET push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL WHERE push_endpoint = ?")
      .run(endpoint);
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
    this.sql.transaction(() => {
      this.sql.prepare("UPDATE workflow_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(status, error, final ? now.toISOString() : null, id);
      if (final) {
        // A finished run leaves nothing behind that could wake it.
        this.deleteListeners(id);
        this.cancelJobsForRun(id, ["workflow_resume", "workflow_nag"], now);
      }
    })();
  }

  // Run listeners -------------------------------------------------------------

  addListener(l: { workflow_run_id: number; step_path: string | null; kind: "until" | "cancel"; event_type: string; conditions: Condition[] }, now = new Date()): void {
    this.sql
      .prepare("INSERT INTO run_listeners (workflow_run_id, step_path, kind, event_type, conditions, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(l.workflow_run_id, l.step_path, l.kind, l.event_type, JSON.stringify(l.conditions), now.toISOString());
  }

  /** Listeners for an event type whose run is still waiting. */
  listenersFor(eventType: string): ListenerRow[] {
    const rows = this.sql
      .prepare(
        `SELECT l.* FROM run_listeners l JOIN workflow_runs r ON r.id = l.workflow_run_id
           WHERE l.event_type = ? AND r.status = 'waiting' ORDER BY l.id`,
      )
      .all(eventType) as (Omit<ListenerRow, "conditions"> & { conditions: string })[];
    return rows.map((r) => ({ ...r, conditions: JSON.parse(r.conditions) as Condition[] }));
  }

  deleteListeners(runId: number, opts: { stepPath?: string; kind?: "until" | "cancel" } = {}): number {
    let sql = "DELETE FROM run_listeners WHERE workflow_run_id = ?";
    const args: unknown[] = [runId];
    if (opts.stepPath !== undefined) {
      sql += " AND step_path = ?";
      args.push(opts.stepPath);
    }
    if (opts.kind) {
      sql += " AND kind = ?";
      args.push(opts.kind);
    }
    return this.sql.prepare(sql).run(...args).changes as number;
  }

  deleteListener(id: number): boolean {
    return this.sql.prepare("DELETE FROM run_listeners WHERE id = ?").run(id).changes > 0;
  }

  hasListeners(runId: number, kind: "until" | "cancel"): boolean {
    return !!this.sql.prepare("SELECT 1 FROM run_listeners WHERE workflow_run_id = ? AND kind = ? LIMIT 1").get(runId, kind);
  }

  /** Cancels a run's pending jobs of the given kinds. */
  cancelJobsForRun(runId: number, kinds: string[], now = new Date(), reason: CancelReason = "run ended"): number {
    const marks = kinds.map(() => "?").join(",");
    return this.sql
      .prepare(
        `UPDATE jobs SET cancelled_at = ?, cancel_reason = ? WHERE done_at IS NULL AND cancelled_at IS NULL
           AND kind IN (${marks}) AND json_extract(payload, '$.workflow_run_id') = ?`,
      )
      .run(now.toISOString(), reason, ...kinds, runId).changes as number;
  }

  /** True when a real (not dry) run of this workflow is paused. */
  hasWaitingRun(workflowId: string): boolean {
    return !!this.sql.prepare("SELECT 1 FROM workflow_runs WHERE workflow_id = ? AND status = 'waiting' AND dry_run = 0 LIMIT 1").get(workflowId);
  }

  /** Runs with a pending nag about this plugin item. */
  nagRunsForItem(plugin: string, itemId: string): { run_id: number; step_path: string }[] {
    const rows = this.sql
      .prepare(
        `SELECT json_extract(payload, '$.workflow_run_id') AS run_id, json_extract(payload, '$.step_path') AS step_path FROM jobs
           WHERE done_at IS NULL AND cancelled_at IS NULL AND kind = 'workflow_nag'
             AND json_extract(payload, '$.plugin') = ? AND json_extract(payload, '$.item_id') = ?`,
      )
      .all(plugin, itemId) as { run_id: number; step_path: string }[];
    return rows.map((r) => ({ run_id: Number(r.run_id), step_path: String(r.step_path) }));
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

  // Evaluations and activity --------------------------------------------------

  recordEvaluation(e: Omit<EvaluationRow, "id">): number {
    return Number(
      this.sql
        .prepare("INSERT INTO evaluations (at, workflow_id, trigger_kind, event_id, fired, reason, simulated) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(e.at, e.workflow_id, e.trigger_kind, e.event_id, e.fired ? 1 : 0, e.reason, e.simulated ? 1 : 0).lastInsertRowid,
    );
  }

  addActivity(kind: ActivityKind, subject: string | null, detail: unknown = null, now = new Date()): number {
    return Number(
      this.sql
        .prepare("INSERT INTO activity (at, kind, subject, detail) VALUES (?, ?, ?, ?)")
        .run(now.toISOString(), kind, subject, detail === null ? null : JSON.stringify(detail)).lastInsertRowid,
    );
  }

  private feedWhere(q: FeedQuery, col: string, wfCol: string | null): { sql: string; args: unknown[] } {
    const parts: string[] = [];
    const args: unknown[] = [];
    if (q.from) (parts.push(`${col} >= ?`), args.push(q.from));
    if (q.to) (parts.push(`${col} <= ?`), args.push(q.to));
    if (q.before) (parts.push(`${col} < ?`), args.push(q.before));
    if (q.workflow_id && wfCol) (parts.push(`${wfCol} = ?`), args.push(q.workflow_id));
    return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
  }

  evaluations(q: FeedQuery & { fired?: boolean }): (EvaluationRow & { event_type: string | null })[] {
    const w = this.feedWhere(q, "v.at", "v.workflow_id");
    let where = w.sql;
    if (q.fired !== undefined) where = `${where ? `${where} AND` : "WHERE"} v.fired = ${q.fired ? 1 : 0}`;
    const rows = this.sql
      .prepare(`SELECT v.*, e.type AS event_type FROM evaluations v LEFT JOIN events e ON e.id = v.event_id ${where} ORDER BY v.at DESC, v.id DESC LIMIT ?`)
      .all(...w.args, q.limit) as Record<string, unknown>[];
    return rows.map((r) => ({ ...(r as unknown as EvaluationRow & { event_type: string | null }), fired: r.fired === 1, simulated: r.simulated === 1 }));
  }

  activityRows(q: FeedQuery & { kinds?: string[] }): ActivityRow[] {
    const w = this.feedWhere(q, "at", null);
    let where = w.sql;
    const args = [...w.args];
    if (q.kinds?.length) {
      where = `${where ? `${where} AND` : "WHERE"} kind IN (${q.kinds.map(() => "?").join(", ")})`;
      args.push(...q.kinds);
    }
    if (q.workflow_id) return []; // activity rows are not tied to a workflow
    const rows = this.sql.prepare(`SELECT * FROM activity ${where} ORDER BY at DESC, id DESC LIMIT ?`).all(...args, q.limit) as Record<string, unknown>[];
    return rows.map((r) => ({ ...(r as unknown as ActivityRow), detail: parseJson(r.detail) }));
  }

  workflowRunsFeed(q: FeedQuery & { statuses?: string[] }): WorkflowRunRow[] {
    const w = this.feedWhere(q, "started_at", "workflow_id");
    let where = w.sql;
    const args = [...w.args];
    if (q.statuses?.length) {
      where = `${where ? `${where} AND` : "WHERE"} status IN (${q.statuses.map(() => "?").join(", ")})`;
      args.push(...q.statuses);
    }
    return (this.sql.prepare(`SELECT * FROM workflow_runs ${where} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...args, q.limit) as Record<string, unknown>[]).map(
      toWorkflowRun,
    );
  }

  /** Token totals for runs created at or after `since`. */
  tokensSince(since: string): { input_tokens: number; output_tokens: number; runs: number } {
    return this.sql
      .prepare("SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens, COUNT(*) AS runs FROM runs WHERE created_at >= ?")
      .get(since) as { input_tokens: number; output_tokens: number; runs: number };
  }

  /** The most recent event from each paired device. */
  lastEventPerDevice(): { device_id: number; name: string; last_event_type: string | null; last_event_at: string | null }[] {
    return this.sql
      .prepare(
        `SELECT d.id AS device_id, d.name, e.type AS last_event_type, e.received_at AS last_event_at
         FROM devices d LEFT JOIN events e ON e.id = (SELECT id FROM events WHERE device_id = d.id ORDER BY received_at DESC, id DESC LIMIT 1)
         ORDER BY d.id`,
      )
      .all() as { device_id: number; name: string; last_event_type: string | null; last_event_at: string | null }[];
  }

  /**
   * Retention: drops evaluations, activity, finished workflow runs (with their steps) and events
   * older than `cutoff`. Claude runs are kept for token history (and because messages point at
   * them) but their transcripts and inputs are cleared. Events still needed by a waiting run stay.
   */
  prune(cutoff: string): Record<string, number> {
    return this.sql.transaction(() => {
      const out: Record<string, number> = {};
      out.evaluations = this.sql.prepare("DELETE FROM evaluations WHERE at < ?").run(cutoff).changes;
      out.activity = this.sql.prepare("DELETE FROM activity WHERE at < ?").run(cutoff).changes;
      out.run_listeners = this.sql
        .prepare("DELETE FROM run_listeners WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE finished_at IS NOT NULL AND finished_at < ?)")
        .run(cutoff).changes;
      out.step_runs = this.sql
        .prepare("DELETE FROM step_runs WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE finished_at IS NOT NULL AND finished_at < ?)")
        .run(cutoff).changes;
      out.phone_commands = this.sql.prepare("DELETE FROM phone_commands WHERE created_at < ?").run(cutoff).changes;
      out.workflow_runs = this.sql.prepare("DELETE FROM workflow_runs WHERE finished_at IS NOT NULL AND finished_at < ?").run(cutoff).changes;
      out.events = this.sql
        .prepare(
          `DELETE FROM events WHERE received_at < ?
             AND id NOT IN (SELECT event_id FROM workflow_runs WHERE event_id IS NOT NULL AND status IN ('running', 'waiting'))
             AND id NOT IN (SELECT id FROM events e2 WHERE e2.id IN (SELECT MAX(id) FROM events GROUP BY type, device_id))`,
        )
        .run(cutoff).changes;
      out.transcripts = this.sql
        .prepare("UPDATE runs SET transcript = NULL, input = NULL WHERE created_at < ? AND (transcript IS NOT NULL OR input IS NOT NULL)")
        .run(cutoff).changes;
      out.jobs = this.sql.prepare("DELETE FROM jobs WHERE (done_at IS NOT NULL OR cancelled_at IS NOT NULL) AND run_at < ?").run(cutoff).changes;
      return out;
    })();
  }

  // Phone commands ------------------------------------------------------------

  addPhoneCommand(c: { workflow_run_id: number; step_run_id: number; payload: PhoneAction }, now: Date, ttlMs: number): PhoneCommandRow {
    const id = this.sql
      .prepare("INSERT INTO phone_commands (workflow_run_id, step_run_id, payload, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, 'pending')")
      .run(c.workflow_run_id, c.step_run_id, JSON.stringify(c.payload), now.toISOString(), new Date(now.getTime() + ttlMs).toISOString()).lastInsertRowid;
    return this.getPhoneCommand(Number(id))!;
  }

  getPhoneCommand(id: number): PhoneCommandRow | undefined {
    const r = this.sql.prepare("SELECT * FROM phone_commands WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return { ...r, payload: JSON.parse(r.payload as string), result: r.result ? JSON.parse(r.result as string) : null } as PhoneCommandRow;
  }

  /** Atomic: only a still-pending command changes, so the first reply wins and a late one is ignored. */
  settlePhoneCommand(id: number, status: "ok" | "failed" | "expired", result: unknown): boolean {
    return (
      this.sql.prepare("UPDATE phone_commands SET status = ?, result = ? WHERE id = ? AND status = 'pending'").run(status, JSON.stringify(result ?? null), id).changes > 0
    );
  }

  // Messages ----------------------------------------------------------------

  addMessage(
    direction: "in" | "out",
    text: string,
    items: PlanItem[] | null = null,
    runId: number | null = null,
    now = new Date(),
    extra: { level?: ReminderLevel | null; due_at?: string | null; job_id?: number | null } = {},
  ): MessageRow {
    const created_at = now.toISOString();
    const level = extra.level ?? null;
    const due_at = extra.due_at ?? null;
    const job_id = extra.job_id ?? null;
    const info = this.sql
      .prepare("INSERT INTO messages (direction, text, items, run_id, created_at, level, due_at, job_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(direction, text, items ? JSON.stringify(items) : null, runId, created_at, level, due_at, job_id);
    return { id: Number(info.lastInsertRowid), direction, text, items, run_id: runId, created_at, level, due_at, job_id };
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

  /** Cancels pending follow-ups about a plugin's item, e.g. when a task is marked done early. */
  cancelJobsForItem(plugin: string, itemId: string, now = new Date()): number {
    return this.sql
      .prepare(
        "UPDATE jobs SET done_at = ? WHERE done_at IS NULL AND kind = 'followup' AND json_extract(payload, '$.plugin') = ? AND json_extract(payload, '$.item_id') = ?",
      )
      .run(now.toISOString(), plugin, itemId).changes as number;
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
  cancelJob(id: number, now = new Date(), reason: CancelReason = "user"): boolean {
    return (
      this.sql
        .prepare("UPDATE jobs SET cancelled_at = ?, cancel_reason = ? WHERE id = ? AND done_at IS NULL AND cancelled_at IS NULL")
        .run(now.toISOString(), reason, id).changes > 0
    );
  }

  // Plugin reminders ------------------------------------------------------------

  /** The pending reminder for a plugin and key, if any. */
  pendingReminder(plugin: string, key: string): Job | undefined {
    const r = this.sql
      .prepare("SELECT * FROM jobs WHERE kind = 'reminder' AND plugin = ? AND reminder_key = ? AND done_at IS NULL AND cancelled_at IS NULL")
      .get(plugin, key) as (Omit<Job, "payload"> & { payload: string }) | undefined;
    return r ? { ...r, payload: JSON.parse(r.payload) as Record<string, unknown> } : undefined;
  }

  pendingRemindersInGroup(plugin: string, group: string): Job[] {
    const rows = this.sql
      .prepare(
        "SELECT * FROM jobs WHERE kind = 'reminder' AND plugin = ? AND reminder_group = ? AND done_at IS NULL AND cancelled_at IS NULL ORDER BY run_at",
      )
      .all(plugin, group) as (Omit<Job, "payload"> & { payload: string })[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  }

  /** Cancels the pending reminder for a plugin and key. Returns false if there was none. */
  cancelReminder(plugin: string, key: string, reason: CancelReason, now = new Date()): boolean {
    return (
      this.sql
        .prepare(
          "UPDATE jobs SET cancelled_at = ?, cancel_reason = ? WHERE kind = 'reminder' AND plugin = ? AND reminder_key = ? AND done_at IS NULL AND cancelled_at IS NULL",
        )
        .run(now.toISOString(), reason, plugin, key).changes > 0
    );
  }

  /**
   * Creates or updates the pending reminder for (plugin, key). It never re-arms a reminder that already
   * fired or was cancelled by the user for the same `at`, and never undoes a snooze.
   */
  upsertReminder(
    plugin: string,
    key: string,
    group: string | null,
    at: Date,
    payload: Omit<ReminderPayload, "snoozed_from">,
  ): { status: UpsertStatus; job_id: number | null } {
    return this.sql.transaction(() => {
      const runAt = at.toISOString();
      const pending = this.pendingReminder(plugin, key);
      if (pending) {
        const { snoozed_from, ...oldBody } = pending.payload as unknown as ReminderPayload;
        const sameBody = JSON.stringify(oldBody) === JSON.stringify(payload);
        if (snoozed_from === runAt) {
          // The plugin re-sent the original time of a snoozed reminder: keep the snooze, refresh the content.
          if (!sameBody || pending.reminder_group !== group) {
            this.sql
              .prepare("UPDATE jobs SET payload = ?, reminder_group = ? WHERE id = ?")
              .run(JSON.stringify({ ...payload, snoozed_from }), group, pending.id);
          }
          return { status: "kept_snooze" as const, job_id: pending.id };
        }
        if (pending.run_at === runAt && sameBody && snoozed_from === undefined && pending.reminder_group === group) {
          return { status: "unchanged" as const, job_id: pending.id };
        }
        this.sql
          .prepare("UPDATE jobs SET run_at = ?, payload = ?, reminder_group = ? WHERE id = ?")
          .run(runAt, JSON.stringify(payload), group, pending.id);
        return { status: "scheduled" as const, job_id: pending.id };
      }
      const finished = this.sql
        .prepare(
          `SELECT id FROM jobs WHERE kind = 'reminder' AND plugin = ? AND reminder_key = ? AND run_at = ?
             AND (done_at IS NOT NULL OR cancel_reason = 'user') LIMIT 1`,
        )
        .get(plugin, key, runAt) as { id: number } | undefined;
      if (finished) return { status: "already_done" as const, job_id: null };
      const info = this.sql
        .prepare("INSERT INTO jobs (run_at, kind, payload, plugin, reminder_key, reminder_group) VALUES (?, 'reminder', ?, ?, ?, ?)")
        .run(runAt, JSON.stringify(payload), plugin, key, group);
      return { status: "scheduled" as const, job_id: Number(info.lastInsertRowid) };
    })();
  }

  /**
   * Re-queues a reminder (fired or not) `minutes` from now under the same plugin and key, replacing any
   * pending row. The new row remembers the original time so the plugin's next sync keeps the snooze.
   */
  snoozeReminder(job: Job, minutes: number, now = new Date()): { job_id: number; at: string } {
    const plugin = job.plugin as string;
    const key = job.reminder_key as string;
    const body = job.payload as unknown as ReminderPayload;
    const at = new Date(now.getTime() + minutes * 60_000).toISOString();
    return this.sql.transaction(() => {
      this.cancelReminder(plugin, key, "replaced", now);
      const payload: ReminderPayload = { ...body, snoozed_from: body.snoozed_from ?? job.run_at };
      const info = this.sql
        .prepare("INSERT INTO jobs (run_at, kind, payload, plugin, reminder_key, reminder_group) VALUES (?, 'reminder', ?, ?, ?, ?)")
        .run(at, JSON.stringify(payload), plugin, key, job.reminder_group ?? null);
      return { job_id: Number(info.lastInsertRowid), at };
    })();
  }
}
