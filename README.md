# postiz-infra

Deployment configuration for **postiz.dailylatin.org** — a single-host Docker
Compose stack running [Postiz](https://github.com/gitroomhq/postiz-app) behind
system Caddy.

This repo is the source of truth for `/opt/postiz` on the server. Files here are
the live files — the repo lives at `/opt/postiz`, it is not deployed from
elsewhere.

Secrets are kept in a gitignored `.env` and are not present in this repo or its
history — see [Secrets](#secrets).

## Contents

| Path | Purpose |
| --- | --- |
| `docker-compose.yaml` | The entire stack — Postiz, its Postgres/Redis, and Temporal. |
| `.env.example` | Template for the gitignored `.env`. |
| `dynamicconfig/development-sql.yaml` | Temporal dynamic config, bind-mounted into the `temporal` container. |
| `backup.sh` | Nightly backup to Cloudflare R2. Run from cron. |
| `Caddyfile` | Copy of `/etc/caddy/Caddyfile`. **Not** read from here — see [Caddy](#caddy). |

`postiz-docker-compose/` on the server is an untracked clone of upstream
`gitroomhq/postiz-docker-compose`, kept for reference only. Nothing in it runs.
The live `docker-compose.yaml` was derived from it and has since diverged
(Temporal merged in, ports bound to loopback, real credentials filled in).

## What runs

One Compose project (`postiz`) spanning two networks.

**Postiz** (`postiz-network`):

- `postiz` — `ghcr.io/gitroomhq/postiz-app:latest`, bound `127.0.0.1:4007` -> `5000`. Also joined to `temporal-network`.
- `postiz-postgres` — `postgres:17-alpine`. DB `postiz-db-local`, user `postiz-user`. Not published.
- `postiz-redis` — `redis:7.2`. Not published.
- `spotlight` — Sentry debug UI, under the `debug` profile. Does not start by default.

**Temporal** (`temporal-network`), used by Postiz for scheduled posting:

- `temporal` — `temporalio/auto-setup:1.28.1`, `127.0.0.1:7233`.
- `temporal-postgresql` — `postgres:16`. Temporal's own DB, separate from Postiz's.
- `temporal-elasticsearch` — `elasticsearch:7.17.27`, 256 MB heap.
- `temporal-ui` — `temporalio/ui:2.34.0`, `127.0.0.1:8080`.
- `temporal-admin-tools` — idle container for `tctl` / `temporal` CLI.

Every published port binds to `127.0.0.1`. Nothing is reachable from outside the
host except through Caddy.

## Caddy

Caddy runs as a **system service**, not a container, and reads
`/etc/caddy/Caddyfile` — *not* the copy in this repo. The copy here is for
history and review only.

After changing `Caddyfile` here, apply it deliberately:

```bash
sudo cp /opt/postiz/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

TLS certificates are issued and renewed automatically by Caddy.

## Operating

```bash
cd /opt/postiz
docker compose up -d           # apply config changes / start
docker compose ps              # all services should report healthy
docker compose logs -f postiz  # tail app logs
```

Docker is enabled at boot and every service is `restart: always`, so the stack
returns after a reboot unattended.

### Upgrading Postiz

`postiz` tracks `:latest`, so there is no pinned version to roll back to, and
Postiz runs database migrations on start. **Take a backup first.**

```bash
/opt/postiz/backup.sh
docker compose pull postiz
docker compose up -d postiz
```

### Rules

1. **Never run `docker compose down -v`.** `-v` destroys named volumes, including
   `postiz_postgres-volume` (all Postiz data). Use `docker compose down` or
   `docker compose restart`.
2. **Never edit the Postgres volume directly.** No writes into
   `/var/lib/docker/volumes/postiz_postgres-volume/`, no ad-hoc containers mounting
   it to change files. Go through
   `docker exec postiz-postgres psql -U postiz-user -d postiz-db-local`.
3. **Commit before changing `docker-compose.yaml`**, so there is always a known-good
   revision to return to.

## Backups

`backup.sh` runs from joe's crontab at **09:15 daily**, logging to
`/var/log/postiz-backup.log`:

```
15 9 * * * /opt/postiz/backup.sh >> /var/log/postiz-backup.log 2>&1
```

Each run dumps `postiz-db-local`, tars the `postiz_postiz-uploads` volume, uploads
both to Cloudflare R2 via the rclone remote `r2`, removes the local temp files,
then prunes both remote prefixes to **30 days**.

Destinations: `r2:postiz-backups/db/` and `r2:postiz-backups/uploads/`.
rclone credentials live in `~/.config/rclone/rclone.conf` (not in this repo).

### What is NOT backed up

- The `postiz_postiz-config` volume.
- `temporal-postgres-data` — Temporal's workflow history, i.e. **scheduled posts**.
  Restoring only the Postiz DB will not bring back in-flight schedules.

### Restore procedure

**Verified 2026-07-20** against a scratch database and scratch volumes, without
touching live data. What was confirmed: the dump restores with zero errors into an
empty database and reproduces all 69 tables, 220 indexes, and 124 constraints
identically, with row content byte-for-byte identical (including the user's
password hash, so logins survive a restore). The uploads tar/untar round-trip was
verified separately with nested directories, binary files, and dotfiles.

> **`ON_ERROR_STOP=1` is not optional.** `psql` exits **0 even when the restore
> fails**. Restoring onto a non-empty database produced 362 errors and changed
> nothing, yet still reported success. Always pass `-v ON_ERROR_STOP=1` and check
> the exit code, or you will believe a failed restore worked.

List available backups:

```bash
rclone lsl r2:postiz-backups/db/
rclone lsl r2:postiz-backups/uploads/
```

**Database.** Postiz must be stopped so it is not writing during the restore:

```bash
cd /opt/postiz
docker compose stop postiz

rclone copy r2:postiz-backups/db/postiz-db-<stamp>.sql.gz /tmp/
gunzip -c /tmp/postiz-db-<stamp>.sql.gz | \
  docker exec -i postiz-postgres psql -U postiz-user -d postiz-db-local -v ON_ERROR_STOP=1
echo "restore exit: $?"   # must be 0 — see the warning above

docker compose start postiz
docker compose logs -f postiz
```

The dump is a plain `pg_dump` (no `--clean`), so it only restores cleanly into an
**empty** database. Against a populated one every object and row conflicts, the
restore is a no-op, and without `ON_ERROR_STOP=1` it still exits 0. In a real
recovery the database will usually already exist, so recreate it empty first —
this destroys current contents, so be certain:

```bash
docker exec -i postiz-postgres psql -U postiz-user -d postgres \
  -c 'DROP DATABASE "postiz-db-local";' \
  -c 'CREATE DATABASE "postiz-db-local" OWNER "postiz-user";'
```

**Uploads.** Restore into the volume via a throwaway container:

```bash
rclone copy r2:postiz-backups/uploads/postiz-uploads-<stamp>.tar.gz /tmp/
docker run --rm -i -v postiz_postiz-uploads:/uploads alpine \
  tar xzf - -C /uploads < /tmp/postiz-uploads-<stamp>.tar.gz
```

**Full host rebuild.** Install Docker, Caddy, and rclone; clone this repo to
`/opt/postiz`; restore `~/.config/rclone/rclone.conf`; `docker compose up -d`;
then run the two restores above. Copy `Caddyfile` to `/etc/caddy/` and reload.
Reinstate the cron line. Temporal rebuilds its own schema on first start, but
prior workflow history is not recoverable.

## Secrets

Secrets live in `.env`, which is gitignored and never committed. `.env.example` is
the committed template. Nothing in this repo's history has ever contained a real
credential — verify with `git log -p | grep -i jwt_secret`.

`docker-compose.yaml` pulls them in by interpolation:

| Variable | Used for |
| --- | --- |
| `JWT_SECRET` | Signs Postiz session tokens. |
| `POSTIZ_POSTGRES_PASSWORD` | The `postiz-user` role. `DATABASE_URL` and `POSTGRES_PASSWORD` are both built from it, so it is set in exactly one place. |

References use `${VAR:?message}` so Compose **fails loudly** if a variable is
missing, rather than silently substituting an empty password.

Setting up a fresh checkout:

```bash
cp .env.example .env && chmod 600 .env
# fill in values, then:
docker compose config -q    # fails if anything is unset
```

Temporal's Postgres password is left inline as the upstream default (`temporal`).
It is not published outside `temporal-network` and is not treated as a secret.

### Rotating

`POSTIZ_POSTGRES_PASSWORD` is *not* changed by editing `.env` alone — the value
already lives inside the Postgres volume. Change both together:

```bash
docker exec -it postiz-postgres psql -U postiz-user -d postiz-db-local \
  -c "ALTER USER \"postiz-user\" WITH PASSWORD '<new>';"
# then update .env, then:
docker compose up -d postiz
```

Rotating `JWT_SECRET` needs only an `.env` edit plus `docker compose up -d postiz`,
but it invalidates every logged-in session.

## Access

The server authenticates to GitHub with a dedicated ed25519 **deploy key** at
`~/.ssh/github_deploy`, selected for `github.com` via `~/.ssh/config`. The public
key must be registered under this repo's *Settings -> Deploy keys*, with write
access enabled if the server should push.

### Re-testing the restore

Non-disruptive — uses a scratch database, never touches `postiz-db-local`:

```bash
rclone copy r2:postiz-backups/db/postiz-db-<stamp>.sql.gz /tmp/
docker exec postiz-postgres psql -U postiz-user -d postgres \
  -c 'CREATE DATABASE "postiz-restore-test" OWNER "postiz-user";'
gunzip -c /tmp/postiz-db-<stamp>.sql.gz | \
  docker exec -i postiz-postgres psql -U postiz-user -d postiz-restore-test -v ON_ERROR_STOP=1
echo "exit: $?"   # must be 0

# compare against live
docker exec postiz-postgres psql -U postiz-user -d postiz-restore-test -tAc \
  "select count(*) from information_schema.tables where table_schema='public';"   # expect 69

docker exec postiz-postgres psql -U postiz-user -d postgres \
  -c 'DROP DATABASE "postiz-restore-test";'
```

Worth re-running after any Postiz major-version upgrade, since migrations change
the schema.
