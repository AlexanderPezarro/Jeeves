import { Cron } from "croner";
import { describeCondition } from "./conditions.js";
import { isSchedule, ssidList, type ConfigSource, type Step, type Trigger, type Workflow } from "./config.js";
import type { ConfigStore } from "./configstore.js";
import type { Db, EventRow, ReminderPayload, StepRunRow, WorkflowRunRow } from "./db.js";
import type { PluginHost } from "./plugins.js";
import { nextPath, RESUME_JOB, stepAt } from "./runner.js";
import { localTime } from "./time.js";
import { blockReason, scheduleEventType } from "./triggers.js";

// ---------------------------------------------------------------------------
// Plain-English triggers

const EVENT_NAMES: Record<string, string> = {
  "wifi.connected": "Wi-Fi connects",
  "wifi.disconnected": "Wi-Fi disconnects",
  "location.arrived": "you arrive",
  "location.left": "you leave",
  "manual.plan": 'you tap "Plan my day"',
  "manual.run": "you run it by hand",
};

const DAY_NAMES: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function eventName(type: string): string {
  if (EVENT_NAMES[type]) return EVENT_NAMES[type];
  const dot = type.indexOf(".");
  if (dot > 0) return `${type.slice(0, dot)} reports ${type.slice(dot + 1).replace(/_/g, " ")}`;
  return type;
}

/**
 * e.g. "Wi-Fi connects to MyHomeWiFi between 17:00 and 22:30 after 2h away, once a day".
 * `cooldown` is the workflow's (triggers share it).
 */
export function describeTrigger(trigger: Trigger, cooldown: Workflow["cooldown"] = "daily"): string {
  const w = trigger.when ?? {};
  const parts: string[] = [];
  if (isSchedule(trigger)) parts.push(`On schedule "${trigger.schedule}"`);
  else {
    let name = eventName(trigger.event);
    const ssids = ssidList(w.ssid).join(" or ");
    if (ssids && trigger.event.startsWith("wifi.")) name += ` ${trigger.event === "wifi.connected" ? "to" : "from"} ${ssids}`;
    else if (ssids) name += ` on ${ssids}`;
    parts.push(name.charAt(0).toUpperCase() + name.slice(1));
  }
  if (w.days?.length) parts.push(`on ${w.days.map((d) => DAY_NAMES[d]).join(", ")}`);
  if (w.after && w.before) parts.push(`between ${w.after} and ${w.before}`);
  else if (w.after) parts.push(`after ${w.after}`);
  else if (w.before) parts.push(`before ${w.before}`);
  if (w.min_away_minutes) parts.push(`after ${duration(w.min_away_minutes)} away`);
  if (w.conditions?.length) parts.push(`when ${w.conditions.map(describeCondition).join(" and ")}`);
  let text = parts.join(" ");
  if (cooldown === "daily") text += ", once a day";
  else if (cooldown > 0) text += `, at most every ${duration(cooldown)}`;
  return text;
}

// ---------------------------------------------------------------------------
// Upcoming

export type UpcomingStatus = "will_run" | "will_skip" | "disabled" | "cap_reached";

export type UpcomingItem =
  | { kind: "schedule"; at: string; workflow_id: string; schedule: string; status: UpcomingStatus; reason: string | null }
  | { kind: "wait"; at: string; job_id: number; workflow_id: string; workflow_run_id: number; next_step: string | null; dry_run: boolean }
  | { kind: "followup"; at: string; job_id: number; message: string; plugin: string | null; item_id: string | null }
  | { kind: "reminder"; at: string; job_id: number; plugin: string; key: string; level: string; text: string; item_id: string | null };

export interface WaitingFor {
  workflow_id: string;
  enabled: boolean;
  event: string;
  description: string;
}

export interface TimelineDeps {
  db: Db;
  config: ConfigSource;
  plugins?: PluginHost;
  store?: ConfigStore;
}

const hasClaudeStep = (steps: Step[]): boolean =>
  steps.some((s) => "claude" in s || ("if" in s && (hasClaudeStep(s.then) || hasClaudeStep(s.else ?? []))));

