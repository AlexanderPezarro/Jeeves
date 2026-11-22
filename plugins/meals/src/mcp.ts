import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mealActions, type ActionDeps } from "./actions.js";
import { VERSION } from "./version.js";

export type McpDeps = ActionDeps;

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const fail = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

/** Runs an action, turning a thrown error (unknown id, bad transition) into a tool error. */
const attempt = async (fn: () => unknown) => {
  try {
    return json(await fn());
  } catch (e) {
    return fail((e as Error).message);
  }
};

const date = z.string().describe("YYYY-MM-DD");
const unit = z.enum(["g", "ml", "each"]).describe("Quantities are always in the ingredient's own unit and never converted");

const night = z.object({
  date,
  kind: z.enum(["cook", "out", "skip"]).optional().describe("Defaults to cook. out = eating out, skip = no dinner."),
  recipe_id: z.string().optional().describe("Required for cook nights"),
  start_at: z.string().optional().describe("HH:MM to start cooking; defaults to the default dinner time"),
});

/**
 * Builds the MCP server the Jeeves control plane talks to. A fresh server is built per request
 * (stateless HTTP), so this must stay cheap.
 */
export function buildMcpServer(deps: McpDeps): McpServer {
  const actions = mealActions(deps);
  const server = new McpServer({ name: "jeeves-meals", version: VERSION });
  const read = { readOnlyHint: true };

  server.registerTool(
    "get_tonight",
    {
      description:
        "Tonight's dinner (or another date's): kind (cook, leftover, out, skip or none), status, the recipe with method and ingredients, " +
        "start_at (HH:MM) and whether the pantry already covers it.",
      inputSchema: { date: date.optional().describe("Defaults to today") },
      annotations: read,
    },
    async ({ date }) => attempt(() => actions.getTonight(date)),
  );

  server.registerTool(
    "get_plan",
    {
      description: "The dinner plan for a date range (default: 7 days from today), one entry per night, plus the open shop if any.",
      inputSchema: { from: date.optional(), to: date.optional().describe("Defaults to 6 days after from") },
      annotations: read,
    },
    async ({ from, to }) => attempt(() => actions.getPlan(from, to)),
  );

  server.registerTool(
    "list_recipes",
    {
      description: "The recipe library, filtered. Returns id, name, portions, minutes, tags and rating; use get_recipe for ingredients and method.",
      inputSchema: {
        tag: z.string().optional(),
        text: z.string().optional().describe("Matches the recipe name or an ingredient name"),
        max_minutes: z.number().int().optional(),
        min_rating: z.number().int().optional(),
      },
      annotations: read,
    },
    async (filter) => attempt(() => actions.listRecipes(filter)),
  );

  server.registerTool(
    "get_recipe",
    {
      description: "One recipe in full: ingredients (qty in each ingredient's unit, for the whole recipe), method steps, portions and rating.",
      inputSchema: { recipe_id: z.string() },
      annotations: read,
    },
    async ({ recipe_id }) => attempt(() => actions.getRecipe(recipe_id)),
  );

  server.registerTool(
    "get_pantry",
    {
      description: "What is in the pantry, one row per lot, soonest use-by first. qty is in the ingredient's unit.",
      inputSchema: {},
      annotations: read,
    },
    async () => attempt(() => actions.getPantry()),
  );

  server.registerTool(
    "get_shopping_list",
    {
      description: "The open shop (or a given one), grouped by aisle, with pack counts, estimated cost and what is ticked. due_today says the shop is today or overdue.",
      inputSchema: { shop_id: z.number().int().optional() },
      annotations: read,
    },
    async ({ shop_id }) => attempt(() => actions.getShoppingList(shop_id)),
  );

  server.registerTool(
    "preview_plan",
    {
      description:
        "Works out a draft plan without saving it: the full list of nights (batch-cooked recipes automatically fill later nights as leftovers), " +
        "the shopping list after the pantry, estimated cost against the weekly budget, leftover and expiry forecast, tag variety, and the best shop day " +
        "(with a second shop if a perishable would not keep). Going over budget is reported in budget.over_budget, never refused. Writes nothing.",
      inputSchema: {
        from: date.optional().describe("First night; defaults to the earliest night given"),
        to: date.optional().describe("Last night; defaults to 6 days after from"),
        nights: z.array(night).describe("Only the nights you choose: cook, out or skip. Leave leftover nights out; they are filled in."),
        busy_dates: z.array(date).optional().describe("Days that cannot be a shop day"),
      },
      annotations: read,
    },
    async (input) => attempt(() => actions.previewPlan(input)),
  );

  server.registerTool(
    "set_plan",
    {
      description:
        "Saves the dinner plan: replaces the planned nights between from and to (nights already cooked are kept). Same input as preview_plan. " +
        "Leftover nights are filled in automatically. Sends a plan_set event. Run preview_plan first.",
      inputSchema: { from: date.optional(), to: date.optional(), nights: z.array(night) },
    },
    async (input) => attempt(() => actions.setPlan(input)),
  );

  server.registerTool(
    "mark_cooked",
    {
      description: "Mark a night cooked. Takes the recipe's quantities out of the pantry (soonest use-by first) and creates any missing leftover nights.",
      inputSchema: { date },
    },
    async ({ date }) => attempt(() => actions.markCooked(date)),
  );

  server.registerTool(
    "skip_meal",
    { description: "Skip a night: no dinner. Leftovers waiting on that cook night are released.", inputSchema: { date } },
    async ({ date }) => attempt(() => actions.skipMeal(date)),
  );

  server.registerTool(
    "mark_out",
    { description: "Mark a night as eating out. Leftovers waiting on that cook night are released.", inputSchema: { date } },
    async ({ date }) => attempt(() => actions.markOut(date)),
  );

  server.registerTool(
    "save_recipe",
    {
      description:
        "Create or replace a recipe. Ingredients are given by id or name with qty for the whole recipe in the ingredient's unit (g, ml or each). " +
        "Unknown ingredient names are created flagged as estimated; never invent prices, leave pack_price out unless you know it.",
      inputSchema: {
        id: z.string().optional().describe("Omit to create; give an existing id to replace that recipe"),
        name: z.string(),
        portions: z.number().int().min(1).optional(),
        minutes: z.number().int().min(1).optional(),
        tags: z.array(z.string()).optional(),
        method: z.array(z.string()).optional().describe("One step per entry"),
        source: z.string().optional().describe("'claude' (default here), 'mine' or a URL"),
        rating: z.number().int().min(1).max(5).nullable().optional(),
        ingredients: z.array(
          z.object({
            ingredient: z.string().describe("Ingredient id or name"),
            qty: z.number().positive(),
            unit: unit.optional().describe("Only used when the ingredient has to be created"),
            aisle: z.string().optional(),
            pack_qty: z.number().positive().optional(),
            pack_price: z.number().min(0).optional(),
            keeps_days: z.number().int().min(0).optional(),
            staple: z.boolean().optional(),
          }),
        ),
      },
    },
    async (input) => attempt(() => actions.saveRecipe({ ...input, source: input.source ?? "claude" })),
  );

  server.registerTool(
    "upsert_ingredient",
    {
      description:
        "Create or update an ingredient (matched by id or name). pack_qty is in the ingredient's unit; pack_price is for one pack. " +
        "New ingredients are flagged estimated unless you pass estimated: false.",
      inputSchema: {
        id: z.string().optional(),
        name: z.string(),
        aisle: z.string().optional(),
        pack_qty: z.number().positive().optional(),
        unit: unit.optional(),
        pack_price: z.number().min(0).optional(),
        keeps_days: z.number().int().min(0).optional().describe("Days it keeps after buying"),
        staple: z.boolean().optional().describe("Assumed always in the cupboard; never on the shopping list"),
        estimated: z.boolean().optional(),
      },
    },
    async (input) => attempt(() => actions.upsertIngredient(input)),
  );

  server.registerTool(
    "adjust_pantry",
    {
      description:
        "Add stock (positive qty_delta, in the ingredient's unit, optionally with use_by) or remove it (negative, soonest use-by first). " +
        "Use reason 'waste' to log food thrown away.",
      inputSchema: {
        ingredient_id: z.string(),
        qty_delta: z.number(),
        use_by: date.nullable().optional().describe("For additions; defaults to today plus keeps_days. null = does not expire"),
        reason: z.enum(["cooked", "shop", "waste", "adjust"]),
        note: z.string().optional(),
      },
    },
    async (input) => attempt(() => actions.adjustPantry(input)),
  );

  server.registerTool(
    "create_shop",
    {
      description:
        "Build the shopping list from the saved plan for from..to (default 7 days from today), replacing any shop still open. " +
        "date defaults to the suggested shop day. Fails if the pantry covers everything.",
      inputSchema: { date: date.optional(), from: date.optional(), to: date.optional(), busy_dates: z.array(date).optional() },
    },
    async (input) => attempt(() => actions.createShop(input)),
  );

  server.registerTool(
    "tick_item",
    {
      description: "Tick or untick one item of an open shop.",
      inputSchema: { shop_id: z.number().int(), ingredient_id: z.string(), ticked: z.boolean() },
    },
    async ({ shop_id, ingredient_id, ticked }) => attempt(() => actions.tickItem(shop_id, ingredient_id, ticked)),
  );

  server.registerTool(
    "finish_shop",
    {
      description:
        "Finish a shop: ticked items go into the pantry (use-by = shop date + keeps_days), unticked items are dropped. " +
        "If total (the receipt) is given, ticked items' prices are updated to match and flagged as no longer estimated.",
      inputSchema: { shop_id: z.number().int(), total: z.number().min(0).optional() },
    },
    async ({ shop_id, total }) => attempt(() => actions.finishShop(shop_id, total)),
  );

  return server;
}
