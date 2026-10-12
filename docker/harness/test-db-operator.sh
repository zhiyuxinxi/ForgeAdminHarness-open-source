#!/usr/bin/env sh

set -eu

umask 077

die() {
  printf 'test-db-operator: %s\n' "$*" >&2
  exit 1
}

unquote() {
  printf '%s' "$1" | sed "s/^['\"]//;s/['\"]$//"
}

action="${1:-}"
case "$action" in
  plan|snapshot|reset|restore) ;;
  *) die 'action must be plan, snapshot, reset, or restore' ;;
esac

for command_name in awk chmod cut grep gzip mkdir mktemp mv mysql mysqldump rm sed sha256sum stat; do
  command -v "$command_name" >/dev/null 2>&1 || die "required command is unavailable: $command_name"
done

MYSQL_HOST="$(unquote "${MYSQL_HOST:-}")"
MYSQL_PORT="$(unquote "${MYSQL_PORT:-}")"
MYSQL_USER="$(unquote "${MYSQL_USER:-}")"
MYSQL_PASSWORD="$(unquote "${MYSQL_PASSWORD:-}")"
runtime_database="$(unquote "${FORGE_RUNTIME_DATABASE:-}")"
test_database="$(unquote "${FORGE_TEST_DATABASE:-}")"

[ -n "$MYSQL_HOST" ] || die 'MYSQL_HOST is required'
printf '%s' "$MYSQL_PORT" | grep -Eq '^[0-9]{1,5}$' || die 'MYSQL_PORT is invalid'
[ -n "$MYSQL_USER" ] || die 'MYSQL_USER is required'
[ -n "$MYSQL_PASSWORD" ] || die 'MYSQL_PASSWORD is required'
printf '%s' "$runtime_database" | grep -Eq '^[a-z0-9_]{1,59}$' || die 'runtime database is invalid'
printf '%s' "$test_database" | grep -Eq '^[a-z0-9_]{1,64}_test$' || die 'test database is invalid'
[ "$test_database" = "${runtime_database}_test" ] \
  || die 'test database must be the exact <runtime database>_test schema'

export MYSQL_PWD="$MYSQL_PASSWORD"

mysql_base() {
  mysql \
    --batch \
    --raw \
    --skip-column-names \
    --protocol=TCP \
    --host="$MYSQL_HOST" \
    --port="$MYSQL_PORT" \
    --user="$MYSQL_USER" \
    "$@"
}

database_exists="$(mysql_base -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='$test_database';")"
[ "$database_exists" = 1 ] || die 'registered test database does not exist'

active_connections() {
  mysql_base -e "SELECT COUNT(*) FROM information_schema.processlist WHERE db='$test_database';"
}

