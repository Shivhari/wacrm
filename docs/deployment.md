# Deploying wacrm to a server (Docker + nginx)

> Starting from nothing (new Supabase project, new Meta app, new server)?
> Use [deployment-comprehensive.md](./deployment-comprehensive.md) instead.

Runbook for moving the app off a dev machine + ngrok and onto a server as a
Docker container, with a permanent HTTPS webhook URL for Meta. Placeholder
used throughout: `wacrm.yetanother.site` — swap in the hostname you actually
want.

**What moves and what doesn't.** Supabase is hosted at supabase.com — the
database, auth, storage, and realtime stay exactly where they are. The only
thing being deployed is the Next.js app itself. The repo ships a multi-stage
`Dockerfile` (standalone output, non-root user) and a `docker-compose.yml`
with a single `app` service, so the server needs Docker and nothing
Node-related.

Flow after deploy:

```
Meta → nginx (TLS) → host :3100 → wacrm container :3000 → Supabase cloud
```

## 00 — Prerequisites

- [ ] SSH access to the server with sudo
- [ ] nginx already serving your sites
- [ ] Docker Engine + the compose plugin — if not:
      `curl -fsSL https://get.docker.com | sudo sh`
- [ ] certbot with the nginx plugin —
      `sudo apt install certbot python3-certbot-nginx`
- [ ] Meta app credentials (App Secret, webhook verify token) and Supabase
      project keys at hand

## 01 — DNS

At your DNS provider, add an A record:

| Type | Name    | Value                    | TTL |
| ---- | ------- | ------------------------ | --- |
| A    | `wacrm` | your server's public IP  | 300 |

Verify before continuing (certbot needs this resolving):
`nslookup wacrm.yetanother.site`.

## 02 — Get the code onto the server

```bash
ssh user@yetanother.site
sudo mkdir -p /opt/wacrm && sudo chown $USER /opt/wacrm
git clone https://github.com/ArnasDon/wacrm.git /opt/wacrm
cd /opt/wacrm
```

If you deploy your own fork instead, clone that — but the point is: deploy
from git, not by copying your dev folder. Your dev machine's `.env.local`,
`node_modules`, and `.next` should not travel.

## 03 — Environment file

Create `/opt/wacrm/.env.local` (start from `.env.local.example`). You can
copy the _values_ from your dev machine's `.env.local` for the Supabase keys,
`ENCRYPTION_KEY`, and `META_APP_SECRET` — same Supabase project, same Meta
app. Two values change, one is new:

| Variable                        | Value on the server                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | same as dev                                                                                                                  |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same as dev                                                                                                                  |
| `SUPABASE_SERVICE_ROLE_KEY`     | same as dev                                                                                                                  |
| `ENCRYPTION_KEY`                | **same as dev** — a new key would orphan every already-saved WhatsApp token                                                  |
| `META_APP_SECRET`               | same as dev                                                                                                                  |
| `NEXT_PUBLIC_SITE_URL`          | `https://wacrm.yetanother.site` — the new canonical URL                                                                      |
| `AUTOMATION_CRON_SECRET`        | new: `openssl rand -hex 32` — required for automation Wait steps and flows (step 08)                                         |
| `HOST_PORT`                     | `3100` — 3000 and 3001 are already taken on this server (`ss -ltnp` to confirm 3100 is free). Use `HOST_PORT`, not `PORT`.   |

Leave `WHATSAPP_TEMPLATES_DRY_RUN` unset in prod. Lock the file down:
`chmod 600 .env.local`.

> **Heads up:** dev and prod will share one Supabase project and one Meta app.
> Workable for now, and it means all your existing data is already there — but
> a wrong move in dev touches prod data. When that starts to feel risky,
> create a second Supabase project for dev and re-run the migrations there.

## 04 — Build and start the container

```bash
cd /opt/wacrm
docker compose --env-file .env.local up --build -d
```

The `--env-file` flag is required — Compose only reads `.env` by default, and
this project keeps config in `.env.local`. First build takes a few minutes.
Then verify:

```bash
docker compose ps                 # state should be healthy
curl -I http://localhost:3100     # expect HTTP 200
```

> **Note:** `NEXT_PUBLIC_*` variables are baked into the client bundle at
> build time. Changing one later means rebuilding (`up --build -d`).
> Everything else (service-role key, encryption key, app secret) is
> runtime-only — a plain `docker compose restart` picks up changes.

## 05 — nginx vhost + TLS

Create `/etc/nginx/sites-available/wacrm.yetanother.site`:

```nginx
server {
    listen 80;
    server_name wacrm.yetanother.site;

    # Webhook bodies are small, but media uploads from the UI aren't.
    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:3100;   # HOST_PORT from step 03
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Next.js RSC headers + the CSP header + Supabase sb-* Set-Cookie
        # overflow nginx's default 4k proxy buffer → 502
        # "upstream sent too big header". Give it room.
        proxy_buffer_size 32k;
        proxy_buffers 8 32k;
        proxy_busy_buffers_size 64k;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/wacrm.yetanother.site /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d wacrm.yetanother.site
```

certbot rewrites the vhost for TLS and installs auto-renewal. Meta rejects
self-signed and expired certs, so confirm:
`curl -I https://wacrm.yetanother.site` → 200 with a valid chain.

