/** Fixtures shared by the tests. Not part of the build (see tsconfig.json). */
import type { Ingredient } from "./planner.js";
import type { MealsStore } from "./store.js";

const ing = (id: string, over: Partial<Ingredient>): Ingredient => ({
  id,
  name: id,
  aisle: "Other",
  pack_qty: 1,
  unit: "each",
  pack_price: 1,
  keeps_days: 7,
  staple: false,
  estimated: false,
  ...over,
});

export const INGREDIENTS: Ingredient[] = [
  ing("chicken", { name: "Chicken", aisle: "Meat", pack_qty: 500, unit: "g", pack_price: 3, keeps_days: 3 }),
  ing("rice", { name: "Rice", aisle: "Dry", pack_qty: 1000, unit: "g", pack_price: 1.5, keeps_days: 365 }),
  ing("tomatoes", { name: "Tomatoes", aisle: "Veg", pack_qty: 6, unit: "each", pack_price: 1.2, keeps_days: 5 }),
  ing("pasta", { name: "Pasta", aisle: "Dry", pack_qty: 500, unit: "g", pack_price: 1, keeps_days: 365 }),
  ing("oil", { name: "Oil", aisle: "Dry", pack_qty: 500, unit: "ml", pack_price: 4, keeps_days: 365, staple: true }),
  ing("fish", { name: "Fish", aisle: "Fish", pack_qty: 300, unit: "g", pack_price: 4, keeps_days: 2 }),
];

export const RECIPE_INPUTS = {
  curry: {
    id: "curry",
    name: "Chicken curry",
    portions: 4,
    minutes: 45,
    tags: ["chicken", "batch"],
    method: ["Fry the chicken", "Add rice"],
    ingredients: [
      { ingredient: "chicken", qty: 600 },
      { ingredient: "rice", qty: 300 },
      { ingredient: "oil", qty: 20 },
    ],
  },
  pasta: {
    id: "pasta",
    name: "Tomato pasta",
    portions: 1,
    minutes: 15,
    tags: ["veg", "quick"],
    method: ["Boil pasta", "Add tomatoes"],
    ingredients: [
      { ingredient: "pasta", qty: 200 },
      { ingredient: "tomatoes", qty: 4 },
    ],
  },
  fish: {
    id: "fish",
    name: "Baked fish",
    portions: 1,
    minutes: 25,
    tags: ["fish"],
    method: ["Bake"],
    ingredients: [{ ingredient: "fish", qty: 300 }],
  },
};

/** An in-memory store with the fixture ingredients (recipes are added by the tests via saveRecipe). */
export function seedIngredients(store: MealsStore): void {
  for (const i of INGREDIENTS) store.putIngredient(i);
}
