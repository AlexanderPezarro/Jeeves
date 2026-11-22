import {
  addDays,
  budgetCheck,
  byUseBy,
  dateRange,
  diffDays,
  expandPlan,
  leftoverForecast,
  requiredQuantities,
  shoppingList,
  spreadReceipt,
  suggestShopDay,
  varietySummary,
  type Assignment,
  type Ingredient,
  type Night,
  type Recipe,
  type ShoppingItem,
  type Unit,
} from "./planner.js";
import { emitMealEvent, type EventPoster } from "./events.js";
import { slugify, type MealsStore, type PlanRow, type RecipeInput } from "./store.js";

export interface ActionDeps {
  store: MealsStore;
  timeZone: string;
  now?: () => Date;
  /** Where cooked / shop_finished / plan_set events go (fire and forget). */
  events?: EventPoster;
}

/** YYYY-MM-DD in the given time zone. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function checkDate(d: string, what = "date"): string {
  if (!DATE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new Error(`${what} must be YYYY-MM-DD, got "${d}"`);
  return d;
}

export interface NightInput {
  date: string;
  kind?: "cook" | "out" | "skip";
  recipe_id?: string;
  start_at?: string;
}

export interface RecipeIngredientInput {
  /** An ingredient id or name. Unknown names are created, flagged as estimated. */
  ingredient: string;
  qty: number;
  unit?: Unit;
  aisle?: string;
  pack_qty?: number;
  pack_price?: number;
  keeps_days?: number;
  staple?: boolean;
}

export interface SaveRecipeInput {
  id?: string;
  name: string;
  portions?: number;
  minutes?: number;
  tags?: string[];
  method?: string[];
  source?: string;
  rating?: number | null;
  ingredients: RecipeIngredientInput[];
}

export interface IngredientInput {
  id?: string;
  name: string;
  aisle?: string;
  pack_qty?: number;
  unit?: Unit;
  pack_price?: number;
  keeps_days?: number;
  staple?: boolean;
  estimated?: boolean;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * What can be done with meals, shared by the MCP tools (Claude, workflow steps) and the /jeeves
 * actions endpoint (buttons in the Jeeves app), so both have the same side effects. Each throws on an
 * unknown id or a bad transition.
 */
export function mealActions({ store, timeZone, now = () => new Date(), events }: ActionDeps) {
  const today = () => localDate(now(), timeZone);

  const groupByAisle = <T extends { aisle: string }>(items: T[]) => {
    const groups = new Map<string, T[]>();
    for (const i of items) groups.set(i.aisle, [...(groups.get(i.aisle) ?? []), i]);
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([aisle, list]) => ({ aisle, items: list }));
  };

  /** Plan rows as nights, plus which dates are locked (cooked, or leftovers of a night already cooked). */
  const rowsAsNights = (rows: PlanRow[]) => {
    const locked = new Set<string>();
    for (const r of rows) {
      const src = r.kind === "leftover" && r.cooked_from_date ? store.getPlanRow(r.cooked_from_date) : null;
      if (r.status === "cooked" || src?.status === "cooked") locked.add(r.date);
    }
    const nights: Night[] = rows.map((r) => ({ date: r.date, kind: r.kind, recipe_id: r.recipe_id, cooked_from_date: r.cooked_from_date }));
    return { nights, locked };
  };

  /** Everything derived from a full night list: list, cost, forecast, variety, shop day. */
  const analyse = (from: string, to: string, nights: Night[], locked: Set<string>, wasted: { date: string; recipe_id: string; portions: number }[], busy: string[]) => {
    const recipes = store.recipeMap();
    const ingredients = store.ingredientMap();
    const settings = store.settings();
    const open = nights.filter((n) => !locked.has(n.date));
    const required = requiredQuantities(open, recipes);
    const pantry = store.pantryLots();
    const list = shoppingList(required, pantry, ingredients);
    const est_cost = Math.round(list.reduce((s, i) => s + i.est_cost, 0) * 100) / 100;
    const shop = suggestShopDay({ nights, list, busyDates: busy, today: today() });
    return {
      list,
      est_cost,
      budget: budgetCheck(est_cost, settings.weekly_budget),
      forecast: leftoverForecast(required, pantry, ingredients, to),
      variety: varietySummary(nights, recipes),
      shop,
      wasted: wasted.map((w) => ({ ...w, name: recipes.get(w.recipe_id)?.name ?? w.recipe_id })),
      estimated_ingredients: list.filter((i) => i.estimated).map((i) => i.name),
      from,
      to,
    };
  };

