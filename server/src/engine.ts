import { Cron } from "croner";
import { Agent } from "./agent.js";
import { isSchedule, type ConfigSource, type Workflow } from "./config.js";
import type { Db, EventRow, ReminderPayload } from "./db.js";
import type { PluginHost } from "./plugins.js";
import { PhoneCommands } from "./phone.js";
import { RESUME_JOB, WorkflowRunner, type RunOutcome } from "./runner.js";
import { evaluateWorkflows, scheduleEventType, type Decision } from "./triggers.js";
import { localTime } from "./time.js";

/** The event a chat message from the phone becomes. */
export const CHAT_EVENT = "message.received";

export interface DecisionView {
  workflow_id: string;
  fired: boolean;
  reason: string;
}

/** Anything that emits `reload` when the config changes (ConfigStore does). */
interface Reloadable {
  on(event: "reload", fn: (diff: unknown) => void): unknown;
  off?(event: "reload", fn: (diff: unknown) => void): unknown;
}

/**
 * The control plane: takes events in, decides which workflows fire, runs them, and drives
 * scheduled jobs. Workflow runs happen in the background so the phone's request returns at once.
 */
export class Engine {
  private tick?: NodeJS.Timeout;
  private crons: { workflow_id: string; schedule: string; cron: Cron }[] = [];
  private readonly now: () => Date;
  private readonly onReload = () => this.reload();
  readonly runner: WorkflowRunner;
  /** Phone commands the runner is waiting on; the result endpoint settles them. */
  readonly phone = new PhoneCommands();
  /** Background work, tracked so tests and shutdown can wait for it. */
  readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly config: ConfigSource,
    private readonly plugins: PluginHost,
    readonly agent: Agent,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
    this.runner = new WorkflowRunner({ db, config, plugins, agent, notifier: agent.notifier, phone: this.phone, now: this.now });
    (config as Partial<Reloadable>).on?.("reload", this.onReload);
  }

  private get workflows(): Workflow[] {
    return this.config.current.workflows;
  }

  /** Decisions for an event without side effects (no fire recorded, nothing run). */
  evaluate(event: EventRow, now = this.now()): Decision[] {
    return evaluateWorkflows(this.workflows, event, this.db, this.config.current.timezone, now);
  }

  handleEvent(type: string, payload: Record<string, unknown>, deviceId: number | null): { event: EventRow; decisions: DecisionView[] } {
    const now = this.now();
    const event = this.db.insertEvent(type, payload, deviceId, now);
    const decisions = this.evaluate(event, now);
    const local = localTime(now, this.config.current.timezone);
    for (const d of decisions) {
      console.log(`Workflow ${d.workflow_id} on ${type}: ${d.fired ? "FIRE" : "skip"} (${d.reason})`);
      const trigger = isSchedule(d.workflow.triggers[d.trigger_index]) ? "schedule" : "event";
      this.db.recordEvaluation({
        at: now.toISOString(),
        workflow_id: d.workflow_id,
        trigger_kind: trigger,
        event_id: event.id,
        fired: d.fired,
        reason: d.reason,
        simulated: false,
      });
      if (!d.fired) continue;
      this.db.recordFire(d.workflow_id, event.id, local.date, now);
      this.background(this.runner.start(d.workflow, { event, trigger }));
    }
    return { event, decisions: decisions.map((d) => ({ workflow_id: d.workflow_id, fired: d.fired, reason: d.reason })) };
  }

  /**
   * What would fire for this event at `at` (default now). Nothing is stored or run: the event is
   * built in memory and no evaluations are written, so simulating never pollutes history.
   */
  simulate(type: string, payload: Record<string, unknown>, at?: Date): DecisionView[] {
    const when = at ?? this.now();
    const event: EventRow = { id: 0, device_id: null, type, payload, received_at: when.toISOString() };
    return this.evaluate(event, when).map((d) => ({ workflow_id: d.workflow_id, fired: d.fired, reason: d.reason }));
  }

  /**
   * Runs a workflow now, bypassing triggers and cooldown. Returns the run id at once; `done`
   * resolves when the run finishes, stops or starts waiting.
   */
  runNow(workflowId: string, opts: { dryRun?: boolean; payload?: Record<string, unknown> } = {}): { workflowRunId: number; done: Promise<RunOutcome> } {
    const wf = this.workflows.find((w) => w.id === workflowId);
    if (!wf) throw Object.assign(new Error(`no workflow ${workflowId}`), { notFound: true });
    const payload = opts.payload ?? {};
    // Real runs get an event row so a later `wait` can rebuild {{event.*}} on resume.
    const event = opts.dryRun
      ? { id: 0, device_id: null, type: "manual.run", payload, received_at: this.now().toISOString() }
      : this.db.insertEvent("manual.run", { workflow_id: workflowId, ...payload }, null, this.now());
    const run = this.runner.begin(wf, { event, trigger: "manual", dryRun: opts.dryRun });
    this.background(run.done);
    return run;
  }

  /** Retention: drops history older than `activity_retention_days`. Runs daily at 03:30 local time. */
  prune(now = this.now()) {
    const days = this.config.current.activity_retention_days;
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const out = this.db.prune(cutoff);
    console.log(`Pruned history older than ${days} days`, JSON.stringify(out));
    return out;
  }

  /**
   * A free-text message from the phone: stored, then posted as a `message.received` event so a
   * workflow (by default chat-reply) answers it. If none fires, the user is told why.
   */
  handleUserMessage(text: string, deviceId: number | null = null) {
    const msg = this.db.addMessage("in", text, null, null, this.now());
    const { decisions } = this.handleEvent(CHAT_EVENT, { text, message_id: msg.id }, deviceId);
    if (!decisions.some((d) => d.fired)) {
      const why = decisions.length ? decisions.map((d) => `${d.workflow_id}: ${d.reason}`).join("; ") : "no workflow is triggered by message.received";
      this.background(this.agent.sendMessage(`Nothing answered that message (${why}). Add or enable a workflow triggered by message.received, such as chat-reply.`, []));
    }
    return msg;
  }


  /** Cancels a pending follow-up or wait. A cancelled wait cancels its workflow run. */
  cancelJob(id: number): boolean {
    const job = this.db.getJob(id);
    if (!job || !this.db.cancelJob(id, this.now())) return false;
    if (job.kind === RESUME_JOB) this.runner.cancel(Number(job.payload.workflow_run_id));
    return true;
  }

  /** Sends follow-ups and resumes waiting workflows whose time has come. Runs every 30 seconds. */
  async runDueJobs() {
    for (const job of this.db.claimDueJobs(this.now())) {
      try {
        if (job.kind === "followup") {
          const message = String(job.payload.message);
          const { plugin, item_id } = job.payload as { plugin?: unknown; item_id?: unknown };
          const about = typeof plugin === "string" && typeof item_id === "string" ? [{ plugin, item_id, title: message, steps: [] }] : [];
          await this.agent.sendMessage(message, about);
        } else if (job.kind === "reminder") {
          const p = job.payload as unknown as ReminderPayload;
          const msg = await this.agent.sendMessage(p.text, p.items ?? [], null, { level: p.level, due_at: job.run_at, job_id: job.id });
          this.db.addActivity("reminder_fired", job.plugin ?? null, { key: job.reminder_key, level: p.level, message_id: msg.id }, this.now());
        } else if (job.kind === RESUME_JOB) {
          await this.runner.resume(Number(job.payload.workflow_run_id), String(job.payload.step_path));
        }
      } catch (e) {
        console.error(`Job ${job.id} (${job.kind}) failed`, e);
      }
    }
  }

  start() {
    // Anything still "running" was cut off by a restart: mark it failed rather than run it twice.
    const interrupted = this.db.markInterruptedSteps(this.now());
    if (interrupted) console.warn(`Marked ${interrupted} interrupted step(s) as failed`);
    this.tick = setInterval(() => void this.runDueJobs().catch((e) => console.error("Job tick failed", e)), 30_000);
    this.scheduleCrons();
  }

  /** Re-creates cron timers from the current workflows. The 30 s job tick is left alone. */
  reload() {
    this.stopCrons();
    if (this.tick) this.scheduleCrons();
  }

  /** Workflow schedules with their next run, for logs, tests and the timeline. */
  scheduled(): { workflow_id: string; schedule: string; next: string | null }[] {
    return this.crons.filter((c) => c.workflow_id).map((c) => ({ workflow_id: c.workflow_id, schedule: c.schedule, next: c.cron.nextRun()?.toISOString() ?? null }));
  }

  private scheduleCrons() {
    const retention = new Cron("30 3 * * *", { timezone: this.config.current.timezone }, () => {
      try {
        this.prune();
      } catch (e) {
        console.error("Prune failed", e);
      }
    });
    this.crons.push({ workflow_id: "", schedule: "30 3 * * *", cron: retention });
    for (const wf of this.workflows) {
      if (!wf.enabled) continue;
      for (const t of wf.triggers) {
        if (!isSchedule(t)) continue;
        try {
          const cron = new Cron(t.schedule, { timezone: this.config.current.timezone }, () => {
            this.handleEvent(scheduleEventType(wf.id), {}, null);
          });
          this.crons.push({ workflow_id: wf.id, schedule: t.schedule, cron });
          console.log(`Workflow ${wf.id} scheduled: ${t.schedule}, next ${cron.nextRun()?.toISOString()}`);
        } catch (e) {
          console.error(`Workflow ${wf.id}: bad schedule "${t.schedule}": ${(e as Error).message}`);
        }
      }
    }
  }

  private stopCrons() {
    for (const c of this.crons) c.cron.stop();
    this.crons = [];
  }

  async stop() {
    if (this.tick) clearInterval(this.tick);
    this.tick = undefined;
    this.stopCrons();
    (this.config as Partial<Reloadable>).off?.("reload", this.onReload);
    await Promise.allSettled([...this.pending]);
  }

  private background(p: Promise<unknown>) {
    const tracked = p.catch((e) => console.error("Background task failed", e)).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Waits for all background runs; used by tests. */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
