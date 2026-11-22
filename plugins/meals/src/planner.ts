/**
 * The deterministic maths of the meals plugin. No database and no clock: everything takes plain data
 * so it can be unit tested. Quantities are always in an ingredient's own unit and never converted.
 * Dates are YYYY-MM-DD strings.
 */

export type Unit = "g" | "ml" | "each";

export interface Ingredient {
  id: string;
  name: string;
  aisle: string;
  pack_qty: number;
  unit: Unit;
  pack_price: number;
  /** Days an item keeps after it is bought. Big for tins and dry goods. */
  keeps_days: number;
  /** Staples (oil, salt) are assumed to be in the cupboard and never go on the list. */
  staple: boolean;
  /** Created by Claude or with a guessed price. */
  estimated: boolean;
}

export interface Recipe {
  id: string;
  name: string;
  portions: number;
  minutes: number;
  tags: string[];
  method: string[];
  source: string;
  rating: number | null;
  /** qty is for the whole recipe, in the ingredient's unit. */
  ingredients: { ingredient_id: string; qty: number }[];
}

/** One lot of an ingredient in the pantry. `use_by` null means it does not go off. */
export interface PantryLot {
  id?: number;
  ingredient_id: string;
  qty: number;
  use_by: string | null;
}

export type Assignment = { date: string; kind: "cook"; recipe_id: string } | { date: string; kind: "out" | "skip" };
export type NightKind = "cook" | "leftover" | "out" | "skip" | "none";

export interface Night {
  date: string;
  kind: NightKind;
  recipe_id: string | null;
  /** For a leftover night, the date it was cooked. */
  cooked_from_date: string | null;
}

// --- dates ---

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// --- plan expansion ---

export interface Expanded {
  nights: Night[];
  /** Portions that did not fit in a free night within the leftover window. */
  wasted: { date: string; recipe_id: string; portions: number }[];
}

/**
 * A cook night for a recipe with N portions fills the next N-1 unassigned nights (never out or skip,
 * never one already given a meal) with leftovers, as long as they fall within `leftoverMaxDays` of
 * the cook night, counting the cook night as day 1. Returns one night per date, in date order.
 */
export function expandPlan(dates: string[], assignments: Assignment[], recipes: Map<string, Recipe>, leftoverMaxDays: number): Expanded {
  const sorted = [...new Set(dates)].sort();
  const byDate = new Map(assignments.map((a) => [a.date, a]));
  const nights = new Map<string, Night>();
  for (const date of sorted) {
    const a = byDate.get(date);
    nights.set(date, {
      date,
      kind: a ? a.kind : "none",
      recipe_id: a?.kind === "cook" ? a.recipe_id : null,
      cooked_from_date: null,
    });
  }
  const wasted: Expanded["wasted"] = [];
  for (const date of sorted) {
    const a = byDate.get(date);
    if (a?.kind !== "cook") continue;
    const recipe = recipes.get(a.recipe_id);
    if (!recipe) throw new Error(`No recipe with id ${a.recipe_id}`);
    let left = Math.max(0, recipe.portions - 1);
    for (const next of sorted) {
      if (left === 0) break;
      if (next <= date || diffDays(next, date) >= leftoverMaxDays) continue;
      const n = nights.get(next)!;
      if (n.kind !== "none") continue;
      nights.set(next, { date: next, kind: "leftover", recipe_id: a.recipe_id, cooked_from_date: date });
      left--;
    }
    if (left > 0) wasted.push({ date, recipe_id: a.recipe_id, portions: left });
  }
  return { nights: sorted.map((d) => nights.get(d)!), wasted };
}

// --- quantities ---

export interface Required {
  ingredient_id: string;
  qty: number;
  first_use: string;
  uses: { date: string; qty: number }[];
}

/** Total of each ingredient the cook nights need, with the date of each use. Leftover nights need nothing. */
export function requiredQuantities(nights: Night[], recipes: Map<string, Recipe>): Required[] {
  const out = new Map<string, Required>();
  for (const n of [...nights].sort((a, b) => a.date.localeCompare(b.date))) {
    if (n.kind !== "cook" || !n.recipe_id) continue;
    const recipe = recipes.get(n.recipe_id);
    if (!recipe) throw new Error(`No recipe with id ${n.recipe_id}`);
    for (const ri of recipe.ingredients) {
      const r = out.get(ri.ingredient_id) ?? { ingredient_id: ri.ingredient_id, qty: 0, first_use: n.date, uses: [] };
      r.qty += ri.qty;
      r.uses.push({ date: n.date, qty: ri.qty });
      out.set(ri.ingredient_id, r);
    }
  }
  return [...out.values()];
}

interface Allocation {
  /** What the pantry covers, by use date. */
  covered: number;
  unmet: { date: string; qty: number }[];
  /** Pantry lots with what is left of each after the plan. */
  lots: { lot: PantryLot; left: number }[];
}

