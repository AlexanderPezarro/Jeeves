import ICAL from "ical.js";
import { formatDate, isValidTimeZone, localToUtc, toLocalIso, zonedParts } from "./tz.js";

export interface CalEvent {
  /** `YYYY-MM-DD` for all-day events, else an ISO time with the configured zone's offset. */
  start: string;
  /** All-day: exclusive end date (RFC 5545), so a one-day event ends the next day. */
  end: string;
  all_day: boolean;
  title: string;
  location: string;
  calendar: string;
}

export interface ParsedFeed {
  /** The calendar's own name (X-WR-CALNAME), if it has one. */
  name: string | undefined;
  /** Parsed once per fetch and expanded per call. */
  component: ICAL.Component;
}

/** Hard cap on occurrences returned per recurring master. */
export const MAX_OCCURRENCES = 2000;
/** Runaway guard on iterations per master (occurrences before the range are walked, not returned). */
const MAX_ITERATIONS = 100_000;
/** Exceptions can move an occurrence later than its original slot; keep iterating this long past `to`. */
const LOOKAHEAD_MS = 14 * 86_400_000;

/** Windows time zone names that show up in Outlook-style feeds, mapped to IANA. */
const WINDOWS_ZONES: Record<string, string> = {
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "Russian Standard Time": "Europe/Moscow",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "New Zealand Standard Time": "Pacific/Auckland",
};

/** Parses an ICS body. Throws on an unparsable or truncated feed. */
export function parseFeed(text: string): ParsedFeed {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("not an iCalendar feed");
  if (!/END:VCALENDAR\s*$/i.test(text.trim())) throw new Error("feed is truncated (no END:VCALENDAR)");
  let component: ICAL.Component;
  try {
    component = new ICAL.Component(ICAL.parse(text));
  } catch (e) {
    throw new Error(`could not parse feed: ${(e as Error).message}`);
  }
  if (component.name !== "vcalendar") throw new Error("not an iCalendar feed");
  const name = component.getFirstPropertyValue("x-wr-calname");
  return { name: typeof name === "string" && name.trim() ? name.trim() : undefined, component };
}

export interface ExpandOptions {
  /** Range start (inclusive) and end (exclusive) as instants. */
  from: Date;
  to: Date;
  calendar: string;
  /** Configured zone: floating times and unknown TZIDs are read in it, output is rendered in it. */
  timeZone: string;
}

interface Item {
  event: ICAL.Event;
  /** Fallback IANA zone for times the feed's VTIMEZONEs can't resolve. */
  zone: string;
}

/** Zone to use when a time has a TZID the feed doesn't define: IANA name, mapped Windows name, else configured. */
function fallbackZone(comp: ICAL.Component, configured: string): string {
  const prop = comp.getFirstProperty("dtstart");
  const tzid = prop?.getParameter("tzid");
  if (typeof tzid === "string") {
    const clean = tzid.replace(/^\//, "");
    if (isValidTimeZone(clean)) return clean;
    const mapped = WINDOWS_ZONES[clean];
    if (mapped) return mapped;
  }
  return configured;
}

/** An ICAL.Time as an instant. Floating times (and TZIDs nobody defined) are read in `zone`. */
function instant(t: ICAL.Time, zone: string): Date {
  const z = t.zone;
  if (z === ICAL.Timezone.utcTimezone) return new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second));
  if (!z || z === ICAL.Timezone.localTimezone || z.tzid === "floating") {
    return localToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, zone);
  }
  return t.toJSDate();
}

const dateOf = (t: ICAL.Time) => formatDate(t.year, t.month, t.day);

function registerTimezones(comp: ICAL.Component) {
  for (const vtz of comp.getAllSubcomponents("vtimezone")) {
    try {
      ICAL.TimezoneService.register(vtz);
    } catch {
      // A broken VTIMEZONE only affects events that use it; they fall back to IANA/configured zone.
    }
  }
}

