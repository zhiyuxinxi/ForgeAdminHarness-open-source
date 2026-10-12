#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config

usage() {
  printf '%s\n' \
    "Usage: $0 <project-slug> <command> [options]" \
    "" \
    "Commands:" \
    "  prepare --git-url <ssh-url> [--branch <branch>]" \
    "      Generate a project-only deploy key and register the reviewed remote as pending." \
    "  attach --host-key-sha256 <SHA256:fingerprint>" \
    "      Pin the Git server host key, verify write access, and push the exact integration HEAD." \
    "  status [--require-synchronized]" \
    "      Verify local/remote identity and optionally require equal integration HEADs." \
    "" \
    "Only ssh://git@host[:port]/namespace/project.git remotes are accepted."
}

slug="${1:-}"
action="${2:-}"
[[ -n "${slug}" && -n "${action}" ]] || { usage >&2; exit 2; }
shift 2
validate_slug "${slug}"

project_root="${DELIVERY_ROOT}/projects/${slug}"
workspace="${project_root}/workspace"
env_file="${project_root}/ops/project.env"
git_remotes_root="${DELIVERY_ROOT}/git-remotes"
git_root="${git_remotes_root}/${slug}"
private_key="${git_root}/id_ed25519"
public_key="${private_key}.pub"
known_hosts="${git_root}/known_hosts"
[[ -d "${workspace}/.git" && -f "${env_file}" ]] || die "Project is missing or incomplete: ${slug}"

for command_name in awk git grep install mktemp sed ssh-keygen ssh-keyscan stat; do
  require_command "${command_name}"
done

env_value() {
  local key="$1"
  awk -F= -v name="${key}" '$1 == name {sub(/^[^=]*=/, ""); print; exit}' "${env_file}"
}

