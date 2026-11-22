# Deploying the day-to-day release (workflows, web UI, plugin pages)

Nothing here has been applied to the homeserver. The Caddy and Authelia changes live in
`~/projects/proxy` and need your go-ahead.

## 1. Before you deploy

```bash
# Back up the live database (the release adds tables and migrates rules into workflows).
docker run --rm -v jeeves_jeeves-data:/data -v "$PWD":/backup alpine \
  cp /data/jeeves.db /backup/jeeves.db.bak-$(date +%F)

# Move the single config file into the new config directory (one time).
mkdir -p config && cp server/jeeves.yaml config/
# config/ must be writable by uid 1000 (the container's node user).
```

On first start the server moves `rules:` from `config/jeeves.yaml` into `config/workflows/<id>.yaml`,
keeps `config/jeeves.yaml.bak-<date>` and leaves a `# rules moved to workflows/ on <date>` comment.
Once the to-do plugin answers with its manifest (`today: true`), `todo_plugin:` is removed too.

`.env` additions:

```bash
JEEVES_BIND=127.0.0.1             # Caddy uses proxy_network; keep 8080 off the LAN
JEEVES_TRUST_PROXY_AUTH=1         # trust Remote-User on /admin/api ...
JEEVES_TRUSTED_PROXY=172.19.0.8   # ... only from Caddy (proxy-caddy-1 on proxy_network today)
```

`proxy-caddy-1` currently has `172.19.0.8` on `proxy_network` (`172.19.0.0/16`), but Docker can hand
out a different address when the proxy stack is recreated. Either pin Caddy's address in
`~/projects/proxy/docker-compose.yml` (`networks: proxy_network: ipv4_address: 172.19.0.8`) or
update `JEEVES_TRUSTED_PROXY` when it changes. Trusting the whole `/16` would let any container on
proxy_network claim to be you, so don't. If the address is wrong the web UI just answers 401: it
fails closed.

Then:

```bash
docker compose build server todo calendar   # the server now builds from the repo root and includes web/
docker compose up -d
docker compose logs -f server      # look for "Migrated rules to workflows/" and the schedules
```

## 2. Caddy (`~/projects/proxy/Caddyfile`), proposed

Replace the current `jeeves.alexanderpezarro.uk` block (a plain `reverse_proxy jeeves-server-1:8080`):

```caddyfile
jeeves.alexanderpezarro.uk {
    tls {
        dns cloudflare {env.CF_DNS_API_TOKEN}
    }

    # Nobody gets to send their own identity headers; only Authelia's answer counts.
    request_header -Remote-User
    request_header -Remote-Groups
    request_header -Remote-Name
    request_header -Remote-Email

    # The web UI and its API: behind Authelia.
    @admin path /admin /admin/*
    handle @admin {
        forward_auth authelia:9091 {
            uri /api/authz/forward-auth
            copy_headers Remote-User Remote-Groups Remote-Name Remote-Email
        }
        reverse_proxy jeeves-server-1:8080
    }

    # The phone app's API (device bearer tokens), plugin pages for the app (short-lived tokens)
    # and /plugin-events: unchanged, no Authelia.
    handle {
        reverse_proxy jeeves-server-1:8080
    }
}
```

Reload: `cd ~/projects/proxy && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.

## 3. Authelia (`~/projects/proxy/authelia/configuration.yml`), proposed

`default_policy` is `deny`, so add a rule under `access_control.rules`, matching the `aw.` policy:

```yaml
    - domain: 'jeeves.alexanderpezarro.uk'
      resources:
        - '^/admin([/?].*)?$'
      subject: 'user:alex'
      policy: 'two_factor'
```

The `authelia/` directory is root-owned. If the edit or the restart needs root, use
`request-root --reason "add jeeves /admin rule" -- docker compose -f ~/projects/proxy/docker-compose.yml restart authelia`.

## 4. Check it

- `https://jeeves.alexanderpezarro.uk/admin` asks for Authelia, then shows the dashboard.
- `curl -H 'Remote-User: alex' https://jeeves.alexanderpezarro.uk/admin/api/me` without a session
  is redirected or refused by Authelia; from the LAN, `curl http://<host>:8080/admin/api/me`
  fails (port bound to 127.0.0.1) and even from the host gives 401 (not a trusted peer).
