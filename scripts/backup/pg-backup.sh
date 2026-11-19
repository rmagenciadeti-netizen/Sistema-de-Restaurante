#!/usr/bin/env bash
# Scheduled PostgreSQL backup for RM Restaurant (custom-format dump, checksum, integrity check, optional encryption, retention).
# Read-only on the database. Configure with environment variables; schedule it with cron/systemd (see docs/BACKUP.md).
#   DATABASE_URL              connection string of the database to back up (required; "?schema=" is ignored)
#   BACKUP_DIR                destination directory (default: ./backups)
#   BACKUP_RETENTION_DAYS     delete backups older than this many days (default: 14, 0 keeps everything)
#   BACKUP_ENCRYPT_PASSPHRASE when set, the dump is encrypted with AES-256 (openssl) and the plain file is removed
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
URL="${DATABASE_URL%%\?*}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/rm-restaurant-$STAMP.dump"

umask 077
mkdir -p "$BACKUP_DIR"
trap 'rm -f "$FILE.partial"' EXIT

pg_dump --format=custom --no-owner --no-privileges --file="$FILE.partial" "$URL"
# A dump that pg_restore cannot list is useless: refuse to keep it.
pg_restore --list "$FILE.partial" > /dev/null
mv "$FILE.partial" "$FILE"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256" )

if [ -n "${BACKUP_ENCRYPT_PASSPHRASE:-}" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPT_PASSPHRASE -in "$FILE" -out "$FILE.enc"
  rm -f "$FILE" "$FILE.sha256"
  ( cd "$BACKUP_DIR" && sha256sum "$(basename "$FILE").enc" > "$(basename "$FILE").enc.sha256" )
  FILE="$FILE.enc"
fi

if [ "$RETENTION" -gt 0 ]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'rm-restaurant-*' -mtime "+$RETENTION" -delete
fi

echo "backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
