/**
 * The chore manager page. Jeeves reverse-proxies it (web: /admin/api/plugins/todo/ui/, Android
 * WebView: /plugins/todo/ui/), so every URL here is relative and the page only uses GET and POST.
 * Kept as strings so `tsc` is the whole build and the Docker image needs no extra files.
 */

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Chores</title>
<link rel="stylesheet" href="app.css">
</head>
<body>
<header>
  <h1>Chores</h1>
  <div class="actions">
    <button type="button" id="add">Add chore</button>
    <button type="button" id="import" class="secondary">Import from chores.yaml</button>
  </div>
</header>
<p id="status" role="status" aria-live="polite"></p>
<main>
  <ul id="list" class="list"><li class="empty">Loading…</li></ul>

  <form id="form" hidden>
    <h2 id="form-title">Add chore</h2>
    <label>Name <input name="name" required maxlength="200"></label>
    <label id="id-row">Id <small>(optional; lowercase letters, digits and dashes)</small>
      <input name="id" pattern="[a-z0-9-]+" autocapitalize="off" autocomplete="off"></label>

    <fieldset>
      <legend>Repeats</legend>
      <select name="every">
        <option value="day">Every day</option>
        <option value="week">Every week on…</option>
        <option value="month">Every month on day…</option>
        <option value="days">Every N days from…</option>
      </select>
      <div class="rec rec-week weekdays">
        <label><input type="checkbox" name="on" value="mon"> Mon</label>
        <label><input type="checkbox" name="on" value="tue"> Tue</label>
        <label><input type="checkbox" name="on" value="wed"> Wed</label>
        <label><input type="checkbox" name="on" value="thu"> Thu</label>
        <label><input type="checkbox" name="on" value="fri"> Fri</label>
        <label><input type="checkbox" name="on" value="sat"> Sat</label>
        <label><input type="checkbox" name="on" value="sun"> Sun</label>
      </div>
      <label class="rec rec-month">Day of month <input type="number" name="day" min="1" max="31" value="1"></label>
      <div class="rec rec-days row">
        <label>Every <input type="number" name="interval" min="1" value="2"> days</label>
        <label>starting <input type="date" name="start"></label>
      </div>
    </fieldset>

    <div class="row">
      <label>Effort
        <select name="effort">
          <option value="1">1 · trivial</option>
          <option value="2" selected>2 · easy</option>
          <option value="3">3 · medium</option>
          <option value="4">4 · hard</option>
          <option value="5">5 · very hard</option>
        </select>
      </label>
      <label>Minutes <input type="number" name="est_minutes" min="1" value="10"></label>
    </div>

    <label>How to <small>(one step per line)</small>
      <textarea name="how_to" rows="4"></textarea></label>

    <div class="row">
      <label>Remind at <small>(blank = no reminder)</small> <input type="time" name="remind_at"></label>
      <label>Reminder level
        <select name="remind_level">
          <option value="">Default</option>
          <option value="notify">Notify</option>
          <option value="loud">Loud</option>
          <option value="alarm">Alarm</option>
        </select>
      </label>
    </div>

    <label>Completion
      <select name="completion_mode">
        <option value="reply">Reply (tap Done)</option>
        <option value="timer">Timer (follow-up nudges)</option>
        <option value="sensor">Sensor</option>
      </select>
    </label>

    <label>Timer steps <small>(one per line: minutes after the previous step | message)</small>
      <textarea name="timer_steps" rows="3" placeholder="75 | Move the washing to the dryer"></textarea></label>

    <label>Goal <small>(optional)</small> <input name="goal"></label>
    <label class="check"><input type="checkbox" name="active" checked> Active</label>

    <div class="actions">
      <button type="submit">Save</button>
      <button type="button" id="cancel" class="secondary">Cancel</button>
    </div>
  </form>