- The phone app still pairs, polls `/messages` and shows the new Activity tab.
- Post a test event: `curl -H "Authorization: Bearer <device token>" -H 'content-type: application/json'
  -d '{"type":"wifi.connected","payload":{"ssid":"MyHomeWiFi","away_minutes":180}}'
  https://jeeves.alexanderpezarro.uk/events` and look at Activity.


## 5. Push (ntfy + UnifiedPush)

Push uses UnifiedPush through a self-hosted ntfy that is reachable only over Tailscale. No Firebase.
Without it nothing changes: the app keeps polling every 15 minutes, which stays on as the fallback.

```
server --Web Push (VAPID, aes128gcm)--> ntfy (jeeves-ntfy-1) <--stream-- ntfy app on the phone --> Jeeves app
```

Pushes only reach the phone while it is on Tailscale. ntfy caches them for 12 h, so they arrive when it
reconnects (the app drops duplicates by message id).

### 5.1 ntfy container

`docker-compose.yml` has an `ntfy` service (pinned `binwiederhier/ntfy`, config in `ntfy/server.yml`,
no published ports). It is on `proxy_network` so Caddy reaches it as `jeeves-ntfy-1:80`, and on
`default` so the Jeeves server can post to it. Start it as part of the real `jeeves` project:

```bash
cd ~/projects/Jeeves && docker compose up -d ntfy
docker ps --filter name=ntfy --format '{{.Names}}'   # confirm the container name used in the Caddy block
```

ACL, run once (everything is denied by default):

```bash
docker compose exec ntfy ntfy access everyone 'up*' write-only   # the Jeeves server posts without credentials
docker compose exec ntfy ntfy user add phone                      # prompts for a password: keep it for the phone
docker compose exec ntfy ntfy access phone 'up*' read-write       # the ntfy app subscribes as this user
docker compose exec ntfy ntfy access                              # review
```

### 5.2 Caddy (`~/projects/proxy/Caddyfile`), proposed

A top-level Tier 3 block. It deliberately has **no `forward_auth`**: ntfy enforces its own ACL and the
phone's distributor can't do Authelia, so do not add an Authelia rule or a `forward_auth` later. Keep it
out of the `:8080` (cloudflared, public) block and out of `cloudflared-config.yml`.

```caddyfile
# Tier 3: ntfy (UnifiedPush distributor for the Jeeves app). Tailscale-only. No forward_auth on
# purpose: ntfy has its own ACL (anonymous write-only on up*), and the phone's distributor can't
# do Authelia. Don't add an Authelia rule for this name.
ntfy.alexanderpezarro.uk {
    tls {
        dns cloudflare {env.CF_DNS_API_TOKEN}
    }
    reverse_proxy jeeves-ntfy-1:80
}
```

Apply it to the live file in place (never `sed -i`, see the Tier 3 notes), then
`docker exec proxy-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` and
`docker exec proxy-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`.
Caddy's default proxy handles ntfy's long-lived streams and WebSockets; add nothing unless testing
shows timeouts.

### 5.3 DNS

Unproxied (grey cloud) `A ntfy -> 100.123.74.6` in the `alexanderpezarro.uk` Cloudflare zone, TTL auto or
300, using `CF_DNS_API_TOKEN` from `~/projects/proxy/.env` through a small stdlib Python script (as for
`cc.` and `aw.`).

### 5.4 VAPID keys and `.env`

```bash
docker compose run --rm server node dist/index.js vapid
```

