import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { MealActions } from "./actions.js";
import { settingsJsonSchema } from "./settings.js";
import type { MealsStore } from "./store.js";
import { UI_CSS, UI_HTML, UI_JS } from "./ui.js";
import { VERSION } from "./version.js";

export interface JeevesRoutesOptions {
  store: MealsStore;
  token: string;
  /** Meal actions for the views' and notifications' buttons (same side effects as the MCP tools). */
  actions: MealActions;
  now?: () => Date;
}

export const UI_PATH = "/jeeves/ui";

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const num = (description: string) => ({ type: "number", description });
const arr = (items: unknown, description?: string) => ({ type: "array", items, description });

const recipeSummarySchema = {
  type: "object",
  properties: { id: str("Recipe id"), name: str("Recipe name"), minutes: int("Minutes"), portions: int("Portions") },
};

const nightSchema = {
  type: "object",
  properties: {
    date: str("YYYY-MM-DD"),
    kind: { type: "string", enum: ["cook", "leftover", "out", "skip", "none"] },
    status: { type: "string", enum: ["planned", "cooked"] },
    recipe_id: str("Recipe id, if any"),
    name: str("Recipe name"),
    minutes: int("Minutes to cook"),
    start_at: str("HH:MM to start cooking"),
    cooked_from_date: str("For leftovers, the night it is cooked"),
  },
};

const shopItemSchema = {
  type: "object",
  properties: {
    ingredient_id: str("Ingredient id"),
    name: str("Name"),
    aisle: str("Aisle"),
    unit: str("g, ml or each"),
    packs: int("Packs to buy"),
    qty: num("Total quantity bought, in the ingredient's unit"),
    est_cost: num("Estimated cost"),
    ticked: { type: "boolean" },
    estimated: { type: "boolean", description: "Price is still a guess" },
  },
};

const budgetSchema = {
  type: "object",
  properties: {
    est_cost: num("Estimated cost"),
    weekly_budget: num("Budget"),
    over_budget: { type: "boolean" },
    difference: num("Positive when over budget, negative when under"),
  },
};

