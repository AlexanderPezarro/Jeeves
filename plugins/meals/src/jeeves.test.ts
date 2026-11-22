import { describe, expect, it } from "vitest";
import { buildApp } from "./index.js";
import type { MealEventPayload, MealEventType } from "./events.js";
import { MealsStore } from "./store.js";
import { RECIPE_INPUTS, seedIngredients } from "./testdata.js";
import { mealActions } from "./actions.js";
import { UI_HTML, UI_JS } from "./ui.js";

const TOKEN = "secret";
const auth = { authorization: `Bearer ${TOKEN}` };
const SUN = "2026-11-15";

function setup() {
  const store = new MealsStore();
  seedIngredients(store);
  const events: { type: MealEventType; payload: MealEventPayload }[] = [];
  const now = () => new Date(`${SUN}T10:00:00Z`);
  const poster = (type: MealEventType, payload: MealEventPayload) => events.push({ type, payload });
  const app = buildApp({ store, token: TOKEN, timeZone: "Europe/London", now, events: poster });
  // The same store and poster as the app, so setup done through `actions` behaves like the real thing.
  const actions = mealActions({ store, timeZone: "Europe/London", now, events: poster });
  actions.saveRecipe(RECIPE_INPUTS.curry);
  actions.saveRecipe(RECIPE_INPUTS.pasta);
  const get = async (url: string) => app.inject({ method: "GET", url, headers: auth });
  const post = async (url: string, payload: unknown) => app.inject({ method: "POST", url, headers: auth, payload: payload as object });
  return { store, app, events, actions, get, post };
}

describe("/jeeves manifest and auth", () => {
  it("returns the manifest with events, at most three item actions and two views", async () => {
    const { get } = setup();
    const res = await get("/jeeves/manifest");
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m).toMatchObject({ name: "meals", display_name: "Meals", ui: { path: "/jeeves/ui", title: "Recipes" } });
    expect(m.events.map((e: { type: string }) => e.type)).toEqual(["cooked", "shop_finished", "plan_set"]);
    expect(m.events[0].payload_schema.properties).toHaveProperty("leftover_nights");
    expect(m.item_actions.map((a: { id: string }) => a.id)).toEqual(["cooked", "skip", "out"]);
    expect(m.item_actions.length).toBeLessThanOrEqual(3);
    expect(m.views.map((v: { id: string }) => v.id)).toEqual(["tonight", "shopping"]);
    expect(m.steps.get_tonight.output_schema.properties).toHaveProperty("start_at");
    expect(m.instructions.length).toBeLessThanOrEqual(4000);
    expect(Object.keys(m.settings_schema.properties)).toEqual(["weekly_budget", "default_dinner_time", "planning_day", "leftover_max_days", "emit_events", "currency"]);
    // Every MCP tool has a step title.
    expect(Object.keys(m.steps)).toHaveLength(17);
  });

  it("rejects requests without the bearer token", async () => {
    const { app } = setup();
    for (const url of ["/jeeves/manifest", "/jeeves/views/tonight", "/jeeves/settings", "/jeeves/ui/", "/jeeves/api/recipes"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: "POST", url: "/jeeves/actions", payload: {} })).statusCode).toBe(401);
  });
});

