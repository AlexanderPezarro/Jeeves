const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export interface LocalTime {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24-hour */
  time: string;
  weekday: (typeof WEEKDAYS)[number];
}

/** Wall-clock date, time and weekday for `now` in an IANA time zone. */
export function localTime(now: Date, timeZone: string): LocalTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: parts.weekday.toLowerCase().slice(0, 3) as LocalTime["weekday"],
  };
}

/**
 * The instant a wall-clock time ("YYYY-MM-DDTHH:MM") happens in an IANA time zone. A time that
 * doesn't exist (skipped by a clock change) lands an hour later; an ambiguous one takes the first.
 */
export function fromLocal(local: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error(`"${local}" is not YYYY-MM-DDTHH:MM`);
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) throw new Error(`"${local}" is not a valid time`);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (t: number) => {
    const l = localTime(new Date(t), timeZone);
    const [ly, lmo, ld] = l.date.split("-").map(Number);
    const [lh, lmi] = l.time.split(":").map(Number);
    return Date.UTC(ly, lmo - 1, ld, lh, lmi) - t;
  };
  // Try the offsets either side of the guess, earliest instant first, and keep one that round-trips.
  const guesses = [...new Set([offsetAt(wall - 864e5 / 2), offsetAt(wall), offsetAt(wall + 864e5 / 2)])].map((o) => wall - o).sort((a, b) => a - b);
  for (const t of guesses) if (t + offsetAt(t) === wall) return new Date(t);
  return new Date(Math.min(...guesses) + 3_600_000);
}
