#!/bin/bash
set -euo pipefail
STAMP=$(date +%Y-%m-%d_%H%M)
FILE="/tmp/postiz-db-$STAMP.sql.gz"

docker exec postiz-postgres pg_dump -U postiz-user postiz-db-local | gzip > "$FILE"
rclone copy "$FILE" r2:postiz-backups/db/

docker run --rm -v postiz_postiz-uploads:/uploads alpine tar czf - -C /uploads . > /tmp/postiz-uploads-$STAMP.tar.gz
rclone copy "/tmp/postiz-uploads-$STAMP.tar.gz" r2:postiz-backups/uploads/

rm -f "$FILE" /tmp/postiz-uploads-$STAMP.tar.gz

rclone delete --min-age 30d r2:postiz-backups/db/
rclone delete --min-age 30d r2:postiz-backups/uploads/
