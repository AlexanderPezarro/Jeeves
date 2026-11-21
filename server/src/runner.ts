import { Cron } from "croner";
import type { Agent } from "./agent.js";
import { evalCondExpr } from "./conditions.js";
import { stepType, type ConfigSource, type Step, type Workflow } from "./config.js";
import type { Db, EventRow, PlanItem, RunTrigger, WorkflowRunStatus } from "./db.js";
import type { Notifier } from "./notify.js";
import type { PhoneCommands } from "./phone.js";
import type { PluginHost } from "./plugins.js";
import { renderDeep, render, type TemplateContext } from "./template.js";
import { eventContext } from "./triggers.js";
import { localTime } from "./time.js";

export interface RunnerDeps {
  db: Db;
  config: ConfigSource;
  plugins: PluginHost;
  agent: Agent;
  notifier: Notifier;
  phone: PhoneCommands;
  now?: () => Date;
}

export interface StartContext {
  event: EventRow | null;
  trigger: RunTrigger;
  dryRun?: boolean;
}

export interface RunOutcome {
  workflowRunId: number;
  status: WorkflowRunStatus;
  error?: string;
}

/** Job kind for resuming a run after a `wait` step. */
export const RESUME_JOB = "workflow_resume";

// Paths -----------------------------------------------------------------------
// A step's path is its position: "0", "1", "2.then.0", "2.else.1.then.3".

type Seg = number | "then" | "else";

function parsePath(path: string): Seg[] {
  return path.split(".").map((s) => (s === "then" || s === "else" ? s : Number(s)));
}

function listAt(steps: Step[], segs: Seg[]): Step[] {
  let list = steps;
  for (let i = 0; i < segs.length; i += 2) {
    const step = list[segs[i] as number] as Step & { then?: Step[]; else?: Step[] };
    list = (step?.[segs[i + 1] as "then" | "else"] ?? []) as Step[];
  }
  return list;
}

export function stepAt(steps: Step[], path: string): Step | undefined {
  const segs = parsePath(path);
  return listAt(steps, segs.slice(0, -1))[segs.at(-1) as number];
}

/** The path of the step that runs after `path` (ignoring branches inside it), or null at the end. */
export function nextPath(steps: Step[], path: string): string | null {
  let segs = parsePath(path);
  for (;;) {
    const idx = segs.at(-1) as number;
    const parent = segs.slice(0, -1);
    if (idx + 1 < listAt(steps, parent).length) return [...parent, idx + 1].join(".");
    if (parent.length === 0) return null;
    segs = parent.slice(0, -1); // climb out of the branch to the `if` step itself
  }
}

/** Next local occurrence of HH:MM in `timeZone`, today if still ahead, else tomorrow. */
export function nextLocalTime(hhmm: string, timeZone: string, now: Date): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const next = new Cron(`${m} ${h} * * *`, { timezone: timeZone }).nextRun(now);
  if (!next) throw new Error(`Cannot compute next ${hhmm}`);
  return next;
}

type StepResult = { next?: string | null } | { halt: WorkflowRunStatus; error?: string };

class StepFailure extends Error {}

/**
 * Executes workflow steps in order and records every step in step_runs. Waits become jobs, so a
 * run survives restarts: `resume()` rebuilds the template context from the event row and the
 * stored step outputs, then carries on after the wait.
 */
export class WorkflowRunner {
  private readonly now: () => Date;

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  start(workflow: Workflow, ctx: StartContext): Promise<RunOutcome> {
    return this.begin(workflow, ctx).done;
  }

  /** Inserts the run row synchronously (so callers get its id) and executes in the background. */
  begin(workflow: Workflow, ctx: StartContext): { workflowRunId: number; done: Promise<RunOutcome> } {
    const { db } = this.deps;
    const local = localTime(this.now(), this.deps.config.current.timezone);
    const eventId = ctx.event && ctx.event.id > 0 ? ctx.event.id : null;
    const id = db.startWorkflowRun(
      {
        workflow_id: workflow.id,
        trigger: ctx.trigger,
        event_id: eventId,
        dry_run: !!ctx.dryRun,
        definition: workflow,
        local_date: local.date,
      },
      this.now(),
    );
    const tctx: TemplateContext = { event: ctx.event ? eventContext(ctx.event) : {}, steps: {} };
    return { workflowRunId: id, done: this.execute(id, workflow, tctx, "0", !!ctx.dryRun, eventId) };
  }

