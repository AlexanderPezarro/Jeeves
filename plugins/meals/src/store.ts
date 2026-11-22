import Database from "better-sqlite3";
import type { Ingredient, PantryLot, Recipe, Unit } from "./planner.js";
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from "./settings.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ingredients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aisle TEXT NOT NULL DEFAULT 'Other',
  pack_qty REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'each' CHECK (unit IN ('g','ml','each')),
  pack_price REAL NOT NULL DEFAULT 0,
  keeps_days INTEGER NOT NULL DEFAULT 7,
  staple INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  portions INTEGER NOT NULL DEFAULT 1,
  minutes INTEGER NOT NULL DEFAULT 30,
  tags TEXT NOT NULL DEFAULT '[]',
  method TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'mine',
  rating INTEGER
);
CREATE TABLE IF NOT EXISTS recipe_ingredients (
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  qty REAL NOT NULL,
  PRIMARY KEY (recipe_id, ingredient_id)
);
CREATE TABLE IF NOT EXISTS pantry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  qty REAL NOT NULL,
  added_on TEXT NOT NULL,
  use_by TEXT
);
CREATE TABLE IF NOT EXISTS pantry_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id TEXT NOT NULL,
  qty_delta REAL NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('cooked','shop','waste','adjust')),
  note TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plan (
  date TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('cook','leftover','out','skip')),
  recipe_id TEXT REFERENCES recipes(id),
  start_at TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','cooked')),
  cooked_from_date TEXT
);
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  est_cost REAL NOT NULL DEFAULT 0,
  actual_total REAL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS shop_items (
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  packs INTEGER NOT NULL,
  qty REAL NOT NULL,
  est_cost REAL NOT NULL,
  ticked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, ingredient_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export type PlanKind = "cook" | "leftover" | "out" | "skip";

export interface PlanRow {
  date: string;
  kind: PlanKind;
  recipe_id: string | null;
  start_at: string | null;
  status: "planned" | "cooked";
  cooked_from_date: string | null;
}

export interface Shop {
  id: number;
  date: string;
  est_cost: number;
  actual_total: number | null;
  finished_at: string | null;
}

export interface ShopItemRow {
  shop_id: number;
  ingredient_id: string;
  packs: number;
  qty: number;
  est_cost: number;
  ticked: boolean;
}

export interface PantryLogRow {
  id: number;
  ingredient_id: string;
  qty_delta: number;
  reason: "cooked" | "shop" | "waste" | "adjust";
  note: string | null;
  at: string;
}

export interface RecipeInput {
  id: string;
  name: string;
  portions: number;
  minutes: number;
  tags: string[];
  method: string[];
  source: string;
  rating: number | null;
  ingredients: { ingredient_id: string; qty: number }[];
}

export class NotFoundError extends Error {}

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
}

const toIngredient = (r: Record<string, unknown>): Ingredient => ({
  id: r.id as string,
  name: r.name as string,
  aisle: r.aisle as string,
  pack_qty: r.pack_qty as number,
  unit: r.unit as Unit,
  pack_price: r.pack_price as number,
  keeps_days: r.keeps_days as number,
  staple: !!r.staple,
  estimated: !!r.estimated,
});

