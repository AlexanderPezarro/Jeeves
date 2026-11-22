import { describe, expect, it } from "vitest";
import { mealActions } from "./actions.js";
import type { MealEventPayload, MealEventType } from "./events.js";
import { MealsStore } from "./store.js";
import { RECIPE_INPUTS, seedIngredients } from "./testdata.js";

const SUN = "2026-11-15";
const MON = "2026-11-16";
const TUE = "2026-11-17";
const WED = "2026-11-18";

function setup() {
  const store = new MealsStore();
  seedIngredients(store);
  const events: { type: MealEventType; payload: MealEventPayload }[] = [];
  const clock = { now: new Date(`${SUN}T10:00:00Z`) };
  const actions = mealActions({ store, timeZone: "Europe/London", now: () => clock.now, events: (type, payload) => events.push({ type, payload }) });
  actions.saveRecipe(RECIPE_INPUTS.curry);
  actions.saveRecipe(RECIPE_INPUTS.pasta);
  actions.saveRecipe(RECIPE_INPUTS.fish);
  return { store, actions, events, clock };
}

describe("markCooked", () => {
  it("deducts from the soonest use-by lot first and logs it", () => {
    const { store, actions } = setup();
    actions.adjustPantry({ ingredient_id: "chicken", qty_delta: 500, use_by: "2026-11-20", reason: "adjust" });
    actions.adjustPantry({ ingredient_id: "chicken", qty_delta: 400, use_by: "2026-11-17", reason: "adjust" });
    actions.setPlan({ nights: [{ date: MON, recipe_id: "curry" }] });

    const r = actions.markCooked(MON);
    expect(r.deducted.find((d) => d.ingredient_id === "chicken")).toMatchObject({ qty: 600, short: 0 });

    // The 400 g lot that expires first is gone; 300 g of the later lot is left.
    expect(store.pantryLots().filter((l) => l.ingredient_id === "chicken")).toMatchObject([{ qty: 300, use_by: "2026-11-20" }]);
    const log = store.pantryLog().filter((l) => l.reason === "cooked");
    expect(log).toMatchObject([{ ingredient_id: "chicken", qty_delta: -600, note: "Chicken curry" }]);
    // Rice and oil were not in the pantry: nothing to log, shortfall reported.
    expect(r.deducted.find((d) => d.ingredient_id === "oil")).toMatchObject({ qty: 0, short: 20 });
    expect(store.getPlanRow(MON)!.status).toBe("cooked");
  });

  it("creates any missing leftover nights and reports them in the event", () => {
    const { store, actions, events } = setup();
    // A cook night with no leftover rows, as if it had been entered by hand.
    store.putPlanRow({ date: MON, kind: "cook", recipe_id: "curry", start_at: null, status: "planned", cooked_from_date: null });
    store.putPlanRow({ date: TUE, kind: "out", recipe_id: null, start_at: null, status: "planned", cooked_from_date: null });

    const r = actions.markCooked(MON);
    expect(r.leftover_nights).toBe(1); // Tuesday is taken and the window is 3 days, so only Wednesday is free
    expect(store.planRange(MON, "2026-11-20").map((p) => [p.date, p.kind])).toEqual([
      [MON, "cook"],
      [TUE, "out"],
      [WED, "leftover"],
    ]);
    expect(events).toEqual([{ type: "cooked", payload: { date: MON, recipe_id: "curry", name: "Chicken curry", leftover_nights: r.leftover_nights } }]);
  });

  it("rejects a second cook, an out night and an empty night", () => {
    const { actions } = setup();
    actions.setPlan({ nights: [{ date: MON, recipe_id: "pasta" }, { date: TUE, kind: "out" }] });
    actions.markCooked(MON);
    expect(() => actions.markCooked(MON)).toThrow(/already cooked/);
    expect(() => actions.markCooked(TUE)).toThrow(/out night/);
    expect(() => actions.markCooked(WED)).toThrow(/Nothing is planned/);
  });

  it("marking a leftover night eaten takes nothing from the pantry", () => {
    const { store, actions, events } = setup();
    actions.setPlan({ nights: [{ date: MON, recipe_id: "curry" }] });
    actions.markCooked(MON);
    const logged = store.pantryLog().length;
    const r = actions.markCooked(TUE);
    expect(r).toMatchObject({ kind: "leftover", leftover_nights: 0 });
    expect(store.pantryLog()).toHaveLength(logged);
    expect(events.map((e) => e.type)).toEqual(["plan_set", "cooked", "cooked"]);
  });
});