export const manifest = {
  name: "meals",
  display_name: "Meals",
  version: VERSION,
  settings_schema: settingsJsonSchema,
  ui: { path: UI_PATH, title: "Recipes" },
  events: [
    {
      type: "cooked",
      title: "Dinner cooked",
      description: "A night was marked cooked.",
      payload_schema: {
        type: "object",
        properties: { date: str("YYYY-MM-DD"), recipe_id: str("Recipe id"), name: str("Recipe name"), leftover_nights: int("Nights of leftovers this made") },
      },
    },
    {
      type: "shop_finished",
      title: "Shop finished",
      description: "A shop was finished and its items put in the pantry.",
      payload_schema: {
        type: "object",
        properties: { shop_id: int("Shop id"), date: str("Shop date"), total: num("What it cost"), est_cost: num("What it was estimated to cost") },
      },
    },
    {
      type: "plan_set",
      title: "Plan set",
      description: "The dinner plan was saved.",
      payload_schema: {
        type: "object",
        properties: {
          from: str("First night"),
          to: str("Last night"),
          shop_date: str("Suggested shop day"),
          est_cost: num("Estimated cost"),
          over_budget: { type: "boolean" },
        },
      },
    },
  ],
  // Every MCP tool is a workflow step; these give them names and describe what they return.
  steps: {
    get_tonight: {
      title: "Get tonight's dinner",
      output_schema: {
        type: "object",
        properties: {
          date: str("YYYY-MM-DD"),
          kind: { type: "string", enum: ["cook", "leftover", "out", "skip", "none"] },
          status: { type: "string", enum: ["planned", "cooked"] },
          start_at: str("HH:MM to start cooking"),
          name: str("Recipe name"),
          minutes: int("Minutes to cook"),
          pantry_covers: { type: "boolean", description: "Everything is already in the pantry" },
        },
      },
    },
    get_plan: { title: "Get the dinner plan", output_schema: { type: "object", properties: { from: str("First night"), to: str("Last night"), nights: arr(nightSchema) } } },
    list_recipes: { title: "List recipes", output_schema: arr(recipeSummarySchema) },
    get_recipe: { title: "Get a recipe" },
    get_pantry: { title: "Get the pantry" },
    get_shopping_list: {
      title: "Get the shopping list",
      output_schema: {
        type: "object",
        properties: {
          shop_id: int("Shop id, null when no shop is open"),
          date: str("Shop date"),
          open: { type: "boolean" },
          due_today: { type: "boolean", description: "The shop is today or overdue" },
          est_cost: num("Estimated cost"),
          items: arr(shopItemSchema),
        },
      },
    },
    preview_plan: {
      title: "Preview a dinner plan",
      output_schema: {
        type: "object",
        properties: {
          nights: arr(nightSchema),
          est_cost: num("Estimated cost of the shop"),
          budget: budgetSchema,
          shop_date: str("Suggested shop day"),
          estimated_ingredients: arr({ type: "string" }, "Ingredients whose price is a guess"),
        },
      },
    },
    set_plan: { title: "Save the dinner plan" },
    mark_cooked: { title: "Mark dinner cooked" },
    skip_meal: { title: "Skip a dinner" },
    mark_out: { title: "Mark a night out" },
    save_recipe: { title: "Save a recipe" },
    upsert_ingredient: { title: "Save an ingredient" },
    adjust_pantry: { title: "Adjust the pantry" },
    create_shop: { title: "Create a shopping list" },
    tick_item: { title: "Tick a shopping item" },
    finish_shop: { title: "Finish the shop" },
  },
  // Added to Claude's system prompt whenever this plugin's tools are offered.
  instructions: [
    "This plugin owns dinners for one person: recipes, the weekly plan, the pantry and the shopping list. It does all the maths",
    "(packs, cost, leftovers, use-by dates, shop day); you only choose meals. Quantities are always in an ingredient's own unit (g, ml, each).",
    "To plan a week: read the pantry first and use what expires soonest; list the recipes; draft nights; call preview_plan and iterate until",
    "the estimated cost is within the weekly budget, or say why it is not (over budget is reported, never refused). Only then set_plan, and",
    "create_shop once the user has approved. A recipe with several portions fills later nights as leftovers by itself: do not plan those",
    "nights again. Vary the tags (no tag more than 2-3 times a week), put quick recipes (low minutes) on busy nights, and use mark_out for",
    "nights out. If no calendar tools are offered, ask which nights are out or busy.",
    "Never invent prices: new ingredients from save_recipe are created estimated, and you must say in your message which prices are guesses.",
    'Message items for a night use plugin "meals" and item_id "<YYYY-MM-DD>", which gives Cooked / Skip / Out buttons. Do not attach the',
    "shopping list as items; write it into the text and point to the Shopping list view.",
    "get_tonight returns kind, status, start_at and the recipe for one night.",
  ].join("\n"),
  // Lists the app shows (GET /jeeves/views/<id>); each item carries its own buttons.
  views: [
    { id: "tonight", title: "Tonight", empty_text: "Nothing planned tonight." },
    { id: "shopping", title: "Shopping list", empty_text: "No shop open." },
  ],
  // Buttons on notifications about a night (POST /jeeves/actions). Jeeves and the app take at most three.
  item_actions: [
    { id: "cooked", label: "Cooked", style: "primary" },
    { id: "skip", label: "Skip", style: "text" },
    { id: "out", label: "Out", style: "secondary" },
  ],
};

const DATE_ITEM = /^\d{4}-\d{2}-\d{2}$/;
const TICK_ITEM = /^shop:(\d+):([a-z0-9-]+)$/;
const SHOP_ITEM = /^shop:(\d+)$/;

const actionBody = z.object({
  item: z.string().min(1).max(128),
  action: z.enum(["cooked", "skip", "out", "tick", "untick", "finish"]),
  args: z.object({ total: z.number().min(0).optional(), ticked: z.boolean().optional() }).default({}),
});

const ingredientBody = z
  .object({
    name: z.string().min(1).max(200),
    aisle: z.string().min(1).max(100).optional(),
    pack_qty: z.number().positive().optional(),
    unit: z.enum(["g", "ml", "each"]).optional(),
    pack_price: z.number().min(0).optional(),
    keeps_days: z.number().int().min(0).max(3650).optional(),
    staple: z.boolean().optional(),
    estimated: z.boolean().optional(),
  })
  .strict();

const recipeBody = z
  .object({
    name: z.string().min(1).max(200),
    portions: z.number().int().min(1).max(50).optional(),
    minutes: z.number().int().min(1).max(1440).optional(),
    tags: z.array(z.string().max(40)).optional(),
    method: z.array(z.string().max(2000)).optional(),
    source: z.string().max(500).optional(),
    rating: z.number().int().min(1).max(5).nullable().optional(),
    ingredients: z.array(z.object({ ingredient: z.string().min(1), qty: z.number().positive() }).strict()),
  })
  .strict();

const pantryBody = z
  .object({
    ingredient_id: z.string().min(1),
    qty_delta: z.number(),
    use_by: z.string().nullable().optional(),
    reason: z.enum(["cooked", "shop", "waste", "adjust"]).default("adjust"),
    note: z.string().max(500).optional(),
  })
  .strict();

