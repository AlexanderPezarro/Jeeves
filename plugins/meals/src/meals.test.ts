import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "./index.js";
import { MealsStore } from "./store.js";
import { seedIngredients } from "./testdata.js";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const NOW = new Date("2026-11-15T10:00:00Z"); // a Sunday

async function connect() {
  const store = new MealsStore();
  seedIngredients(store);
  const app = buildApp({ store, token: "secret", timeZone: "Europe/London", now: () => NOW });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { Authorization: "Bearer secret" } } }));
  closers.push(() => app.close(), () => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0].text;
    return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) };
  };
  return { client, call, store };
}

describe("MCP endpoint", () => {
  it("exposes the meal tools, reads flagged read-only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "adjust_pantry", "create_shop", "finish_shop", "get_pantry", "get_plan", "get_recipe", "get_shopping_list", "get_tonight",
        "list_recipes", "mark_cooked", "mark_out", "preview_plan", "save_recipe", "set_plan", "skip_meal", "tick_item", "upsert_ingredient",
      ].sort(),
    );
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(["get_pantry", "get_plan", "get_recipe", "get_shopping_list", "get_tonight", "list_recipes", "preview_plan"]);
  });

  it("plans a night end to end: save, preview, set, tonight, cooked", async () => {
    const { call } = await connect();
    const saved = await call("save_recipe", {
      name: "Chicken curry",
      portions: 4,
      minutes: 45,
      tags: ["chicken"],
      method: ["Fry", "Simmer"],
      ingredients: [{ ingredient: "chicken", qty: 600 }, { ingredient: "Curry paste", qty: 1 }],
    });
    expect(saved.json).toMatchObject({ recipe: { id: "chicken-curry", source: "claude" }, new_ingredients: ["Curry paste"] });

    const preview = await call("preview_plan", { from: "2026-11-15", nights: [{ date: "2026-11-15", recipe_id: "chicken-curry" }] });
    expect(preview.json).toMatchObject({
      est_cost: 6, // chicken 2 packs; the curry paste has no price yet
      budget: { over_budget: false },
      shop_date: "2026-11-15",
      estimated_ingredients: ["Curry paste"],
    });
    expect(preview.json.nights.map((n: { kind: string }) => n.kind)).toEqual(["cook", "leftover", "leftover", "none", "none", "none", "none"]);
    expect(preview.json.nights[0]).toMatchObject({ date: "2026-11-15", start_at: "18:30" });
    // Previewing writes nothing.
    expect((await call("get_tonight")).json).toMatchObject({ kind: "none" });

    expect((await call("set_plan", { nights: [{ date: "2026-11-15", recipe_id: "chicken-curry", start_at: "19:00" }] })).isError).toBe(false);
    expect((await call("get_tonight")).json).toMatchObject({ kind: "cook", start_at: "19:00", name: "Chicken curry", status: "planned" });
    expect((await call("get_plan", { from: "2026-11-15", to: "2026-11-17" })).json.nights.map((n: { kind: string }) => n.kind)).toEqual(["cook", "leftover", "leftover"]);

    const shop = await call("create_shop", { from: "2026-11-15" });
    expect(shop.json).toMatchObject({ open: true, items: [{ ingredient_id: "chicken", packs: 2 }, { ingredient_id: "curry-paste", packs: 1 }] });
    expect((await call("get_shopping_list")).json.shop_id).toBe(shop.json.shop_id);

    expect((await call("mark_cooked", { date: "2026-11-15" })).json).toMatchObject({ leftover_nights: 2 });
    expect((await call("get_tonight")).json.status).toBe("cooked");
    expect((await call("list_recipes", { tag: "chicken" })).json).toHaveLength(1);
    expect((await call("list_recipes", { max_minutes: 10 })).json).toEqual([]);
  });

  it("reports errors as tool errors, and over budget as a flag", async () => {
    const { call, store } = await connect();
    expect((await call("get_recipe", { recipe_id: "nope" })).isError).toBe(true);
    expect((await call("set_plan", { nights: [{ date: "2026-11-15", recipe_id: "nope" }] })).isError).toBe(true);
    expect((await call("mark_cooked", { date: "2026-11-15" })).isError).toBe(true);

    store.setSettings({ weekly_budget: 1 });
    await call("save_recipe", { id: "fish", name: "Fish", portions: 1, ingredients: [{ ingredient: "fish", qty: 300 }] });
    const p = await call("preview_plan", { nights: [{ date: "2026-11-15", recipe_id: "fish" }] });
    expect(p.isError).toBe(false);
    expect(p.json.budget).toMatchObject({ over_budget: true, difference: 3 });
  });

  it("rejects requests without the token", async () => {
    const app = buildApp({ store: new MealsStore(), token: "secret", timeZone: "Europe/London" });
    expect((await app.inject({ method: "POST", url: "/mcp", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/mcp" })).statusCode).toBe(405);
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
  });
});
