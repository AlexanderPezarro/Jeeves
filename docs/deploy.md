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
docker compose build server todo   # the server now builds from the repo root and includes web/
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