export class MealsStore {
  readonly db: Database.Database;
  private cachedSettings: Settings;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.cachedSettings = this.loadSettings();
  }

  // --- settings ---

  settings(): Settings {
    return { ...this.cachedSettings };
  }

  /** Replace all settings (missing keys fall back to defaults). Throws a ZodError on bad values. */
  setSettings(values: unknown): Settings {
    const parsed = settingsSchema.parse(values ?? {});
    const insert = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM settings").run();
      for (const [k, v] of Object.entries(parsed)) insert.run(k, JSON.stringify(v));
    })();
    this.cachedSettings = parsed;
    return this.settings();
  }

  private loadSettings(): Settings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const raw: Record<string, unknown> = {};
    for (const r of rows) raw[r.key] = JSON.parse(r.value);
    const parsed = settingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
  }

  // --- ingredients ---

  getIngredient(id: string): Ingredient | null {
    const r = this.db.prepare("SELECT * FROM ingredients WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toIngredient(r) : null;
  }

  listIngredients(): Ingredient[] {
    return (this.db.prepare("SELECT * FROM ingredients ORDER BY aisle, name").all() as Record<string, unknown>[]).map(toIngredient);
  }

  ingredientMap(): Map<string, Ingredient> {
    return new Map(this.listIngredients().map((i) => [i.id, i]));
  }

  /** Matches an id first, then a name ignoring case. */
  findIngredient(idOrName: string): Ingredient | null {
    return (
      this.getIngredient(idOrName) ??
      this.getIngredient(slugify(idOrName)) ??
      ((r) => (r ? toIngredient(r) : null))(
        this.db.prepare("SELECT * FROM ingredients WHERE lower(name) = lower(?)").get(idOrName) as Record<string, unknown> | undefined,
      )
    );
  }

  putIngredient(i: Ingredient): Ingredient {
    this.db
      .prepare(
        `INSERT INTO ingredients (id, name, aisle, pack_qty, unit, pack_price, keeps_days, staple, estimated)
         VALUES (@id, @name, @aisle, @pack_qty, @unit, @pack_price, @keeps_days, @staple, @estimated)
         ON CONFLICT(id) DO UPDATE SET name=@name, aisle=@aisle, pack_qty=@pack_qty, unit=@unit, pack_price=@pack_price,
           keeps_days=@keeps_days, staple=@staple, estimated=@estimated`,
      )
      .run({ ...i, staple: i.staple ? 1 : 0, estimated: i.estimated ? 1 : 0 });
    return this.getIngredient(i.id)!;
  }

  setPackPrice(id: string, price: number, estimated: boolean): void {
    this.db.prepare("UPDATE ingredients SET pack_price = ?, estimated = ? WHERE id = ?").run(price, estimated ? 1 : 0, id);
  }

  /** Throws if a recipe still uses it. */
  deleteIngredient(id: string): boolean {
    const used = this.db.prepare("SELECT r.name FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id WHERE ri.ingredient_id = ?").all(id) as { name: string }[];
    if (used.length) throw new Error(`Used by ${used.map((u) => u.name).join(", ")}; remove it from those recipes first`);
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM pantry WHERE ingredient_id = ?").run(id);
      return this.db.prepare("DELETE FROM ingredients WHERE id = ?").run(id).changes > 0;
    })();
  }

  // --- recipes ---

  private toRecipe(r: Record<string, unknown>): Recipe {
    const ingredients = this.db.prepare("SELECT ingredient_id, qty FROM recipe_ingredients WHERE recipe_id = ? ORDER BY rowid").all(r.id) as Recipe["ingredients"];
    return {
      id: r.id as string,
      name: r.name as string,
      portions: r.portions as number,
      minutes: r.minutes as number,
      tags: JSON.parse(r.tags as string),
      method: JSON.parse(r.method as string),
      source: r.source as string,
      rating: (r.rating as number | null) ?? null,
      ingredients,
    };
  }

  getRecipe(id: string): Recipe | null {
    const r = this.db.prepare("SELECT * FROM recipes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.toRecipe(r) : null;
  }

  listRecipes(): Recipe[] {
    return (this.db.prepare("SELECT * FROM recipes ORDER BY name").all() as Record<string, unknown>[]).map((r) => this.toRecipe(r));
  }

  recipeMap(): Map<string, Recipe> {
    return new Map(this.listRecipes().map((r) => [r.id, r]));
  }

  putRecipe(r: RecipeInput): Recipe {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO recipes (id, name, portions, minutes, tags, method, source, rating)
           VALUES (@id, @name, @portions, @minutes, @tags, @method, @source, @rating)
           ON CONFLICT(id) DO UPDATE SET name=@name, portions=@portions, minutes=@minutes, tags=@tags, method=@method,
             source=@source, rating=@rating`,
        )
        .run({ ...r, tags: JSON.stringify(r.tags), method: JSON.stringify(r.method) });
      this.db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").run(r.id);
      const ins = this.db.prepare("INSERT INTO recipe_ingredients (recipe_id, ingredient_id, qty) VALUES (?, ?, ?)");
      for (const i of r.ingredients) ins.run(r.id, i.ingredient_id, i.qty);
    })();
    return this.getRecipe(r.id)!;
  }

  /** Throws if the recipe is still in the plan. */
  deleteRecipe(id: string): boolean {
    const planned = this.db.prepare("SELECT date FROM plan WHERE recipe_id = ? AND status = 'planned' ORDER BY date").all(id) as { date: string }[];
    if (planned.length) throw new Error(`Planned on ${planned.map((p) => p.date).join(", ")}; change the plan first`);
    return this.db.transaction(() => {
      this.db.prepare("UPDATE plan SET recipe_id = NULL WHERE recipe_id = ?").run(id); // cooked history keeps its date
      return this.db.prepare("DELETE FROM recipes WHERE id = ?").run(id).changes > 0;
    })();
  }

  // --- pantry ---

  pantryLots(): (PantryLot & { id: number; added_on: string })[] {
    return this.db
      .prepare("SELECT id, ingredient_id, qty, added_on, use_by FROM pantry WHERE qty > 0 ORDER BY (use_by IS NULL), use_by, id")
      .all() as (PantryLot & { id: number; added_on: string })[];
  }

  addLot(ingredientId: string, qty: number, addedOn: string, useBy: string | null): number {
    return Number(this.db.prepare("INSERT INTO pantry (ingredient_id, qty, added_on, use_by) VALUES (?, ?, ?, ?)").run(ingredientId, qty, addedOn, useBy).lastInsertRowid);
  }

  /**
   * Takes up to `qty` out of the ingredient's lots, soonest use-by first. Returns how much was
   * actually taken (less than asked if the pantry ran short).
   */
  consume(ingredientId: string, qty: number): number {
    let left = qty;
    const lots = this.pantryLots().filter((l) => l.ingredient_id === ingredientId);
    for (const lot of lots) {
      if (left <= 1e-9) break;
      const take = Math.min(lot.qty, left);
      this.db.prepare("UPDATE pantry SET qty = ? WHERE id = ?").run(lot.qty - take, lot.id);
      left -= take;
    }
    this.db.prepare("DELETE FROM pantry WHERE qty <= 1e-9").run();
    return qty - Math.max(0, left);
  }

  log(ingredientId: string, qtyDelta: number, reason: PantryLogRow["reason"], note: string | null, at: string): void {
    this.db.prepare("INSERT INTO pantry_log (ingredient_id, qty_delta, reason, note, at) VALUES (?, ?, ?, ?, ?)").run(ingredientId, qtyDelta, reason, note, at);
  }

  pantryLog(): PantryLogRow[] {
    return this.db.prepare("SELECT * FROM pantry_log ORDER BY id").all() as PantryLogRow[];
  }

  // --- plan ---

  getPlanRow(date: string): PlanRow | null {
    return (this.db.prepare("SELECT * FROM plan WHERE date = ?").get(date) as PlanRow | undefined) ?? null;
  }

  planRange(from: string, to: string): PlanRow[] {
    return this.db.prepare("SELECT * FROM plan WHERE date >= ? AND date <= ? ORDER BY date").all(from, to) as PlanRow[];
  }

  putPlanRow(row: PlanRow): void {
    this.db
      .prepare(
        `INSERT INTO plan (date, kind, recipe_id, start_at, status, cooked_from_date)
         VALUES (@date, @kind, @recipe_id, @start_at, @status, @cooked_from_date)
         ON CONFLICT(date) DO UPDATE SET kind=@kind, recipe_id=@recipe_id, start_at=@start_at, status=@status, cooked_from_date=@cooked_from_date`,
      )
      .run(row);
  }

  /**
   * Replaces the planned rows in [from, to] with `rows`. Cooked rows, and any date in `locked` (such
   * as leftovers of a night already cooked), stay as they are and win over new rows.
   */
  replacePlan(from: string, to: string, rows: PlanRow[], locked: Set<string> = new Set()): void {
    this.db.transaction(() => {
      for (const r of this.planRange(from, to)) if (r.status === "planned" && !locked.has(r.date)) this.deletePlanRow(r.date);
      for (const r of rows) {
        if (locked.has(r.date) || this.getPlanRow(r.date)?.status === "cooked") continue;
        this.putPlanRow(r);
      }
    })();
  }

  deletePlanRow(date: string): void {
    this.db.prepare("DELETE FROM plan WHERE date = ?").run(date);
  }

  // --- shops ---

  getShop(id: number): Shop | null {
    return (this.db.prepare("SELECT * FROM shops WHERE id = ?").get(id) as Shop | undefined) ?? null;
  }

  /** The most recent shop not yet finished. */
  openShop(): Shop | null {
    return (this.db.prepare("SELECT * FROM shops WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1").get() as Shop | undefined) ?? null;
  }

  createShop(date: string, estCost: number, items: Omit<ShopItemRow, "shop_id" | "ticked">[]): Shop {
    return this.db.transaction(() => {
      const id = Number(this.db.prepare("INSERT INTO shops (date, est_cost) VALUES (?, ?)").run(date, estCost).lastInsertRowid);
      const ins = this.db.prepare("INSERT INTO shop_items (shop_id, ingredient_id, packs, qty, est_cost, ticked) VALUES (?, ?, ?, ?, ?, 0)");
      for (const i of items) ins.run(id, i.ingredient_id, i.packs, i.qty, i.est_cost);
      return this.getShop(id)!;
    })();
  }

  shopItems(shopId: number): ShopItemRow[] {
    return (this.db.prepare("SELECT * FROM shop_items WHERE shop_id = ? ORDER BY rowid").all(shopId) as (Omit<ShopItemRow, "ticked"> & { ticked: number })[]).map((r) => ({ ...r, ticked: !!r.ticked }));
  }

  setTicked(shopId: number, ingredientId: string, ticked: boolean): boolean {
    return this.db.prepare("UPDATE shop_items SET ticked = ? WHERE shop_id = ? AND ingredient_id = ?").run(ticked ? 1 : 0, shopId, ingredientId).changes > 0;
  }

  /** Closes a shop, dropping unticked items. */
  closeShop(shopId: number, actualTotal: number | null, at: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM shop_items WHERE shop_id = ? AND ticked = 0").run(shopId);
      this.db.prepare("UPDATE shops SET actual_total = ?, finished_at = ? WHERE id = ?").run(actualTotal, at, shopId);
    })();
  }

  /** Drops open shops (used when a new one replaces them). */
  discardOpenShops(): void {
    this.db.prepare("DELETE FROM shops WHERE finished_at IS NULL").run();
  }
}
