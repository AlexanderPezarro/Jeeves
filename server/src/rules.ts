import type { Rule } from "./config.js";
import type { Db, EventRow } from "./db.js";
import { localTime } from "./time.js";

export interface RuleDecision {
  rule: Rule;
  fire: boolean;
  /** Why the rule did or did not fire; shown in logs and the run history. */
  reason: string;
}

/** Event type the scheduler emits when a rule's cron schedule ticks. */
export const scheduleEventType = (ruleId: string) => `schedule.${ruleId}`;

/** Which event marks the start of an "away" period for a given arrival event. */
const AWAY_EVENT: Record<string, string> = {
  "wifi.connected": "wifi.disconnected",
  "location.arrived": "location.left",
};

/**
 * Decides, for every rule listening to this event type, whether it should fire.
 * Pure apart from reading event and fire history from the database.
 */
export function evaluateRules(rules: Rule[], event: EventRow, db: Db, timeZone: string, now = new Date()): RuleDecision[] {
  const local = localTime(now, timeZone);
  return rules
    .filter((r) => r.enabled && (r.event === event.type || event.type === scheduleEventType(r.id)))
    .map((rule) => {
      const reason = blockReason(rule, event, db, local, now);
      return { rule, fire: reason === null, reason: reason ?? "conditions met" };
    });
}

function blockReason(
  rule: Rule,
  event: EventRow,
  db: Db,
  local: ReturnType<typeof localTime>,
  now: Date,
): string | null {
  const w = rule.when;
  const ssid = typeof event.payload.ssid === "string" ? event.payload.ssid : undefined;

  if (w.ssid && ssid !== w.ssid) return `SSID ${ssid ?? "(none)"} is not ${w.ssid}`;
  if (w.days && !w.days.includes(local.weekday)) return `not on ${local.weekday}`;
  if (w.after && local.time < w.after) return `before ${w.after}`;
  if (w.before && local.time >= w.before) return `after ${w.before}`;

  if (w.min_away_minutes !== undefined) {
    const away = awayMinutes(event, db, ssid);
    if (away === null) return "no record of leaving, so away time is unknown";
    if (away < w.min_away_minutes) return `away ${away} min, needs ${w.min_away_minutes}`;
  }

  const last = db.lastFire(rule.id);
  if (last) {
    if (rule.cooldown === "daily" && last.local_date === local.date) return "already fired today";
    if (typeof rule.cooldown === "number") {
      const mins = (now.getTime() - Date.parse(last.fired_at)) / 60_000;
      if (mins < rule.cooldown) return `cooldown: fired ${Math.round(mins)} min ago`;
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
