import type { CalEvent } from "./ical.js";
import { addDays, daysBetween, localToUtc, parseDate, weekdayName, zonedParts } from "./tz.js";

export interface SlotOptions {
  /** First and last local date, YYYY-MM-DD, both inclusive. */
  from: string;
  to: string;
  /** Window within each day, HH:MM. `latest` may be "24:00". */
  earliest: string;
  latest: string;
  /** Gaps shorter than this are dropped. */
  minMinutes: number;
  timeZone: string;
}

export interface DaySlots {
  date: string;
  weekday: string;
  free: { start: string; end: string; minutes: number }[];
  busy: { start: string; end: string; title: string }[];
  all_day: string[];
}

const TIME = /^(\d{2}):(\d{2})$/;

/** "HH:MM" to minutes since midnight; 24:00 is allowed (end of day). */
export function minutesOfDay(s: string): number {
  const m = TIME.exec(s);
  if (!m) throw new Error(`invalid time "${s}", use HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) throw new Error(`invalid time "${s}", use HH:MM (00:00 to 24:00)`);
  return h * 60 + min;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local HH:MM of an instant, with midnight at the end of `date` written as 24:00. */
function clock(ms: number, date: string, timeZone: string): string {
  const p = zonedParts(new Date(ms), timeZone);
  const d = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  if (d !== date && daysBetween(date, d) > 0) return "24:00";
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Free gaps inside [earliest, latest) on each local date, after removing timed events. All-day events
 * are not subtracted (Google all-day entries are often birthdays or reminders); they are listed so the
 * caller can judge. DST days are 23 or 25 hours long because the window is built from local wall times.
 */
export function freeSlots(events: CalEvent[], opts: SlotOptions): DaySlots[] {
  const { from, to, minMinutes, timeZone } = opts;
  const earliest = minutesOfDay(opts.earliest);
  const latest = minutesOfDay(opts.latest);
  if (latest <= earliest) throw new Error("latest must be after earliest (overnight windows are not supported)");
  if (daysBetween(from, to) < 0) throw new Error("to must not be before from");

  const timed = events
    .filter((e) => !e.all_day)
    .map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end), title: e.title }))
    .filter((e) => Number.isFinite(e.start) && Number.isFinite(e.end))
    .sort((a, b) => a.start - b.start);
  const allDay = events.filter((e) => e.all_day);

  const days: DaySlots[] = [];
  for (let date = from; daysBetween(date, to) >= 0; date = addDays(date, 1)) {
    const { year, month, day } = parseDate(date);
    const winStart = localToUtc(year, month, day, 0, earliest, 0, timeZone).getTime();
    const winEnd = localToUtc(year, month, day, 0, latest, 0, timeZone).getTime();

    const inWindow = timed.filter((e) => (e.end > e.start ? e.start < winEnd && e.end > winStart : e.start >= winStart && e.start < winEnd));

    // Merge overlapping or touching busy intervals, clipped to the window.
    const merged: { start: number; end: number }[] = [];
    for (const e of inWindow) {
      const s = Math.max(e.start, winStart);
      const en = Math.min(Math.max(e.end, e.start), winEnd);
      const last = merged[merged.length - 1];
      if (last && s <= last.end) last.end = Math.max(last.end, en);
      else merged.push({ start: s, end: en });
    }

    const free: DaySlots["free"] = [];
    let cursor = winStart;
    const addGap = (a: number, b: number) => {
      const minutes = Math.round((b - a) / 60_000);
      if (minutes >= minMinutes && minutes > 0) free.push({ start: clock(a, date, timeZone), end: clock(b, date, timeZone), minutes });
    };
    for (const m of merged) {
      if (m.start > cursor) addGap(cursor, m.start);
      cursor = Math.max(cursor, m.end);
    }
    if (cursor < winEnd) addGap(cursor, winEnd);

    days.push({
      date,
      weekday: weekdayName(date),
      free,
      busy: inWindow.map((e) => ({
        start: clock(Math.max(e.start, winStart), date, timeZone),
        end: clock(Math.min(Math.max(e.end, e.start), winEnd), date, timeZone),
        title: e.title,
      })),
      all_day: allDay.filter((e) => e.start <= date && e.end > date).map((e) => e.title),
    });
  }
  return days;
}
