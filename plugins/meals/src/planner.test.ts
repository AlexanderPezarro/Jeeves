import { describe, expect, it } from "vitest";
import {
  budgetCheck,
  expandPlan,
  leftoverForecast,
  packsFor,
  requiredQuantities,
  shoppingList,
  spreadReceipt,
  suggestShopDay,
  varietySummary,
  type Night,
  type PantryLot,
  type Recipe,
  type ShoppingItem,
} from "./planner.js";
import { INGREDIENTS } from "./testdata.js";

const ingredients = new Map(INGREDIENTS.map((i) => [i.id, i]));

const recipe = (id: string, portions: number, lines: [string, number][], tags: string[] = []): Recipe => ({
  id,
  name: id,
  portions,
  minutes: 30,
  tags,
  method: [],
  source: "mine",
  rating: null,
  ingredients: lines.map(([ingredient_id, qty]) => ({ ingredient_id, qty })),
});

const curry = recipe("curry", 4, [["chicken", 600], ["rice", 300], ["oil", 20]], ["chicken", "batch"]);
const pasta = recipe("pasta", 1, [["pasta", 200], ["tomatoes", 4]], ["veg", "quick"]);
const recipes = new Map([curry, pasta].map((r) => [r.id, r]));

// 2026-11-16 is a Monday.
const WEEK = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"];
const [MON, TUE, WED, THU, FRI, SAT, SUN] = WEEK;

describe("packsFor", () => {
  it("rounds up to whole packs", () => {
    expect(packsFor(500, 500)).toBe(1); // exact multiple
    expect(packsFor(1000, 500)).toBe(2);
    expect(packsFor(501, 500)).toBe(2); // just over
    expect(packsFor(4, 6)).toBe(1); // each
    expect(packsFor(7, 6)).toBe(2);
    expect(packsFor(0, 6)).toBe(0);
    expect(packsFor(0.1 + 0.2, 0.3)).toBe(1); // float noise does not buy an extra pack
  });
});

describe("expandPlan", () => {
  it("fills the next nights with leftovers and skips out nights", () => {
    const { nights, wasted } = expandPlan(
      WEEK,
      [{ date: MON, kind: "cook", recipe_id: "curry" }, { date: TUE, kind: "out" }],
      recipes,
      4,
    );
    expect(nights.map((n) => n.kind)).toEqual(["cook", "out", "leftover", "leftover", "none", "none", "none"]);
    expect(nights[2]).toMatchObject({ recipe_id: "curry", cooked_from_date: MON });
    // 3 spare portions, but Tuesday is out and Friday is past the 4 day window.
    expect(wasted).toEqual([{ date: MON, recipe_id: "curry", portions: 1 }]);
  });

  it("stops at leftover_max_days and reports the wasted portions", () => {
    const { nights, wasted } = expandPlan(WEEK, [{ date: MON, kind: "cook", recipe_id: "curry" }], recipes, 2);
    expect(nights.filter((n) => n.kind === "leftover").map((n) => n.date)).toEqual([TUE]);
    expect(wasted[0].portions).toBe(2);
  });

  it("never overwrites a night that already has a meal", () => {
    const { nights, wasted } = expandPlan(
      WEEK,
      [{ date: MON, kind: "cook", recipe_id: "curry" }, { date: TUE, kind: "cook", recipe_id: "pasta" }],
      recipes,
      3,
    );
    expect(nights.map((n) => n.kind).slice(0, 4)).toEqual(["cook", "cook", "leftover", "none"]);
    expect(wasted[0].portions).toBe(2);
  });

  it("does not extend past the planned dates", () => {
    const { nights, wasted } = expandPlan([MON, TUE], [{ date: MON, kind: "cook", recipe_id: "curry" }], recipes, 5);
    expect(nights.map((n) => n.kind)).toEqual(["cook", "leftover"]);
    expect(wasted[0].portions).toBe(2);
  });

  it("rejects an unknown recipe", () => {
    expect(() => expandPlan(WEEK, [{ date: MON, kind: "cook", recipe_id: "nope" }], recipes, 3)).toThrow(/No recipe/);
  });
});

describe("requiredQuantities", () => {
  it("sums per ingredient with the first use, ignoring leftover nights", () => {
    const nights: Night[] = [
      { date: WED, kind: "cook", recipe_id: "curry", cooked_from_date: null },
      { date: THU, kind: "leftover", recipe_id: "curry", cooked_from_date: WED },
      { date: FRI, kind: "cook", recipe_id: "curry", cooked_from_date: null },
    ];
    const req = requiredQuantities(nights, recipes);
    const chicken = req.find((r) => r.ingredient_id === "chicken")!;
    expect(chicken).toMatchObject({ qty: 1200, first_use: WED });
    expect(chicken.uses).toEqual([{ date: WED, qty: 600 }, { date: FRI, qty: 600 }]);
  });
});

