import type { TaskInstance, TodoStore } from "./store.js";

export type TaskEventType = "task_started" | "task_completed" | "task_skipped";

export interface TaskEventPayload {
  task_id: number;
  chore_id: string;
  name: string;
}

/** Sends one event to Jeeves. Must not throw; delivery is fire and forget. */
export type EventPoster = (type: TaskEventType, payload: TaskEventPayload) => void;

/**
 * Posts events to `${jeevesUrl}/plugin-events` with the plugin's bearer token. Returns a no-op when
 * there is no Jeeves URL. Failures are logged, never thrown.
 */
export function httpEventPoster(opts: {
  jeevesUrl?: string;
  token: string;
  fetch?: typeof fetch;
}): EventPoster {
  const { jeevesUrl, token } = opts;
  if (!jeevesUrl) return () => {};
  const doFetch = opts.fetch ?? fetch;
  const url = `${jeevesUrl.replace(/\/+$/, "")}/plugin-events`;
  return (type, payload) => {
    void (async () => {
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ type, payload }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) console.warn(`Jeeves rejected ${type} event: HTTP ${res.status}`);
      } catch (e) {
        console.warn(`Could not send ${type} event to Jeeves: ${(e as Error).message}`);
      }
    })();
  };
}

/** Emits a task event if the emit_events setting is on. */
export function emitTaskEvent(
  store: TodoStore,
  poster: EventPoster | undefined,
  type: TaskEventType,
  task: TaskInstance,
): void {
  if (!poster || !store.settings().emit_events) return;
  const name = store.getChore(task.chore_id)?.name ?? task.chore_id;
  try {
    poster(type, { task_id: task.id, chore_id: task.chore_id, name });
  } catch (e) {
    console.warn(`Could not send ${type} event to Jeeves: ${(e as Error).message}`);
  }
}