export function upcoming({ db, config }: TimelineDeps, hours = 48, now = new Date()): { from: string; to: string; items: UpcomingItem[]; waiting_for: WaitingFor[] } {
  const cfg = config.current;
  const end = new Date(now.getTime() + hours * 3600_000);
  const today = localTime(now, cfg.timezone).date;
  const capped = db.runsOn(today) >= cfg.max_runs_per_day;
  const items: UpcomingItem[] = [];

  // Future fires change later cooldown checks, so pre-check slots in time order with virtual fires.
  const virtualFires = new Map<string, { fired_at: string; local_date: string }>();
  const shim = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "lastFire") return (id: string) => virtualFires.get(id) ?? target.lastFire(id);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

  const slots: { at: Date; wf: Workflow; trigger: Trigger & { schedule: string } }[] = [];
  for (const wf of cfg.workflows) {
    for (const t of wf.triggers) {
      if (!isSchedule(t)) continue;
      let cron: Cron;
      try {
        cron = new Cron(t.schedule, { timezone: cfg.timezone, paused: true });
      } catch {
        continue;
      }
      for (const at of cron.nextRuns(200, now)) {
        if (at > end) break;
        slots.push({ at, wf, trigger: t });
      }
      cron.stop();
    }
  }
  slots.sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const { at, wf, trigger } of slots) {
    const local = localTime(at, cfg.timezone);
    const event: EventRow = { id: 0, device_id: null, type: scheduleEventType(wf.id), payload: {}, received_at: at.toISOString() };
    const reason = blockReason(wf, trigger, event, shim, local, at);
    let status: UpcomingStatus = reason === null ? "will_run" : reason === "disabled" ? "disabled" : "will_skip";
    if (status === "will_run" && capped && local.date === today && hasClaudeStep(wf.steps)) status = "cap_reached";
    if (status === "will_run") virtualFires.set(wf.id, { fired_at: at.toISOString(), local_date: local.date });
    items.push({
      kind: "schedule",
      at: at.toISOString(),
      workflow_id: wf.id,
      schedule: trigger.schedule,
      status,
      reason: status === "cap_reached" ? `daily cap of ${cfg.max_runs_per_day} Claude runs reached` : reason,
    });
  }

  for (const job of db.pendingJobs(RESUME_JOB)) {
    if (new Date(job.run_at) > end) continue;
    const run = db.getWorkflowRun(Number(job.payload.workflow_run_id));
    if (!run) continue;
    const steps = (run.definition as Workflow).steps;
    const next = nextPath(steps, String(job.payload.step_path));
    items.push({
      kind: "wait",
      at: job.run_at,
      job_id: job.id,
      workflow_id: run.workflow_id,
      workflow_run_id: run.id,
      next_step: next ? (stepAt(steps, next)?.id ?? null) : null,
      dry_run: run.dry_run,
    });
  }

  for (const job of db.pendingJobs("followup")) {
    if (new Date(job.run_at) > end) continue;
    items.push({
      kind: "followup",
      at: job.run_at,
      job_id: job.id,
      message: String(job.payload.message ?? ""),
      plugin: typeof job.payload.plugin === "string" ? job.payload.plugin : null,
      item_id: typeof job.payload.item_id === "string" ? job.payload.item_id : null,
    });
  }

  for (const job of db.pendingJobs("reminder")) {
    if (new Date(job.run_at) > end) continue;
    const p = job.payload as unknown as ReminderPayload;
    items.push({
      kind: "reminder",
      at: job.run_at,
      job_id: job.id,
      plugin: job.plugin ?? "",
      key: job.reminder_key ?? "",
      level: p.level,
      text: p.text,
      item_id: p.items?.length === 1 ? (p.items[0].item_id ?? null) : null,
    });
  }

  items.sort((a, b) => a.at.localeCompare(b.at));

  const waiting_for: WaitingFor[] = [];
  for (const wf of cfg.workflows) {
    for (const t of wf.triggers) {
      if (isSchedule(t)) continue;
      waiting_for.push({ workflow_id: wf.id, enabled: wf.enabled, event: t.event, description: describeTrigger(t, wf.cooldown) });
    }
  }
  return { from: now.toISOString(), to: end.toISOString(), items, waiting_for };
}

// ---------------------------------------------------------------------------
// Activity feed

export interface ActivityQuery {
  from?: string;
  to?: string;
  workflow?: string;
  /** Comma list of: evaluation, workflow_run, config, plugin (or exact activity kinds). */
  kind?: string;
  /** For runs: a run status (ok, failed, …). For evaluations: fired or skipped. */
  status?: string;
  limit?: number;
  cursor?: string;
}

