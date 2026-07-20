#!/bin/bash
#
# Nightly backup for the postiz stack -> Cloudflare R2 (rclone remote "r2").
# Installed in joe's crontab:
#   15 9 * * * /opt/postiz/backup.sh >> /var/log/postiz-backup.log 2>&1
#
# Backs up, to r2:postiz-backups/<prefix>/:
#   db/          postiz-db-local          Postiz application data
#   temporal-db/ temporal                 Temporal workflow history = scheduled posts
#   uploads/     postiz_postiz-uploads    user-uploaded media
#   config/      postiz_postiz-config     Postiz config volume
#
# NOT backed up, deliberately:
#   temporal-elasticsearch-data — Temporal's *visibility index*. It is derived
#   data used for searching/listing workflows; the authoritative workflow history
#   lives in the temporal Postgres DB above. Losing it does not lose scheduled
#   posts, though the Temporal UI's list view will be incomplete until reindexed.
#
# Every artifact is verified (gzip integrity, and for SQL dumps the pg_dump
# completion marker) BEFORE upload, so a truncated dump is never silently
# shipped. Exits non-zero on any failure — check the log.

set -euo pipefail

# Absolute paths: cron runs with a minimal PATH (/usr/bin:/bin) and none of the
# shell profile, so never rely on the environment to resolve these. Overridable
# for testing. RCLONE_CONFIG is passed explicitly rather than relying on $HOME,
# which is the usual reason an rclone job works by hand but fails under cron.
DOCKER=${DOCKER:-/usr/bin/docker}
RCLONE=${RCLONE:-/usr/bin/rclone}
RCLONE_CONFIG=${RCLONE_CONFIG:-/home/joe/.config/rclone/rclone.conf}

STAMP=$(/usr/bin/date +%Y-%m-%d_%H%M)
RETENTION_DAYS=30
REMOTE=r2:postiz-backups

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT   # temp files cleaned up even if we fail partway

log()  { echo "[$(/usr/bin/date +%Y-%m-%dT%H:%M:%S%z)] $*"; }
fail() { log "FAILED: $*"; exit 1; }

# Fail immediately and legibly if the environment is not what we expect, rather
# than part-way through with a confusing "command not found".
preflight() {
  [ -x "$DOCKER" ] || fail "docker not executable at $DOCKER"
  [ -x "$RCLONE" ] || fail "rclone not executable at $RCLONE"
  [ -r "$RCLONE_CONFIG" ] || fail "rclone config not readable at $RCLONE_CONFIG"
  "$RCLONE" --config "$RCLONE_CONFIG" listremotes 2>/dev/null | grep -q '^r2:' \
    || fail "rclone remote 'r2' not found in $RCLONE_CONFIG"
  "$DOCKER" info >/dev/null 2>&1 || fail "cannot talk to the docker daemon"
}

# dump_db <container> <pg_user> <db_name> <remote_prefix> <artifact_name>
dump_db() {
  local container=$1 user=$2 db=$3 prefix=$4 name=$5
  local file="$WORK/${name}-${STAMP}.sql.gz"

  log "dumping $db from $container"
  "$DOCKER" exec "$container" pg_dump -U "$user" "$db" | gzip > "$file" \
    || fail "pg_dump of $db"

  gzip -t "$file" || fail "$db dump is not valid gzip"
  # pg_dump writes this marker last; its absence means a truncated dump.
  gunzip -c "$file" | grep -q "PostgreSQL database dump complete" \
    || fail "$db dump is truncated (no completion marker)"

  log "  $(basename "$file") $(stat -c%s "$file") bytes — verified"
  "$RCLONE" --config "$RCLONE_CONFIG" copy "$file" "$REMOTE/$prefix/" || fail "upload of $db dump"
}

# archive_volume <docker_volume> <remote_prefix> <artifact_name>
archive_volume() {
  local volume=$1 prefix=$2 name=$3
  local file="$WORK/${name}-${STAMP}.tar.gz"

  log "archiving volume $volume"
  "$DOCKER" run --rm -v "$volume":/data alpine tar czf - -C /data . > "$file" \
    || fail "tar of $volume"

  gzip -t "$file" || fail "$volume archive is not valid gzip"
  tar tzf "$file" >/dev/null || fail "$volume archive is not a readable tar"

  log "  $(basename "$file") $(stat -c%s "$file") bytes, $(tar tzf "$file" | wc -l) entries — verified"
  "$RCLONE" --config "$RCLONE_CONFIG" copy "$file" "$REMOTE/$prefix/" || fail "upload of $volume archive"
}

log "=== backup start ($STAMP) ==="
preflight

dump_db postiz-postgres     postiz-user postiz-db-local db          postiz-db
dump_db temporal-postgresql temporal    temporal        temporal-db temporal-db

archive_volume postiz_postiz-uploads uploads postiz-uploads
archive_volume postiz_postiz-config  config  postiz-config

log "pruning backups older than ${RETENTION_DAYS}d"
for prefix in db temporal-db uploads config; do
  "$RCLONE" --config "$RCLONE_CONFIG" delete --min-age "${RETENTION_DAYS}d" "$REMOTE/$prefix/" \
    || fail "prune of $prefix"
done

log "=== backup complete ==="