upsert_env() {
  local key="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "${project_root}/ops/.project.env.XXXXXX")"
  awk -F= -v key="${key}" -v value="${value}" '
    $1 == key { print key "=" value; found=1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "${env_file}" >"${temporary}"
  chown --reference="${env_file}" "${temporary}"
  chmod 0600 "${temporary}"
  mv -- "${temporary}" "${env_file}"
}

validate_remote_url() {
  local url="$1"
  [[ "${url}" =~ ^ssh://git@([A-Za-z0-9.-]+)(:([0-9]{1,5}))?/[A-Za-z0-9._/-]+\.git$ ]] \
    || die "Git remote must be ssh://git@host[:port]/namespace/project.git without credentials."
  remote_host="${BASH_REMATCH[1]}"
  remote_port="${BASH_REMATCH[3]:-22}"
  [[ "${remote_port}" =~ ^[0-9]+$ ]] && ((remote_port >= 1 && remote_port <= 65535)) \
    || die "Git SSH port must be between 1 and 65535."
  [[ "${url}" != *$'\n'* && "${url}" != *$'\r'* && "${url}" != *$'\t'* ]] \
    || die "Git remote URL contains forbidden whitespace."
}

validate_branch() {
  local branch="$1"
  [[ "${branch}" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ]] \
    || die "Git remote branch is invalid: ${branch}"
  [[ "${branch}" != *..* && "${branch}" != */. && "${branch}" != */ ]] \
    || die "Git remote branch is invalid: ${branch}"
}

git_ssh_command() {
  printf 'ssh -i %q -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=%q' \
    "${private_key}" "${known_hosts}"
}

remote_git() {
  GIT_SSH_COMMAND="$(git_ssh_command)" project_git "${workspace}" "$@"
}

ensure_permissions() {
  [[ -f "${private_key}" && -f "${public_key}" ]] || die "Project deploy key is missing; run prepare first."
  [[ "$(stat -c '%a' "${git_remotes_root}")" == 700 ]] || die "Git credential root must have mode 0700."
  [[ "$(stat -c '%a' "${git_root}")" == 700 ]] || die "Git credential directory must have mode 0700."
  [[ "$(stat -c '%a' "${private_key}")" == 600 ]] || die "Git private key must have mode 0600."
  [[ "$(stat -c '%a' "${public_key}")" == 644 ]] || die "Git public key must have mode 0644."
}

case "${action}" in
  prepare)
    git_url=''
    branch="$(project_git_readonly "${workspace}" branch --show-current)"
    while (($# > 0)); do
      case "$1" in
        --git-url) git_url="${2:-}"; shift 2 ;;
        --branch) branch="${2:-}"; shift 2 ;;
        *) usage >&2; die "Unknown prepare argument: $1" ;;
      esac
    done
    [[ -n "${git_url}" ]] || die "--git-url is required."
    [[ -n "${branch}" ]] || die "--branch is required when the integration workspace is detached."
    validate_remote_url "${git_url}"
    validate_branch "${branch}"
    [[ -z "$(project_git_readonly "${workspace}" status --porcelain=v1 --untracked-files=all)" ]] \
      || die "Integration workspace must be clean before remote preparation."
    install -d -m 0700 "${git_remotes_root}"
    install -d -m 0700 "${git_root}"
    if [[ "${EUID}" -eq 0 ]]; then
      chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${git_remotes_root}"
    fi
    if [[ ! -f "${private_key}" ]]; then
      ssh-keygen -q -t ed25519 -N '' -C "forge-delivery:${slug}" -f "${private_key}"
    fi
    chmod 0700 "${git_root}"
    chmod 0600 "${private_key}"
    chmod 0644 "${public_key}"
    if [[ "${EUID}" -eq 0 ]]; then
      chown -R "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${git_root}"
    fi
    existing_url="$(project_git_readonly "${workspace}" remote get-url origin 2>/dev/null || true)"
    if [[ -n "${existing_url}" && "${existing_url}" != "${git_url}" ]]; then
      die "origin already points elsewhere; refusing to replace ${existing_url}."
    fi
    if [[ -z "${existing_url}" ]]; then
      project_git "${workspace}" remote add origin "${git_url}"
    fi
    upsert_env PROJECT_GIT_REMOTE_REQUIRED true
    upsert_env PROJECT_GIT_REMOTE_READY false
    upsert_env PROJECT_GIT_REMOTE_NAME origin
    upsert_env PROJECT_GIT_REMOTE_URL "${git_url}"
    upsert_env PROJECT_GIT_REMOTE_BRANCH "${branch}"
    upsert_env PROJECT_GIT_SSH_ROOT "${git_root}"
    log "Prepared project-only Git deploy key for ${slug}."
    log "Add this public key to the exact GitLab project with write_repository permission:"
    sed -n '1p' "${public_key}"
    warn "The project remains remote-pending until attach pins the host key and verifies the initial push."
    ;;
  attach)
    expected_fingerprint=''
    while (($# > 0)); do
      case "$1" in
        --host-key-sha256) expected_fingerprint="${2:-}"; shift 2 ;;
        *) usage >&2; die "Unknown attach argument: $1" ;;
      esac
    done
    [[ "${expected_fingerprint}" =~ ^SHA256:[A-Za-z0-9+/]{20,}={0,2}$ ]] \
      || die "--host-key-sha256 must be an independently reviewed SHA256 fingerprint."
    git_url="$(env_value PROJECT_GIT_REMOTE_URL)"
    branch="$(env_value PROJECT_GIT_REMOTE_BRANCH)"
    validate_remote_url "${git_url}"
    validate_branch "${branch}"
    ensure_permissions
    temporary_hosts="$(mktemp "${git_root}/.known_hosts.XXXXXX")"
    verified_hosts="$(mktemp "${git_root}/.verified-hosts.XXXXXX")"
    trap 'rm -f -- "${temporary_hosts}" "${verified_hosts}"' EXIT
    ssh-keyscan -T 10 -p "${remote_port}" "${remote_host}" >"${temporary_hosts}" 2>/dev/null \
      || die "Unable to scan the Git server host key."
    [[ -s "${temporary_hosts}" ]] || die "Git server host-key scan returned no keys."
    while IFS= read -r scanned_key; do
      [[ -n "${scanned_key}" && "${scanned_key}" != \#* ]] || continue
      scanned_fingerprint="$(
        ssh-keygen -lf <(printf '%s\n' "${scanned_key}") -E sha256 2>/dev/null \
          | awk 'NR == 1 {print $2}'
      )"
      if [[ "${scanned_fingerprint}" == "${expected_fingerprint}" ]]; then
        printf '%s\n' "${scanned_key}" >>"${verified_hosts}"
      fi
    done <"${temporary_hosts}"
    [[ -s "${verified_hosts}" ]] \
      || die "Git server host-key fingerprint does not match the reviewed value."
    install -m 0600 "${verified_hosts}" "${known_hosts}"
    if [[ "${EUID}" -eq 0 ]]; then
      chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${known_hosts}"
    fi
    remote_url="$(project_git_readonly "${workspace}" remote get-url origin 2>/dev/null || true)"
    [[ "${remote_url}" == "${git_url}" ]] || die "origin does not match the registered project Git URL."
    [[ -z "$(project_git_readonly "${workspace}" status --porcelain=v1 --untracked-files=all)" ]] \
      || die "Integration workspace must be clean before remote attachment."
    local_head="$(project_git_readonly "${workspace}" rev-parse 'HEAD^{commit}')"
    remote_line="$(remote_git ls-remote origin "refs/heads/${branch}")"
    remote_head="$(awk 'NR == 1 {print $1}' <<<"${remote_line}")"
    if [[ -n "${remote_head}" && "${remote_head}" != "${local_head}" ]]; then
      die "Remote branch already contains a different commit; refusing to overwrite it."
    fi
    if [[ -z "${remote_head}" ]]; then
      remote_git push origin "${local_head}:refs/heads/${branch}"
    fi
    verified_head="$(remote_git ls-remote origin "refs/heads/${branch}" | awk 'NR == 1 {print $1}')"
    [[ "${verified_head}" == "${local_head}" ]] || die "Remote branch verification failed after push."
    local_branch="$(project_git_readonly "${workspace}" branch --show-current)"
    project_git "${workspace}" branch --set-upstream-to="origin/${branch}" "${local_branch}" >/dev/null 2>&1 \
      || true
    upsert_env PROJECT_GIT_REMOTE_READY true
    upsert_env PROJECT_GIT_HOST_KEY_SHA256 "${expected_fingerprint}"
    log "Project ${slug} is bound to ${git_url} at ${branch}=${local_head}."
    ;;
  status)
    require_synchronized=false
    if [[ "${1:-}" == '--require-synchronized' ]]; then
      require_synchronized=true
      shift
    fi
    (($# == 0)) || { usage >&2; die "Unexpected status arguments."; }
    required="$(env_value PROJECT_GIT_REMOTE_REQUIRED)"
    ready="$(env_value PROJECT_GIT_REMOTE_READY)"
    git_url="$(env_value PROJECT_GIT_REMOTE_URL)"
    branch="$(env_value PROJECT_GIT_REMOTE_BRANCH)"
    expected_fingerprint="$(env_value PROJECT_GIT_HOST_KEY_SHA256)"
    [[ "${required}" == true ]] || die "Project Git remote is not mandatory for ${slug}."
    [[ "${ready}" == true ]] || die "Project Git remote is pending for ${slug}."
    validate_remote_url "${git_url}"
    validate_branch "${branch}"
    ensure_permissions
    [[ -f "${known_hosts}" && "$(stat -c '%a' "${known_hosts}")" == 600 ]] \
      || die "Pinned Git known_hosts must exist with mode 0600."
    [[ "${expected_fingerprint}" =~ ^SHA256:[A-Za-z0-9+/]{20,}={0,2}$ ]] \
      || die "The reviewed Git host-key fingerprint is missing or invalid."
    [[ "$(ssh-keygen -lf "${known_hosts}" -E sha256 | awk 'NR == 1 {print $2}')" == "${expected_fingerprint}" ]] \
      || die "Pinned Git known_hosts differs from the reviewed fingerprint."
    [[ "$(project_git_readonly "${workspace}" remote get-url origin)" == "${git_url}" ]] \
      || die "origin differs from the registered project Git URL."
    local_head="$(project_git_readonly "${workspace}" rev-parse 'HEAD^{commit}')"
    remote_head="$(remote_git ls-remote origin "refs/heads/${branch}" | awk 'NR == 1 {print $1}')"
    [[ "${remote_head}" =~ ^[a-f0-9]{40}$ ]] || die "Remote integration branch is missing."
    if [[ "${require_synchronized}" == true && "${local_head}" != "${remote_head}" ]]; then
      die "Local integration HEAD ${local_head} differs from remote ${remote_head}."
    fi
    printf 'project=%s\nremote=%s\nbranch=%s\nlocalHead=%s\nremoteHead=%s\nsynchronized=%s\n' \
      "${slug}" "${git_url}" "${branch}" "${local_head}" "${remote_head}" \
      "$([[ "${local_head}" == "${remote_head}" ]] && printf true || printf false)"
    ;;
  *)
    usage >&2
    die "Unknown command: ${action}"
    ;;
esac
