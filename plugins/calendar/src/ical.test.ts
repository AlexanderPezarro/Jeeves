import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandEvents, MAX_OCCURRENCES, parseFeed } from "./ical.js";
import { startOfLocalDate } from "./tz.js";

const TZ = "Europe/London";
const fixture = (name: string) => parseFeed(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8"));

/** Events overlapping the local dates from..to (to inclusive). */
function expand(name: string, from: string, to: string, timeZone = TZ) {
  const end = new Date(startOfLocalDate(to, timeZone).getTime() + 24 * 3_600_000);
  return expandEvents(fixture(name), { from: startOfLocalDate(from, timeZone), to: end, calendar: "Cal", timeZone });
}

describe("recurring events", () => {
  const events = expand("recurring.ics", "2026-11-01", "2026-12-07");
  const choir = events.filter((e) => e.title.startsWith("Choir"));

  it("expands the weekly series, honouring EXDATE, a moved occurrence and a cancelled one", () => {
    expect(choir.map((e) => [e.start, e.end, e.title])).toEqual([
      ["2026-11-02T19:00:00+00:00", "2026-11-02T20:00:00+00:00", "Choir"],
      ["2026-11-10T18:30:00+00:00", "2026-11-10T19:30:00+00:00", "Choir (moved)"],
      // 2026-11-16 is an EXDATE, 2026-11-30 is STATUS:CANCELLED
      ["2026-11-23T19:00:00+00:00", "2026-11-23T20:00:00+00:00", "Choir"],
      ["2026-12-07T19:00:00+00:00", "2026-12-07T20:00:00+00:00", "Choir"],
    ]);
  });

  it("carries location, calendar and all_day", () => {
    expect(choir[0]).toMatchObject({ location: "Church hall", calendar: "Cal", all_day: false });
  });

  it("stops COUNT-limited series after COUNT occurrences", () => {
    const lunch = events.filter((e) => e.title === "Lunch course");
    expect(lunch.map((e) => e.start)).toEqual([
      "2026-11-03T12:00:00+00:00",
      "2026-11-04T12:00:00+00:00",
      "2026-11-05T12:00:00+00:00",
    ]);
  });

  it("stops UNTIL-limited series at UNTIL", () => {
    const gym = events.filter((e) => e.title === "Gym");
    expect(gym.map((e) => e.start)).toEqual(["2026-11-04T17:00:00+00:00", "2026-11-11T17:00:00+00:00", "2026-11-18T17:00:00+00:00"]);
  });

  it('titles a SUMMARY-less event "(busy)"', () => {
    expect(events.find((e) => e.start === "2026-11-05T21:00:00+00:00")?.title).toBe("(busy)");
  });

  it("returns events sorted by start", () => {
    const starts = events.map((e) => e.start);
    expect(starts).toEqual([...starts].sort());
  });

  it("only returns the occurrences in range", () => {
    expect(expand("recurring.ics", "2026-11-09", "2026-11-10").filter((e) => e.title.startsWith("Choir")).map((e) => e.title)).toEqual([
      "Choir (moved)",
    ]);
  });
});

describe("range overlap", () => {
  it("includes an event that spans the start of the range", () => {
    const from = new Date("2026-11-02T19:30:00Z");
    const to = new Date("2026-11-02T22:00:00Z");
    const got = expandEvents(fixture("recurring.ics"), { from, to, calendar: "Cal", timeZone: TZ });
    expect(got.map((e) => e.title)).toEqual(["Choir"]);
  });

  it("treats the end of the range as exclusive and the end of an event as exclusive", () => {
    const feed = fixture("recurring.ics");
    const touchingEnd = expandEvents(feed, { from: new Date("2026-11-02T20:00:00Z"), to: new Date("2026-11-02T21:00:00Z"), calendar: "C", timeZone: TZ });
    expect(touchingEnd).toEqual([]);
    const touchingStart = expandEvents(feed, { from: new Date("2026-11-02T18:00:00Z"), to: new Date("2026-11-02T19:00:00Z"), calendar: "C", timeZone: TZ });
    expect(touchingStart).toEqual([]);
  });
});

describe("all-day events", () => {
  const events = expand("allday.ics", "2026-11-20", "2026-12-05");

  it("uses dates with an exclusive end", () => {
    expect(events.map((e) => [e.start, e.end, e.all_day, e.title])).toEqual([
      ["2026-11-24", "2026-11-25", true, "Birthday"],
      ["2026-11-26", "2026-11-29", true, "Trip"],
      ["2026-11-30", "2026-12-01", true, "No end"],
    ]);
  });

  it("includes a multi-day event from any day it covers, not the day it ends", () => {
    expect(expand("allday.ics", "2026-11-28", "2026-11-28").map((e) => e.title)).toEqual(["Trip"]);
    expect(expand("allday.ics", "2026-11-29", "2026-11-29")).toEqual([]);
    expect(expand("allday.ics", "2026-11-25", "2026-11-25")).toEqual([]);
  });
});

describe("time zones", () => {
  const events = expand("timezones.ics", "2026-11-24", "2026-11-24");
  const at = (title: string) => events.find((e) => e.title === title)!;

  it("converts America/New_York to the configured zone", () => {
    expect(at("NY call").start).toBe("2026-11-24T19:00:00+00:00");
    expect(at("NY call").end).toBe("2026-11-24T20:00:00+00:00");
  });

  it("converts UTC times", () => {
    expect(at("UTC call").start).toBe("2026-11-24T18:00:00+00:00");
  });

  it("reads floating times in the configured zone", () => {
    expect(at("Floating").start).toBe("2026-11-24T20:00:00+00:00");
    const summer = expand("timezones.ics", "2026-11-24", "2026-11-24", "America/New_York");
    expect(summer.find((e) => e.title === "Floating")!.start).toBe("2026-11-24T20:00:00-05:00");
  });

  it("maps a Windows TZID that the feed does not define", () => {
    expect(at("Windows zone").start).toBe("2026-11-24T21:00:00+00:00");
  });

  it("renders in the configured zone's offset", () => {
    const ny = expand("timezones.ics", "2026-11-24", "2026-11-24", "America/New_York");
    expect(ny.find((e) => e.title === "UTC call")!.start).toBe("2026-11-24T13:00:00-05:00");
  });
});

describe("daylight saving", () => {
  it("keeps a weekly 19:00 series at 19:00 local across both changes", () => {
    const events = expand("dst.ics", "2026-10-19", "2027-04-05");
    const byDate = Object.fromEntries(events.map((e) => [e.start.slice(0, 10), e.start.slice(10)]));
    expect(byDate["2026-10-19"]).toBe("T19:00:00+01:00");
    expect(byDate["2026-10-26"]).toBe("T19:00:00+00:00");
    expect(byDate["2027-03-22"]).toBe("T19:00:00+00:00");
    expect(byDate["2027-03-29"]).toBe("T19:00:00+01:00");
    expect(events.every((e) => e.start.slice(11, 16) === "19:00")).toBe(true);
  });
});

describe("limits and bad input", () => {
  it("caps the occurrences returned per series", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:many",
      "DTSTART:20200101T100000Z",
      "DTEND:20200101T110000Z",
      "RRULE:FREQ=HOURLY",
      "SUMMARY:Ticker",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const got = expandEvents(parseFeed(text), {
      from: new Date("2020-01-01T00:00:00Z"),
      to: new Date("2030-01-01T00:00:00Z"),
      calendar: "C",
      timeZone: TZ,
    });
    expect(got).toHaveLength(MAX_OCCURRENCES);
  });

  it("rejects a truncated feed", () => {
    expect(() => fixture("broken.ics")).toThrow(/truncated/);
  });

  it("rejects something that is not iCalendar", () => {
    expect(() => parseFeed("<html>sign in</html>")).toThrow(/not an iCalendar/);
  });

  it("reads the calendar name", () => {
    expect(fixture("recurring.ics").name).toBe("Test");
  });
});