</main>
<script src="app.js"></script>
</body>
</html>
`;

export const UI_CSS = `:root {
  --bg: #f7f7f5; --fg: #1c1c1a; --muted: #6b6b66; --card: #ffffff; --border: #dddcd6;
  --accent: #2f6f4f; --accent-fg: #ffffff; --danger: #b3261e; --badge: #ecebe6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --fg: #ececea; --muted: #a09f99; --card: #212120; --border: #3a3a37;
    --accent: #6fbf94; --accent-fg: #0f1a14; --danger: #ff8a80; --badge: #2e2e2b;
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
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
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
.list li.inactive .name { color: var(--muted); text-decoration: line-through; }
.chore { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
.name { font-weight: 600; }
.meta { color: var(--muted); font-size: .9rem; margin-top: 2px; }
.badge { display: inline-block; background: var(--badge); border-radius: 999px; padding: 0 8px; font-size: .8rem; margin-left: 4px; }
form { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-top: 16px;
  display: grid; gap: 12px; }
label { display: grid; gap: 4px; }
label.check, .weekdays label { display: flex; align-items: center; gap: 6px; }
small { color: var(--muted); }
input, select, textarea { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--border);
  border-radius: 8px; padding: 8px; width: 100%; min-height: 40px; }
input[type=checkbox] { width: 20px; min-height: 20px; height: 20px; }
fieldset { border: 1px solid var(--border); border-radius: 8px; display: grid; gap: 8px; padding: 8px 12px 12px; }
legend { padding: 0 4px; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.weekdays { display: flex; flex-wrap: wrap; gap: 4px 14px; }
[hidden] { display: none !important; }
@media (max-width: 420px) { .row { grid-template-columns: 1fr; } }
`;

// Plain ES5-ish browser script: no build step, no template literals (this file is itself one).
export const UI_JS = `(function () {
  "use strict";
  var DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  var $ = function (sel) { return document.querySelector(sel); };
  var list = $("#list"), form = $("#form"), statusEl = $("#status");
  var chores = [], editing = null;

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

  function describe(r) {
    if (r.every === "day") return "Every day";
    if (r.every === "week") return "Weekly on " + r.on.map(function (d) { return d[0].toUpperCase() + d.slice(1); }).join(", ");
    if (r.every === "month") return "Monthly on day " + r.day;
    if (r.every === "days") return "Every " + r.interval + " days from " + r.start;
    return "";
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function render() {
    list.innerHTML = "";
    if (!chores.length) {
      list.appendChild(el("li", "empty", "No chores yet. Add one, or import from chores.yaml."));
      return;
    }
    chores.forEach(function (c) {
      var li = el("li", c.active ? "" : "inactive");
      var row = el("div", "chore");
      var info = el("div");
      var name = el("div", "name", c.name);
      if (!c.active) name.appendChild(el("span", "badge", "inactive"));
      if (c.completion_mode !== "reply") name.appendChild(el("span", "badge", c.completion_mode));
      info.appendChild(name);
      info.appendChild(el("div", "meta", describe(c.recurrence) + " · effort " + c.effort + " · " + c.est_minutes + " min" + (c.remind_at ? " · reminds " + c.remind_at : "")));
      if (c.goal) info.appendChild(el("div", "meta", "Goal: " + c.goal));
      var actions = el("div", "actions");
      var edit = el("button", "secondary", "Edit");
      edit.type = "button";
      edit.onclick = function () { openForm(c); };
      var del = el("button", "danger", "Delete");
      del.type = "button";
      del.onclick = function () { remove(c); };
      actions.appendChild(edit);
      actions.appendChild(del);
      row.appendChild(info);
      row.appendChild(actions);
      li.appendChild(row);
      list.appendChild(li);
    });
  }

  function load() {
    return api("GET", "api/chores").then(function (data) {
      chores = data.chores;
      render();
    }).catch(function (e) { setStatus("Could not load chores: " + e.message, true); });
  }

  function showRecurrence() {
    var every = form.elements.every.value;
    Array.prototype.forEach.call(form.querySelectorAll(".rec"), function (n) {
      n.hidden = !n.classList.contains("rec-" + every);
    });
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function openForm(c) {
    editing = c || null;
    form.reset();
    var f = form.elements;
    $("#form-title").textContent = c ? "Edit " + c.name : "Add chore";
    $("#id-row").hidden = !!c;
    f.start.value = today();
    Array.prototype.forEach.call(form.querySelectorAll("input[name=on]"), function (b) { b.checked = false; });
    if (c) {
      f.name.value = c.name;
      f.id.value = c.id;
      f.every.value = c.recurrence.every;
      if (c.recurrence.every === "week") {
        Array.prototype.forEach.call(form.querySelectorAll("input[name=on]"), function (b) {
          b.checked = c.recurrence.on.indexOf(b.value) >= 0;
        });
      }
      if (c.recurrence.every === "month") f.day.value = c.recurrence.day;
      if (c.recurrence.every === "days") { f.interval.value = c.recurrence.interval; f.start.value = c.recurrence.start; }
      f.effort.value = String(c.effort);
      f.est_minutes.value = c.est_minutes;
      f.how_to.value = c.how_to.join("\\n");
      f.completion_mode.value = c.completion_mode;
      f.timer_steps.value = c.timer_steps.map(function (s) { return s.after_minutes + " | " + s.message; }).join("\\n");
      f.remind_at.value = c.remind_at || "";
      f.remind_level.value = c.remind_level || "";
      f.goal.value = c.goal || "";
      f.active.checked = c.active;
    }
    showRecurrence();
    form.hidden = false;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    f.name.focus();
  }

  function closeForm() {
    form.hidden = true;
    editing = null;
  }

  function lines(text) {
    return text.split("\\n").map(function (l) { return l.trim(); }).filter(Boolean);
  }

  function readForm() {
    var f = form.elements;
    var every = f.every.value, recurrence;
    if (every === "day") recurrence = { every: "day" };
    if (every === "week") {
      recurrence = { every: "week", on: DAYS.filter(function (d) {
        return form.querySelector("input[name=on][value=" + d + "]").checked;
      }) };
      if (!recurrence.on.length) throw new Error("Pick at least one weekday");
    }
    if (every === "month") recurrence = { every: "month", day: Number(f.day.value) };
    if (every === "days") recurrence = { every: "days", interval: Number(f.interval.value), start: f.start.value };
    var timer_steps = lines(f.timer_steps.value).map(function (l) {
      var m = /^(\\d+)\\s*\\|\\s*(.+)$/.exec(l);
      if (!m) throw new Error("Timer step lines look like: 75 | Move the washing to the dryer");
      return { after_minutes: Number(m[1]), message: m[2] };
    });
    var body = {
      name: f.name.value.trim(),
      recurrence: recurrence,
      effort: Number(f.effort.value),
      est_minutes: Number(f.est_minutes.value),
      how_to: lines(f.how_to.value),
      completion_mode: f.completion_mode.value,
      timer_steps: timer_steps,
      active: f.active.checked,
      remind_at: f.remind_at.value || null,
      remind_level: f.remind_level.value || null
    };
    var goal = f.goal.value.trim();
    if (goal) body.goal = goal;
    if (!editing && f.id.value.trim()) body.id = f.id.value.trim();
    return body;
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body;
    try { body = readForm(); } catch (e) { setStatus(e.message, true); return; }
    var req = editing
      ? api("POST", "api/chores/" + encodeURIComponent(editing.id), body)
      : api("POST", "api/chores", body);
    req.then(function (data) {
      setStatus((editing ? "Saved " : "Added ") + data.chore.name);
      closeForm();
      return load();
    }).catch(function (e) { setStatus(e.message, true); });
  });

  function remove(c) {
    if (!confirm("Delete \\u201c" + c.name + "\\u201d and its history? To keep the history, untick Active instead.")) return;
    api("POST", "api/chores/" + encodeURIComponent(c.id) + "/delete").then(function () {
      setStatus("Deleted " + c.name);
      if (editing && editing.id === c.id) closeForm();
      return load();
    }).catch(function (e) { setStatus(e.message, true); });
  }

  $("#add").onclick = function () { openForm(null); };
  $("#cancel").onclick = closeForm;
  form.elements.every.onchange = showRecurrence;
  $("#import").onclick = function () {
    var btn = this;
    btn.disabled = true;
    api("POST", "api/import").then(function (r) {
      setStatus("Imported " + r.inserted + " new chore" + (r.inserted === 1 ? "" : "s") + ", skipped " + r.skipped + " already here.");
      return load();
    }).catch(function (e) { setStatus("Import failed: " + e.message, true); })
      .then(function () { btn.disabled = false; });
  };

  load();
})();
`;
