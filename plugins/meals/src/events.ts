import type { MealsStore } from "./store.js";

export type MealEventType = "cooked" | "shop_finished" | "plan_set";

export interface CookedPayload {
  date: string;
  recipe_id: string;
  name: string;
  leftover_nights: number;
}

export interface ShopFinishedPayload {
  shop_id: number;
  date: string;
  total: number;
  est_cost: number;
}

export interface PlanSetPayload {
  from: string;
  to: string;
  shop_date: string | null;
  est_cost: number;
  over_budget: boolean;
}

export type MealEventPayload = CookedPayload | ShopFinishedPayload | PlanSetPayload;

/** Sends one event to Jeeves. Must not throw; delivery is fire and forget. */
export type EventPoster = (type: MealEventType, payload: MealEventPayload) => void;

/**
 * Posts events to `${jeevesUrl}/plugin-events` with the plugin's bearer token. Returns a no-op when
 * there is no Jeeves URL. Failures are logged, never thrown.
 */
export function httpEventPoster(opts: { jeevesUrl?: string; token: string; fetch?: typeof fetch }): EventPoster {
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

/** Emits an event if the emit_events setting is on. */
export function emitMealEvent(store: MealsStore, poster: EventPoster | undefined, type: MealEventType, payload: MealEventPayload): void {
  if (!poster || !store.settings().emit_events) return;
  try {
    poster(type, payload);
  } catch (e) {
    console.warn(`Could not send ${type} event to Jeeves: ${(e as Error).message}`);
  }
}