  /** Continues a waiting run after the step at `stepPath`. Does nothing if the run is no longer waiting. */
  async resume(workflowRunId: number, stepPath: string): Promise<RunOutcome | null> {
    const { db } = this.deps;
    const run = db.getWorkflowRun(workflowRunId);
    if (!run || run.status !== "waiting") return null;
    const workflow = run.definition as Workflow;
    const waiting = db.waitingStep(workflowRunId);
    if (waiting) db.finishStep(waiting.id, { status: "ok" }, this.now());
    db.finishWorkflowRun(workflowRunId, "running", null, this.now());
    const event = run.event_id !== null ? db.getEvent(run.event_id) : undefined;
    const tctx: TemplateContext = { event: event ? eventContext(event) : {}, steps: db.stepOutputs(workflowRunId) };
    const next = nextPath(workflow.steps, stepPath);
    if (next === null) {
      db.finishWorkflowRun(workflowRunId, "ok", null, this.now());
      return { workflowRunId, status: "ok" };
    }
    return this.execute(workflowRunId, workflow, tctx, next, run.dry_run, run.event_id);
  }

  /** Cancels a waiting run (its resume job is cancelled by the caller). */
  cancel(workflowRunId: number): boolean {
    const { db } = this.deps;
    const run = db.getWorkflowRun(workflowRunId);
    if (!run || run.status !== "waiting") return false;
    const waiting = db.waitingStep(workflowRunId);
    if (waiting) db.finishStep(waiting.id, { status: "cancelled", error: "cancelled" }, this.now());
    db.finishWorkflowRun(workflowRunId, "cancelled", "cancelled", this.now());
    return true;
  }

  private async execute(
    runId: number,
    workflow: Workflow,
    tctx: TemplateContext,
    from: string,
    dryRun: boolean,
    eventId: number | null,
  ): Promise<RunOutcome> {
    const { db } = this.deps;
    let path: string | null = from;
    while (path !== null) {
      const step = stepAt(workflow.steps, path);
      if (!step) break;
      const type = stepType(step);
      const stepRunId = db.startStep({ workflow_run_id: runId, step_id: step.id, path, type }, this.now());
      const warnings: string[] = [];
      let result: StepResult;
      try {
        result = await this.runStep(step, path, { runId, stepRunId, workflow, tctx, dryRun, eventId, warnings });
      } catch (e) {
        const error = (e as Error).message;
        db.finishStep(stepRunId, { status: "failed", error, warnings }, this.now());
        db.finishWorkflowRun(runId, "failed", `${step.id}: ${error}`, this.now());
        console.warn(`Workflow ${workflow.id} run ${runId} failed at ${step.id}: ${error}`);
        if (workflow.notify_on_failure && !dryRun) {
          await this.deps.agent.sendMessage(`Workflow ${workflow.id} failed at ${step.id}: ${error}`, []).catch(() => {});
        }
        return { workflowRunId: runId, status: "failed", error };
      }
      if ("halt" in result) {
        db.finishWorkflowRun(runId, result.halt, result.error ?? null, this.now());
        return { workflowRunId: runId, status: result.halt, ...(result.error ? { error: result.error } : {}) };
      }
      path = result.next !== undefined ? result.next : nextPath(workflow.steps, path);
    }
    db.finishWorkflowRun(runId, "ok", null, this.now());
    return { workflowRunId: runId, status: "ok" };
  }

