/** Time zone maths on top of Intl, so DST days and arbitrary IANA zones work without a date library. */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock fields of an instant in a zone. */
export function zonedParts(date: Date, timeZone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour!, minute: out.minute!, second: out.second! };
}

const wallMs = (p: LocalParts) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);

/** Offset of the zone from UTC at an instant, in minutes (BST is +60). */
export function offsetMinutes(date: Date, timeZone: string): number {
  const whole = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((wallMs(zonedParts(date, timeZone)) - whole) / 60_000);
}

/**
 * The instant at which a zone's wall clock reads the given fields. Hour may be 24 (start of the next
 * day) and fields may overflow like Date.UTC. A time skipped by a spring-forward gap resolves to just
 * after the gap; an ambiguous time (autumn) resolves to the first occurrence.
 */
export function localToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  // The offset can differ either side of a transition, so try both and keep one that round-trips.
  const off1 = offsetMinutes(new Date(wall - 24 * 3_600_000), timeZone);
  const off2 = offsetMinutes(new Date(wall + 24 * 3_600_000), timeZone);
  const candidates = [...new Set([off1, off2])].map((o) => wall - o * 60_000).sort((a, b) => a - b);
  for (const c of candidates) {
    if (wallMs(zonedParts(new Date(c), timeZone)) === wall) return new Date(c);
  }
  // In a gap: no candidate round-trips. The earlier (smaller) offset pushes the time forward past the gap.
  return new Date(wall - Math.min(off1, off2) * 60_000);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** `2026-11-24T19:00:00+00:00`: local wall time plus the zone's offset at that instant. */
export function toLocalIso(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${formatOffset(offsetMinutes(date, timeZone))}`;
}

export function parseDate(s: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`invalid date "${s}", use YYYY-MM-DD`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`invalid date "${s}"`);
  }
  return { year, month, day };
}

export function formatDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Calendar-day arithmetic on YYYY-MM-DD strings. */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function daysBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** Today's date in the zone. */
export function todayIn(now: Date, timeZone: string): string {
  const p = zonedParts(now, timeZone);
  return formatDate(p.year, p.month, p.day);
}

/** Start of a local date as an instant. */
export function startOfLocalDate(date: string, timeZone: string): Date {
  const { year, month, day } = parseDate(date);
  return localToUtc(year, month, day, 0, 0, 0, timeZone);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function weekdayName(date: string): string {
  const { year, month, day } = parseDate(date);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
}