describe("shoppingList", () => {
  const night = (date: string, recipe_id: string): Night => ({ date, kind: "cook", recipe_id, cooked_from_date: null });

  it("rounds packs up, prices them and drops staples", () => {
    const list = shoppingList(requiredQuantities([night(MON, "curry"), night(WED, "pasta")], recipes), [], ingredients);
    expect(list.map((i) => i.ingredient_id).sort()).toEqual(["chicken", "pasta", "rice", "tomatoes"]); // no oil
    expect(list.find((i) => i.ingredient_id === "chicken")).toMatchObject({ need: 600, packs: 2, qty: 1000, est_cost: 6, first_need: MON });
    expect(list.find((i) => i.ingredient_id === "tomatoes")).toMatchObject({ packs: 1, qty: 6, est_cost: 1.2 });
  });

  it("subtracts pantry stock that is still good on the night it is needed", () => {
    const pantry: PantryLot[] = [{ ingredient_id: "chicken", qty: 300, use_by: MON }];
    const list = shoppingList(requiredQuantities([night(MON, "curry")], recipes), pantry, ingredients);
    expect(list.find((i) => i.ingredient_id === "chicken")).toMatchObject({ need: 300, packs: 1 });
  });

  it("ignores lots that expire before the night they are needed", () => {
    const pantry: PantryLot[] = [{ ingredient_id: "chicken", qty: 600, use_by: "2026-11-15" }];
    const list = shoppingList(requiredQuantities([night(MON, "curry")], recipes), pantry, ingredients);
    expect(list.find((i) => i.ingredient_id === "chicken")).toMatchObject({ need: 600, packs: 2 });
  });

  it("uses the soonest use-by lot first and lets a later lot cover a later night", () => {
    const pantry: PantryLot[] = [
      { ingredient_id: "pasta", qty: 200, use_by: null },
      { ingredient_id: "pasta", qty: 200, use_by: TUE },
    ];
    // Tuesday's pasta takes the lot that expires Tuesday; Thursday's takes the one that never expires.
    const list = shoppingList(requiredQuantities([night(TUE, "pasta"), night(THU, "pasta")], recipes), pantry, ingredients);
    expect(list.find((i) => i.ingredient_id === "pasta")).toBeUndefined();
    expect(list.find((i) => i.ingredient_id === "tomatoes")).toMatchObject({ need: 8, packs: 2 });
  });

  it("covers everything from the pantry with nothing to buy", () => {
    const pantry: PantryLot[] = [
      { ingredient_id: "pasta", qty: 500, use_by: null },
      { ingredient_id: "tomatoes", qty: 4, use_by: null },
    ];
    expect(shoppingList(requiredQuantities([night(MON, "pasta")], recipes), pantry, ingredients)).toEqual([]);
  });

  it("flags estimated ingredients", () => {
    const est = new Map(ingredients);
    est.set("pasta", { ...ingredients.get("pasta")!, estimated: true });
    const list = shoppingList(requiredQuantities([night(MON, "pasta")], recipes), [], est);
    expect(list.find((i) => i.ingredient_id === "pasta")!.estimated).toBe(true);
    expect(list.find((i) => i.ingredient_id === "tomatoes")!.estimated).toBe(false);
  });
});

describe("leftoverForecast", () => {
  it("reports bought + pantry - used and lots that would expire unused", () => {
    const req = requiredQuantities([{ date: MON, kind: "cook", recipe_id: "curry", cooked_from_date: null }], recipes);
    const pantry: PantryLot[] = [
      { ingredient_id: "rice", qty: 500, use_by: TUE },
      { ingredient_id: "tomatoes", qty: 3, use_by: WED }, // never used by the plan
    ];
    const f = leftoverForecast(req, pantry, ingredients, SUN);
    expect(f.find((l) => l.ingredient_id === "chicken")).toMatchObject({ bought: 1000, used: 600, remainder: 400, expiring: [] });
    expect(f.find((l) => l.ingredient_id === "rice")).toMatchObject({ bought: 0, pantry: 500, used: 300, remainder: 200, expiring: [{ use_by: TUE, qty: 200 }] });
    expect(f.find((l) => l.ingredient_id === "tomatoes")).toMatchObject({ used: 0, expiring: [{ use_by: WED, qty: 3 }] });
  });
});

describe("varietySummary", () => {
  it("counts tags and repeats without scoring", () => {
    const nights: Night[] = [
      { date: MON, kind: "cook", recipe_id: "curry", cooked_from_date: null },
      { date: TUE, kind: "leftover", recipe_id: "curry", cooked_from_date: MON },
      { date: WED, kind: "cook", recipe_id: "pasta", cooked_from_date: null },
      { date: THU, kind: "cook", recipe_id: "pasta", cooked_from_date: null },
      { date: FRI, kind: "out", recipe_id: null, cooked_from_date: null },
    ];
    const v = varietySummary(nights, recipes);
    expect(v.tag_counts).toEqual({ chicken: 1, batch: 1, veg: 2, quick: 2 });
    expect(v.nights_per_tag.chicken).toBe(2);
    expect(v.repeated).toEqual([{ recipe_id: "pasta", name: "pasta", times: 2 }]);
  });
});

