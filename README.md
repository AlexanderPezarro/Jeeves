# Jeeves

Jeeves helps you get through chores and goals with less effort. Your phone tells a small server you
host when something happens (you got home, you tapped "Plan my evening"). The server decides
whether that matters, and if it does, asks Claude to look at what's due and send you a short to-do
list, easiest first, with steps for each item. You tick things off from the notification or by
replying in plain English, and a workflow can keep nagging until you act, which is how laundry works.

```
Android app ──events──▶ server (workflows, scheduler, Claude) ──MCP──▶ to-do plugin
     ▲                         │
     └───── messages ──────────┘
```

| Folder | What it is |
| --- | --- |
| [`server/`](server) | Control plane: event API, workflow engine, job scheduler, plugin host, Claude runs. TypeScript, Fastify, SQLite. |
| [`config.example/`](config.example) | Template for the live `config/` directory: globals and one file per workflow. |
| [`plugins/todo/`](plugins/todo) | To-do plugin: chores, recurrence and completion, exposed as MCP tools. |
| [`plugins/calendar/`](plugins/calendar) | Calendar plugin: read-only Google Calendar (iCal feed) events and free evening slots, exposed as MCP tools. |
| [`plugins/meals/`](plugins/meals) | Meals plugin: recipes, dinner plan, pantry and shopping list, with the packs/cost/leftover maths done in code. |
| [`web/`](web) | Web UI (Vite, React): dashboard, workflow editor, activity, plugins, settings. Served at `/admin` (browser, behind Authelia) and at `/app` (the phone app's built-in workflow editor). |
| [`android/`](android) | Native Android app (Kotlin, Jetpack Compose): Today list, chat with Jeeves, activity, workflows, plugin settings, Wi-Fi trigger, notifications. |

## How it works

1. **Triggers.** The app watches the Wi-Fi networks you list (home, work, …). When you join one, it
   posts `wifi.connected` with that network's `ssid` and how long you were away from it; leaving
   posts `wifi.disconnected`. Schedules (cron) and the app's "Plan my evening" button are triggers
   too.
2. **Workflows.** Each file in `config/workflows/` says which events matter, e.g. "home Wi-Fi,
   after 17:00, away at least 2 hours, once a day", and what to do then. No Claude call is spent
   deciding whether a workflow fires.
3. **Steps.** A firing workflow runs its steps in order: call a plugin tool, start a Claude run,
   send a message, wait (minutes, or until a time of day), branch with `if`, or `stop`. A Claude
   step can call the plugins' tools (`todo__list_due_tasks`, `todo__complete_task`, …) plus two
   built-ins: `send_message` and `schedule_followup`. Only messages reach your phone.
4. **Completion.** Tap the plugin's buttons (the to-do plugin's Start/Done/Skip) on a notification or in the Today list, or reply in the chat (a `message.received` event, see below)
   ("dishes done, laundry is in"). Timing is the workflow's job, not the plugin's: see
   [`config.example/workflows/laundry.yaml`](config.example/workflows/laundry.yaml) for "wait, then
   nag until I tap Start, wait again, then nag until I tap Done".

Every workflow run and each of its steps is logged in the server's database, and every Claude run
with its input, transcript and token counts (`GET /runs`). `max_runs_per_day` caps spend.

## Configuration

```
config/
  jeeves.yaml              # timezone, model, effort, max_runs_per_day, about_me, plugins
  workflows/<id>.yaml      # one workflow per file; the file name must equal its id
  plugins/<name>.yaml      # settings for each plugin
```

A workflow:

```yaml
id: laundry-done
description: Tell me when something is finished
cooldown: 0                     # "daily" (default) or minutes between fires
notify_on_failure: true         # message me if a step fails (default)
triggers:
  - event: todo.task_completed  # or wifi.connected, manual.plan, …; or `schedule: "0 9 * * sat"`
    when:                       # optional: ssid (a name or a list), after, before, days, min_away_minutes, conditions
      conditions: [{ path: event.chore_id, eq: laundry }]
steps:
  - id: done
    message: { text: "{{event.name}} is done" }
```