Paste the three lines (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT=mailto:you@example.com`)
into `.env`, then rebuild and restart: `docker compose up -d --build server ntfy`. The server logs
`Push: Web Push (UnifiedPush) is on`. With VAPID set, Web Push wins even if `FIREBASE_SERVICE_ACCOUNT` is
also set.

### 5.5 Can the server reach ntfy? (`PUSH_ENDPOINT_REWRITE`)

The endpoint the ntfy app hands out is `https://ntfy.alexanderpezarro.uk/up…`, and that name resolves to the
Tailscale IP, which containers may not be able to reach. Test first:

```bash
docker exec jeeves-server-1 wget -S -O- -T 5 https://ntfy.alexanderpezarro.uk/v1/health
```

If that fails, set this in `.env` and run `docker compose up -d server`. The server then posts to ntfy over
the compose network and still stores the public endpoint:

```bash
PUSH_ENDPOINT_REWRITE=https://ntfy.alexanderpezarro.uk=http://ntfy:80
```

(The alternative, `extra_hosts` pointing the name at Caddy's `proxy_network` address, breaks whenever that
address changes, so prefer the rewrite.)

### 5.6 Verify the infrastructure

```bash
curl --resolve ntfy.alexanderpezarro.uk:443:100.123.74.6 https://ntfy.alexanderpezarro.uk/v1/health   # healthy
curl --resolve ntfy.alexanderpezarro.uk:443:100.123.74.6 -d hi https://ntfy.alexanderpezarro.uk/upTEST  # 200
curl --resolve ntfy.alexanderpezarro.uk:443:100.123.74.6 https://ntfy.alexanderpezarro.uk/upTEST/json     # 403
curl --resolve ntfy.alexanderpezarro.uk:443:100.123.74.6 -d hi https://ntfy.alexanderpezarro.uk/other     # 403
```

### 5.7 Phone setup

1. Install the ntfy app (F-Droid or Play). Set the default server to `https://ntfy.alexanderpezarro.uk`
   and sign in as `phone`. Allow it to run unrestricted in the background (battery optimisation off).
2. Install the new Jeeves build. Settings > Push should show "On (ntfy)". Tapping it registers again.

### 5.8 Manual checks

- Force-stop Jeeves, send a chat message from the web UI: the notification arrives within seconds.
- Turn Tailscale off and send a message: nothing arrives until the next poll. Turn it back on: the ntfy
  cache delivers it, and it is not shown twice.
- Uninstall ntfy: the server drops the endpoint on the next 404/410.
- Large plans (over about 3 KB of JSON) are pushed as `{message_id, truncated}` and the app fetches the
  full message.

## 6. External plugins (exercise / workout-app)

A plugin doesn't have to live in this compose project. The exercise plugin is the standalone
workout-app (`~/projects/workout-app`), which serves MCP at `/mcp` and the Jeeves contract at
`/jeeves/*` when it has a `JEEVES_PLUGIN_TOKEN`. Deploy the workout-app change first: until its
manifest is live Jeeves shows the plugin as disconnected and the other plugins keep working.

- **Network.** Both projects attach the external `proxy_network`, so Jeeves reaches the app as
  `http://workout-app:4321/mcp` (the container name) with no new networking, and the app posts events
  back to `<JEEVES_URL>/plugin-events`. The `server` service has the alias `jeeves-server` on
  `proxy_network`, so set `JEEVES_URL=http://jeeves-server:8080` in workout-app's `.env` rather than the
  generic `server` name, which could collide with other projects on that shared network. Recreate the
  server after pulling this change: `docker compose up -d server`.
- **Token pairing.** One secret, two names: `EXERCISE_PLUGIN_TOKEN` here (`.env`, named by `token_env` in
  `config/jeeves.yaml`) and `JEEVES_PLUGIN_TOKEN` in workout-app's `.env`. Use the same value.
- **Config.** Copy the `exercise` entry from `config.example/jeeves.yaml`, `plugins/exercise.yaml` and the
  `training-today` and `missed-session` workflows. `training-today` waits for a fixed `18:00`; keep it equal
  to the plugin's `session_time` setting, since a `wait` can't follow a setting.
- **Caddy.** The bearer token protects the endpoints, but the workout-app site block in
  `~/projects/proxy/Caddyfile` should also refuse them from outside, e.g.
  `@jeeves path /mcp /jeeves/*` with `respond @jeeves 404`. Jeeves doesn't go through Caddy.
- **Plugin not on `proxy_network`.** Publish its port on the host and use the host address instead,
  e.g. `url: http://<host>:4321/mcp`; bind it to the LAN or Tailscale address only, never `0.0.0.0` on a
  public interface.
