import { emitTaskEvent, type EventPoster } from "./events.js";
import type { ReminderScheduler } from "./reminders.js";
import { localDate, type DueTask, type TaskInstance, type TodoStore } from "./store.js";

export interface ActionDeps {
  store: TodoStore;
  timeZone: string;
  now?: () => Date;
  /** Where task_started / task_completed events go (fire and forget). */
  events?: EventPoster;
  /** Schedules timer steps and daily reminders on Jeeves. Without it, start returns plain followups. */
  reminders?: ReminderScheduler;
}

export interface Followup {
  at: string;
  message: string;
  scheduled?: boolean;
}

/**
 * What can be done to a task, shared by the MCP tools (Claude, workflow steps) and the /jeeves
 * actions endpoint (buttons in the Jeeves app), so both have the same side effects: events,
 * timer reminders and the daily reminder set. Each throws on an unknown task or bad transition.
 */
export function taskActions({ store, timeZone, now = () => new Date(), events, reminders }: ActionDeps) {
  /** After a task is done or skipped: drop its timer reminders and refresh the daily set. */
  const finishTimers = async (task: TaskInstance) => {
    if (!reminders) return;
    const chore = store.getChore(task.chore_id);
    if (chore) await reminders.cancelTimers(task, chore);
    await reminders.sync();
  };

  return {
    listDue(date?: string): DueTask[] {
      return store.listDue(date ?? localDate(now(), timeZone), now());
    },

    async start(taskId: number): Promise<{ task: TaskInstance; followups: Followup[] }> {
      const task = store.setState(taskId, "started", now());
      const chore = store.getChore(task.chore_id)!;
      let followups: Followup[];
      if (reminders) {
        followups = await reminders.scheduleTimer(task, chore);
      } else {
        let at = new Date(task.started_at!).getTime();
        const steps = store.settings().followup_nudges ? chore.timer_steps : [];
        followups = steps.map((s) => {
          at += s.after_minutes * 60_000;
          return { at: new Date(at).toISOString(), message: s.message };
        });
      }
      emitTaskEvent(store, events, "task_started", task);
      await reminders?.sync();
      return { task, followups };
    },

    async complete(taskId: number): Promise<TaskInstance> {
      const task = store.setState(taskId, "done", now());
      emitTaskEvent(store, events, "task_completed", task);
      await finishTimers(task);
      return task;
    },

    async skip(taskId: number): Promise<TaskInstance> {
      const task = store.setState(taskId, "skipped", now());
      await finishTimers(task);
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