/** Sorted soonest use-by first; lots that never expire go last. */
export function byUseBy<T extends { use_by: string | null }>(lots: T[]): T[] {
  return [...lots].sort((a, b) => (a.use_by ?? "9999-99-99").localeCompare(b.use_by ?? "9999-99-99"));
}

function allocate(req: Required, pantry: PantryLot[]): Allocation {
  const lots = byUseBy(pantry.filter((l) => l.ingredient_id === req.ingredient_id && l.qty > 0)).map((lot) => ({ lot, left: lot.qty }));
  let covered = 0;
  const unmet: Allocation["unmet"] = [];
  for (const use of [...req.uses].sort((a, b) => a.date.localeCompare(b.date))) {
    let need = use.qty;
    for (const l of lots) {
      if (need <= 1e-9) break;
      if (l.left <= 0 || (l.lot.use_by !== null && l.lot.use_by < use.date)) continue;
      const take = Math.min(l.left, need);
      l.left -= take;
      need -= take;
      covered += take;
    }
    if (need > 1e-9) unmet.push({ date: use.date, qty: need });
  }
  return { covered, unmet, lots };
}

export interface ShoppingItem {
  ingredient_id: string;
  name: string;
  aisle: string;
  unit: Unit;
  /** What the plan needs that the pantry does not cover. */
  need: number;
  packs: number;
  /** packs * pack_qty, in the ingredient's unit. */
  qty: number;
  pack_qty: number;
  est_cost: number;
  estimated: boolean;
  keeps_days: number;
  first_need: string;
  last_need: string;
}

export const packsFor = (need: number, packQty: number) => (need <= 1e-9 ? 0 : Math.ceil(need / packQty - 1e-9));

/**
 * What to buy: the requirement minus usable pantry (lots whose use-by is not before the night they
 * are needed, soonest first), staples dropped, rounded up to whole packs.
 */
export function shoppingList(required: Required[], pantry: PantryLot[], ingredients: Map<string, Ingredient>): ShoppingItem[] {
  const items: ShoppingItem[] = [];
  for (const req of required) {
    const ing = ingredients.get(req.ingredient_id);
    if (!ing) throw new Error(`No ingredient with id ${req.ingredient_id}`);
    if (ing.staple) continue;
    const { unmet } = allocate(req, pantry);
    const need = unmet.reduce((s, u) => s + u.qty, 0);
    const packs = packsFor(need, ing.pack_qty);
    if (packs === 0) continue;
    items.push({
      ingredient_id: ing.id,
      name: ing.name,
      aisle: ing.aisle,
      unit: ing.unit,
      need: round2(need),
      packs,
      qty: packs * ing.pack_qty,
      pack_qty: ing.pack_qty,
      est_cost: round2(packs * ing.pack_price),
      estimated: ing.estimated,
      keeps_days: ing.keeps_days,
      first_need: unmet[0].date,
      last_need: unmet[unmet.length - 1].date,
    });
  }
  return items.sort((a, b) => a.aisle.localeCompare(b.aisle) || a.name.localeCompare(b.name));
}

export interface ForecastLine {
  ingredient_id: string;
  name: string;
  unit: Unit;
  bought: number;
  pantry: number;
  used: number;
  /** bought + pantry - used: what is left after the week. */
  remainder: number;
  /** Pantry lots that expire within the plan and are not used before then. */
  expiring: { use_by: string; qty: number }[];
}

/** Per ingredient: bought + pantry - used, plus lots that would expire unused before the plan ends. */
export function leftoverForecast(
  required: Required[],
  pantry: PantryLot[],
  ingredients: Map<string, Ingredient>,
  endDate: string,
): ForecastLine[] {
  const lines: ForecastLine[] = [];
  const seen = new Set<string>();
  const add = (id: string, req: Required | null) => {
    seen.add(id);
    const ing = ingredients.get(id);
    if (!ing) return;
    const empty: Required = { ingredient_id: id, qty: 0, first_use: endDate, uses: [] };
    const r = req ?? empty;
    const a = allocate(r, pantry);
    const need = a.unmet.reduce((s, u) => s + u.qty, 0);
    const bought = ing.staple ? 0 : packsFor(need, ing.pack_qty) * ing.pack_qty;
    const inPantry = a.lots.reduce((s, l) => s + l.lot.qty, 0);
    const expiring = a.lots
      .filter((l) => l.left > 1e-9 && l.lot.use_by !== null && l.lot.use_by <= endDate)
      .map((l) => ({ use_by: l.lot.use_by!, qty: round2(l.left) }));
    if (!req && expiring.length === 0) return;
    lines.push({
      ingredient_id: id,
      name: ing.name,
      unit: ing.unit,
      bought,
      pantry: round2(inPantry),
      used: round2(r.qty),
      remainder: ing.staple ? round2(inPantry - a.covered) : round2(bought + inPantry - r.qty),
      expiring,
    });
  };
  for (const r of required) add(r.ingredient_id, r);
  // Pantry stock the plan never touches can still go off during the week.
  for (const id of new Set(pantry.map((l) => l.ingredient_id))) if (!seen.has(id)) add(id, null);
  return lines.sort((a, b) => a.name.localeCompare(b.name));
}