describe("setPlan", () => {
  it("keeps cooked nights and the leftovers of a cooked night", () => {
    const { store, actions } = setup();
    actions.setPlan({ nights: [{ date: MON, recipe_id: "curry" }] });
    actions.markCooked(MON);
    const r = actions.setPlan({ from: MON, to: "2026-11-20", nights: [{ date: MON, recipe_id: "pasta" }, { date: TUE, recipe_id: "pasta" }, { date: "2026-11-19", recipe_id: "fish" }] });
    expect(r.kept_dates).toEqual([MON, TUE, WED]);
    expect(store.getPlanRow(MON)).toMatchObject({ kind: "cook", recipe_id: "curry", status: "cooked" });
    expect(store.getPlanRow(TUE)).toMatchObject({ kind: "leftover", recipe_id: "curry" });
    expect(store.getPlanRow("2026-11-19")).toMatchObject({ kind: "cook", recipe_id: "fish", status: "planned" });
  });

  it("replaces planned nights and removes ones no longer chosen", () => {
    const { store, actions } = setup();
    actions.setPlan({ nights: [{ date: MON, recipe_id: "curry" }] });
    expect(store.planRange(MON, "2026-11-22")).toHaveLength(3); // cook + 2 leftovers
    actions.setPlan({ from: MON, to: "2026-11-22", nights: [{ date: TUE, recipe_id: "pasta" }] });
    expect(store.planRange(MON, "2026-11-22").map((p) => p.date)).toEqual([TUE]);
  });

  it("emits plan_set with the shop day and budget flag", () => {
    const { actions, events } = setup();
    actions.setPlan({ nights: [{ date: "2026-11-17", recipe_id: "curry" }] });
    expect(events[0]).toMatchObject({ type: "plan_set", payload: { from: TUE, to: "2026-11-23", shop_date: TUE, est_cost: 7.5, over_budget: false } });
  });

  it("rejects unknown recipes and a cook night without one", () => {
    const { actions } = setup();
    expect(() => actions.setPlan({ nights: [{ date: MON, recipe_id: "nope" }] })).toThrow(/No recipe/);
    expect(() => actions.setPlan({ nights: [{ date: MON }] })).toThrow(/needs a recipe_id/);
  });

  it("skipping or going out of a cook night frees its leftovers", () => {
    const { store, actions } = setup();
    actions.setPlan({ nights: [{ date: MON, recipe_id: "curry" }] });
    actions.markOut(MON);
    expect(store.planRange(MON, "2026-11-22").map((p) => [p.date, p.kind])).toEqual([[MON, "out"]]);
    actions.skipMeal(TUE);
    expect(store.getPlanRow(TUE)!.kind).toBe("skip");
  });
});

describe("saveRecipe", () => {
  it("creates unknown ingredients flagged as estimated, and reports them", () => {
    const { store, actions } = setup();
    const r = actions.saveRecipe({ name: "Soup", portions: 2, ingredients: [{ ingredient: "Leeks", qty: 3 }, { ingredient: "pasta", qty: 100 }] });
    expect(r.new_ingredients).toEqual(["Leeks"]);
    expect(store.getIngredient("leeks")).toMatchObject({ estimated: true, unit: "each", pack_price: 0 });
    expect(store.getIngredient("pasta")!.estimated).toBe(false);
    expect(r.recipe.ingredients.map((i) => i.name)).toEqual(["Leeks", "Pasta"]);
  });

  it("matches existing ingredients by name, ignoring case", () => {
    const { store, actions } = setup();
    actions.saveRecipe({ name: "More chicken", ingredients: [{ ingredient: "CHICKEN", qty: 100 }] });
    expect(store.listIngredients().filter((i) => i.name.toLowerCase() === "chicken")).toHaveLength(1);
  });
});

