#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
platform_config="${PLATFORM_CONFIG:-${REPO_ROOT}/config/platform.env}"

usage() {
  printf 'Usage: %s --confirm-secret-install glm-provider\n' "$0"
}

confirmation=''
while (($# > 0)); do
  case "$1" in
    --confirm-secret-install) confirmation="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ "${confirmation}" == glm-provider ]] \
  || { usage >&2; printf '%s\n' 'Refusing to write a model secret without the exact confirmation token.' >&2; exit 2; }
[[ "${EUID}" -eq 0 ]] || { printf '%s\n' 'install-glm-provider-secret.sh must run as root.' >&2; exit 1; }
[[ -f "${platform_config}" && ! -L "${platform_config}" ]] \
  || { printf 'Platform configuration is missing or unsafe: %s\n' "${platform_config}" >&2; exit 1; }
[[ -t 0 ]] || { printf '%s\n' 'GLM API key must be entered from an interactive terminal; pipes and command arguments are forbidden.' >&2; exit 1; }

# platform.env is root-owned infrastructure input.  It contains no shell code
# beyond reviewed KEY=value declarations and is already the lifecycle source.
# shellcheck disable=SC1090
source "${platform_config}"
: "${DELIVERY_ROOT:?DELIVERY_ROOT is required in platform.env}"
glm_secret_file="${GLM_KEY_FILE:-${DELIVERY_ROOT}/secrets/glm-api-key}"
secrets_root="${DELIVERY_ROOT}/secrets"
secrets_root="$(readlink -m -- "${secrets_root}")"
glm_secret_file="$(readlink -m -- "${glm_secret_file}")"
[[ "${glm_secret_file}" == "${secrets_root}/"* ]] \
  || { printf '%s\n' 'GLM_KEY_FILE must remain under DELIVERY_ROOT/secrets.' >&2; exit 1; }

install -d -m 0700 -o root -g root "${secrets_root}"
[[ -d "${secrets_root}" && ! -L "${secrets_root}" && ! -L "${glm_secret_file}" ]] \
  || { printf '%s\n' 'GLM secret location is unsafe.' >&2; exit 1; }

IFS= read -r -s -p 'Paste GLM API key (input is hidden): ' glm_api_key
printf '\n'
[[ -n "${glm_api_key}" && "${glm_api_key}" != *$'\n'* && "${glm_api_key}" != *$'\r'* ]] \
  || { unset glm_api_key; printf '%s\n' 'GLM API key must be one non-empty line.' >&2; exit 1; }

secret_tmp="$(mktemp "${secrets_root}/.glm-api-key.XXXXXX")"
config_tmp=''
cleanup() {
  unset glm_api_key
  [[ -z "${secret_tmp:-}" ]] || rm -f -- "${secret_tmp}"
  [[ -z "${config_tmp:-}" ]] || rm -f -- "${config_tmp}"
}
trap cleanup EXIT

printf '%s\n' "${glm_api_key}" >"${secret_tmp}"
unset glm_api_key
chmod 0600 "${secret_tmp}"
chown root:root "${secret_tmp}"
[[ "$(stat -Lc '%u:%g:%a:%F' -- "${secret_tmp}")" == '0:0:600:regular file' ]] \
  || { printf '%s\n' 'Staged GLM secret permissions are unsafe.' >&2; exit 1; }
mv -- "${secret_tmp}" "${glm_secret_file}"
secret_tmp=''

config_dir="$(dirname -- "${platform_config}")"
config_tmp="$(mktemp "${config_dir}/.platform.env.glm.XXXXXX")"
awk -F= -v key='GLM_KEY_FILE' -v value="${glm_secret_file}" '
  BEGIN { found = 0 }
  $1 == key { print key "=" value; found = 1; next }
  { print }
  END { if (!found) print key "=" value }
' "${platform_config}" >"${config_tmp}"
chmod --reference="${platform_config}" "${config_tmp}"
chown --reference="${platform_config}" "${config_tmp}"
mv -- "${config_tmp}" "${platform_config}"
config_tmp=''

printf 'GLM secret is installed at %s with root-only permissions. Run the reviewed GLM provider maintenance upgrade next.\n' \
  "${glm_secret_file}"
