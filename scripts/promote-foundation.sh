#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config

usage() {
  printf '%s\n' \
    "Usage: $0 --source-workspace <path> --source-origin <url> --source-commit <sha> --tag <foundation-version>" \
    "" \
    "Promotes an explicitly reviewed, clean public foundation main commit to the" \
    "internal foundation repository. The source origin must match the independently" \
    "verified public repository URL. No project workspace is selected implicitly."
}

tag=''
workspace=''
source_origin=''
source_commit=''
while (($# > 0)); do
  case "$1" in
    --tag) tag="${2:-}"; shift 2 ;;
    --source-workspace) workspace="${2:-}"; shift 2 ;;
    --source-origin) source_origin="${2:-}"; shift 2 ;;
    --source-commit) source_commit="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done

[[ -n "${workspace}" && -n "${source_origin}" ]] \
  || die "--source-workspace and --source-origin are required; no implicit project source is allowed."
[[ "${source_commit}" =~ ^[0-9a-f]{40}$ ]] \
  || die "--source-commit must be the exact reviewed 40-character public main commit."
[[ "${tag}" =~ ^foundation-[0-9A-Za-z][0-9A-Za-z._-]{2,63}$ ]] \
  || die "--tag must match foundation-<version> using letters, digits, dot, underscore or hyphen."

for command_name in flock git; do
  require_command "${command_name}"
done

foundation_path="${DELIVERY_ROOT}/baselines/forge-admin-foundation.git"
audit_file="${DELIVERY_ROOT}/registry/foundation-promotions.tsv"
[[ -d "${workspace}/.git" && -d "${foundation_path}" ]] \
  || die "Public candidate workspace or the internal foundation repository is missing."
[[ ! -L "${foundation_path}" \
    && "$(git --git-dir="${foundation_path}" rev-parse --is-bare-repository)" == true ]] \
  || die "The internal foundation must be a non-symlink bare repository."

foundation_lock="${DELIVERY_ROOT}/registry/foundation.lock"
prepare_delivery_lock "${foundation_lock}"
exec 9>>"${foundation_lock}"
flock --exclusive 9

[[ "$(project_git_readonly "${workspace}" branch --show-current)" == main ]] \
  || die "The public candidate must be on main before promotion."
[[ -z "$(project_git_readonly "${workspace}" status --porcelain --untracked-files=all)" ]] \
  || die "The public candidate contains uncommitted changes. Review and commit them first."
[[ "$(project_git_readonly "${workspace}" remote get-url origin)" == "${source_origin}" ]] \
  || die "The candidate origin differs from the explicitly reviewed public repository."
new_commit="$(project_git_readonly "${workspace}" rev-parse 'HEAD^{commit}')"
[[ "${new_commit}" == "${source_commit}" ]] \
  || die "Public candidate HEAD differs from --source-commit."

# Fetch only the local delivery baseline. The public hosted commit has already
# been reviewed; offline bundle-based candidate checkouts need no remote key.
project_git "${workspace}" fetch --no-tags "${foundation_path}" refs/heads/main
old_commit="$(git --git-dir="${foundation_path}" rev-parse 'refs/heads/main^{commit}')"
project_git_readonly "${workspace}" merge-base --is-ancestor "${old_commit}" "${new_commit}" \
  || die "Promotion must be a fast-forward from the current foundation main."
if git --git-dir="${foundation_path}" show-ref --verify --quiet "refs/tags/${tag}"; then
  die "Foundation tag already exists: ${tag}"
fi

project_git "${workspace}" push --atomic "${foundation_path}" \
  "${new_commit}:refs/heads/main" \
  "${new_commit}:refs/tags/${tag}"

if [[ ! -f "${audit_file}" ]]; then
  printf 'promoted_at\tactor\ttag\told_commit\tnew_commit\n' >"${audit_file}"
fi
if [[ "${EUID}" -eq 0 ]]; then
  chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${audit_file}"
fi
chmod 0640 "${audit_file}"
printf '%s\t%s\t%s\t%s\t%s\n' \
  "$(date --iso-8601=seconds)" "$(id -un)" "${tag}" "${old_commit}" "${new_commit}" \
  >>"${audit_file}"

log "Promoted reviewed public foundation ${new_commit} as ${tag}."
log "Only projects created after this promotion inherit the new foundation."