  const decorate = (n: Night, extra: Partial<PlanRow> & { locked?: boolean } = {}) => {
    const r = n.recipe_id ? store.getRecipe(n.recipe_id) : null;
    return {
      date: n.date,
      kind: n.kind,
      recipe_id: n.recipe_id,
      name: r?.name ?? null,
      minutes: r?.minutes ?? null,
      cooked_from_date: n.cooked_from_date,
      status: extra.status ?? "planned",
      start_at: n.kind === "cook" ? (extra.start_at ?? store.settings().default_dinner_time) : null,
      locked: !!extra.locked,
    };
  };

  const shopView = (shopId: number) => {
    const shop = store.getShop(shopId);
    if (!shop) throw new Error(`No shop with id ${shopId}`);
    const ingredients = store.ingredientMap();
    const items = store.shopItems(shopId).map((i) => {
      const ing = ingredients.get(i.ingredient_id)!;
      return {
        ingredient_id: i.ingredient_id,
        name: ing.name,
        aisle: ing.aisle,
        unit: ing.unit,
        packs: i.packs,
        pack_qty: ing.pack_qty,
        qty: i.qty,
        est_cost: i.est_cost,
        ticked: i.ticked,
        estimated: ing.estimated,
      };
    });
    items.sort((a, b) => a.aisle.localeCompare(b.aisle) || a.name.localeCompare(b.name));
    return {
      shop_id: shop.id,
      date: shop.date,
      open: shop.finished_at === null,
      due_today: shop.finished_at === null && shop.date <= today(),
      est_cost: shop.est_cost,
      actual_total: shop.actual_total,
      items,
      aisles: groupByAisle(items),
    };
  };

  /** Finds or creates the ingredient for a recipe line. Returns [ingredient, created]. */
  const resolveIngredient = (line: RecipeIngredientInput): [Ingredient, boolean] => {
    const found = store.findIngredient(line.ingredient);
    if (found) return [found, false];
    const name = line.ingredient.trim();
    if (!name) throw new Error("An ingredient needs a name");
    let id = slugify(name);
    for (let n = 2; store.getIngredient(id); n++) id = `${slugify(name)}-${n}`;
    return [
      store.putIngredient({
        id,
        name,
        aisle: line.aisle ?? "Other",
        pack_qty: line.pack_qty ?? 1,
        unit: line.unit ?? "each",
        pack_price: line.pack_price ?? 0,
        keeps_days: line.keeps_days ?? 7,
        staple: line.staple ?? false,
        estimated: true,
      }),
      true,
    ];
  };

  /** Rows in [from, to] -> everything a shop or a plan_set event needs. */
  const fromPlan = (from: string, to: string, busy: string[] = []) => {
    const rows = store.planRange(from, to);
    const { nights, locked } = rowsAsNights(rows);
    return { rows, nights, locked, ...analyse(from, to, nights, locked, [], busy) };
  };

