import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { emitTaskEvent, type EventPoster } from "./events.js";
import type { ReminderScheduler } from "./reminders.js";
import { localDate, type TaskInstance, type TodoStore } from "./store.js";
import { VERSION } from "./version.js";

export interface McpDeps {
  store: TodoStore;
  timeZone: string;
  now?: () => Date;
  /** Where task_started / task_completed events go (fire and forget). */
  events?: EventPoster;
  /** Schedules timer steps and daily reminders on Jeeves. Without it, start_task returns plain followups. */
  reminders?: ReminderScheduler;
}

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const fail = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

/**
 * Builds the MCP server the Jeeves control plane talks to. A fresh server is built per request
 * (stateless HTTP), so this must stay cheap.
 */
export function buildMcpServer({ store, timeZone, now = () => new Date(), events, reminders }: McpDeps): McpServer {
  const server = new McpServer({ name: "jeeves-todo", version: VERSION });

  /** After a task is done or skipped: drop its timer reminders and refresh the daily set. */
  const finishTimers = async (task: TaskInstance) => {
    if (!reminders) return;
    const chore = store.getChore(task.chore_id);
    if (chore) await reminders.cancelTimers(task, chore);
    await reminders.sync();
  };

  server.registerTool(
    "list_due_tasks",
    {
      description:
        "List today's chores plus unfinished ones from the last few days, easiest first. " +
        "Each task has an id, effort (1-5), estimated minutes, how-to steps, state and overdue_days.",
      inputSchema: { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
      annotations: { readOnlyHint: true },
    },
    async ({ date }) => json(store.listDue(date ?? localDate(now(), timeZone), now())),
  );

  server.registerTool(
    "get_chore",
    {
      description: "Full details for one chore, including how-to steps, timer steps and recent history.",
      inputSchema: { chore_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ chore_id }) => {
      const chore = store.getChore(chore_id);
      if (!chore) return fail(`No chore with id ${chore_id}`);
      return json({ ...chore, history: store.history(chore_id) });
    },
  );

  server.registerTool(
    "start_task",
    {
      description:
        "Mark a task as started. Returns the chore's timer steps with absolute due times as `followups`. " +
        "Followups with scheduled: true are already set up as reminders on Jeeves, so do NOT call " +
        "schedule_followup for them; only schedule the ones with scheduled: false.",
      inputSchema: { task_id: z.number().int() },
    },
    async ({ task_id }) => {
      try {
        const task = store.setState(task_id, "started", now());
        const chore = store.getChore(task.chore_id)!;
        let at = new Date(task.started_at!).getTime();
        let followups: { at: string; message: string; scheduled?: boolean }[];
        if (reminders) {
          followups = await reminders.scheduleTimer(task, chore);
        } else {
          const steps = store.settings().followup_nudges ? chore.timer_steps : [];
          followups = steps.map((s) => {
            at += s.after_minutes * 60_000;
            return { at: new Date(at).toISOString(), message: s.message };
          });
        }
        emitTaskEvent(store, events, "task_started", task);
        await reminders?.sync();
        return json({ task, followups });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "complete_task",
    { description: "Mark a task as done.", inputSchema: { task_id: z.number().int() } },
    async ({ task_id }) => {
      try {
        const task = store.setState(task_id, "done", now());
        emitTaskEvent(store, events, "task_completed", task);
        await finishTimers(task);
        return json(task);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "skip_task",
    { description: "Skip a task for today.", inputSchema: { task_id: z.number().int() } },
    async ({ task_id }) => {
      try {
        const task = store.setState(task_id, "skipped", now());
        await finishTimers(task);
        return json(task);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "snooze_task",
    {
      description:
        "Hide a task from the due list for a number of minutes (defaults to the plugin's default snooze).",
      inputSchema: {
        task_id: z.number().int(),
        minutes: z.number().int().min(1).max(24 * 60).optional(),
      },
    },
    async ({ task_id, minutes }) => {
      try {
        const task = store.snooze(task_id, minutes ?? store.settings().default_snooze_minutes, now());
        await reminders?.sync();
        return json(task);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  return server;
}
