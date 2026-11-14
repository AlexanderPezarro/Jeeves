import { Cron } from "croner";
import { Agent, scheduleFollowups } from "./agent.js";
import type { Config } from "./config.js";
import type { Db, EventRow } from "./db.js";
import type { PluginHost } from "./plugins.js";
import { evaluateRules, scheduleEventType, type RuleDecision } from "./rules.js";
import { localTime } from "./time.js";

export type TaskAction = "start" | "done" | "skip" | "snooze";

const ACTION_TOOL: Record<TaskAction, string> = {
  start: "start_task",
  done: "complete_task",
  skip: "skip_task",
  snooze: "snooze_task",
};

/**
 * The control plane: takes events in, decides which rules fire, runs their actions,
 * and drives scheduled jobs. Claude runs happen in the background so the phone's
 * request returns straight away.
 */
export class Engine {
  private timers: { stop(): void }[] = [];
  private readonly now: () => Date;
  /** Background work, tracked so tests and shutdown can wait for it. */
  readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly plugins: PluginHost,
    readonly agent: Agent,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  handleEvent(type: string, payload: Record<string, unknown>, deviceId: number | null): { event: EventRow; decisions: RuleDecision[] } {
    const now = this.now();
    const event = this.db.insertEvent(type, payload, deviceId, now);
    const decisions = evaluateRules(this.config.rules, event, this.db, this.config.timezone, now);
    const local = localTime(now, this.config.timezone);
    for (const d of decisions) {
      console.log(`Rule ${d.rule.id} on ${type}: ${d.fire ? "FIRE" : "skip"} (${d.reason})`);
      if (!d.fire) continue;
      this.db.recordFire(d.rule.id, event.id, local.date, now);
      const action = d.rule.action;
      if (action.type === "message") {
        this.background(this.agent.sendMessage(action.text, []));
      } else {
        this.background(this.agent.run({ kind: "plan", prompt: action.prompt, rule_id: d.rule.id, event_id: event.id }));
      }
    }
    return { event, decisions };
  }

  /** A free-text message from the phone. */
  handleUserMessage(text: string) {
    const msg = this.db.addMessage("in", text, null, null, this.now());
    this.background(this.agent.run({ kind: "reply", prompt: `Alexander says: ${text}` }));
    return msg;
  }

  /** A notification button or a tap in the Today list. */
  async taskAction(taskId: number, action: TaskAction, minutes = 15) {
    const args: Record<string, unknown> = { task_id: taskId };
    if (action === "snooze") args.minutes = minutes;
    const res = await this.plugins.call(this.config.todo_plugin, ACTION_TOOL[action], args);
    if (!res.isError) {
      if (action === "start") scheduleFollowups(this.db, res.text);
      if (action === "done" || action === "skip") this.db.cancelJobsForTask(taskId, this.now());
    }
    return res;
  }

  async today() {
    const res = await this.plugins.call(this.config.todo_plugin, "list_due_tasks", {});
    if (res.isError) throw new Error(res.text);
    return JSON.parse(res.text) as unknown[];
  }

  /** Sends follow-ups whose time has come. Runs every 30 seconds. */
  async runDueJobs() {
    for (const job of this.db.claimDueJobs(this.now())) {
      if (job.kind !== "followup") continue;
      const message = String(job.payload.message);
      const taskId = typeof job.payload.task_id === "number" ? job.payload.task_id : undefined;
      await this.agent.sendMessage(message, taskId ? [{ task_id: taskId, title: message, steps: [] }] : []);
    }
  }

  start() {
    const tick = setInterval(() => void this.runDueJobs().catch((e) => console.error("Job tick failed", e)), 30_000);
    this.timers.push({ stop: () => clearInterval(tick) });
    for (const rule of this.config.rules) {
      if (!rule.enabled || !rule.schedule) continue;
      const cron = new Cron(rule.schedule, { timezone: this.config.timezone }, () => {
        this.handleEvent(scheduleEventType(rule.id), {}, null);
      });
      this.timers.push(cron);
      console.log(`Rule ${rule.id} scheduled: ${rule.schedule}, next ${cron.nextRun()?.toISOString()}`);
    }
  }

  async stop() {
    for (const t of this.timers) t.stop();
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
