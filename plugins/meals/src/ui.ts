/**
 * The recipe manager page. Jeeves reverse-proxies it (web: /admin/api/plugins/meals/ui/, Android
 * WebView: /plugins/meals/ui/), so every URL here is relative and the page only uses GET and POST.
 * Kept as strings so `tsc` is the whole build and the Docker image needs no extra files.
 */

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Recipes</title>
<link rel="stylesheet" href="app.css">
</head>
<body>
<header>
  <h1>Recipes</h1>
  <nav class="tabs" role="tablist">
    <button type="button" class="tab" data-tab="recipes">Recipes</button>
    <button type="button" class="tab secondary" data-tab="ingredients">Ingredients</button>
    <button type="button" class="tab secondary" data-tab="pantry">Pantry</button>
  </nav>
</header>
<p id="status" role="status" aria-live="polite"></p>
<main>
  <section id="recipes-tab">
    <div class="actions">
      <button type="button" id="add-recipe">Add recipe</button>
      <select id="tag-filter" aria-label="Filter by tag"><option value="">All tags</option></select>
    </div>
    <ul id="recipe-list" class="list"><li class="empty">Loading…</li></ul>

    <form id="recipe-form" hidden>
      <h2 id="recipe-form-title">Add recipe</h2>
      <label>Name <input name="name" required maxlength="200"></label>
      <div class="row">
        <label>Portions <input type="number" name="portions" min="1" value="2"></label>
        <label>Minutes <input type="number" name="minutes" min="1" value="30"></label>
      </div>
      <label>Tags <small>(comma separated)</small> <input name="tags" autocapitalize="off"></label>
      <div class="row">
        <label>Source <small>(mine, claude or a URL)</small> <input name="source" value="mine"></label>
        <label>Rating
          <select name="rating">
            <option value="">Not rated</option>
            <option value="1">1</option><option value="2">2</option><option value="3">3</option>
            <option value="4">4</option><option value="5">5</option>
          </select>
        </label>
      </div>
      <fieldset>
        <legend>Ingredients <small>(quantity for the whole recipe, in the ingredient's unit)</small></legend>
        <div id="ing-rows"></div>
        <button type="button" id="add-ing-row" class="secondary">Add ingredient</button>
        <datalist id="ing-names"></datalist>
      </fieldset>
      <label>Method <small>(one step per line)</small> <textarea name="method" rows="5"></textarea></label>
      <div class="actions">
        <button type="submit">Save</button>
        <button type="button" id="cancel-recipe" class="secondary">Cancel</button>
      </div>
    </form>
  </section>

  <section id="ingredients-tab" hidden>
    <div class="actions">
      <button type="button" id="add-ingredient">Add ingredient</button>
      <label class="check"><input type="checkbox" id="only-estimated"> Only estimated</label>
    </div>
    <ul id="ingredient-list" class="list"></ul>

    <form id="ingredient-form" hidden>
      <h2 id="ingredient-form-title">Add ingredient</h2>
      <label>Name <input name="name" required maxlength="200"></label>
      <label>Aisle <input name="aisle" value="Other"></label>
      <div class="row">
        <label>Pack size <input type="number" name="pack_qty" min="0.01" step="any" value="1"></label>
        <label>Unit
          <select name="unit"><option value="g">g</option><option value="ml">ml</option><option value="each">each</option></select>
        </label>
      </div>
      <div class="row">
        <label>Pack price <input type="number" name="pack_price" min="0" step="0.01" value="0"></label>
        <label>Keeps (days) <input type="number" name="keeps_days" min="0" value="7"></label>
      </div>
      <label class="check"><input type="checkbox" name="staple"> Staple (always in the cupboard, never on the list)</label>
      <label class="check"><input type="checkbox" name="estimated"> Estimated (price or pack still a guess)</label>
      <div class="actions">
        <button type="submit">Save</button>
        <button type="button" id="cancel-ingredient" class="secondary">Cancel</button>
      </div>
    </form>
  </section>

  <section id="pantry-tab" hidden>
    <ul id="pantry-list" class="list"></ul>
    <form id="pantry-form">
      <h2>Adjust the pantry</h2>
      <label>Ingredient <select name="ingredient_id" required></select></label>
      <div class="row">
        <label>Change <small>(+ adds, − removes; in the ingredient's unit)</small> <input type="number" name="qty_delta" step="any" required></label>
        <label>Use by <small>(for additions)</small> <input type="date" name="use_by"></label>
      </div>
      <div class="row">
        <label>Reason
          <select name="reason">
            <option value="adjust">Adjust</option>
            <option value="waste">Waste (thrown away)</option>
            <option value="shop">Bought</option>
          </select>
        </label>
        <label>Note <input name="note" maxlength="500"></label>
      </div>
      <div class="actions"><button type="submit">Apply</button></div>
    </form>
  </section>
</main>
<script src="app.js"></script>
</body>
</html>
`;

export const UI_CSS = `:root {
  --bg: #f7f7f5; --fg: #1c1c1a; --muted: #6b6b66; --card: #ffffff; --border: #dddcd6;
  --accent: #2f6f4f; --accent-fg: #ffffff; --danger: #b3261e; --badge: #ecebe6; --warn: #8a5a00;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --fg: #ececea; --muted: #a09f99; --card: #212120; --border: #3a3a37;
    --accent: #6fbf94; --accent-fg: #0f1a14; --danger: #ff8a80; --badge: #2e2e2b; --warn: #e6b450;
  }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg);
  font: 16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 720px; margin: 0 auto; }