export type FeedItem =
  | ({ kind: "evaluation"; at: string } & Record<string, unknown>)
  | ({ kind: "workflow_run"; at: string } & Record<string, unknown>)
  | ({ kind: string; at: string } & Record<string, unknown>);

function runDetail(db: Db, run: WorkflowRunRow) {
  const steps = db.stepRuns(run.id).map((s: StepRunRow) => {
    const claude = s.run_id ? db.getRun(s.run_id) : undefined;
    const messageId = (s.output as { message_id?: number } | null)?.message_id;
    return {
      ...s,
      claude_run: claude
        ? { id: claude.id, status: claude.status, model: claude.model, input_tokens: claude.input_tokens, output_tokens: claude.output_tokens, error: claude.error }
        : null,
      messages: s.run_id ? db.messagesForRun(s.run_id) : messageId ? [db.getMessage(messageId)].filter(Boolean) : [],
    };
  });
  const { definition: _d, ...rest } = run;
  return { kind: "workflow_run" as const, at: run.started_at, ...rest, steps };
}

export function activityFeed({ db }: TimelineDeps, q: ActivityQuery = {}): { items: FeedItem[]; next_cursor: string | null } {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const kinds = (q.kind ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const want = (k: string) => !kinds.length || kinds.includes(k);
  const base = { from: q.from, to: q.to, before: q.cursor, workflow_id: q.workflow, limit };
  const items: FeedItem[] = [];

  if (want("evaluation")) {
    const fired = q.status === "fired" ? true : q.status === "skipped" ? false : undefined;
    if (!q.status || fired !== undefined) {
      for (const e of db.evaluations({ ...base, fired })) items.push({ ...e, kind: "evaluation", at: e.at });
    }
  }
  const evalStatus = q.status === "fired" || q.status === "skipped";
  if (want("workflow_run") && !evalStatus) {
    const statuses = q.status ? q.status.split(",") : undefined;
    for (const r of db.workflowRunsFeed({ ...base, statuses })) items.push(runDetail(db, r));
  }
  const activityKinds: string[] = [];
  if (!kinds.length) activityKinds.push("config_reload", "config_error", "plugin_connect", "plugin_disconnect", "reminder_fired", "item_action");
  for (const k of kinds) {
    if (k === "config") activityKinds.push("config_reload", "config_error");
    else if (k === "plugin") activityKinds.push("plugin_connect", "plugin_disconnect");
    else if (k === "reminder") activityKinds.push("reminder_fired");
    else if (k !== "evaluation" && k !== "workflow_run") activityKinds.push(k);
  }
  if (activityKinds.length && !q.status) {
    for (const a of db.activityRows({ ...base, kinds: activityKinds })) items.push({ ...a, kind: a.kind, at: a.at });
  }

  items.sort((a, b) => b.at.localeCompare(a.at));
  const page = items.slice(0, limit);
  return { items: page, next_cursor: items.length > limit || page.length === limit ? (page.at(-1)?.at ?? null) : null };
}

export function runDetailById(db: Db, id: number) {
  const run = db.getWorkflowRun(id);
  return run ? { ...runDetail(db, run), definition: run.definition } : undefined;
}

// ---------------------------------------------------------------------------
// Health

export function health({ db, config, plugins, store }: TimelineDeps, now = new Date()) {
  const cfg = config.current;
  const local = localTime(now, cfg.timezone);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  return {
    now: now.toISOString(),
    local_date: local.date,
    timezone: cfg.timezone,
    runs_today: db.runsOn(local.date),
    max_runs_per_day: cfg.max_runs_per_day,
    tokens_7d: db.tokensSince(weekAgo),
    workflows: { total: cfg.workflows.length, enabled: cfg.workflows.filter((w) => w.enabled).length },
    waiting_runs: db.waitingRuns().length,
    plugins: plugins?.status?.() ?? [],
    config_errors: store?.errors ?? [],
    devices: db.lastEventPerDevice(),
  };
}

/** Writes config reload/error rows to the activity table. */
export function recordConfigActivity(store: ConfigStore, db: Db) {
  store.on("reload", (diff) => db.addActivity("config_reload", null, diff));
  store.on("error_recorded", (e: { file: string; error: string }) => db.addActivity("config_error", e.file, { error: e.error }));
}