  private async runStep(
    step: Step,
    path: string,
    s: { runId: number; stepRunId: number; workflow: Workflow; tctx: TemplateContext; dryRun: boolean; eventId: number | null; warnings: string[] },
  ): Promise<StepResult> {
    const { db, agent, plugins } = this.deps;
    const done = (output: unknown, extra: { status?: "ok" | "skipped"; run_id?: number | null; input?: unknown; error?: string } = {}) => {
      db.finishStep(s.stepRunId, { status: extra.status ?? "ok", output, warnings: s.warnings, input: extra.input, run_id: extra.run_id, error: extra.error }, this.now());
      s.tctx.steps[step.id] = output;
    };

    if ("call" in step) {
      const args = renderDeep(step.call.args ?? {}, s.tctx, s.warnings);
      const input = { plugin: step.call.plugin, tool: step.call.tool, args };
      if (s.dryRun) {
        const tool = (await plugins.listTools()).find((t) => t.plugin === step.call.plugin && t.tool === step.call.tool);
        if (!tool?.read_only) {
          done({ skipped: "not read-only" }, { status: "skipped", input, error: "not read-only" });
          return {};
        }
      }
      const res = await plugins.call(step.call.plugin, step.call.tool, args);
      if (res.isError) {
        db.finishStep(s.stepRunId, { status: "failed", input, output: { text: res.text } }, this.now());
        throw new StepFailure(res.text);
      }
      let output: unknown;
      try {
        output = JSON.parse(res.text);
      } catch {
        output = { text: res.text };
      }
      done(output, { input });
      return {};
    }

    if ("claude" in step) {
      const prompt = render(step.claude.prompt, s.tctx, s.warnings);
      const { tools, model, effort, history } = step.claude;
      const input = { prompt, ...(tools ? { tools } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(history ? { history } : {}) };
      db.finishStep(s.stepRunId, { status: "running", input }, this.now());
      const r = await agent.run({
        kind: "plan",
        prompt,
        rule_id: s.workflow.id,
        event_id: s.eventId ?? undefined,
        workflow_run_id: s.runId,
        tools,
        model,
        effort,
        history,
        dryRun: s.dryRun,
      });
      const output = { status: r.status, run_id: r.runId, messages_sent: r.messagesSent, ...(r.recorded ? { recorded: r.recorded } : {}) };
      if (r.status === "capped") {
        db.finishStep(s.stepRunId, { status: "capped", output, warnings: s.warnings, error: "daily Claude run cap reached" }, this.now());
        return { halt: "capped", error: `${step.id}: daily Claude run cap reached` };
      }
      if (r.status !== "ok") {
        db.finishStep(s.stepRunId, { status: "failed", output, run_id: r.runId }, this.now());
        throw new StepFailure(r.status === "refused" ? "Claude refused" : `Claude run failed${r.error ? `: ${r.error}` : ""}`);
      }
      done(output, { run_id: r.runId });
      return {};
    }

    if ("message" in step) {
      const text = render(step.message.text, s.tctx, s.warnings);
      const items: PlanItem[] = (renderDeep(step.message.items ?? [], s.tctx, s.warnings) as (Omit<PlanItem, "item_id"> & { item_id?: unknown })[]).map((i) => ({
        ...i,
        ...(i.item_id === undefined || i.item_id === null ? { item_id: undefined } : { item_id: String(i.item_id) }),
        steps: i.steps ?? [],
      }));
      const input = { text, ...(items.length ? { items } : {}) };
      if (s.dryRun) {
        done({ dry_run: true, text, items }, { input });
        return {};
      }
      const msg = await agent.sendMessage(text, items);
      done({ message_id: msg.id, text }, { input });
      return {};
    }

    if ("wait" in step) {
      const now = this.now();
      const resumeAt =
        "minutes" in step.wait ? new Date(now.getTime() + step.wait.minutes * 60_000) : nextLocalTime(step.wait.until, this.deps.config.current.timezone, now);
      if (s.dryRun) {
        done({ resume_at: resumeAt.toISOString(), dry_run: true }, { status: "skipped", input: step.wait });
        return {};
      }
      const jobId = db.addJob(resumeAt, RESUME_JOB, { workflow_run_id: s.runId, step_path: path });
      const output = { resume_at: resumeAt.toISOString(), job_id: jobId };
      db.finishStep(s.stepRunId, { status: "waiting", output, input: step.wait }, now);
      s.tctx.steps[step.id] = output;
      return { halt: "waiting" };
    }

    if ("if" in step) {
      const result = evalCondExpr(step.if, s.tctx);
      const branch = result ? "then" : "else";
      done({ result, branch });
      const list = (result ? step.then : step.else) ?? [];
      return { next: list.length ? `${path}.${branch}.0` : nextPath(s.workflow.steps, path) };
    }

    if ("stop" in step) {
      const reason = step.stop?.reason ? render(step.stop.reason, s.tctx, s.warnings) : undefined;
      done({ reason: reason ?? null });
      return { halt: "stopped", ...(reason ? { error: reason } : {}) };
    }

    if ("phone" in step) {
      const input = step.phone;
      if (s.dryRun) {
        done({ dry_run: true, would_send: { phone: step.phone } }, { status: "skipped", input });
        return {};
      }
      const { notifier, phone } = this.deps;
      db.finishStep(s.stepRunId, { status: "running", input }, this.now());
      const row = db.addPhoneCommand({ workflow_run_id: s.runId, step_run_id: s.stepRunId, payload: step.phone }, this.now(), phone.timeoutMs);
      // Register the waiter before sending so a very fast reply cannot beat it.
      const waiting = phone.wait(row.id);
      let sent: number;
      try {
        sent = await notifier.command(row);
      } catch (e) {
        phone.cancel(row.id);
        db.settlePhoneCommand(row.id, "failed", { ok: false, error: (e as Error).message });
        throw new StepFailure(`could not push to the phone: ${(e as Error).message}`);
      }
      if (sent === 0) {
        phone.cancel(row.id);
        db.settlePhoneCommand(row.id, "failed", { ok: false, error: "no push" });
        throw new StepFailure("no paired device has push set up (UnifiedPush): open Jeeves → Settings → Push");
      }
      const res = await waiting;
      if (res === "timeout") {
        db.settlePhoneCommand(row.id, "expired", { ok: false, error: "timeout" });
        throw new StepFailure(`the phone didn't answer within ${Math.round(phone.timeoutMs / 1000)}s`);
      }
      if (!res.ok) throw new StepFailure(res.error ?? "the phone reported a failure");
      done({ ok: true }, { input });
      return {};
    }

    throw new StepFailure(`unknown step type`);
  }
}
