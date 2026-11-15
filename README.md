# Jeeves

Jeeves helps you get through chores and goals with less effort. Your phone tells a small server you
host when something happens (you got home, you tapped "Plan my evening"). The server decides
whether that matters, and if it does, asks Claude to look at what's due and send you a short to-do
list, easiest first, with steps for each item. You tick things off from the notification or by
replying in plain English, and timed chores like laundry nudge you when the cycle is done.

```
Android app ──events──▶ server (rules, scheduler, Claude) ──MCP──▶ to-do plugin
     ▲                         │
     └───── messages ──────────┘
```

| Folder | What it is |
| --- | --- |
| [`server/`](server) | Control plane: event API, rule engine, job scheduler, plugin host, Claude runs. TypeScript, Fastify, SQLite. |
| [`plugins/todo/`](plugins/todo) | To-do plugin: chores, recurrence, completion and timer steps, exposed as MCP tools. |
| [`android/`](android) | Native Android app (Kotlin, Jetpack Compose): Today list, chat with Jeeves, Wi-Fi trigger, notifications. |

## How it works

1. **Triggers.** The app watches for your home Wi-Fi. When you join it, it posts `wifi.connected`
   with how long you were away. Schedules (cron) and the app's "Plan my evening" button are triggers
   too.
2. **Rules.** `server/jeeves.yaml` says which events matter, e.g. "home Wi-Fi, after 17:00, away at
   least 2 hours, once a day". No Claude call is spent deciding whether a rule fires.
3. **Claude.** A firing rule starts a short Claude run. Claude can call the plugins' tools
   (`todo__list_due_tasks`, `todo__complete_task`, …) plus two built-ins: `send_message` and
   `schedule_followup`. Only `send_message` reaches your phone.
4. **Completion.** Tap Done/Snooze/Skip on a notification or in the Today list, or reply in the chat
   ("dishes done, laundry is in"). Starting a timed chore schedules its follow-up nudges.

Every run is logged in the server's database with its input, transcript and token counts
(`GET /runs`). `max_runs_per_day` caps spend.

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

## Running it on the homeserver

```bash
cp .env.example .env                                   # API key, pairing code, plugin token
cp server/jeeves.example.yaml server/jeeves.yaml       # rules: set your home Wi-Fi name
cp plugins/todo/chores.example.yaml plugins/todo/chores.yaml
docker compose up -d --build
```

The server listens on port 8080. Expose it through your Cloudflare tunnel or reach it over
Tailscale; the to-do plugin stays on the internal compose network.

## The Android app

CI builds a debug APK on every push: open the latest run under **Actions** and download
`jeeves-debug-apk`. Or build it yourself with Android Studio (open `android/`) or
`./gradlew assembleDebug`.

First run:

1. **Settings:** enter the server URL and the `JEEVES_PAIRING_CODE` from `.env`, then pair.
2. Enter your home Wi-Fi name (or tap "Use the current Wi-Fi" while at home) and save.
3. Allow notifications and location "all the time". Android only reveals the Wi-Fi name to apps
   with location access, and "all the time" lets arrivals register while the app is closed.

Notifications currently arrive by polling: every 15 minutes in the background, and within a couple
of minutes after a trigger. Firebase push (instant delivery) is wired into the server
(`FIREBASE_SERVICE_ACCOUNT`) and is the next step for the app.

## Development

```bash
cd server && npm install && npm test          # 10 tests, Claude is scripted
cd plugins/todo && npm install && npm test    # 6 tests, including a real MCP round trip
```

The design doc covers the reasoning and the roadmap.