describe("views and actions", () => {
  it("shows tonight with the method and Cooked / Skip buttons", async () => {
    const { get, actions } = setup();
    expect((await get("/jeeves/views/tonight")).json()).toEqual({ items: [] });
    actions.setPlan({ nights: [{ date: SUN, recipe_id: "curry", start_at: "19:00" }] });
    const { items } = (await get("/jeeves/views/tonight")).json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: SUN,
      title: "Chicken curry",
      meta: "start 19:00 · 45 min",
      detail: ["Fry the chicken", "Add rice"],
      finished: false,
      actions: [{ id: "cooked", style: "primary" }, { id: "skip", style: "text" }],
    });
  });

  it("shows a leftover night as such", async () => {
    const { get, actions } = setup();
    actions.setPlan({ nights: [{ date: "2026-11-14", recipe_id: "curry" }] });
    const { items } = (await get("/jeeves/views/tonight")).json();
    expect(items[0].meta).toBe("start 18:30 · 45 min · leftover");
  });

  it("cooked, skip and out resolve the item; unknown things are rejected", async () => {
    const { post, store, actions, events } = setup();
    actions.setPlan({ nights: [{ date: SUN, recipe_id: "pasta" }, { date: "2026-11-16", recipe_id: "pasta" }, { date: "2026-11-17", recipe_id: "pasta" }] });

    const cooked = await post("/jeeves/actions", { item: SUN, action: "cooked" });
    expect(cooked.json()).toMatchObject({ ok: true, resolved: true });
    expect(store.getPlanRow(SUN)!.status).toBe("cooked");
    expect(events.filter((e) => e.type === "cooked")).toHaveLength(1);

    expect((await post("/jeeves/actions", { item: "2026-11-16", action: "skip" })).json()).toMatchObject({ ok: true, resolved: true });
    expect(store.getPlanRow("2026-11-16")!.kind).toBe("skip");
    expect((await post("/jeeves/actions", { item: "2026-11-17", action: "out" })).json()).toMatchObject({ resolved: true });
    expect(store.getPlanRow("2026-11-17")!.kind).toBe("out");

    expect((await post("/jeeves/actions", { item: SUN, action: "cooked" })).statusCode).toBe(409); // already cooked
    expect((await post("/jeeves/actions", { item: "2026-12-25", action: "cooked" })).statusCode).toBe(404);
    expect((await post("/jeeves/actions", { item: SUN, action: "tick" })).statusCode).toBe(400);
    expect((await post("/jeeves/actions", { item: "nonsense", action: "cooked" })).statusCode).toBe(404);
    expect((await post("/jeeves/actions", { item: SUN, action: "explode" })).statusCode).toBe(400);
  });

  it("the shopping view ticks items and finishes the shop", async () => {
    const { get, post, actions, store, events } = setup();
    expect((await get("/jeeves/views/shopping")).json()).toEqual({ items: [] });
    actions.setPlan({ nights: [{ date: "2026-11-17", recipe_id: "curry" }] });
    const shop = actions.createShop({ from: SUN });

    const view = (await get("/jeeves/views/shopping")).json();
    expect(view.items.map((i: { id: string }) => i.id)).toEqual([`shop:${shop.shop_id}:rice`, `shop:${shop.shop_id}:chicken`, `shop:${shop.shop_id}`]);
    expect(view.items[1]).toMatchObject({ title: "Chicken", meta: "2 × 500 g · £6.00", finished: false, actions: [{ id: "tick" }] });
    expect(view.items[2]).toMatchObject({ title: "Finish shop", actions: [{ id: "finish", style: "primary" }] });

    const tick = await post("/jeeves/actions", { item: `shop:${shop.shop_id}:chicken`, action: "tick" });
    expect(tick.json()).toMatchObject({ ok: true, resolved: false });
    const after = (await get("/jeeves/views/shopping")).json();
    expect(after.items[1]).toMatchObject({ finished: true, actions: [{ id: "untick" }] });
    expect((await post("/jeeves/actions", { item: `shop:${shop.shop_id}:chicken`, action: "untick" })).json().resolved).toBe(false);
    expect(store.shopItems(shop.shop_id).every((i) => !i.ticked)).toBe(true);
    await post("/jeeves/actions", { item: `shop:${shop.shop_id}:chicken`, action: "tick" });

    const done = await post("/jeeves/actions", { item: `shop:${shop.shop_id}`, action: "finish", args: { total: 6.5 } });
    expect(done.json()).toMatchObject({ ok: true, resolved: true });
    expect(events.at(-1)).toMatchObject({ type: "shop_finished", payload: { shop_id: shop.shop_id, total: 6.5 } });
    expect((await get("/jeeves/views/shopping")).json()).toEqual({ items: [] });
    expect((await post("/jeeves/actions", { item: `shop:${shop.shop_id}`, action: "finish" })).statusCode).toBe(409);
    expect((await post("/jeeves/actions", { item: "shop:99", action: "finish" })).statusCode).toBe(404);
    expect((await get("/jeeves/views/nope")).statusCode).toBe(404);
  });
});

