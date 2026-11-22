import { describe, expect, it } from "vitest";
import type { CalEvent } from "./ical.js";
import { freeSlots, minutesOfDay, type SlotOptions } from "./slots.js";

const base: SlotOptions = {
  from: "2026-11-24",
  to: "2026-11-24",
  earliest: "17:00",
  latest: "22:00",
  minMinutes: 60,
  timeZone: "Europe/London",
};

const timed = (start: string, end: string, title = "Thing"): CalEvent => ({
  start: `2026-11-24T${start}:00+00:00`,
  end: `2026-11-24T${end}:00+00:00`,
  all_day: false,
  title,
  location: "",
  calendar: "Cal",
});

const day = (events: CalEvent[], over: Partial<SlotOptions> = {}) => freeSlots(events, { ...base, ...over })[0]!;

describe("freeSlots", () => {
  it("gives one full window for an empty day", () => {
    expect(day([])).toEqual({
      date: "2026-11-24",
      weekday: "Tuesday",
      free: [{ start: "17:00", end: "22:00", minutes: 300 }],
      busy: [],
      all_day: [],
    });
  });

  it("subtracts an event in the middle and reports it as busy", () => {
    const d = day([timed("18:30", "19:30", "Choir")]);
    expect(d.free).toEqual([
      { start: "17:00", end: "18:30", minutes: 90 },
      { start: "19:30", end: "22:00", minutes: 150 },
    ]);
    expect(d.busy).toEqual([{ start: "18:30", end: "19:30", title: "Choir" }]);
  });

  it("merges overlapping and adjacent events", () => {
    const d = day([timed("18:00", "19:00"), timed("18:30", "20:00"), timed("20:00", "20:30")], { minMinutes: 1 });
    expect(d.free).toEqual([
      { start: "17:00", end: "18:00", minutes: 60 },
      { start: "20:30", end: "22:00", minutes: 90 },
    ]);
  });

  it("clips events that straddle the window edges", () => {
    const d = day([timed("15:00", "17:30", "Early"), timed("21:30", "23:00", "Late")], { minMinutes: 1 });
    expect(d.free).toEqual([{ start: "17:30", end: "21:30", minutes: 240 }]);
    expect(d.busy).toEqual([
      { start: "17:00", end: "17:30", title: "Early" },
      { start: "21:30", end: "22:00", title: "Late" },
    ]);
  });

  it("ignores events outside the window or on other days", () => {
    const d = day([timed("09:00", "10:00"), timed("22:00", "23:00"), timed("16:00", "17:00")]);
    expect(d.free).toEqual([{ start: "17:00", end: "22:00", minutes: 300 }]);
    expect(d.busy).toEqual([]);
  });

  it("drops gaps shorter than min_minutes", () => {
    expect(day([timed("17:30", "21:30")]).free).toEqual([]);
    expect(day([timed("17:30", "21:00")]).free).toEqual([{ start: "21:00", end: "22:00", minutes: 60 }]);
    expect(day([timed("17:30", "21:00")], { minMinutes: 30 }).free).toEqual([
      { start: "17:00", end: "17:30", minutes: 30 },
      { start: "21:00", end: "22:00", minutes: 60 },
    ]);
  });

  it("does not subtract all-day events but lists them on each day they cover", () => {
    const allDay: CalEvent = { start: "2026-11-23", end: "2026-11-25", all_day: true, title: "Trip", location: "", calendar: "Cal" };
    const days = freeSlots([allDay], { ...base, from: "2026-11-22", to: "2026-11-25" });
    expect(days.map((d) => d.all_day)).toEqual([[], ["Trip"], ["Trip"], []]);
    expect(days[1]!.free).toEqual([{ start: "17:00", end: "22:00", minutes: 300 }]);
  });

  it("returns every date in the range with its weekday", () => {
    const days = freeSlots([], { ...base, from: "2026-11-27", to: "2026-11-30" });
    expect(days.map((d) => [d.date, d.weekday])).toEqual([
      ["2026-11-27", "Friday"],
      ["2026-11-28", "Saturday"],
      ["2026-11-29", "Sunday"],
      ["2026-11-30", "Monday"],
    ]);
  });

  it("supports latest 24:00", () => {
    expect(day([timed("20:00", "21:00")], { latest: "24:00" }).free).toEqual([
      { start: "17:00", end: "20:00", minutes: 180 },
      { start: "21:00", end: "24:00", minutes: 180 },
    ]);
  });

  it("handles the 25 hour day when the clocks go back", () => {
    const d = day([], { from: "2026-10-25", to: "2026-10-25", earliest: "00:00", latest: "24:00" });
    expect(d.free).toEqual([{ start: "00:00", end: "24:00", minutes: 25 * 60 }]);
  });

  it("handles the 23 hour day when the clocks go forward", () => {
    const d = day([], { from: "2027-03-28", to: "2027-03-28", earliest: "00:00", latest: "24:00" });
    expect(d.free).toEqual([{ start: "00:00", end: "24:00", minutes: 23 * 60 }]);
  });

  it("uses local evening times on a BST day", () => {
    const e: CalEvent = { ...timed("00:00", "00:00"), start: "2026-10-20T19:00:00+01:00", end: "2026-10-20T20:00:00+01:00" };
    const d = day([e], { from: "2026-10-20", to: "2026-10-20" });
    expect(d.busy).toEqual([{ start: "19:00", end: "20:00", title: "Thing" }]);
    expect(d.free.map((f) => [f.start, f.end])).toEqual([["17:00", "19:00"], ["20:00", "22:00"]]);
  });

  it("rejects an empty or overnight window and a reversed range", () => {
    expect(() => day([], { earliest: "22:00", latest: "22:00" })).toThrow(/after earliest/);
    expect(() => day([], { earliest: "22:00", latest: "02:00" })).toThrow(/after earliest/);
    expect(() => day([], { from: "2026-11-25", to: "2026-11-24" })).toThrow(/before from/);
  });
});

describe("minutesOfDay", () => {
  it("parses HH:MM including 24:00", () => {
    expect(minutesOfDay("00:00")).toBe(0);
    expect(minutesOfDay("17:30")).toBe(1050);
    expect(minutesOfDay("24:00")).toBe(1440);
  });
  it("rejects bad times", () => {
    for (const bad of ["24:01", "7:00", "12:60", "noon"]) expect(() => minutesOfDay(bad)).toThrow();
  });
});