  return {
    // --- reads ---

    getTonight(date?: string) {
      const d = checkDate(date ?? today());
      const row = store.getPlanRow(d);
      const settings = store.settings();
      const base = { date: d, start_at: row?.start_at ?? settings.default_dinner_time };
      if (!row) return { ...base, kind: "none" as const, status: null, recipe: null, name: null, minutes: null, pantry_covers: false, cooked_from_date: null };
      const recipe = row.recipe_id ? store.getRecipe(row.recipe_id) : null;
      let pantry_covers = false;
      if (row.kind === "cook" && recipe) {
        const need = requiredQuantities([{ date: d, kind: "cook", recipe_id: recipe.id, cooked_from_date: null }], new Map([[recipe.id, recipe]]));
        pantry_covers = shoppingList(need, store.pantryLots(), store.ingredientMap()).length === 0;
      }
      return {
        ...base,
        kind: row.kind,
        status: row.status,
        recipe: recipe && {
          ...recipe,
          ingredients: recipe.ingredients.map((i) => ({ ...i, name: store.getIngredient(i.ingredient_id)?.name ?? i.ingredient_id, unit: store.getIngredient(i.ingredient_id)?.unit })),
        },
        name: recipe?.name ?? null,
        minutes: recipe?.minutes ?? null,
        pantry_covers,
        cooked_from_date: row.cooked_from_date,
      };
    },

    getPlan(from?: string, to?: string) {
      const f = checkDate(from ?? today(), "from");
      const t = checkDate(to ?? addDays(f, 6), "to");
      const rows = new Map(store.planRange(f, t).map((r) => [r.date, r]));
      const nights = dateRange(f, t).map((d) => {
        const r = rows.get(d);
        if (!r) return decorate({ date: d, kind: "none", recipe_id: null, cooked_from_date: null });
        return decorate({ date: d, kind: r.kind, recipe_id: r.recipe_id, cooked_from_date: r.cooked_from_date }, r);
      });
      const shop = store.openShop();
      return { from: f, to: t, nights, open_shop: shop ? { shop_id: shop.id, date: shop.date, est_cost: shop.est_cost } : null };
    },

    listRecipes(filter: { tag?: string; text?: string; max_minutes?: number; min_rating?: number } = {}) {
      const text = filter.text?.toLowerCase();
      const ingredients = store.ingredientMap();
      return store
        .listRecipes()
        .filter((r) => !filter.tag || r.tags.includes(filter.tag))
        .filter((r) => filter.max_minutes === undefined || r.minutes <= filter.max_minutes)
        .filter((r) => filter.min_rating === undefined || (r.rating ?? 0) >= filter.min_rating)
        .filter(
          (r) => !text || r.name.toLowerCase().includes(text) || r.ingredients.some((i) => ingredients.get(i.ingredient_id)?.name.toLowerCase().includes(text)),
        )
        .map((r) => ({ id: r.id, name: r.name, portions: r.portions, minutes: r.minutes, tags: r.tags, rating: r.rating, source: r.source }));
    },

    getRecipe(id: string) {
      return getRecipeOut(id);
    },

    getPantry() {
      const t = today();
      const ingredients = store.ingredientMap();
      return byUseBy(store.pantryLots()).map((l) => ({
        id: l.id,
        ingredient_id: l.ingredient_id,
        name: ingredients.get(l.ingredient_id)?.name ?? l.ingredient_id,
        unit: ingredients.get(l.ingredient_id)?.unit ?? null,
        qty: l.qty,
        added_on: l.added_on,
        use_by: l.use_by,
        days_left: l.use_by ? diffDays(l.use_by, t) : null,
        past_use_by: l.use_by !== null && l.use_by < t,
      }));
    },

    getShoppingList(shopId?: number) {
      const shop = shopId !== undefined ? store.getShop(shopId) : store.openShop();
      if (shopId !== undefined && !shop) throw new Error(`No shop with id ${shopId}`);
      if (!shop) return { shop_id: null, date: null, open: false, due_today: false, est_cost: 0, actual_total: null, items: [], aisles: [] };
      return shopView(shop.id);
    },

    // --- preview and plan ---

    /** Works out cost, shopping, leftovers and shop day for a draft plan. Writes nothing. */
    previewPlan(input: { from?: string; to?: string; nights: NightInput[]; busy_dates?: string[] }) {
      const dates = input.nights.map((n) => n.date);
      const from = checkDate(input.from ?? [...dates].sort()[0] ?? today(), "from");
      const to = checkDate(input.to ?? addDays(from, 6), "to");
      const range = dateRange(from, to);
      const assignments = toAssignments(input.nights, range);
      const rows = store.planRange(from, to);
      const { nights: lockedNights, locked } = rowsAsNights(rows);
      const lockedAssign: Assignment[] = [...locked].map((d) => ({ date: d, kind: "skip" }));
      const withoutLocked = assignments.filter((a) => !locked.has(a.date));
      const expanded = expandPlan(range, [...withoutLocked, ...lockedAssign], store.recipeMap(), store.settings().leftover_max_days);
      const byDate = new Map(lockedNights.map((n) => [n.date, n]));
      const nights = expanded.nights.map((n) => (locked.has(n.date) ? byDate.get(n.date)! : n));
      const startAt = new Map(input.nights.map((n) => [n.date, n.start_at]));
      const a = analyse(from, to, nights, locked, expanded.wasted, input.busy_dates ?? []);
      return {
        from,
        to,
        nights: nights.map((n) => decorate(n, { start_at: startAt.get(n.date), locked: locked.has(n.date), status: rows.find((r) => r.date === n.date)?.status })),
        wasted_portions: a.wasted,
        shopping_list: { items: a.list, aisles: groupByAisle(a.list) },
        est_cost: a.est_cost,
        budget: a.budget,
        leftover_forecast: a.forecast,
        variety: a.variety,
        shop_date: a.shop.shop_date,
        second_shop: a.shop.second_shop,
        shop_note: a.shop.note,
        estimated_ingredients: a.estimated_ingredients,
      };
    },

    /** Replaces the planned nights in the range (cooked nights stay) and tells Jeeves. */
    setPlan(input: { from?: string; to?: string; nights: NightInput[] }) {
      if (input.nights.length === 0 && !input.from) throw new Error("Give some nights, or a from/to range to clear");
      const dates = input.nights.map((n) => n.date).sort();
      const from = checkDate(input.from ?? dates[0], "from");
      const to = checkDate(input.to ?? dates[dates.length - 1] ?? addDays(from, 6), "to");
      const range = dateRange(from, to);
      const assignments = toAssignments(input.nights, range);
      const { locked } = rowsAsNights(store.planRange(from, to));
      const lockedAssign: Assignment[] = [...locked].map((d) => ({ date: d, kind: "skip" }));
      const expanded = expandPlan(range, [...assignments.filter((a) => !locked.has(a.date)), ...lockedAssign], store.recipeMap(), store.settings().leftover_max_days);
      const startAt = new Map(input.nights.map((n) => [n.date, n.start_at ?? null]));
      const rows: PlanRow[] = expanded.nights
        .filter((n) => n.kind !== "none" && !locked.has(n.date))
        .map((n) => ({
          date: n.date,
          kind: n.kind as PlanRow["kind"],
          recipe_id: n.recipe_id,
          start_at: n.kind === "cook" ? (startAt.get(n.date) ?? null) : null,
          status: "planned",
          cooked_from_date: n.cooked_from_date,
        }));
      store.replacePlan(from, to, rows, locked);
      const a = fromPlan(from, to);
      emitMealEvent(store, events, "plan_set", { from, to, shop_date: a.shop.shop_date, est_cost: a.est_cost, over_budget: a.budget.over_budget });
      return {
        from,
        to,
        nights: store.planRange(from, to).map((r) => decorate({ date: r.date, kind: r.kind, recipe_id: r.recipe_id, cooked_from_date: r.cooked_from_date }, r)),
        wasted_portions: expanded.wasted,
        est_cost: a.est_cost,
        budget: a.budget,
        shop_date: a.shop.shop_date,
        second_shop: a.shop.second_shop,
      };
    },

    /** Marks a night cooked: takes the recipe's ingredients out of the pantry, soonest use-by first. */
    markCooked(date: string) {
      checkDate(date);
      const row = store.getPlanRow(date);
      if (!row) throw new Error(`Nothing is planned for ${date}`);
      if (row.status === "cooked") throw new Error(`${date} is already cooked`);
      if (row.kind !== "cook" && row.kind !== "leftover") throw new Error(`${date} is ${row.kind === "out" ? "an out night" : "skipped"}, so there is nothing to cook`);
      const recipe = row.recipe_id ? store.getRecipe(row.recipe_id) : null;
      if (!recipe) throw new Error(`${date} has no recipe`);
      const at = now().toISOString();
      let leftoverNights = 0;
      const deducted: { ingredient_id: string; qty: number; short: number }[] = [];
      store.db.transaction(() => {
        if (row.kind === "cook") {
          for (const i of recipe.ingredients) {
            const took = store.consume(i.ingredient_id, i.qty);
            if (took > 0) store.log(i.ingredient_id, -took, "cooked", recipe.name, at);
            deducted.push({ ingredient_id: i.ingredient_id, qty: took, short: Math.round((i.qty - took) * 100) / 100 });
          }
          // Fill in any leftover nights the plan did not have yet.
          const max = store.settings().leftover_max_days;
          let missing = recipe.portions - 1 - (store.db.prepare("SELECT COUNT(*) AS n FROM plan WHERE kind = 'leftover' AND cooked_from_date = ?").get(date) as { n: number }).n;
          for (let k = 1; k < max && missing > 0; k++) {
            const next = addDays(date, k);
            if (store.getPlanRow(next)) continue;
            store.putPlanRow({ date: next, kind: "leftover", recipe_id: recipe.id, start_at: null, status: "planned", cooked_from_date: date });
            missing--;
          }
          leftoverNights = (store.db.prepare("SELECT COUNT(*) AS n FROM plan WHERE kind = 'leftover' AND cooked_from_date = ?").get(date) as { n: number }).n;
        }
        store.putPlanRow({ ...row, status: "cooked" });
      })();
      emitMealEvent(store, events, "cooked", { date, recipe_id: recipe.id, name: recipe.name, leftover_nights: leftoverNights });
      return { date, kind: row.kind, recipe_id: recipe.id, name: recipe.name, leftover_nights: leftoverNights, deducted };
    },

    skipMeal(date: string) {
      return setNight("skip", date);
    },

    markOut(date: string) {
      return setNight("out", date);
    },

    // --- recipes and ingredients ---

    saveRecipe(input: SaveRecipeInput) {
      const name = input.name.trim();
      if (!name) throw new Error("A recipe needs a name");
      const id = input.id ?? slugify(name);
      const merged = new Map<string, number>();
      const created: string[] = [];
      for (const line of input.ingredients) {
        if (!(line.qty > 0)) throw new Error(`${line.ingredient}: qty must be more than 0`);
        const [ing, isNew] = resolveIngredient(line);
        if (isNew) created.push(ing.name);
        merged.set(ing.id, (merged.get(ing.id) ?? 0) + line.qty);
      }
      const rating = input.rating ?? null;
      if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) throw new Error("rating is 1 to 5");
      const recipe: RecipeInput = {
        id,
        name,
        portions: input.portions ?? 2,
        minutes: input.minutes ?? 30,
        tags: [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))],
        method: (input.method ?? []).map((s) => s.trim()).filter(Boolean),
        source: input.source ?? "mine",
        rating,
        ingredients: [...merged].map(([ingredient_id, qty]) => ({ ingredient_id, qty })),
      };
      if (recipe.portions < 1) throw new Error("portions must be at least 1");
      return { recipe: getRecipeOut(store.putRecipe(recipe).id), new_ingredients: created };
    },

    deleteRecipe(id: string) {
      if (!store.deleteRecipe(id)) throw new Error(`No recipe with id ${id}`);
      return { ok: true };
    },

    upsertIngredient(input: IngredientInput) {
      const existing = (input.id ? store.getIngredient(input.id) : null) ?? store.findIngredient(input.name);
      const name = input.name.trim();
      if (!name) throw new Error("An ingredient needs a name");
      let id = existing?.id ?? input.id ?? slugify(name);
      if (!existing) for (let n = 2; store.getIngredient(id); n++) id = `${input.id ?? slugify(name)}-${n}`;
      const next: Ingredient = {
        id,
        name,
        aisle: input.aisle ?? existing?.aisle ?? "Other",
        pack_qty: input.pack_qty ?? existing?.pack_qty ?? 1,
        unit: input.unit ?? existing?.unit ?? "each",
        pack_price: input.pack_price ?? existing?.pack_price ?? 0,
        keeps_days: input.keeps_days ?? existing?.keeps_days ?? 7,
        staple: input.staple ?? existing?.staple ?? false,
        estimated: input.estimated ?? existing?.estimated ?? true,
      };
      if (!(next.pack_qty > 0)) throw new Error("pack_qty must be more than 0");
      if (next.pack_price < 0) throw new Error("pack_price can't be negative");
      if (!Number.isInteger(next.keeps_days) || next.keeps_days < 0) throw new Error("keeps_days must be a whole number of days");
      return store.putIngredient(next);
    },

    deleteIngredient(id: string) {
      if (!store.getIngredient(id)) throw new Error(`No ingredient with id ${id}`);
      store.deleteIngredient(id);
      return { ok: true };
    },

    // --- pantry ---

    /** Adds a lot (positive) or takes stock out, soonest use-by first (negative). Waste checks use reason "waste". */
    adjustPantry(input: { ingredient_id: string; qty_delta: number; use_by?: string | null; reason: "cooked" | "shop" | "waste" | "adjust"; note?: string }) {
      const ing = store.getIngredient(input.ingredient_id);
      if (!ing) throw new Error(`No ingredient with id ${input.ingredient_id}`);
      if (!Number.isFinite(input.qty_delta) || input.qty_delta === 0) throw new Error("qty_delta must be a non-zero number");
      const t = today();
      const at = now().toISOString();
      if (input.qty_delta > 0) {
        const useBy = input.use_by === undefined ? addDays(t, ing.keeps_days) : input.use_by === null ? null : checkDate(input.use_by, "use_by");
        const lot = store.addLot(ing.id, input.qty_delta, t, useBy);
        store.log(ing.id, input.qty_delta, input.reason, input.note ?? null, at);
        return { ingredient_id: ing.id, lot_id: lot, qty_delta: input.qty_delta, use_by: useBy };
      }
      const took = store.consume(ing.id, -input.qty_delta);
      if (took > 0) store.log(ing.id, -took, input.reason, input.note ?? null, at);
      return { ingredient_id: ing.id, qty_delta: -took, requested: input.qty_delta, short: Math.round((-input.qty_delta - took) * 100) / 100 };
    },

    // --- shopping ---

    /** Builds a shop from the planned nights in the range, replacing any shop still open. */
    createShop(input: { date?: string; from?: string; to?: string; busy_dates?: string[] } = {}) {
      const from = checkDate(input.from ?? today(), "from");
      const to = checkDate(input.to ?? addDays(from, 6), "to");
      const a = fromPlan(from, to, input.busy_dates ?? []);
      if (a.list.length === 0) throw new Error(`Nothing to buy for ${from} to ${to}: the pantry covers the plan (or nothing is planned)`);
      const date = checkDate(input.date ?? a.shop.shop_date ?? today());
      store.discardOpenShops();
      const shop = store.createShop(
        date,
        a.est_cost,
        a.list.map((i) => ({ ingredient_id: i.ingredient_id, packs: i.packs, qty: i.qty, est_cost: i.est_cost })),
      );
      return { ...shopView(shop.id), budget: a.budget, second_shop: a.shop.second_shop };
    },

    tickItem(shopId: number, ingredientId: string, ticked: boolean) {
      const shop = store.getShop(shopId);
      if (!shop) throw new Error(`No shop with id ${shopId}`);
      if (shop.finished_at) throw new Error(`Shop ${shopId} is already finished`);
      if (!store.setTicked(shopId, ingredientId, ticked)) throw new Error(`Shop ${shopId} has no item ${ingredientId}`);
      return shopView(shopId);
    },

    /** Ticked items become pantry lots; a receipt total re-prices them; unticked items are dropped. */
    finishShop(shopId: number, total?: number) {
      const shop = store.getShop(shopId);
      if (!shop) throw new Error(`No shop with id ${shopId}`);
      if (shop.finished_at) throw new Error(`Shop ${shopId} is already finished`);
      if (total !== undefined && !(total >= 0)) throw new Error("total can't be negative");
      const ingredients = store.ingredientMap();
      const items = store.shopItems(shopId);
      const ticked = items.filter((i) => i.ticked);
      const dropped = items.filter((i) => !i.ticked).map((i) => ingredients.get(i.ingredient_id)?.name ?? i.ingredient_id);
      const t = today();
      const boughtOn = shop.date < t ? shop.date : t;
      const at = now().toISOString();
      store.db.transaction(() => {
        for (const i of ticked) {
          const ing = ingredients.get(i.ingredient_id)!;
          store.addLot(i.ingredient_id, i.qty, boughtOn, addDays(boughtOn, ing.keeps_days));
          store.log(i.ingredient_id, i.qty, "shop", `shop ${shopId}`, at);
        }
        if (total !== undefined) for (const p of spreadReceipt(ticked, total)) store.setPackPrice(p.ingredient_id, p.pack_price, false);
        store.closeShop(shopId, total ?? null, at);
      })();
      const spent = total ?? Math.round(ticked.reduce((s, i) => s + i.est_cost, 0) * 100) / 100;
      emitMealEvent(store, events, "shop_finished", { shop_id: shopId, date: shop.date, total: spent, est_cost: shop.est_cost });
      return {
        shop_id: shopId,
        date: shop.date,
        bought: ticked.map((i) => ({ ingredient_id: i.ingredient_id, name: ingredients.get(i.ingredient_id)?.name, qty: i.qty })),
        dropped,
        total: spent,
        est_cost: shop.est_cost,
        repriced: total !== undefined,
      };
    },
  };

  /** A recipe with ingredient names and units. */
  function getRecipeOut(id: string) {
    const r = store.getRecipe(id);
    if (!r) throw new Error(`No recipe with id ${id}`);
    return {
      ...r,
      ingredients: r.ingredients.map((i) => {
        const ing = store.getIngredient(i.ingredient_id);
        return { ingredient_id: i.ingredient_id, name: ing?.name ?? i.ingredient_id, qty: i.qty, unit: ing?.unit ?? null };
      }),
    };
  }

  /** Validates and normalises night input; every recipe and date is checked. */
  function toAssignments(nights: NightInput[], range: string[]): Assignment[] {
    const seen = new Set<string>();
    return nights.map((n) => {
      checkDate(n.date);
      if (!range.includes(n.date)) throw new Error(`${n.date} is outside the planned range ${range[0]} to ${range[range.length - 1]}`);
      if (seen.has(n.date)) throw new Error(`${n.date} is listed twice`);
      seen.add(n.date);
      if (n.start_at !== undefined && !HHMM.test(n.start_at)) throw new Error(`start_at must be HH:MM, got "${n.start_at}"`);
      const kind = n.kind ?? "cook";
      if (kind !== "cook") return { date: n.date, kind };
      if (!n.recipe_id) throw new Error(`${n.date}: a cook night needs a recipe_id`);
      if (!store.getRecipe(n.recipe_id)) throw new Error(`No recipe with id ${n.recipe_id}`);
      return { date: n.date, kind: "cook", recipe_id: n.recipe_id };
    });
  }

  /** skip / out: the night becomes that kind. Leftovers that were waiting on a cook night are released. */
  function setNight(kind: "skip" | "out", date: string) {
    checkDate(date);
    const row = store.getPlanRow(date);
    if (row?.status === "cooked") throw new Error(`${date} is already cooked`);
    store.db.transaction(() => {
      if (row?.kind === "cook") {
        for (const l of store.planRange(addDays(date, 1), addDays(date, 30))) {
          if (l.kind === "leftover" && l.cooked_from_date === date && l.status === "planned") store.deletePlanRow(l.date);
        }
      }
      store.putPlanRow({ date, kind, recipe_id: null, start_at: null, status: "planned", cooked_from_date: null });
    })();
    return { date, kind };
  }
}

export type MealActions = ReturnType<typeof mealActions>;
export type { ShoppingItem };