describe("shops", () => {
  function shopSetup() {
    const s = setup();
    s.actions.setPlan({ nights: [{ date: "2026-11-17", recipe_id: "curry" }, { date: "2026-11-19", recipe_id: "pasta" }] });
    s.store.setPackPrice("chicken", 3, true); // price still a guess
    return s;
  }

  it("builds a shop from the plan, grouped by aisle", () => {
    const { actions } = shopSetup();
    const shop = actions.createShop({ from: MON, to: "2026-11-22" });
    expect(shop).toMatchObject({ open: true, date: TUE, est_cost: 9.7 });
    expect(shop.aisles.map((a) => a.aisle)).toEqual(["Dry", "Meat", "Veg"]);
    expect(actions.getShoppingList().shop_id).toBe(shop.shop_id);
    expect(() => actions.createShop({ from: "2026-12-01", to: "2026-12-07" })).toThrow(/Nothing to buy/);
  });

  it("creates pantry lots with use_by, re-prices from the receipt and drops unticked items", () => {
    const { store, actions, events } = shopSetup();
    const shop = actions.createShop({ from: MON, to: "2026-11-22", date: MON });
    for (const id of ["chicken", "rice", "pasta"]) actions.tickItem(shop.shop_id, id, true);
    actions.tickItem(shop.shop_id, "pasta", false);
    actions.tickItem(shop.shop_id, "pasta", true);

    const r = actions.finishShop(shop.shop_id, 12);
    expect(r.dropped).toEqual(["Tomatoes"]);
    expect(r.total).toBe(12);

    const chicken = store.pantryLots().find((l) => l.ingredient_id === "chicken")!;
    expect(chicken).toMatchObject({ qty: 1000, use_by: "2026-11-18", added_on: SUN }); // bought today (the shop day is still ahead) + 3 days
    expect(store.pantryLots().find((l) => l.ingredient_id === "rice")).toMatchObject({ qty: 1000, use_by: "2027-11-15" });
    expect(store.pantryLots().find((l) => l.ingredient_id === "tomatoes")).toBeUndefined();

    // Ticked estimates were 6 + 1.5 + 1 = 8.5 and the receipt says 12, so everything scales by 12 / 8.5.
    expect(store.getIngredient("chicken")).toMatchObject({ pack_price: 4.24, estimated: false }); // 6 * 12/8.5 / 2 packs
    expect(store.getIngredient("rice")!.pack_price).toBe(2.12);
    expect(store.getIngredient("tomatoes")!.pack_price).toBe(1.2); // not bought, untouched
    expect(store.getShop(shop.shop_id)).toMatchObject({ actual_total: 12 });
    expect(store.shopItems(shop.shop_id).map((i) => i.ingredient_id).sort()).toEqual(["chicken", "pasta", "rice"]);
    expect(store.pantryLog().filter((l) => l.reason === "shop")).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: "shop_finished", payload: { shop_id: shop.shop_id, date: MON, total: 12, est_cost: 9.7 } });
  });

  it("leaves prices alone without a receipt total", () => {
    const { store, actions } = shopSetup();
    const shop = actions.createShop({ from: MON, to: "2026-11-22", date: MON });
    actions.tickItem(shop.shop_id, "chicken", true);
    const r = actions.finishShop(shop.shop_id);
    expect(r.repriced).toBe(false);
    expect(store.getIngredient("chicken")).toMatchObject({ pack_price: 3, estimated: true });
  });

  it("refuses to finish or tick a finished shop, or an unknown one", () => {
    const { actions } = shopSetup();
    const shop = actions.createShop({ from: MON, to: "2026-11-22" });
    actions.finishShop(shop.shop_id);
    expect(() => actions.finishShop(shop.shop_id)).toThrow(/already finished/);
    expect(() => actions.tickItem(shop.shop_id, "chicken", true)).toThrow(/already finished/);
    expect(() => actions.finishShop(999)).toThrow(/No shop/);
  });
});

describe("adjustPantry and tonight", () => {
  it("logs waste and reports a shortfall instead of going negative", () => {
    const { store, actions } = setup();
    actions.adjustPantry({ ingredient_id: "fish", qty_delta: 300, use_by: null, reason: "shop" });
    const r = actions.adjustPantry({ ingredient_id: "fish", qty_delta: -500, reason: "waste", note: "off" });
    expect(r).toMatchObject({ qty_delta: -300, short: 200 });
    expect(store.pantryLots()).toEqual([]);
    expect(store.pantryLog().at(-1)).toMatchObject({ reason: "waste", qty_delta: -300, note: "off" });
    expect(() => actions.adjustPantry({ ingredient_id: "nope", qty_delta: 1, reason: "adjust" })).toThrow(/No ingredient/);
  });

  it("get_tonight shows the recipe, start time and whether the pantry covers it", () => {
    const { actions } = setup();
    actions.setPlan({ nights: [{ date: SUN, recipe_id: "pasta", start_at: "19:15" }] });
    expect(actions.getTonight()).toMatchObject({ date: SUN, kind: "cook", start_at: "19:15", pantry_covers: false, name: "Tomato pasta", status: "planned" });
    actions.adjustPantry({ ingredient_id: "pasta", qty_delta: 500, reason: "adjust", use_by: null });
    actions.adjustPantry({ ingredient_id: "tomatoes", qty_delta: 6, reason: "adjust", use_by: null });
    expect(actions.getTonight().pantry_covers).toBe(true);
    expect(actions.getTonight("2026-11-30")).toMatchObject({ kind: "none", start_at: "18:30", recipe: null });
  });
});
