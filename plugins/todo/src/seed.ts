import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { Chore, TodoStore } from "./store.js";

const weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const recurrence = z.union([
  z.object({ every: z.literal("day") }),
  z.object({ every: z.literal("week"), on: z.array(weekday).min(1) }),
  z.object({ every: z.literal("month"), day: z.number().int().min(1).max(31) }),
  z.object({
    every: z.literal("days"),
    interval: z.number().int().min(1),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
]);

export const choreSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "use lowercase letters, digits and dashes"),
  name: z.string().min(1),
  recurrence,
  effort: z.number().int().min(1).max(5).default(2),
  est_minutes: z.number().int().min(1).default(10),
  how_to: z.array(z.string()).default([]),
  completion_mode: z.enum(["reply", "timer", "sensor"]).default("reply"),
  timer_steps: z
    .array(z.object({ after_minutes: z.number().int().min(1), message: z.string().min(1) }))
    .default([]),
  goal: z.string().optional(),
  active: z.boolean().default(true),
});

const fileSchema = z.object({ chores: z.array(choreSchema) });

export function loadChores(path: string): Chore[] {
  const parsed = fileSchema.parse(parse(readFileSync(path, "utf8")));
  return parsed.chores as Chore[];
}

export interface SeedResult {
  inserted: number;
  skipped: number;
}

/**
 * Seed/import: insert the file's chores whose id the DB doesn't know yet. Once a chore is in the DB
 * the DB owns it, so edits made in the chore manager are never overwritten, and chores deleted
 * there are not brought back. Chores removed from the file are left as they are.
 */
export function seedFromFile(store: TodoStore, path: string): SeedResult {
  const result: SeedResult = { inserted: 0, skipped: 0 };
  for (const c of loadChores(path)) {
    if (store.knowsChore(c.id)) {
      result.skipped++;
    } else {
      store.upsertChore(c);
      result.inserted++;
    }
  }
  return result;
}

/** Lowercase-dash slug used as a chore id when none is given, e.g. "Wash the dishes!" -> "wash-the-dishes". */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "chore"
  );
}