The `Host` header being set by nginx matters beyond routing: invite links
generated by the app derive their origin from it.

## 06 — Supabase auth URLs

Supabase dashboard → your project → **Authentication → URL Configuration**:

- **Site URL**: `https://wacrm.yetanother.site`
- **Redirect URLs**: add `https://wacrm.yetanother.site/**`. Keep
  `http://localhost:3000/**` on the list so local dev login keeps working.

No migration work needed — the project's database is the one dev has been
using all along.

## 07 — Point Meta at the new webhook

Meta for Developers → your app → **WhatsApp → Configuration → Webhook**:

- **Callback URL**: `https://wacrm.yetanother.site/api/whatsapp/webhook`
- **Verify token**: unchanged — the same one saved in wacrm's
  Settings → WhatsApp

Click **Verify and save**. Meta immediately GETs the URL with a challenge;
the app answers it using the stored verify token. If verification fails,
check `docker compose logs -f app` while retrying. Webhook fields already
subscribed (`messages`, etc.) carry over — this only changes the delivery
address.

> **Cutover:** the moment verification succeeds, inbound messages flow to the
> server. ngrok on your dev machine can be shut off. Nothing is lost in
> between — Meta retries failed deliveries with backoff.

## 08 — Cron pinger (automations + flows)

Nothing inside the container is scheduled. Automation _Wait_ steps and flows
need an external pinger hitting two endpoints with the secret from step 03.
On the server, `crontab -e`:

```cron
* * * * * curl -fsS -H "x-cron-secret: YOUR_SECRET" https://wacrm.yetanother.site/api/automations/cron >/dev/null 2>&1
* * * * * curl -fsS -H "x-cron-secret: YOUR_SECRET" https://wacrm.yetanother.site/api/flows/cron >/dev/null 2>&1
```

Both endpoints return 503 until `AUTOMATION_CRON_SECRET` is set in the env
file. If you use neither Wait steps nor flows yet, you can skip this — but
it's two lines, so set it up now and forget it.

## 09 — Verify end to end

- [ ] `https://wacrm.yetanother.site` loads, login works
- [ ] Send a WhatsApp message _to_ your business number from a phone — it
      appears in the inbox
- [ ] Reply from the inbox — it arrives on the phone
- [ ] Send an image inbound — it renders (confirms the chat-media storage
      copy works)
- [ ] `docker compose logs app` shows no signature-verification errors
- [ ] Reboot test: `sudo reboot`, container comes back on its own (compose
      restart policy) and the site answers

### CAPI payload log

Every Meta CAPI fire attempt is appended (exact request body + outcome)
as NDJSON to `/app/logs/capi.log` inside the container — the `capi-logs`
named volume, so it survives rebuilds and redeploys. Inspect it with:

```bash
docker compose exec app cat /app/logs/capi.log        # whole file
docker compose exec app tail -f /app/logs/capi.log    # follow live
docker compose cp app:/app/logs/capi.log ./capi.log   # copy to host
docker compose exec app cat /app/logs/capi.log | jq . # pretty print
docker compose exec app cat /app/logs/capi.log | jq 'select(.outcome=="failed")' # only failures
docker compose exec app cat /app/logs/capi.log | jq 'select(.body.data[0].event_id=="<uuid>")' # find by event_id
sudo cat "$(docker volume inspect wacrm_capi-logs -f '{{.Mountpoint}}')/capi.log" #Container down? Read volume direct:

```

Entries contain the hashed phone and `ctwa_clid` (never the access
token). The path is set by `CAPI_LOG_PATH` in `docker-compose.yml`.

## 10 — Deploying updates

```bash
cd /opt/wacrm
git pull
docker compose --env-file .env.local up --build -d
```

New database migrations under `supabase/migrations/` are **not** applied by
the container — run them with the Supabase CLI (from anywhere linked to the
project) before or right after deploying code that needs them:
`supabase db push`.

### Migration numbering for fork-only changes

Upstream (`ArnasDon/wacrm`) numbers migrations sequentially (`040_…`,
`041_…`). The Supabase CLI records an applied migration by that numeric
prefix alone, so a fork-only migration that reuses the next number
collides as soon as upstream ships its own. Fork-only migrations
therefore use timestamp versions (`supabase migration new <name>`
produces one), which sort after every upstream file.

`040_capi_events.sql` was renamed to `20260819120000_capi_events.sql`
in October 2026 for this reason. Any database that already applied it
under the old name needs a one-time repair before the next `db push`,
otherwise upstream's own `040` is skipped as "already applied":

```bash
supabase migration list                                    # remote shows 040 applied
supabase migration repair --status reverted 040            # forget the record; no SQL runs
supabase migration repair --status applied 20260819120000  # mark the renamed file applied
supabase db push                                           # applies upstream 040..046
```

Never edit a migration file that also exists upstream; put fixes in a
new timestamped migration instead.

Watch the Supabase storage quota over time — inbound attachments are copied
into the `chat-media` bucket (because Meta deletes media after ~30 days) and
it grows with volume.

## 11 — Rollback

```bash
cd /opt/wacrm
git checkout <last-good-commit>
docker compose --env-file .env.local up --build -d
```

App-only rollbacks are that simple. If a deploy included a migration, rolling
the code back does not roll the schema back — migrations here are
forward-only, so fix forward in that case rather than restoring the database.