// --- variety ---

export interface Variety {
  /** Cook nights per tag. */
  tag_counts: Record<string, number>;
  /** Nights (cook and leftover) that have each tag. */
  nights_per_tag: Record<string, number>;
  /** Recipes cooked more than once. */
  repeated: { recipe_id: string; name: string; times: number }[];
}

/** Counts only; deciding what is too samey is left to the caller. */
export function varietySummary(nights: Night[], recipes: Map<string, Recipe>): Variety {
  const tag_counts: Record<string, number> = {};
  const nights_per_tag: Record<string, number> = {};
  const cooked = new Map<string, number>();
  for (const n of nights) {
    if (!n.recipe_id || (n.kind !== "cook" && n.kind !== "leftover")) continue;
    const r = recipes.get(n.recipe_id);
    if (!r) continue;
    for (const t of r.tags) {
      nights_per_tag[t] = (nights_per_tag[t] ?? 0) + 1;
      if (n.kind === "cook") tag_counts[t] = (tag_counts[t] ?? 0) + 1;
    }
    if (n.kind === "cook") cooked.set(r.id, (cooked.get(r.id) ?? 0) + 1);
  }
  const repeated = [...cooked].filter(([, n]) => n > 1).map(([id, times]) => ({ recipe_id: id, name: recipes.get(id)!.name, times }));
  return { tag_counts, nights_per_tag, repeated };
}

// --- shop day ---

export interface ShopSuggestion {
  /** Null when nothing needs buying. */
  shop_date: string | null;
  /** Perishables the main shop day cannot keep until they are used: shop again for them. */
  second_shop: { date: string; ingredient_ids: string[] } | null;
  note: string | null;
}

/**
 * The latest free day (not an out night, not busy) on or before the first night that needs something
 * bought, and no earlier than today. Each bought item must keep until its last use
 * (shop day + keeps_days >= last use); items that cannot move to a second shop on the latest free day
 * before their own first night.
 */
export function suggestShopDay(opts: {
  nights: Night[];
  list: ShoppingItem[];
  busyDates: string[];
  today: string;
}): ShopSuggestion {
  const { nights, list, busyDates, today } = opts;
  if (list.length === 0) return { shop_date: null, second_shop: null, note: null };
  const blocked = new Set([...busyDates, ...nights.filter((n) => n.kind === "out").map((n) => n.date)]);
  const latestFree = (onOrBefore: string): string | null => {
    for (let d = onOrBefore; d >= today; d = addDays(d, -1)) if (!blocked.has(d)) return d;
    return null;
  };
  const firstNeed = list.map((i) => i.first_need).sort()[0];
  let note: string | null = null;
  let shop = latestFree(firstNeed < today ? today : firstNeed);
  if (!shop) {
    shop = today;
    note = `No free day before ${firstNeed}; shopping today.`;
  }
  const failing = list.filter((i) => addDays(shop!, i.keeps_days) < i.last_need);
  let second: ShopSuggestion["second_shop"] = null;
  if (failing.length > 0) {
    const earliest = failing.map((i) => i.first_need).sort()[0];
    // Never before the main shop: a second trip on the same day would be the same trip.
    const d = latestFree(earliest);
    if (d && d > shop) second = { date: d, ingredient_ids: failing.map((i) => i.ingredient_id) };
    else note = `${failing.map((i) => i.name).join(", ")} will not keep until used and no later free day helps.`;
  }
  return { shop_date: shop, second_shop: second, note };
}

// --- money ---

export interface Budget {
  est_cost: number;
  weekly_budget: number;
  over_budget: boolean;
  /** Positive when over, negative when under. */
  difference: number;
}

/** Over budget is a flag, never an error. */
export function budgetCheck(estCost: number, weeklyBudget: number): Budget {
  const difference = round2(estCost - weeklyBudget);
  return { est_cost: round2(estCost), weekly_budget: weeklyBudget, over_budget: difference > 0, difference };
}

/**
 * Scales each ticked item's estimated cost so they add up to what the receipt said, returning the
 * new price per pack. Items with no estimated cost are left alone.
 */
export function spreadReceipt(
  items: { ingredient_id: string; packs: number; est_cost: number }[],
  actualTotal: number,
): { ingredient_id: string; pack_price: number }[] {
  const sum = items.reduce((s, i) => s + i.est_cost, 0);
  if (sum <= 0) return [];
  const factor = actualTotal / sum;
  return items.filter((i) => i.packs > 0).map((i) => ({ ingredient_id: i.ingredient_id, pack_price: round2((i.est_cost * factor) / i.packs) }));
}
