#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "${SCRIPT_DIR}/../scripts/lib/common.sh"
[[ "${EUID}" -eq 0 ]] || die "This ownership contract test requires a root Linux fixture."
fixture="$(mktemp -d)"
trap 'rm -rf -- "${fixture}"' EXIT
export DELIVERY_ROOT="${fixture}/delivery"
export DELIVERY_GROUP="$(getent group 983 | cut -d: -f1)"
[[ -n "${DELIVERY_GROUP}" ]] || die "Fixture runtime group 983 is unavailable."
export DEEPSEEK_KEY_FILE="${DELIVERY_ROOT}/secrets/deepseek-api-key"
mkdir -p "${DELIVERY_ROOT}/secrets"
repair_harness_deepseek_secret_access
printf '%s\n' 'fixture-key-never-a-real-credential' >"${DEEPSEEK_KEY_FILE}"
chmod 0600 "${DEEPSEEK_KEY_FILE}"
printf '%s\n' 'unrelated-provider-fixture' >"${DELIVERY_ROOT}/secrets/glm-api-key"
chmod 0600 "${DELIVERY_ROOT}/secrets/glm-api-key"
before="$(sha256sum "${DEEPSEEK_KEY_FILE}" | cut -d' ' -f1)"
repair_harness_deepseek_secret_access
[[ "$(stat -c '%u:%g:%a' "${DEEPSEEK_KEY_FILE}")" == 0:983:640 ]]
repair_harness_deepseek_secret_access
[[ "$(sha256sum "${DEEPSEEK_KEY_FILE}" | cut -d' ' -f1)" == "${before}" ]]
[[ "$(stat -c '%u:%g:%a' "${DELIVERY_ROOT}/secrets/glm-api-key")" == 0:0:600 ]]
ln -s "${DEEPSEEK_KEY_FILE}" "${DELIVERY_ROOT}/secrets/symlink-key"
if (DEEPSEEK_KEY_FILE="${DELIVERY_ROOT}/secrets/symlink-key" repair_harness_deepseek_secret_access) 2>"${fixture}/symlink-error"; then die 'Symlink must be rejected'; fi
ln "${DEEPSEEK_KEY_FILE}" "${DELIVERY_ROOT}/secrets/hardlink-key"
if (repair_harness_deepseek_secret_access) 2>"${fixture}/hardlink-error"; then die 'Hardlink must be rejected'; fi
printf 'outside' >"${fixture}/outside-key"
if (DEEPSEEK_KEY_FILE="${fixture}/outside-key" repair_harness_deepseek_secret_access) 2>"${fixture}/outside-error"; then die 'Outside path must be rejected'; fi
printf '%s\n' 'PASS: missing optional key, runtime group, idempotence, unchanged bytes, unrelated provider, symlink, hardlink, outside path'
