import { emitTaskEvent, type EventPoster } from "./events.js";
import type { ReminderScheduler } from "./reminders.js";
import { localDate, type DueTask, type TaskInstance, type TodoStore } from "./store.js";

export interface ActionDeps {
  store: TodoStore;
  timeZone: string;
  now?: () => Date;
  /** Where task_started / task_completed events go (fire and forget). */
  events?: EventPoster;
  /** Keeps the daily reminders on Jeeves in step with task changes. */
  reminders?: ReminderScheduler;
}

/**
 * What can be done to a task, shared by the MCP tools (Claude, workflow steps) and the /jeeves
 * actions endpoint (buttons in the Jeeves app), so both have the same side effects: events,
 * timer reminders and the daily reminder set. Each throws on an unknown task or bad transition.
 */
export function taskActions({ store, timeZone, now = () => new Date(), events, reminders }: ActionDeps) {
  return {
    listDue(date?: string): DueTask[] {
      return store.listDue(date ?? localDate(now(), timeZone), now());
    },

    /** Today's instance of one chore (created if due), whatever its state, or null if it has none. */
    getTask(choreId: string, date?: string): DueTask | null {
      if (!store.getChore(choreId)) throw new Error(`No chore with id ${choreId}`);
      return store.getTaskFor(choreId, date ?? localDate(now(), timeZone));
    },

    async start(taskId: number): Promise<TaskInstance> {
      const task = store.setState(taskId, "started", now());
      emitTaskEvent(store, events, "task_started", task);
      await reminders?.sync();
      return task;
    },

    async complete(taskId: number): Promise<TaskInstance> {
      const task = store.setState(taskId, "done", now());
      emitTaskEvent(store, events, "task_completed", task);
      await reminders?.sync();
      return task;
    },

    async skip(taskId: number): Promise<TaskInstance> {
      const task = store.setState(taskId, "skipped", now());
      emitTaskEvent(store, events, "task_skipped", task);
      await reminders?.sync();
      return task;
    },

    async snooze(taskId: number, minutes?: number): Promise<TaskInstance> {
      const task = store.snooze(taskId, minutes ?? store.settings().default_snooze_minutes, now());
      await reminders?.sync();
      return task;
    },
  };
}

export type TaskActions = ReturnType<typeof taskActions>;