describe("/jeeves settings", () => {
  it("returns defaults, accepts a full replacement and rejects bad values", async () => {
    const { app, get } = setup();
    expect((await get("/jeeves/settings")).json()).toEqual({
      weekly_budget: 50,
      default_dinner_time: "18:30",
      planning_day: "sun",
      leftover_max_days: 3,
      emit_events: true,
      currency: "£",
    });
    const put = await app.inject({ method: "PUT", url: "/jeeves/settings", headers: auth, payload: { weekly_budget: 60, default_dinner_time: "19:00", emit_events: false } });
    expect(put.json()).toMatchObject({ ok: true, values: { weekly_budget: 60, default_dinner_time: "19:00", emit_events: false, leftover_max_days: 3 } });
    expect((await get("/jeeves/settings")).json().weekly_budget).toBe(60);
    for (const bad of [{ default_dinner_time: "7pm" }, { planning_day: "someday" }, { leftover_max_days: 0 }, { weekly_budget: "lots" }, { unknown: 1 }]) {
      expect((await app.inject({ method: "PUT", url: "/jeeves/settings", headers: auth, payload: bad })).statusCode).toBe(400);
    }
  });

  it("emit_events off stops events being posted", async () => {
    const { app, events, actions } = setup();
    actions.setPlan({ nights: [{ date: SUN, recipe_id: "pasta" }] });
    expect(events.map((e) => e.type)).toEqual(["plan_set"]);
    await app.inject({ method: "PUT", url: "/jeeves/settings", headers: auth, payload: { emit_events: false } });
    actions.markCooked(SUN);
    expect(events.map((e) => e.type)).toEqual(["plan_set"]);
  });
});

