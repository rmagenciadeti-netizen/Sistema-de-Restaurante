#!/usr/bin/env bash
# Proves that a backup can be restored: restores a dump into a throwaway database on a SCRATCH server and compares row counts of every
# table with the source. Never point RESTORE_URL at production: it creates and drops the database named in RESTORE_DB.
#   usage: pg-restore-check.sh <dump file>
#   SOURCE_URL   database the dump came from (row counts are compared with it)
#   RESTORE_URL  admin connection of the scratch server (database "postgres")
#   RESTORE_DB   scratch database name (default: rm_restore_check)
#   BACKUP_ENCRYPT_PASSPHRASE  required for *.enc dumps
set -euo pipefail

DUMP="${1:?usage: pg-restore-check.sh <dump file>}"
: "${SOURCE_URL:?SOURCE_URL is required}" "${RESTORE_URL:?RESTORE_URL is required}"
DB="${RESTORE_DB:-rm_restore_check}"
SOURCE="${SOURCE_URL%%\?*}"
ADMIN="${RESTORE_URL%%\?*}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; psql "$ADMIN" -qc "DROP DATABASE IF EXISTS \"$DB\"" >/dev/null 2>&1 || true' EXIT

( cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256" )
FILE="$DUMP"
if [[ "$DUMP" == *.enc ]]; then
  FILE="$WORK/restored.dump"
  openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPT_PASSPHRASE -in "$DUMP" -out "$FILE"
fi

psql "$ADMIN" -qc "DROP DATABASE IF EXISTS \"$DB\"" -c "CREATE DATABASE \"$DB\""
TARGET="${ADMIN%/*}/$DB"
pg_restore --no-owner --no-privileges --dbname="$TARGET" "$FILE"

count_sql="SELECT table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"
psql "$SOURCE" -Atc "$count_sql" > "$WORK/source.txt"
psql "$TARGET" -Atc "$count_sql" > "$WORK/restored.txt"
if diff -u "$WORK/source.txt" "$WORK/restored.txt"; then
  echo "restore check ok: $(wc -l < "$WORK/source.txt") tables, identical row counts"
else
  echo "restore check FAILED: row counts differ (expected if the source changed after the backup)" >&2
  exit 1
fi
