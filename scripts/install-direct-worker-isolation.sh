#!/usr/bin/env bash
set -euo pipefail

# Install/reapply only the named direct-worker profiles. This does not change
# Docker defaults, system paths, sysctl values, existing containers or volumes.
[[ "${EUID}" == 0 ]] || { printf 'Run this platform installation as root.\n' >&2; exit 1; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
apparmor_source="${root}/templates/apparmor/forge-direct-worker"
seccomp_source="${root}/templates/seccomp/forge-direct-worker.json"
apparmor_target=/etc/apparmor.d/forge-direct-worker
seccomp_target=/etc/forge/forge-direct-worker-seccomp.json
[[ -x /sbin/apparmor_parser && -f /etc/apparmor.d/abi/4.0 ]] \
  || { printf 'Direct worker isolation requires AppArmor ABI 4.0 support.\n' >&2; exit 1; }
for item in "${apparmor_source}" "${seccomp_source}"; do
  [[ -f "${item}" && ! -L "${item}" ]] || { printf 'Missing regular isolation source.\n' >&2; exit 1; }
done
[[ ! -L /etc/forge && ! -L "${apparmor_target}" && ! -L "${seccomp_target}" ]] \
  || { printf 'Isolation installation destinations must not be symlinks.\n' >&2; exit 1; }
/sbin/apparmor_parser -Q -T "${apparmor_source}"
[[ -d /etc/forge ]] || install -d -m 0755 /etc/forge
if ! cmp -s -- "${seccomp_source}" "${seccomp_target}"; then
  install -o root -g root -m 0644 -- "${seccomp_source}" "${seccomp_target}"
fi
profile_changed=false
if ! cmp -s -- "${apparmor_source}" "${apparmor_target}"; then
  install -o root -g root -m 0644 -- "${apparmor_source}" "${apparmor_target}"
  profile_changed=true
fi
if [[ "${profile_changed}" == true ]] \
  || ! grep -Fxq 'forge-direct-worker (enforce)' /sys/kernel/security/apparmor/profiles; then
  /sbin/apparmor_parser -r "${apparmor_target}"
fi
printf 'Direct worker profiles installed; no containers were recreated.\n'