object_count() {
  mysql_base -e "
    SELECT
      (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$test_database') +
      (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema='$test_database') +
      (SELECT COUNT(*) FROM information_schema.events WHERE event_schema='$test_database') +
      (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema='$test_database');
  "
}

failed_history_count() {
  history_exists="$(mysql_base -e "
    SELECT COUNT(*)
    FROM information_schema.tables
    WHERE table_schema='$test_database' AND table_name='forge_schema_history';
  ")"
  if [ "$history_exists" = 1 ]; then
    mysql_base -e "SELECT COUNT(*) FROM \`$test_database\`.\`forge_schema_history\` WHERE success=0;"
  else
    printf '0\n'
  fi
}

if [ "$action" = plan ]; then
  printf 'DATABASE=%s\n' "$test_database"
  printf 'OBJECT_COUNT=%s\n' "$(object_count)"
  printf 'FAILED_HISTORY_COUNT=%s\n' "$(failed_history_count)"
  printf 'ACTIVE_CONNECTIONS=%s\n' "$(active_connections)"
  exit 0
fi

connections="$(active_connections)"
[ "$connections" = 0 ] \
  || die "registered test database has active connections: $connections"

validate_backup_path() {
  printf '%s' "$1" \
    | grep -Eq '^/project-backups/test-database-snapshots/[A-Za-z0-9._-]{1,180}\.sql\.gz$' \
    || die 'backup file is outside the controlled test-database snapshot directory'
}

if [ "$action" = snapshot ]; then
  backup_file="${FORGE_BACKUP_FILE:-}"
  validate_backup_path "$backup_file"
  backup_directory="${backup_file%/*}"
  temporary_file="${backup_file}.tmp.$$"
  temporary_dump="${backup_file}.dump.$$"
  mkdir -p -- "$backup_directory"
  chmod 0700 "$backup_directory"
  [ ! -e "$backup_file" ] && [ ! -e "$temporary_file" ] && [ ! -e "$temporary_dump" ] \
    || die 'backup target already exists'
  trap 'rm -f -- "$temporary_file" "$temporary_dump"' EXIT HUP INT TERM
  # POSIX sh reports only the last pipeline status. Publish nothing unless
  # mysqldump itself succeeds, including failures after partial SQL output.
  mysqldump \
    --protocol=TCP \
    --host="$MYSQL_HOST" \
    --port="$MYSQL_PORT" \
    --user="$MYSQL_USER" \
    --single-transaction \
    --routines \
    --events \
    --triggers \
    --hex-blob \
    --no-tablespaces \
    --set-gtid-purged=OFF \
    "$test_database" >"$temporary_dump"
  gzip -9 <"$temporary_dump" >"$temporary_file"
  gzip -t "$temporary_file"
  chmod 0600 "$temporary_file"
  rm -f -- "$temporary_dump"
  mv -- "$temporary_file" "$backup_file"
  trap - EXIT HUP INT TERM
  printf 'BACKUP_FILE=%s\n' "$backup_file"
  printf 'BACKUP_SHA256=%s\n' "$(sha256sum "$backup_file" | awk '{print $1}')"
  printf 'BACKUP_BYTES=%s\n' "$(stat -c '%s' "$backup_file")"
  exit 0
fi

backup_file=''
expected_backup_sha256=''
expected_object_count=''
if [ "$action" = restore ]; then
  backup_file="${FORGE_BACKUP_FILE:-}"
  expected_backup_sha256="${FORGE_BACKUP_SHA256:-}"
  expected_object_count="${FORGE_EXPECTED_OBJECT_COUNT:-}"
  validate_backup_path "$backup_file"
  printf '%s' "$expected_backup_sha256" | grep -Eq '^[a-f0-9]{64}$' \
    || die 'expected backup checksum is invalid'
  printf '%s' "$expected_object_count" | grep -Eq '^[1-9][0-9]*$' \
    || die 'expected restored object count is invalid'
  [ -f "$backup_file" ] && [ ! -L "$backup_file" ] \
    || die 'verified recovery snapshot is not a regular file'
  actual_backup_sha256="$(sha256sum "$backup_file" | awk '{print $1}')"
  [ "$actual_backup_sha256" = "$expected_backup_sha256" ] \
    || die 'recovery snapshot checksum mismatch'
  gzip -t "$backup_file" || die 'recovery snapshot gzip validation failed'
fi

temporary_root="$(mktemp -d /tmp/forge-test-db-reset.XXXXXX)"
drop_statements="$temporary_root/drop-statements.sql"
reset_script="$temporary_root/reset.sql"
trap 'rm -rf -- "$temporary_root"' EXIT HUP INT TERM

mysql_base -e "
  SELECT CONCAT('DROP EVENT IF EXISTS \`', REPLACE(event_name, '\`', '\`\`'), '\`;')
  FROM information_schema.events
  WHERE event_schema='$test_database'
  ORDER BY event_name;
  SELECT CONCAT('DROP TRIGGER IF EXISTS \`', REPLACE(trigger_name, '\`', '\`\`'), '\`;')
  FROM information_schema.triggers
  WHERE trigger_schema='$test_database'
  ORDER BY trigger_name;
  SELECT CONCAT('DROP VIEW IF EXISTS \`', REPLACE(table_name, '\`', '\`\`'), '\`;')
  FROM information_schema.views
  WHERE table_schema='$test_database'
  ORDER BY table_name;
  SELECT CONCAT('DROP TABLE IF EXISTS \`', REPLACE(table_name, '\`', '\`\`'), '\`;')
  FROM information_schema.tables
  WHERE table_schema='$test_database' AND table_type='BASE TABLE'
  ORDER BY table_name;
  SELECT CONCAT(
    'DROP ', routine_type, ' IF EXISTS \`', REPLACE(routine_name, '\`', '\`\`'), '\`;'
  )
  FROM information_schema.routines
  WHERE routine_schema='$test_database'
  ORDER BY routine_type, routine_name;
" >"$drop_statements"

lock_suffix="$(printf '%s' "$test_database" | sha256sum | cut -c1-32)"
lock_name="forge:test-reset:$lock_suffix"

write_reset_prefix() {
  printf "SET @forge_lock = GET_LOCK('%s', 10);\n" "$lock_name"
  printf "SET @forge_active_connections = (SELECT COUNT(*) FROM information_schema.processlist WHERE db='%s' AND id<>CONNECTION_ID());\n" "$test_database"
  printf "SET @forge_guard = IF(@forge_lock=1 AND @forge_active_connections=0, 'DO 0', 'SELECT * FROM __forge_test_reset_guard_failed__');\n"
  printf 'PREPARE forge_reset_guard FROM @forge_guard;\n'
  printf 'EXECUTE forge_reset_guard;\n'
  printf 'DEALLOCATE PREPARE forge_reset_guard;\n'
  printf 'SET FOREIGN_KEY_CHECKS=0;\n'
  while IFS= read -r statement; do
    [ -n "$statement" ] || continue
    printf '%s\n' "$statement"
  done <"$drop_statements"
}

write_reset_suffix() {
  printf 'SET FOREIGN_KEY_CHECKS=1;\n'
  printf "SELECT CONCAT('LOCK_ACQUIRED=', COALESCE(@forge_lock, 0));\n"
  printf "SELECT CONCAT('ACTIVE_CONNECTIONS_AT_RESET=', COALESCE(@forge_active_connections, -1));\n"
  printf "SELECT CONCAT('LOCK_RELEASED=', IF(@forge_lock=1, RELEASE_LOCK('%s'), 0));\n" "$lock_name"
}

if [ "$action" = restore ]; then
  restore_output="$({
    write_reset_prefix
    gzip -dc "$backup_file"
    write_reset_suffix
  } | mysql_base "$test_database")"
  printf '%s\n' "$restore_output" | grep -Fxq 'LOCK_ACQUIRED=1' \
    || die 'could not acquire the project test-database restore lock'
  printf '%s\n' "$restore_output" | grep -Fxq 'LOCK_RELEASED=1' \
    || die 'project test-database restore lock was not released cleanly'
  remaining_objects="$(object_count)"
  [ "$remaining_objects" = "$expected_object_count" ] \
    || die "restored test database object count mismatch: $remaining_objects"
  remaining_failed_history="$(failed_history_count)"
  [ "$remaining_failed_history" = 0 ] \
    || die "restored test database contains failed migration history: $remaining_failed_history"
  printf 'DATABASE=%s\n' "$test_database"
  printf 'OBJECT_COUNT_AFTER=%s\n' "$remaining_objects"
  printf 'FAILED_HISTORY_COUNT_AFTER=%s\n' "$remaining_failed_history"
  printf 'BACKUP_SHA256=%s\n' "$expected_backup_sha256"
  printf 'RESTORE_MODE=verified-snapshot-import\n'
  exit 0
fi

{
  write_reset_prefix
  write_reset_suffix
} >"$reset_script"

reset_output="$(mysql_base "$test_database" <"$reset_script")"
printf '%s\n' "$reset_output" | grep -Fxq 'LOCK_ACQUIRED=1' \
  || die 'could not acquire the project test-database reset lock'
printf '%s\n' "$reset_output" | grep -Fxq 'LOCK_RELEASED=1' \
  || die 'project test-database reset lock was not released cleanly'

remaining_objects="$(object_count)"
[ "$remaining_objects" = 0 ] \
  || die "test database reset left unexpected objects: $remaining_objects"
printf 'DATABASE=%s\n' "$test_database"
printf 'OBJECT_COUNT_AFTER=%s\n' "$remaining_objects"
printf 'RESET_MODE=drop-schema-objects-only\n'