header { max-width: 720px; margin: 0 auto 8px; display: flex; flex-wrap: wrap; gap: 8px;
  align-items: center; justify-content: space-between; }
h1 { margin: 0; font-size: 1.5rem; }
h2 { margin: 0 0 12px; font-size: 1.2rem; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.tabs { display: flex; gap: 6px; }
button { font: inherit; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-fg);
  border-radius: 8px; padding: 8px 14px; min-height: 40px; cursor: pointer; }
button.secondary { background: transparent; color: var(--accent); }
button.danger { background: transparent; border-color: var(--danger); color: var(--danger); }
button:disabled { opacity: .6; cursor: default; }
#status { max-width: 720px; margin: 0 auto 8px; min-height: 1.4em; color: var(--muted); }
#status.error { color: var(--danger); }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.list li { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.list li.empty { color: var(--muted); text-align: center; }
.item { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
.name { font-weight: 600; }
.meta { color: var(--muted); font-size: .9rem; margin-top: 2px; }
.badge { display: inline-block; background: var(--badge); border-radius: 999px; padding: 0 8px; font-size: .8rem; margin-left: 4px; }
.badge.warn { color: var(--warn); }
form { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-top: 16px;
  display: grid; gap: 12px; }
label { display: grid; gap: 4px; }
label.check { display: flex; align-items: center; gap: 6px; }
small { color: var(--muted); }
input, select, textarea { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--border);
  border-radius: 8px; padding: 8px; width: 100%; min-height: 40px; }
