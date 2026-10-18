#!/bin/bash

set -Eeuo pipefail

/usr/local/bin/node /usr/local/lib/forge-sync-model-catalog.mjs

if [ -n "${HARNESS_DEFAULT_WORKSPACE:-}" ]; then
  /usr/local/bin/node /usr/local/lib/seed-default-workspace.mjs
fi

key_file=/run/secrets/deepseek-api-key
if [ -r "${key_file}" ]; then
  DEEPSEEK_API_KEY="$(tr -d '\r\n' <"${key_file}")"
  [ -n "${DEEPSEEK_API_KEY}" ] || {
    printf '%s\n' 'DeepSeek API key secret is empty.' >&2
    exit 1
  }
  export DEEPSEEK_API_KEY
fi

kimi_key_file=/run/secrets/kimi-api-key
if [ -r "${kimi_key_file}" ]; then
  KIMI_API_KEY="$(tr -d '\r\n' <"${kimi_key_file}")"
  [ -n "${KIMI_API_KEY}" ] || {
    printf '%s\n' 'Kimi API key secret is empty.' >&2
    exit 1
  }
  export KIMI_API_KEY
fi

glm_key_file=/run/secrets/glm-api-key
if [ -r "${glm_key_file}" ]; then
  GLM_API_KEY="$(tr -d '\r\n' <"${glm_key_file}")"
  [ -n "${GLM_API_KEY}" ] || {
    printf '%s\n' 'GLM API key secret is empty.' >&2
    exit 1
  }
  export GLM_API_KEY
fi

port="${HARNESS_PORT:-3080}"
bind_address="${HARNESS_BIND_ADDRESS:-127.0.0.1}"
trusted_host="${HARNESS_TRUSTED_HOST:-${bind_address}:${port}}"
internal_port="${HARNESS_INTERNAL_PORT:-${port}}"
privileged_api_mode="${HARNESS_PRIVILEGED_API_MODE:-loopback-only}"
history_page_messages="${HARNESS_HISTORY_PAGE_MESSAGES:-5}"

case "${privileged_api_mode}" in
  loopback-only|trusted-host) ;;
  *)
    printf 'Unsupported HARNESS_PRIVILEGED_API_MODE: %s\n' "${privileged_api_mode}" >&2
    exit 1
    ;;
esac

case "${history_page_messages}" in
  ''|*[!0-9]*)
    printf 'HARNESS_HISTORY_PAGE_MESSAGES must be an integer from 1 to 50: %s\n' "${history_page_messages}" >&2
    exit 1
    ;;
esac
if [ "${history_page_messages}" -lt 1 ] || [ "${history_page_messages}" -gt 50 ]; then
  printf 'HARNESS_HISTORY_PAGE_MESSAGES must be an integer from 1 to 50: %s\n' "${history_page_messages}" >&2
  exit 1
fi

run_dsh() {
  exec /usr/local/bin/dsh web \
    --patch /usr/local/share/forge-governance-runtime.patch.yml \
    --host "${bind_address}" \
    --no-open \
    --port "${internal_port}" \
    --trusted-host "${trusted_host}" \
    --trusted-host "127.0.0.1:${internal_port}"
}

# The loopback-only image profile has no compatibility proxy. Preserve the
# original PID 1 and signal behavior for that profile.
if [[ -z "${HARNESS_PROXY_ADDRESS:-}" ]]; then
  run_dsh
fi

supervise_required_processes() {
  local proxy_pid="$1" dsh_pid="$2"
  local termination_status= first_status watchdog_pid

  terminate_children() {
    kill -TERM "${proxy_pid}" "${dsh_pid}" 2>/dev/null || true
  }

  forward_signal() {
    termination_status="$1"
    terminate_children
  }

  trap 'forward_signal 143' TERM
  trap 'forward_signal 130' INT

  # Both processes are required. If either one exits, stop and reap its sibling
  # so restart: unless-stopped can recover the complete container instead of
  # leaving a running DSH behind a dead public proxy.
  if wait -n "${proxy_pid}" "${dsh_pid}"; then
    first_status=0
  else
    first_status=$?
  fi
  if [[ -n "${termination_status}" ]]; then
    first_status="${termination_status}"
  else
    printf 'A required Harness process exited; stopping its sibling (status=%s).\n' \
      "${first_status}" >&2
  fi
  terminate_children

  # tcp-proxy performs a graceful server.close() on TERM. Bound that drain
  # below the Compose 30-second stop grace period so an abandoned WebSocket
  # cannot keep the container alive indefinitely.
  (
    sleep 25
    kill -KILL "${proxy_pid}" "${dsh_pid}" 2>/dev/null || true
  ) &
  watchdog_pid=$!

  wait "${proxy_pid}" 2>/dev/null || true
  wait "${dsh_pid}" 2>/dev/null || true
  kill "${watchdog_pid}" 2>/dev/null || true
  wait "${watchdog_pid}" 2>/dev/null || true
  trap - TERM INT
  return "${first_status}"
}

/usr/local/bin/node /usr/local/lib/harness-tcp-proxy.mjs \
  "${HARNESS_PROXY_ADDRESS}" "${port}" "127.0.0.1" "${internal_port}" \
  "${trusted_host}" "${privileged_api_mode}" "${history_page_messages}" &
proxy_pid=$!
run_dsh &
dsh_pid=$!

if supervise_required_processes "${proxy_pid}" "${dsh_pid}"; then
  exit 0
else
  exit $?
fi