describe("recipe manager UI and API", () => {
  it("serves the page, script and styles, and redirects /ui", async () => {
    const { app, get } = setup();
    const redirect = await app.inject({ method: "GET", url: "/jeeves/ui", headers: auth });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe("ui/");
    const page = await get("/jeeves/ui/");
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toBe(UI_HTML);
    expect((await get("/jeeves/ui/app.js")).body).toBe(UI_JS);
    expect((await get("/jeeves/ui/app.css")).headers["content-type"]).toContain("text/css");
    expect(UI_HTML).toContain('href="app.css"');
    expect(UI_JS).not.toContain("`"); // the script lives inside a template literal
  });

  it("creates, edits and deletes recipes through the UI API", async () => {
    const { get, post } = setup();
    const created = await post("/jeeves/ui/api/recipes", {
      name: "Veg chilli",
      portions: 3,
      minutes: 40,
      tags: ["Veg"],
      method: ["Chop", "Simmer"],
      rating: 4,
      ingredients: [{ ingredient: "tomatoes", qty: 6 }, { ingredient: "Kidney beans", qty: 2 }],
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ recipe: { id: "veg-chilli", tags: ["veg"], rating: 4 }, new_ingredients: ["Kidney beans"] });

    const list = (await get("/jeeves/ui/api/recipes")).json();
    expect(list.recipes.map((r: { id: string }) => r.id)).toContain("veg-chilli");
    expect(list.ingredients.find((i: { id: string }) => i.id === "kidney-beans")).toMatchObject({ estimated: true });

    const edited = await post("/jeeves/ui/api/recipes/veg-chilli", { name: "Veg chilli", minutes: 35, ingredients: [{ ingredient: "tomatoes", qty: 4 }] });
    expect(edited.json().recipe).toMatchObject({ minutes: 35, ingredients: [{ ingredient_id: "tomatoes", qty: 4 }] });
    expect((await post("/jeeves/ui/api/recipes/nope", { name: "x", ingredients: [] })).statusCode).toBe(404);
    expect((await post("/jeeves/ui/api/recipes", { name: "", ingredients: [] })).statusCode).toBe(400);
    expect((await post("/jeeves/ui/api/recipes", { name: "Bad", ingredients: [{ ingredient: "tomatoes", qty: -1 }] })).statusCode).toBe(400);

    expect((await post("/jeeves/ui/api/recipes/veg-chilli/delete", {})).statusCode).toBe(200);
    expect((await post("/jeeves/ui/api/recipes/veg-chilli/delete", {})).statusCode).toBe(404);
  });

  it("saving an ingredient by hand clears its estimated flag", async () => {
    const { store, post, get } = setup();
    await post("/jeeves/ui/api/recipes", { name: "Soup", ingredients: [{ ingredient: "Leeks", qty: 2 }] });
    expect(store.getIngredient("leeks")!.estimated).toBe(true);
    const saved = await post("/jeeves/ui/api/ingredients/leeks", { name: "Leeks", aisle: "Veg", pack_qty: 3, unit: "each", pack_price: 1.1, keeps_days: 6, staple: false });
    expect(saved.json().ingredient).toMatchObject({ id: "leeks", aisle: "Veg", pack_price: 1.1, estimated: false });
    expect((await get("/jeeves/ui/api/ingredients")).json().ingredients.filter((i: { estimated: boolean }) => i.estimated)).toEqual([]);

    const added = await post("/jeeves/ui/api/ingredients", { name: "Basil", pack_qty: 30, unit: "g", pack_price: 0.9 });
    expect(added.statusCode).toBe(201);
    // An ingredient a recipe still uses can't be deleted.
    expect((await post("/jeeves/ui/api/ingredients/leeks/delete", {})).statusCode).toBe(400);
    expect((await post("/jeeves/ui/api/ingredients/basil/delete", {})).statusCode).toBe(200);
  });

  it("lists and adjusts the pantry, including a waste entry", async () => {
    const { post, get, store } = setup();
    expect((await get("/jeeves/ui/api/pantry")).json()).toEqual({ pantry: [] });
    const add = await post("/jeeves/ui/api/pantry", { ingredient_id: "fish", qty_delta: 300, use_by: "2026-11-16", reason: "shop" });
    expect(add.statusCode).toBe(200);
    const pantry = (await get("/jeeves/ui/api/pantry")).json().pantry;
    expect(pantry).toMatchObject([{ name: "Fish", qty: 300, use_by: "2026-11-16", days_left: 1, past_use_by: false }]);
    await post("/jeeves/ui/api/pantry", { ingredient_id: "fish", qty_delta: -300, reason: "waste", note: "off" });
    expect(store.pantryLots()).toEqual([]);
    expect(store.pantryLog().at(-1)).toMatchObject({ reason: "waste", note: "off" });
    expect((await post("/jeeves/ui/api/pantry", { ingredient_id: "nope", qty_delta: 1 })).statusCode).toBe(404);
  });

  it("mirrors the API under /api", async () => {
    const { get, post, app } = setup();
    expect((await get("/jeeves/api/recipes")).json().recipes).toHaveLength(2);
    const created = await post("/jeeves/api/recipes", { name: "Toast", ingredients: [{ ingredient: "pasta", qty: 10 }] });
    expect(created.statusCode).toBe(201);
    const put = await app.inject({ method: "PUT", url: "/jeeves/api/recipes/toast", headers: auth, payload: { name: "Toast", minutes: 5, ingredients: [{ ingredient: "pasta", qty: 20 }] } });
    expect(put.json().recipe.minutes).toBe(5);
    expect((await app.inject({ method: "DELETE", url: "/jeeves/api/recipes/toast", headers: auth })).statusCode).toBe(200);
  });
});
