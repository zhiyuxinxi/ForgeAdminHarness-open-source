#!/usr/bin/env sh
# Run only in a disposable Linux container with a writable /project-backups tmpfs.
# Argument 1 is the exact installed or candidate operator script being tested.
set -eu

operator="${1:?operator script required}"
[ -f "$operator" ] || exit 2
[ -d /project-backups ] && [ -w /project-backups ] || exit 2
fixture="$(mktemp -d /tmp/forge-snapshot-test.XXXXXX)"
trap 'rm -rf -- "$fixture"' EXIT HUP INT TERM
mkdir "$fixture/bin"
mkdir -p /project-backups/test-database-snapshots
real_gzip="$(command -v gzip)"
export FORGE_TEST_REAL_GZIP="$real_gzip"

cat >"$fixture/bin/mysql" <<'SH'
#!/bin/sh
case "$*" in
  *information_schema.schemata*) printf '1\n' ;;
  *information_schema.processlist*) printf '0\n' ;;
  *) exit 91 ;;
esac
SH
cat >"$fixture/bin/mysqldump" <<'SH'
#!/bin/sh
case "$FORGE_TEST_DUMP_MODE" in
  empty-failure) printf 'fixture: dump permission denied\n' >&2; exit 7 ;;
  partial-failure) printf 'CREATE TABLE incomplete(id int);\n'; exit 8 ;;
  success) printf 'CREATE TABLE complete(id int);\nINSERT INTO complete VALUES (17);\n' ;;
  *) exit 92 ;;
esac
SH
cat >"$fixture/bin/gzip" <<'SH'
#!/bin/sh
if [ "$FORGE_TEST_COMPRESS_MODE" = failure ]; then exit 9; fi
exec "$FORGE_TEST_REAL_GZIP" "$@"
SH
chmod 0755 "$fixture/bin/mysql" "$fixture/bin/mysqldump" "$fixture/bin/gzip"
export PATH="$fixture/bin:$PATH"
export MYSQL_HOST=fixture.invalid MYSQL_PORT=3306 MYSQL_USER=fixture MYSQL_PASSWORD=fixture-only
export FORGE_RUNTIME_DATABASE=fixture FORGE_TEST_DATABASE=fixture_test
failed=0
for scenario in empty-failure partial-failure compression-failure success; do
  export FORGE_TEST_DUMP_MODE="$scenario" FORGE_TEST_COMPRESS_MODE=success
  if [ "$scenario" = compression-failure ]; then
    FORGE_TEST_DUMP_MODE=success
    FORGE_TEST_COMPRESS_MODE=failure
  fi
  backup="/project-backups/test-database-snapshots/snapshot-test-$$-$scenario.sql.gz"
  [ ! -e "$backup" ] || exit 2
  export FORGE_BACKUP_FILE="$backup"
  status=0
  sh "$operator" snapshot >"$fixture/$scenario.stdout" 2>"$fixture/$scenario.stderr" || status=$?
  case "$scenario" in
    success)
      if [ "$status" = 0 ] && [ -f "$backup" ] \
        && [ "$(stat -c '%a' "$backup")" = 600 ] \
        && "$real_gzip" -dc "$backup" >"$fixture/restored.sql" \
        && [ "$(cat "$fixture/restored.sql")" = "$(mysqldump)" ] \
        && grep -Fxq "BACKUP_SHA256=$(sha256sum "$backup" | awk '{print $1}')" "$fixture/$scenario.stdout"; then
        printf 'PASS %s\n' "$scenario"
      else
        printf 'FAIL %s exit=%s\n' "$scenario" "$status"
        failed=$((failed + 1))
      fi
      ;;
    *)
      case "$scenario" in
        empty-failure) expected_status=7 ;;
        partial-failure) expected_status=8 ;;
        compression-failure) expected_status=9 ;;
      esac
      if [ "$status" = "$expected_status" ] && [ ! -e "$backup" ] \
        && ! grep -q '^BACKUP_' "$fixture/$scenario.stdout"; then
        printf 'PASS %s\n' "$scenario"
      else
        printf 'FAIL %s exit=%s published=%s\n' "$scenario" "$status" "$(test -e "$backup" && printf true || printf false)"
        failed=$((failed + 1))
      fi
      ;;
  esac
  # The exact test-owned backup and any test-owned temporary outputs must be gone.
  rm -f -- "$backup"
  for leftover in "$backup".tmp.* "$backup".dump.*; do
    if [ -e "$leftover" ]; then
      printf 'FAIL %s temporary-output-left-behind\n' "$scenario"
      failed=$((failed + 1))
      rm -f -- "$leftover"
    fi
  done
done
printf 'SNAPSHOT_CASES=4 FAILURES=%s\n' "$failed"
[ "$failed" = 0 ]