describe("suggestShopDay", () => {
  const item = (id: string, first_need: string, last_need: string, keeps_days: number): ShoppingItem => ({
    ingredient_id: id,
    name: id,
    aisle: "x",
    unit: "g",
    need: 1,
    packs: 1,
    qty: 1,
    pack_qty: 1,
    est_cost: 1,
    estimated: false,
    keeps_days,
    first_need,
    last_need,
  });
  const nights = (...out: string[]): Night[] => WEEK.map((date) => ({ date, kind: out.includes(date) ? "out" : "cook", recipe_id: null, cooked_from_date: null }));
  const SUNDAY_BEFORE = "2026-11-15";

  it("picks the latest day on or before the first night that needs something", () => {
    const r = suggestShopDay({ nights: nights(), list: [item("a", THU, THU, 30), item("b", SAT, SAT, 30)], busyDates: [], today: SUNDAY_BEFORE });
    expect(r).toEqual({ shop_date: THU, second_shop: null, note: null });
  });

  it("avoids busy days and out nights", () => {
    const list = [item("a", THU, THU, 30)];
    expect(suggestShopDay({ nights: nights(), list, busyDates: [THU], today: SUNDAY_BEFORE }).shop_date).toBe(WED);
    expect(suggestShopDay({ nights: nights(THU), list, busyDates: [WED], today: SUNDAY_BEFORE }).shop_date).toBe(TUE);
  });

  it("is pulled earlier by whatever is needed first", () => {
    const list = [item("late", SAT, SAT, 30), item("early", TUE, TUE, 30)];
    expect(suggestShopDay({ nights: nights(), list, busyDates: [], today: SUNDAY_BEFORE }).shop_date).toBe(TUE);
  });

  it("never suggests a day before today", () => {
    const list = [item("a", MON, MON, 30)];
    expect(suggestShopDay({ nights: nights(), list, busyDates: [], today: MON }).shop_date).toBe(MON);
    const r = suggestShopDay({ nights: nights(), list, busyDates: [MON], today: MON });
    expect(r.shop_date).toBe(MON);
    expect(r.note).toMatch(/No free day/);
  });

  it("flags a second shop for a perishable that will not keep", () => {
    // Pasta from Tuesday sets the shop day; fish is first cooked Thursday, last Friday, and keeps 2 days.
    const list = [item("pasta", TUE, TUE, 365), item("fish", THU, FRI, 2)];
    const r = suggestShopDay({ nights: nights(), list, busyDates: [], today: SUNDAY_BEFORE });
    expect(r.shop_date).toBe(TUE);
    expect(r.second_shop).toEqual({ date: THU, ingredient_ids: ["fish"] });
  });

  it("does not flag a second shop when the perishable keeps long enough", () => {
    const list = [item("pasta", TUE, TUE, 365), item("fish", THU, FRI, 4)];
    expect(suggestShopDay({ nights: nights(), list, busyDates: [], today: SUNDAY_BEFORE }).second_shop).toBeNull();
  });

  it("has no shop day when nothing needs buying", () => {
    expect(suggestShopDay({ nights: nights(), list: [], busyDates: [], today: MON })).toEqual({ shop_date: null, second_shop: null, note: null });
  });
});

describe("budgetCheck", () => {
  it("flags over and under without failing", () => {
    expect(budgetCheck(62.5, 50)).toEqual({ est_cost: 62.5, weekly_budget: 50, over_budget: true, difference: 12.5 });
    expect(budgetCheck(42, 50)).toEqual({ est_cost: 42, weekly_budget: 50, over_budget: false, difference: -8 });
    expect(budgetCheck(50, 50).over_budget).toBe(false);
  });
});

describe("spreadReceipt", () => {
  it("scales each item's estimate so they add up to the receipt", () => {
    const out = spreadReceipt(
      [
        { ingredient_id: "a", packs: 2, est_cost: 6 },
        { ingredient_id: "b", packs: 1, est_cost: 4 },
      ],
      15,
    );
    expect(out).toEqual([
      { ingredient_id: "a", pack_price: 4.5 }, // 6 * 1.5 / 2
      { ingredient_id: "b", pack_price: 6 },
    ]);
  });

  it("leaves prices alone when there was nothing estimated", () => {
    expect(spreadReceipt([{ ingredient_id: "a", packs: 1, est_cost: 0 }], 10)).toEqual([]);
  });
});
