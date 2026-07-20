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

STAMP=$(date +%Y-%m-%d_%H%M)
RETENTION_DAYS=30
REMOTE=r2:postiz-backups

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT   # temp files cleaned up even if we fail partway

log()  { echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] $*"; }
fail() { log "FAILED: $*"; exit 1; }

# dump_db <container> <pg_user> <db_name> <remote_prefix> <artifact_name>
dump_db() {
  local container=$1 user=$2 db=$3 prefix=$4 name=$5
  local file="$WORK/${name}-${STAMP}.sql.gz"

  log "dumping $db from $container"
  docker exec "$container" pg_dump -U "$user" "$db" | gzip > "$file" \
    || fail "pg_dump of $db"

  gzip -t "$file" || fail "$db dump is not valid gzip"
  # pg_dump writes this marker last; its absence means a truncated dump.
  gunzip -c "$file" | grep -q "PostgreSQL database dump complete" \
    || fail "$db dump is truncated (no completion marker)"

  log "  $(basename "$file") $(stat -c%s "$file") bytes — verified"
  rclone copy "$file" "$REMOTE/$prefix/" || fail "upload of $db dump"
}

# archive_volume <docker_volume> <remote_prefix> <artifact_name>
archive_volume() {
  local volume=$1 prefix=$2 name=$3
  local file="$WORK/${name}-${STAMP}.tar.gz"

  log "archiving volume $volume"
  docker run --rm -v "$volume":/data alpine tar czf - -C /data . > "$file" \
    || fail "tar of $volume"

  gzip -t "$file" || fail "$volume archive is not valid gzip"
  tar tzf "$file" >/dev/null || fail "$volume archive is not a readable tar"

  log "  $(basename "$file") $(stat -c%s "$file") bytes, $(tar tzf "$file" | wc -l) entries — verified"
  rclone copy "$file" "$REMOTE/$prefix/" || fail "upload of $volume archive"
}

log "=== backup start ($STAMP) ==="

dump_db postiz-postgres     postiz-user postiz-db-local db          postiz-db
dump_db temporal-postgresql temporal    temporal        temporal-db temporal-db

archive_volume postiz_postiz-uploads uploads postiz-uploads
archive_volume postiz_postiz-config  config  postiz-config

log "pruning backups older than ${RETENTION_DAYS}d"
for prefix in db temporal-db uploads config; do
  rclone delete --min-age "${RETENTION_DAYS}d" "$REMOTE/$prefix/" \
    || fail "prune of $prefix"
done

log "=== backup complete ==="
