# Jeeves

Jeeves helps you get through chores and goals with less effort. Your phone tells a small server you
host when something happens (you got home, you tapped "Plan my evening"). The server decides
whether that matters, and if it does, asks Claude to look at what's due and send you a short to-do
list, easiest first, with steps for each item. You tick things off from the notification or by
replying in plain English, and timed chores like laundry nudge you when the cycle is done.

```
Android app ──events──▶ server (workflows, scheduler, Claude) ──MCP──▶ to-do plugin
     ▲                         │
     └───── messages ──────────┘
```

| Folder | What it is |
| --- | --- |
| [`server/`](server) | Control plane: event API, workflow engine, job scheduler, plugin host, Claude runs. TypeScript, Fastify, SQLite. |
| [`config.example/`](config.example) | Template for the live `config/` directory: globals and one file per workflow. |
| [`plugins/todo/`](plugins/todo) | To-do plugin: chores, recurrence, completion and timer steps, exposed as MCP tools. |
| [`web/`](web) | Web admin UI (Vite, React) served by the server at `/admin`: dashboard, workflow editor, activity, plugins, settings. |
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
4. **Completion.** Tap Done/Snooze/Skip on a notification or in the Today list, or reply in the chat
   ("dishes done, laundry is in"). Starting a timed chore schedules a reminder for each of its timer steps
   (at the todo plugin's `timer_level`), and completing or skipping it cancels them. So a workflow
   shouldn't also wait and nudge for the same timer.

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

Step types: `call: {plugin, tool, args}`, `claude: {prompt, tools?}` (`tools` is an allowlist),
`message: {text, items?}`, `wait`, `if: <condition> then: [...] else: [...]`, `stop: {reason?}`.
Conditions are `{path, eq|ne|gt|gte|lt|lte|contains|exists}` or `{all: [...]}` / `{any: [...]}`.
Templates only know `{{event.<field>}}` and `{{steps.<id>.<field>}}`.

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

The to-do plugin is the first one. A calendar, budget-app or Home Assistant plugin can follow the
same contract without changes to the server.

Plugins can also publish a manifest at `GET /jeeves/manifest`, which declares settings (a JSON
Schema), a UI page and the events they emit; a plugin without one is tools-only and still works.
Settings are stored in `config/plugins/<name>.yaml` (fields marked `format: secret` are stored as
`{env: VAR_NAME}`, with the value in `.env`) and pushed to `PUT /jeeves/settings` on save and
whenever the plugin (re)connects. The plugin's page is proxied at `/admin/api/plugins/<name>/ui/`
(web) and `/plugins/<name>/ui/` (app, with a short-lived token). Events posted to
`POST /plugin-events` with the plugin's token arrive as `<plugin>.<event>` and can trigger
workflows. The Today list comes from the plugin whose manifest says `today: true`.

The to-do plugin uses this for its settings (carry-over days, default snooze, timer follow-ups,
events on or off), a **Chores** page for adding, editing and deleting chores, and the
`todo.task_started` / `todo.task_completed` events it posts back to Jeeves (`JEEVES_URL`).

## Running it on the homeserver

```bash
cp .env.example .env                                   # API key, pairing code, plugin token
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

## The Android app

CI builds a debug APK on every push: open the latest run under **Actions** and download
`jeeves-debug-apk`. Or build it yourself with Android Studio (open `android/`) or
`./gradlew assembleDebug`.

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