type IdParams = { Params: { id: string } };

function badRequest(reply: FastifyReply, e: ZodError) {
  return reply.code(400).send({
    error: "invalid request",
    issues: e.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
  });
}

/** Maps an action's thrown error to a status: unknown things are 404, everything else is a bad request/transition. */
const statusFor = (e: Error) => (/^No .* with id|^Nothing is planned/i.test(e.message) ? 404 : 409);

/**
 * Everything Jeeves talks to besides MCP: the manifest, views, button actions, settings, and the
 * recipe manager UI with its JSON API. Registered under /jeeves and guarded by the same bearer token as /mcp.
 */
export async function jeevesRoutes(app: FastifyInstance, { store, token, actions }: JeevesRoutesOptions) {
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/manifest", async () => manifest);

  // --- views ---

  const money = (n: number) => `${store.settings().currency}${n.toFixed(2)}`;

  const tonightView = () => {
    const t = actions.getTonight();
    if ((t.kind !== "cook" && t.kind !== "leftover") || !t.recipe) return { items: [] };
    const cooked = t.status === "cooked";
    const meta = [`start ${t.start_at}`, `${t.recipe.minutes} min`, ...(t.kind === "leftover" ? ["leftover"] : [])].join(" · ");
    return {
      items: [
        {
          id: t.date,
          title: t.recipe.name,
          meta,
          note: cooked ? "Cooked" : t.pantry_covers || t.kind === "leftover" ? null : "Missing some ingredients",
          detail: t.recipe.method,
          finished: cooked,
          actions: cooked
            ? []
            : [
                { id: "cooked", label: "Cooked", style: "primary" },
                { id: "skip", label: "Skip", style: "text" },
              ],
        },
      ],
    };
  };

  const shoppingView = () => {
    const list = actions.getShoppingList();
    if (!list.shop_id || !list.open) return { items: [] };
    const items = list.items.map((i) => ({
      id: `shop:${list.shop_id}:${i.ingredient_id}`,
      title: i.name,
      meta: `${i.packs} × ${i.pack_qty} ${i.unit} · ${money(i.est_cost)}`,
      note: i.estimated ? "Price is a guess" : null,
      detail: [],
      finished: i.ticked,
      actions: [i.ticked ? { id: "untick", label: "Untick", style: "text" } : { id: "tick", label: "Tick", style: "secondary" }],
    }));
    const left = list.items.filter((i) => !i.ticked).length;
    items.push({
      id: `shop:${list.shop_id}`,
      title: "Finish shop",
      meta: `${money(list.est_cost)} estimated`,
      note: left > 0 ? `${left} not ticked will be dropped` : null,
      detail: [],
      finished: false,
      actions: [{ id: "finish", label: "Finish", style: "primary" }],
    });
    return { items };
  };

  app.get("/views/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (id === "tonight") return tonightView();
    if (id === "shopping") return shoppingView();
    return reply.code(404).send({ error: "no such view" });
  });

  /** A button tap in the app. `resolved` tells Jeeves the item is finished, so it drops follow-ups about it. */
  app.post("/actions", async (req, reply) => {
    const body = actionBody.safeParse(req.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    const { item, action, args } = body.data;
    try {
      if (DATE_ITEM.test(item)) {
        if (action === "cooked") {
          const r = actions.markCooked(item);
          return { ok: true, resolved: true, message: `Cooked ${r.name}` };
        }
        if (action === "skip") actions.skipMeal(item);
        else if (action === "out") actions.markOut(item);
        else return reply.code(400).send({ error: `${action} does not apply to a night` });
        return { ok: true, resolved: true };
      }
      const tick = TICK_ITEM.exec(item);
      if (tick) {
        if (action !== "tick" && action !== "untick") return reply.code(400).send({ error: `${action} does not apply to a shopping item` });
        actions.tickItem(Number(tick[1]), tick[2], args.ticked ?? action === "tick");
        return { ok: true, resolved: false };
      }
      const shop = SHOP_ITEM.exec(item);
      if (shop) {
        if (action !== "finish") return reply.code(400).send({ error: `${action} does not apply to a shop` });
        const r = actions.finishShop(Number(shop[1]), args.total);
        return { ok: true, resolved: true, message: `Shop finished: ${money(r.total)}` };
      }
      return reply.code(404).send({ error: `No item ${item}` });
    } catch (e) {
      return reply.code(statusFor(e as Error)).send({ error: (e as Error).message });
    }
  });

  app.get("/settings", async () => store.settings());
  app.put("/settings", async (req, reply) => {
    try {
      return { ok: true, values: store.setSettings(req.body ?? {}) };
    } catch (e) {
      if (e instanceof ZodError) return badRequest(reply, e);
      throw e;
    }
  });

  // --- Recipe, ingredient and pantry handlers, shared by the UI's GET/POST API and the REST form. ---

  const guard =
    <A extends unknown[]>(fn: (...args: A) => unknown, ok = 200) =>
    async (reply: FastifyReply, ...args: A) => {
      try {
        return reply.code(ok).send(await fn(...args));
      } catch (e) {
        if (e instanceof ZodError) return badRequest(reply, e);
        return reply.code(statusFor(e as Error) === 404 ? 404 : 400).send({ error: (e as Error).message });
      }
    };

  const listRecipes = async () => ({
    recipes: store.listRecipes().map((r) => actions.getRecipe(r.id)),
    ingredients: store.listIngredients(),
  });

  const createRecipe = async (req: FastifyRequest, reply: FastifyReply) =>
    guard(() => actions.saveRecipe(recipeBody.parse(req.body ?? {})), 201)(reply);

  const updateRecipe = async (req: FastifyRequest<IdParams>, reply: FastifyReply) =>
    guard(() => {
      if (!store.getRecipe(req.params.id)) throw new Error(`No recipe with id ${req.params.id}`);
      return actions.saveRecipe({ ...recipeBody.parse(req.body ?? {}), id: req.params.id });
    })(reply);

  const deleteRecipe = async (req: FastifyRequest<IdParams>, reply: FastifyReply) => guard(() => actions.deleteRecipe(req.params.id))(reply);

  const listIngredients = async () => ({ ingredients: store.listIngredients() });

  const createIngredient = async (req: FastifyRequest, reply: FastifyReply) =>
    guard(() => {
      const body = ingredientBody.parse(req.body ?? {});
      // Saved by a person: the price counts as known unless they say otherwise.
      return { ingredient: actions.upsertIngredient({ ...body, estimated: body.estimated ?? false }) };
    }, 201)(reply);

  const updateIngredient = async (req: FastifyRequest<IdParams>, reply: FastifyReply) =>
    guard(() => {
      if (!store.getIngredient(req.params.id)) throw new Error(`No ingredient with id ${req.params.id}`);
      const body = ingredientBody.parse(req.body ?? {});
      return { ingredient: actions.upsertIngredient({ ...body, id: req.params.id, estimated: body.estimated ?? false }) };
    })(reply);

  const deleteIngredient = async (req: FastifyRequest<IdParams>, reply: FastifyReply) => guard(() => actions.deleteIngredient(req.params.id))(reply);

  const listPantry = async () => ({ pantry: actions.getPantry() });

  const adjustPantry = async (req: FastifyRequest, reply: FastifyReply) =>
    guard(() => actions.adjustPantry(pantryBody.parse(req.body ?? {})))(reply);

  // --- Recipe manager UI. Jeeves proxies only GET/POST under /jeeves/ui/, so the page's API lives here. ---

  // Relative redirect so it also works behind Jeeves' proxy prefix.
  app.get("/ui", async (_req, reply) => reply.redirect("ui/"));
  app.get("/ui/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(UI_HTML));
  app.get("/ui/app.js", async (_req, reply) => reply.type("text/javascript; charset=utf-8").send(UI_JS));
  app.get("/ui/app.css", async (_req, reply) => reply.type("text/css; charset=utf-8").send(UI_CSS));

  app.get("/ui/api/recipes", listRecipes);
  app.post("/ui/api/recipes", createRecipe);
  app.post<IdParams>("/ui/api/recipes/:id", updateRecipe);
  app.post<IdParams>("/ui/api/recipes/:id/delete", deleteRecipe);
  app.get("/ui/api/ingredients", listIngredients);
  app.post("/ui/api/ingredients", createIngredient);
  app.post<IdParams>("/ui/api/ingredients/:id", updateIngredient);
  app.post<IdParams>("/ui/api/ingredients/:id/delete", deleteIngredient);
  app.get("/ui/api/pantry", listPantry);
  app.post("/ui/api/pantry", adjustPantry);
  app.get("/ui/api/settings", async () => store.settings());

  // --- REST form for direct use. ---

  app.get("/api/recipes", listRecipes);
  app.post("/api/recipes", createRecipe);
  app.put<IdParams>("/api/recipes/:id", updateRecipe);
  app.delete<IdParams>("/api/recipes/:id", deleteRecipe);
  app.get("/api/ingredients", listIngredients);
  app.post("/api/ingredients", createIngredient);
  app.put<IdParams>("/api/ingredients/:id", updateIngredient);
  app.delete<IdParams>("/api/ingredients/:id", deleteIngredient);
  app.get("/api/pantry", listPantry);
  app.post("/api/pantry", adjustPantry);
}