Step types: `call: {plugin, tool, args}`, `claude: {prompt, tools?, model?, effort?, history?}`
(`tools` is an allowlist; `model`/`effort` override the globals for that step; `history: true`
adds the last 8 chat messages),
`message: {text, items?, level?, repeat?: {every_minutes, max?}, until?: {event, conditions?}}`
(`level` is notify, loud or alarm; with `until` the run pauses after sending until that event
arrives, and `repeat` re-sends every N minutes meanwhile, ending the run as `stopped` one interval
after the `max`-th send; `repeat` needs `until`), `wait`,
`if: <condition> then: [...] else: [...]`, `stop: {reason?}`,
`phone: {action: dnd, on} | {action: volume, stream: media|ring|alarm, percent} | {action: media, command: play|pause|next}`.
A `phone` step pushes the command to the paired phone and waits up to 60s for it to report back.
It fails if no device has push set up (UnifiedPush), if the phone reports an error (for example
missing Do Not Disturb access) or if the phone doesn't answer in time, and then follows the usual
failure path including `notify_on_failure`. In a dry run it is skipped and shows what it would send.
Values are literal, with no templating.
Conditions are `{path, eq|ne|gt|gte|lt|lte|contains|exists}` or `{all: [...]}` / `{any: [...]}`.
Templates only know `{{event.<field>}}` and `{{steps.<id>.<field>}}`.

A workflow can also list `cancel_on: [{event, conditions?}]`: while the run is paused (a `wait` or a
repeating message), a matching event ends it as `cancelled`. Conditions on `until` and `cancel_on`
check `event.*`, and their values may be templates such as `{{steps.task.id}}`, filled in when the
run pauses. Only one real run of a workflow can be paused at a time; another trigger meanwhile
shows "already waiting" in the activity feed. Resolving the item a repeating message is about
(Done or Skip on its notification) also ends the run.

**Chat is a workflow too.** What you write in the app's chat arrives as a `message.received`
event (`{{event.text}}`), answered by `workflows/chat-reply.yaml` (created on first start if no
workflow listens for it; delete or edit it like any other). If nothing fires, Jeeves tells you so.

