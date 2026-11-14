/**
 * Simple recurrence rules for chores.
 *
 *   { every: "day" }
 *   { every: "week", on: ["mon", "thu"] }
 *   { every: "month", day: 1 }
 *   { every: "days", interval: 3, start: "2026-11-01" }
 */
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type Recurrence =
  | { every: "day" }
  | { every: "week"; on: Weekday[] }
  | { every: "month"; day: number }
  | { every: "days"; interval: number; start: string };

const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Parse a YYYY-MM-DD string as a UTC date so arithmetic is timezone-free. */
export function parseDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);
  return new Date(`${date}T00:00:00Z`);
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[parseDate(date).getUTCDay()];
}

export function isDue(rule: Recurrence, date: string): boolean {
  const d = parseDate(date);
  switch (rule.every) {
    case "day":
      return true;
    case "week":
      return rule.on.includes(weekdayOf(date));
    case "month": {
      // A rule for the 31st falls on the last day of shorter months.
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      return d.getUTCDate() === Math.min(rule.day, lastDay);
    }
    case "days": {
      const diff = Math.round((d.getTime() - parseDate(rule.start).getTime()) / 86_400_000);
      return diff >= 0 && diff % rule.interval === 0;
    }
  }
}
