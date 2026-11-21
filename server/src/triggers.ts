import { describeCondition, evalCondition } from "./conditions.js";
import { isSchedule, ssidList, type Trigger, type Workflow } from "./config.js";
import type { Db, EventRow } from "./db.js";
import type { TemplateContext } from "./template.js";
import { localTime, type LocalTime } from "./time.js";

export interface Decision {
  workflow: Workflow;
  workflow_id: string;
  /** Index of the trigger that matched (the first one that passed, else the first that matched the type). */
  trigger_index: number;
  fired: boolean;
  /** Why the workflow did or did not fire; shown in logs, the activity feed and simulate. */
  reason: string;
}

/** Event type the scheduler emits when a workflow's cron schedule ticks. */
export const scheduleEventType = (workflowId: string) => `schedule.${workflowId}`;

/** Which event marks the start of an "away" period for a given arrival event. */
const AWAY_EVENT: Record<string, string> = {
  "wifi.connected": "wifi.disconnected",
  "location.arrived": "location.left",
};

/** The `event.*` template context: the payload's fields plus type, id and time. */
export function eventContext(event: Pick<EventRow, "type" | "payload" | "received_at"> & { id?: number | null }): Record<string, unknown> {
  return { ...event.payload, payload: event.payload, type: event.type, id: event.id ?? null, received_at: event.received_at };
}

export function triggerMatches(workflow: Workflow, trigger: Trigger, eventType: string): boolean {
  return isSchedule(trigger) ? eventType === scheduleEventType(workflow.id) : trigger.event === eventType;
}

/**
 * Decides, for every enabled workflow with a trigger on this event type, whether it fires.
 * A workflow fires if any of its matching triggers passes. Pure apart from reading history.
 */
export function evaluateWorkflows(workflows: Workflow[], event: EventRow, db: Db, timeZone: string, now = new Date()): Decision[] {
  const local = localTime(now, timeZone);
  const out: Decision[] = [];
  for (const wf of workflows) {
    if (!wf.enabled) continue;
    let first: Decision | undefined;
    for (const [i, trigger] of wf.triggers.entries()) {
      if (!triggerMatches(wf, trigger, event.type)) continue;
      const reason = blockReason(wf, trigger, event, db, local, now);
      const d = { workflow: wf, workflow_id: wf.id, trigger_index: i, fired: reason === null, reason: reason ?? "conditions met" };
      if (d.fired) {
        first = d;
        break;
      }
      first ??= d;
    }
    if (first) out.push(first);
  }
  return out;
}

/**
 * Why `trigger` of `workflow` would not fire for `event` at `now`, or null if it would.
 * Also used by the timeline to pre-check future cron slots with a synthetic event.
 */
export function blockReason(workflow: Workflow, trigger: Trigger, event: EventRow, db: Db, local: LocalTime, now: Date): string | null {
  if (!workflow.enabled) return "disabled";
  const w = trigger.when ?? {};
  const ssid = typeof event.payload.ssid === "string" ? event.payload.ssid : undefined;

  const wanted = ssidList(w.ssid);
  if (wanted.length && (ssid === undefined || !wanted.includes(ssid))) {
    return `SSID ${ssid ?? "(none)"} is not ${wanted.length === 1 ? wanted[0] : `one of ${wanted.join(", ")}`}`;
  }
  if (w.days && !w.days.includes(local.weekday)) return `not on ${local.weekday}`;
  if (w.after && local.time < w.after) return `before ${w.after}`;
  if (w.before && local.time >= w.before) return `after ${w.before}`;

  if (w.min_away_minutes !== undefined) {
    const away = awayMinutes(event, db, ssid);
    if (away === null) return "no record of leaving, so away time is unknown";
    if (away < w.min_away_minutes) return `away ${away} min, needs ${w.min_away_minutes}`;
  }

  if (w.conditions?.length) {
    const ctx: TemplateContext = { event: eventContext(event), steps: {} };
    for (const c of w.conditions) if (!evalCondition(c, ctx)) return `condition not met: ${describeCondition(c)}`;
  }

  const last = db.lastFire(workflow.id);
  if (last) {
    if (workflow.cooldown === "daily" && last.local_date === local.date) return "already fired today";
    if (typeof workflow.cooldown === "number") {
      const mins = (now.getTime() - Date.parse(last.fired_at)) / 60_000;
      if (mins < workflow.cooldown) return `cooldown: fired ${Math.round(mins)} min ago`;
    }
  }
  return null;
}

/**
 * Minutes since the matching "left" event. The phone can also report `away_minutes`
 * itself, which is used when the server missed the disconnect (e.g. no signal).
 */
function awayMinutes(event: EventRow, db: Db, ssid: string | undefined): number | null {
  const leftType = AWAY_EVENT[event.type];
  const left = leftType ? db.lastEvent(leftType, event.received_at, ssid) : undefined;
  if (left) return Math.floor((Date.parse(event.received_at) - Date.parse(left.received_at)) / 60_000);
  const reported = event.payload.away_minutes;
  return typeof reported === "number" ? reported : null;
}