**What Claude is told.** The system prompt only says who Jeeves is and how messages reach you.
The task comes from the step's prompt, `about_me` is added as context, and each plugin can add
`instructions` in its manifest (the to-do plugin's say how to build a plan), included only when
that plugin's tools are offered in the step.

The server watches `config/` and reloads on save. A file that fails validation keeps its last good
version and shows up in `GET /config/errors`; the others still load. Edits through the API are
checked against the file's hash, so a stale edit is refused (409) rather than overwriting yours.

**Upgrading from `server/jeeves.yaml`:** back up the `jeeves-data` volume, then
`mkdir config && cp server/jeeves.yaml config/`. On first start the server moves `rules:` into
`config/workflows/` (one file per rule, same id, so "once a day" history carries over), keeps a
`jeeves.yaml.bak-<date>` copy and removes `rules:` from `jeeves.yaml`.

## Plugins

A plugin is any service that speaks [MCP](https://modelcontextprotocol.io) over HTTP. List it in
`jeeves.yaml` and its tools become available to Claude as `<plugin>__<tool>`:

```yaml
plugins:
  - name: todo
    url: http://todo:8081/mcp
    token_env: TODO_PLUGIN_TOKEN
```

The to-do plugin is the first one, followed by the calendar plugin below. A budget-app or Home
Assistant plugin can follow the same contract without changes to the server. A plugin can also be an existing app that gains the
contract: the exercise plugin is the standalone workout-app, reached at `http://workout-app:4321/mcp`
over `proxy_network` (see "External plugins" in [`docs/deploy.md`](docs/deploy.md)).

Plugins can also publish a manifest at `GET /jeeves/manifest`, which declares settings (a JSON
Schema), a UI page and the events they emit; a plugin without one is tools-only and still works.

**Workflow steps are the plugin's MCP tools.** The manifest can describe them for the editor:

```jsonc
{
  "steps": {
    "list_due_tasks": { "title": "List due chores", "output_schema": { "type": "array", "items": { … } } }
  },
  "events": [
    "plain_name",
    { "type": "task_completed", "title": "Chore done", "description": "…", "payload_schema": { "type": "object", "properties": { … } } }
  ]
}
```

`title` falls back to the MCP tool's title and `output_schema` to its `outputSchema`. The editor
shows the titles in the step picker and offers `event.<field>` / `steps.<id>.<field>` paths from
these schemas in conditions and templates. `GET /event-types` returns them as `events`.

Settings are stored in `config/plugins/<name>.yaml` (fields marked `format: secret` are stored as
`{env: VAR_NAME}`, with the value in `.env`) and pushed to `PUT /jeeves/settings` on save and
whenever the plugin (re)connects. The plugin's page is proxied at `/admin/api/plugins/<name>/ui/`
(web) and `/plugins/<name>/ui/` (app, with a short-lived token). Events posted to
`POST /plugin-events` with the plugin's token arrive as `<plugin>.<event>` and can trigger
workflows.

**Lists and buttons in the app.** The server doesn't know what a plugin's items are; the plugin
describes them:

- `views: [{id, title, empty_text?}]` in the manifest: lists the app's Today tab shows. The plugin
  serves `GET /jeeves/views/<id>` as `{items: [{id, title, meta?, note?, detail[], finished, actions[]}]}`,
  where each item's `actions` (`{id, label, style?: primary|secondary|text, args?}`) are its buttons
  right now. The app reads them through `GET /views` and `GET /views/<plugin>/<id>`.
- `item_actions: [...]` in the manifest (up to three): the buttons on a notification about one of
  the plugin's items. A message item is about a plugin item when it carries `plugin` and `item_id`
  (Claude's `send_message`, `schedule_followup`, a workflow `message` step, or a plugin reminder).
- A tap goes to `POST /plugins/<plugin>/actions {item, action, args}` on Jeeves, which forwards it
  to the plugin's `POST /jeeves/actions`. If the plugin answers `resolved: true`, pending follow-ups
  about that item are cancelled.

The to-do plugin uses this for its settings (carry-over days, default snooze,
events on or off), a **Chores** page for adding, editing and deleting chores, the
`todo.task_started` / `todo.task_completed` events it posts back to Jeeves (`JEEVES_URL`), a
**Today** view with Start/Done/Skip on each task, and Done / Snooze 15 min / Skip on notifications.

### Calendar plugin

[`plugins/calendar`](plugins/calendar) lets a Claude step see which evenings are busy (for example
a weekly "plan my week"). It is read-only: it fetches your Google Calendar **Secret address in iCal
format** (Calendar settings, Integrate calendar), expands recurring events, and offers two tools:
`calendar__list_events` and `calendar__free_slots` (free gaps between, by default, 17:00 and 22:00
on each day, with the busy events and all-day events listed alongside so Claude can judge). There is
no OAuth, database or UI page.

The address is a secret, so it lives in `.env` as `CALENDAR_ICAL_URL`; `config/plugins/calendar.yaml`
refers to it as `calendar_url_1: {env: CALENDAR_ICAL_URL}` (see
[`config.example/plugins/calendar.yaml`](config.example/plugins/calendar.yaml)) and the server pushes
the value to the plugin. Up to three calendars can be set (`calendar_url_1` to `_3`). Feeds are cached
for about 10 minutes; if Google can't be reached the last copy is served and marked `stale`, and
Claude is told to say so. Google's own export can lag edits by a few hours, so treat the result as
close, not real-time.
### Meals plugin

`plugins/meals` plans dinners for one person: what to eat tonight, when to cook, when to shop. It
owns the data (recipes, ingredients, pantry lots with use-by dates, the plan, shops) and does the
maths (packs, cost, leftovers, expiry, shop day); Claude only chooses meals, guided by the manifest
`instructions`. Quantities stay in each ingredient's own unit (g, ml, each). It exposes `preview_plan`
(cost against the weekly budget, leftover forecast, suggested shop day; writes nothing), `set_plan`,
`mark_cooked`, `create_shop`, `finish_shop` and friends as `meals__*` tools.

- **Views:** *Tonight* (Cooked / Skip) and *Shopping list* (Tick / Untick, then Finish shop) on Today.
  Notifications about a night carry Cooked / Skip / Out (`item_id` is the date).
- **Events:** `meals.cooked`, `meals.shop_finished`, `meals.plan_set`, posted to `JEEVES_URL`.
- **Recipes page** (`/jeeves/ui`): recipes, ingredients (with an *estimated* flag for guessed prices) and the pantry.
- **Workflows** in `config.example/workflows/`: `plan-my-week`, `dinner-tonight`, `shop-reminder` and an
  optional `meals-waste-check`. Set `MEALS_PLUGIN_TOKEN` in `.env`; the data lives in the `meals-data` volume.

## Running it on the homeserver

```bash
cp .env.example .env                                   # Claude token (`claude setup-token`), pairing code, plugin token
cp -r config.example config                           # set your home Wi-Fi name in config/workflows/arrive-home.yaml
cp plugins/todo/chores.example.yaml plugins/todo/chores.yaml
docker compose up -d --build
```

`chores.yaml` is only a seed: on start (and with "Import from chores.yaml" on the Chores page) the
plugin adds chores whose id it hasn't seen. After that the database owns them, so edit chores on
the Chores page; editing the file won't change existing chores.

The server listens on port 8080. Expose it through your Cloudflare tunnel or reach it over
Tailscale; the to-do plugin stays on the internal compose network. The web UI at `/admin` is meant
to sit behind Caddy and Authelia: see [docs/deploy.md](docs/deploy.md) for the proxy config, the
`JEEVES_TRUST_PROXY_AUTH` / `JEEVES_TRUSTED_PROXY` settings and the upgrade steps.

## Seeing what runs when

- `GET /timeline/upcoming`: the next 48 hours of scheduled runs, each marked will run, will skip
  (with the reason, e.g. "already fired today"), disabled or cap reached; waiting workflow steps
  and follow-ups (cancellable with `DELETE /jobs/:id`); and the events workflows wait for, in
  plain English.
- `GET /activity`: every trigger check (fired or skipped, and why), workflow run (steps, tokens,
  messages), config reload or error and plugin connect/disconnect. Kept for
  `activity_retention_days`.
- `POST /simulate` says which workflows an event would fire, without storing or running
  anything; `POST /workflows/:id/run` runs one now, and `{"dry_run": true}` records messages
  instead of sending them and only calls read-only tools.

The web UI and the app's Activity tab are built on these.

## Editing workflows from the phone

The app's Workflows screen opens the same editor the web UI uses, in a WebView: "New workflow",
or "Edit" on a workflow. The app asks `POST /app/session` (device token) for a two-minute link to
`/app/<path>?t=…`; opening it swaps the token for an HttpOnly cookie scoped to `/app/` (8 hours)
and the editor talks to `/app/api/*`, the same routes the device token reaches. `/app` needs no
Authelia rule: without the cookie its API answers 401.

## The Android app

Workflow `phone` steps need UnifiedPush set up (Settings → Push). Do Not Disturb actions also need
the "Do Not Disturb access" permission, granted from Settings → Permissions.

Every push to `main` publishes the APK to the
[`android-latest`](https://github.com/AlexanderPezarro/Jeeves/releases/tag/android-latest) pre-release
(alongside a `version.json`), numbered by the CI run. Install it from there once; after that the app
updates itself:

- It checks on every open and every 6 hours in the background, and shows an **Update** banner (plus
  a notification for builds found in the background). **Settings → App** shows the version and has
  "Check for updates".
- Tapping Update downloads the APK, checks its SHA-256 and hands it to Android. The first time,
  Android asks you to allow Jeeves to install apps, then confirms the update. On Android 12+ later
  updates may install without the prompt. Android stops the app to replace it, and a notification
  says when the new version is in.
- Android only accepts updates signed with the same key (the committed debug keystore), so builds
  from elsewhere can't replace it.

PR builds are still downloadable as the `jeeves-debug-apk` artifact under **Actions**. Or build it
yourself with Android Studio (open `android/`) or `./gradlew assembleDebug`; local builds are
version 1, so the app offers the latest CI build over them.

First run:

1. **Settings:** enter the server URL and the `JEEVES_PAIRING_CODE` from `.env`, then pair.
2. Under **Wi-Fi networks**, add each network Jeeves should watch: type its name and tap Add, or
   tap "Add the current Wi-Fi" while you're on it. Remove one with its Remove button.
3. Allow notifications and location "all the time". Android only reveals the Wi-Fi name to apps
   with location access, and "all the time" lets arrivals register while the app is closed.

Notifications currently arrive by polling: every 15 minutes in the background, and within a couple
of minutes after a trigger. Firebase push (instant delivery) is wired into the server
(`FIREBASE_SERVICE_ACCOUNT`) and is the next step for the app.

## Development

```bash
cd plugins/todo && npm install && npm test    # including a real MCP round trip
cd plugins/calendar && npm install && npm test   # feeds are faked; no network needed
cd plugins/meals && npm install && npm test   # planner maths, store, MCP and Jeeves routes
cd server && npm install && npm test          # Claude is scripted; e2e test runs the real to-do plugin
cd web && npm install && npm run build && npm run test:e2e   # Playwright smoke test
```

For UI work, run the self-contained test server (tmp config, in-memory DB, the real to-do plugin,
scripted Claude, `Remote-User` trusted from localhost) and point Vite at it:

```bash
cd server && PORT=8090 npx tsx src/testserver.ts
cd web && JEEVES_DEV_TARGET=http://127.0.0.1:8090 npm run dev
```

The design doc covers the reasoning and the roadmap.
