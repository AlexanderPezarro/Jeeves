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

/** Upsert every chore in the file; chores removed from the file are left as they are. */
export function seedFromFile(store: TodoStore, path: string): number {
  const chores = loadChores(path);
  for (const c of chores) store.upsertChore(c);
  return chores.length;
}
