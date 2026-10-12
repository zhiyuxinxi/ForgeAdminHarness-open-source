#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config

failures=0

check_command() {
  if command -v "$1" >/dev/null 2>&1; then
    printf 'PASS command %-10s %s\n' "$1" "$(command -v "$1")"
  else
    printf 'FAIL command %-10s missing\n' "$1"
    failures=$((failures + 1))
  fi
}

for command_name in docker git flock openssl ss; do
  check_command "${command_name}"
done

if docker info >/dev/null 2>&1; then
  printf 'PASS docker-daemon accessible\n'
else
  printf 'WARN docker-daemon not accessible to current user; retry with approved sudo\n'
fi

if [[ -d "${DELIVERY_ROOT}" ]]; then
  printf 'PASS delivery-root %s\n' "${DELIVERY_ROOT}"
else
  printf 'FAIL delivery-root %s is absent; run bootstrap-host.sh\n' "${DELIVERY_ROOT}"
  failures=$((failures + 1))
fi

if [[ -f /var/run/reboot-required ]]; then
  printf 'WARN host-reboot required\n'
fi

if ((failures > 0)); then
  exit 1
fi