/** Expands a parsed feed into concrete events overlapping [from, to), sorted by start. */
export function expandEvents(feed: ParsedFeed, { from, to, calendar, timeZone }: ExpandOptions): CalEvent[] {
  registerTimezones(feed.component);

  const vevents = feed.component.getAllSubcomponents("vevent");
  const masters = new Map<string, Item[]>();
  const exceptions: ICAL.Component[] = [];
  const standalone: ICAL.Component[] = [];
  for (const v of vevents) {
    if (v.hasProperty("recurrence-id")) exceptions.push(v);
    else standalone.push(v);
  }

  const items: Item[] = [];
  for (const v of standalone) {
    let event: ICAL.Event;
    try {
      event = new ICAL.Event(v);
    } catch {
      continue;
    }
    const item = { event, zone: fallbackZone(v, timeZone) };
    items.push(item);
    const list = masters.get(event.uid) ?? [];
    list.push(item);
    masters.set(event.uid, list);
  }

  // Attach RECURRENCE-ID overrides to their master. An override with no master in this feed (a single
  // instance of someone else's series) is just an event.
  for (const v of exceptions) {
    let event: ICAL.Event;
    try {
      event = new ICAL.Event(v);
    } catch {
      continue;
    }
    const master = masters.get(event.uid)?.find((m) => m.event.isRecurring());
    if (master) master.event.relateException(event);
    else items.push({ event, zone: fallbackZone(v, timeZone) });
  }

  const out: (CalEvent & { key: number })[] = [];
  const fromDate = zoneDate(from, timeZone);
  const lastDate = zoneDate(new Date(to.getTime() - 1), timeZone);

  for (const item of items) {
    try {
      collect(item, from, to, fromDate, lastDate, calendar, timeZone, out);
    } catch {
      // One malformed event must not hide the rest of the calendar.
    }
  }

  out.sort((a, b) => a.key - b.key || a.title.localeCompare(b.title));
  return out.map(({ key: _key, ...e }) => e);
}

const zoneDate = (d: Date, timeZone: string) => {
  const p = zonedParts(d, timeZone);
  return formatDate(p.year, p.month, p.day);
};

function collect(
  { event, zone }: Item,
  from: Date,
  to: Date,
  fromDate: string,
  lastDate: string,
  calendar: string,
  timeZone: string,
  out: (CalEvent & { key: number })[],
) {
  if (statusOf(event.component) === "CANCELLED") return;

  const emit = (e: ICAL.Event, startT: ICAL.Time, endT: ICAL.Time) => {
    if (statusOf(e.component) === "CANCELLED") return false;
    const title = (e.summary ?? "").trim() || "(busy)";
    const location = (e.location ?? "").trim();
    if (startT.isDate) {
      const start = dateOf(startT);
      let end = dateOf(endT);
      if (end <= start) end = dateOf(addOneDay(startT));
      // Overlap on dates: ends after the first day and starts by the last day of the range.
      if (!(end > fromDate && start <= lastDate)) return false;
      out.push({ start, end, all_day: true, title, location, calendar, key: localToUtc(startT.year, startT.month, startT.day, 0, 0, 0, timeZone).getTime() });
      return true;
    }
    const z = fallbackZone(e.component, zone);
    const s = instant(startT, z);
    let en = instant(endT, z);
    if (en < s) en = s;
    // Zero-length events count if they fall inside the range.
    const overlaps = en.getTime() > s.getTime() ? s < to && en > from : s >= from && s < to;
    if (!overlaps) return false;
    out.push({
      start: toLocalIso(s, timeZone),
      end: toLocalIso(en, timeZone),
      all_day: false,
      title,
      location,
      calendar,
      key: s.getTime(),
    });
    return true;
  };

  if (!event.isRecurring()) {
    emit(event, event.startDate, event.endDate);
    return;
  }

  const it = event.iterator();
  let emitted = 0;
  for (let i = 0; i < MAX_ITERATIONS && emitted < MAX_OCCURRENCES; i++) {
    const next = it.next();
    if (!next) break;
    // Stop once the original slot is well past the range (exceptions can only move it a little).
    if (!next.isDate && instant(next, zone).getTime() >= to.getTime() + LOOKAHEAD_MS) break;
    if (next.isDate && dateOf(next) > lastDate && Date.parse(`${dateOf(next)}T00:00:00Z`) >= to.getTime() + LOOKAHEAD_MS) break;
    const d = event.getOccurrenceDetails(next);
    if (emit(d.item, d.startDate, d.endDate)) emitted++;
  }
}

function addOneDay(t: ICAL.Time): ICAL.Time {
  const c = t.clone();
  c.day += 1;
  return c.isDate ? ICAL.Time.fromData({ year: c.year, month: c.month, day: c.day, isDate: true }) : c;
}

function statusOf(comp: ICAL.Component): string {
  const s = comp.getFirstPropertyValue("status");
  return typeof s === "string" ? s.toUpperCase() : "";
}