input[type=checkbox] { width: 20px; min-height: 20px; height: 20px; }
fieldset { border: 1px solid var(--border); border-radius: 8px; display: grid; gap: 8px; padding: 8px 12px 12px; }
legend { padding: 0 4px; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ing-row { display: grid; grid-template-columns: 1fr 90px 40px auto; gap: 6px; align-items: center; }
.ing-row .unit { color: var(--muted); font-size: .9rem; }
[hidden] { display: none !important; }
@media (max-width: 420px) { .row { grid-template-columns: 1fr; } }
`;

// Plain ES5-ish browser script: no build step, no template literals (this file is itself one).
export const UI_JS = `(function () {
  "use strict";
  var $ = function (sel) { return document.querySelector(sel); };
  var statusEl = $("#status");
  var recipes = [], ingredients = [], pantry = [], settings = { currency: "" };
  var editingRecipe = null, editingIngredient = null;

  function setStatus(msg, isError) {
    statusEl.textContent = msg || "";
    statusEl.className = isError ? "error" : "";
  }

  function api(method, path, body) {
    var opts = { method: method, headers: { Accept: "application/json" } };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text }; }
        if (!res.ok) {
          var msg = data.error || ("HTTP " + res.status);
          if (data.issues && data.issues.length) {
            msg += ": " + data.issues.map(function (i) { return (i.path || []).join(".") + " " + i.message; }).join("; ");
          }
          throw new Error(msg);
        }
        return data;
      });
    });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(label, cls, onclick) {
    var b = el("button", cls, label);
    b.type = "button";
    b.onclick = onclick;
    return b;
  }

  function lines(text) {
    return text.split("\\n").map(function (l) { return l.trim(); }).filter(Boolean);
  }

  function money(n) { return (settings.currency || "") + Number(n).toFixed(2); }

  function ingredientById(id) {
    for (var i = 0; i < ingredients.length; i++) if (ingredients[i].id === id) return ingredients[i];
    return null;
  }

  function ingredientByName(name) {
    var n = name.trim().toLowerCase();
    for (var i = 0; i < ingredients.length; i++) {
      if (ingredients[i].name.toLowerCase() === n || ingredients[i].id === n) return ingredients[i];
    }
    return null;
  }

  // --- tabs ---

  function showTab(name) {
    ["recipes", "ingredients", "pantry"].forEach(function (t) {
      $("#" + t + "-tab").hidden = t !== name;
    });
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
      b.classList.toggle("secondary", b.getAttribute("data-tab") !== name);
    });
    if (name === "pantry") loadPantry();
  }
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
    b.onclick = function () { showTab(b.getAttribute("data-tab")); };
  });

  // --- recipes ---

  var recipeList = $("#recipe-list"), recipeForm = $("#recipe-form"), tagFilter = $("#tag-filter");

  function renderTagFilter() {
    var current = tagFilter.value, tags = {};
    recipes.forEach(function (r) { r.tags.forEach(function (t) { tags[t] = true; }); });
    tagFilter.innerHTML = "";
    tagFilter.appendChild(new Option("All tags", ""));
    Object.keys(tags).sort().forEach(function (t) { tagFilter.appendChild(new Option(t, t)); });
    tagFilter.value = tags[current] ? current : "";
  }

  function renderRecipes() {
    recipeList.innerHTML = "";
    var shown = recipes.filter(function (r) { return !tagFilter.value || r.tags.indexOf(tagFilter.value) >= 0; });
    if (!shown.length) {
      recipeList.appendChild(el("li", "empty", recipes.length ? "No recipes with that tag." : "No recipes yet. Add one, or ask Jeeves to."));
      return;
    }
    shown.forEach(function (r) {
      var li = el("li");
      var row = el("div", "item");
      var info = el("div");
      var name = el("div", "name", r.name);
      if (r.rating) name.appendChild(el("span", "badge", r.rating + "/5"));
      var meta = r.minutes + " min · " + r.portions + " portion" + (r.portions === 1 ? "" : "s");
      if (r.tags.length) meta += " · " + r.tags.join(", ");
      info.appendChild(name);
      info.appendChild(el("div", "meta", meta));
      info.appendChild(el("div", "meta", r.ingredients.map(function (i) { return i.name + " " + i.qty + " " + (i.unit || ""); }).join(", ")));
      var actions = el("div", "actions");
      actions.appendChild(button("Edit", "secondary", function () { openRecipe(r); }));
      actions.appendChild(button("Delete", "danger", function () { removeRecipe(r); }));
      row.appendChild(info);
      row.appendChild(actions);
      li.appendChild(row);
      recipeList.appendChild(li);
    });
  }

  function fillIngredientNames() {
    var dl = $("#ing-names");
    dl.innerHTML = "";
    ingredients.forEach(function (i) { dl.appendChild(new Option(i.name, i.name)); });
  }

  function addIngRow(name, qty) {
    var row = el("div", "ing-row");
    var n = el("input"); n.setAttribute("list", "ing-names"); n.placeholder = "Ingredient"; n.value = name || "";
    var q = el("input"); q.type = "number"; q.step = "any"; q.min = "0"; q.placeholder = "Qty"; q.value = qty || "";
    var unit = el("span", "unit");
    var show = function () { var i = ingredientByName(n.value); unit.textContent = i ? i.unit : "new"; };
    n.oninput = show; show();
    var rm = button("×", "secondary", function () { row.remove(); });
    row.appendChild(n); row.appendChild(q); row.appendChild(unit); row.appendChild(rm);
    $("#ing-rows").appendChild(row);
  }
  $("#add-ing-row").onclick = function () { addIngRow(); };

  function openRecipe(r) {
    editingRecipe = r || null;
    recipeForm.reset();
    var f = recipeForm.elements;
    $("#recipe-form-title").textContent = r ? "Edit " + r.name : "Add recipe";
    $("#ing-rows").innerHTML = "";
    if (r) {
      f.name.value = r.name; f.portions.value = r.portions; f.minutes.value = r.minutes;
      f.tags.value = r.tags.join(", "); f.source.value = r.source; f.rating.value = r.rating ? String(r.rating) : "";
      f.method.value = r.method.join("\\n");
      r.ingredients.forEach(function (i) { addIngRow(i.name, i.qty); });
    } else {
      addIngRow();
    }
    recipeForm.hidden = false;
    recipeForm.scrollIntoView({ behavior: "smooth", block: "start" });
    f.name.focus();
  }

  function closeRecipe() { recipeForm.hidden = true; editingRecipe = null; }

  recipeForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var f = recipeForm.elements, ings = [];
    Array.prototype.forEach.call(document.querySelectorAll(".ing-row"), function (row) {
      var inputs = row.querySelectorAll("input");
      var name = inputs[0].value.trim(), qty = Number(inputs[1].value);
      if (!name && !inputs[1].value) return;
      var known = ingredientByName(name);
      ings.push({ ingredient: known ? known.id : name, qty: qty });
    });
    var body = {
      name: f.name.value.trim(),
      portions: Number(f.portions.value),
      minutes: Number(f.minutes.value),
      tags: f.tags.value.split(",").map(function (t) { return t.trim(); }).filter(Boolean),
      method: lines(f.method.value),
      source: f.source.value.trim() || "mine",
      rating: f.rating.value ? Number(f.rating.value) : null,
      ingredients: ings
    };
    var req = editingRecipe
      ? api("POST", "api/recipes/" + encodeURIComponent(editingRecipe.id), body)
      : api("POST", "api/recipes", body);
    req.then(function (data) {
      var made = data.new_ingredients && data.new_ingredients.length
        ? " New ingredients (set their pack size and price on the Ingredients tab): " + data.new_ingredients.join(", ") + "." : "";
      setStatus("Saved " + data.recipe.name + "." + made);
      closeRecipe();
      return loadRecipes();
    }).catch(function (e) { setStatus(e.message, true); });
  });

  function removeRecipe(r) {
    if (!confirm("Delete \\u201c" + r.name + "\\u201d?")) return;
    api("POST", "api/recipes/" + encodeURIComponent(r.id) + "/delete").then(function () {
      setStatus("Deleted " + r.name);
      if (editingRecipe && editingRecipe.id === r.id) closeRecipe();
      return loadRecipes();
    }).catch(function (e) { setStatus(e.message, true); });
  }

  $("#add-recipe").onclick = function () { openRecipe(null); };
  $("#cancel-recipe").onclick = closeRecipe;
  tagFilter.onchange = renderRecipes;

  function loadRecipes() {
    return api("GET", "api/recipes").then(function (data) {
      recipes = data.recipes;
      ingredients = data.ingredients;
      renderTagFilter();
      renderRecipes();
      renderIngredients();
      fillIngredientNames();
      fillPantrySelect();
    }).catch(function (e) { setStatus("Could not load recipes: " + e.message, true); });
  }

  // --- ingredients ---

  var ingredientList = $("#ingredient-list"), ingredientForm = $("#ingredient-form");

  function renderIngredients() {
    ingredientList.innerHTML = "";
    var only = $("#only-estimated").checked;
    var shown = ingredients.filter(function (i) { return !only || i.estimated; });
    if (!shown.length) {
      ingredientList.appendChild(el("li", "empty", only ? "Nothing is estimated." : "No ingredients yet."));
      return;
    }
    shown.forEach(function (i) {
      var li = el("li");
      var row = el("div", "item");
      var info = el("div");
      var name = el("div", "name", i.name);
      if (i.estimated) name.appendChild(el("span", "badge warn", "estimated"));
      if (i.staple) name.appendChild(el("span", "badge", "staple"));
      info.appendChild(name);
      info.appendChild(el("div", "meta", i.aisle + " · " + i.pack_qty + " " + i.unit + " pack · " + money(i.pack_price) + " · keeps " + i.keeps_days + " days"));
      var actions = el("div", "actions");
      actions.appendChild(button("Edit", "secondary", function () { openIngredient(i); }));
      actions.appendChild(button("Delete", "danger", function () { removeIngredient(i); }));
      row.appendChild(info);
      row.appendChild(actions);
      li.appendChild(row);
      ingredientList.appendChild(li);
    });
  }

  function openIngredient(i) {
    editingIngredient = i || null;
    ingredientForm.reset();
    var f = ingredientForm.elements;
    $("#ingredient-form-title").textContent = i ? "Edit " + i.name : "Add ingredient";
    if (i) {
      f.name.value = i.name; f.aisle.value = i.aisle; f.pack_qty.value = i.pack_qty; f.unit.value = i.unit;
      f.pack_price.value = i.pack_price; f.keeps_days.value = i.keeps_days; f.staple.checked = i.staple;
      f.estimated.checked = false; // saving it by hand is what makes it known
    }
    ingredientForm.hidden = false;
    ingredientForm.scrollIntoView({ behavior: "smooth", block: "start" });
    f.name.focus();
  }

  function closeIngredient() { ingredientForm.hidden = true; editingIngredient = null; }

  ingredientForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var f = ingredientForm.elements;
    var body = {
      name: f.name.value.trim(),
      aisle: f.aisle.value.trim() || "Other",
      pack_qty: Number(f.pack_qty.value),
      unit: f.unit.value,
      pack_price: Number(f.pack_price.value),
      keeps_days: Number(f.keeps_days.value),
      staple: f.staple.checked,
      estimated: f.estimated.checked
    };
    var req = editingIngredient
      ? api("POST", "api/ingredients/" + encodeURIComponent(editingIngredient.id), body)
      : api("POST", "api/ingredients", body);
    req.then(function (data) {
      setStatus("Saved " + data.ingredient.name);
      closeIngredient();
      return loadRecipes();
    }).catch(function (e) { setStatus(e.message, true); });
  });

  function removeIngredient(i) {
    if (!confirm("Delete \\u201c" + i.name + "\\u201d and its pantry stock?")) return;
    api("POST", "api/ingredients/" + encodeURIComponent(i.id) + "/delete").then(function () {
      setStatus("Deleted " + i.name);
      return loadRecipes();
    }).catch(function (e) { setStatus(e.message, true); });
  }

  $("#add-ingredient").onclick = function () { openIngredient(null); };
  $("#cancel-ingredient").onclick = closeIngredient;
  $("#only-estimated").onchange = renderIngredients;

  // --- pantry ---

  var pantryForm = $("#pantry-form");

  function fillPantrySelect() {
    var sel = pantryForm.elements.ingredient_id, current = sel.value;
    sel.innerHTML = "";
    ingredients.forEach(function (i) { sel.appendChild(new Option(i.name + " (" + i.unit + ")", i.id)); });
    if (current) sel.value = current;
  }

  function loadPantry() {
    return api("GET", "api/pantry").then(function (data) {
      pantry = data.pantry;
      var list = $("#pantry-list");
      list.innerHTML = "";
      if (!pantry.length) { list.appendChild(el("li", "empty", "The pantry is empty.")); return; }
      pantry.forEach(function (l) {
        var li = el("li");
        var name = el("div", "name", l.name + ": " + l.qty + " " + (l.unit || ""));
        if (l.past_use_by) name.appendChild(el("span", "badge warn", "past use-by"));
        li.appendChild(name);
        li.appendChild(el("div", "meta", l.use_by ? "use by " + l.use_by + (l.days_left !== null ? " (" + l.days_left + " days)" : "") : "does not expire"));
        list.appendChild(li);
      });
    }).catch(function (e) { setStatus("Could not load the pantry: " + e.message, true); });
  }

  pantryForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var f = pantryForm.elements;
    var body = { ingredient_id: f.ingredient_id.value, qty_delta: Number(f.qty_delta.value), reason: f.reason.value };
    if (f.use_by.value) body.use_by = f.use_by.value;
    if (f.note.value.trim()) body.note = f.note.value.trim();
    api("POST", "api/pantry", body).then(function () {
      setStatus("Pantry updated");
      pantryForm.reset();
      return loadPantry();
    }).catch(function (e) { setStatus(e.message, true); });
  });

  api("GET", "api/settings").then(function (s) { settings = s; }, function () {}).then(function () {
    showTab("recipes");
    return loadRecipes();
  });
})();
`;
