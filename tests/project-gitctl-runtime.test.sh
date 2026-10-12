#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
fixture_root="$(mktemp -d /tmp/forge-project-gitctl.XXXXXX)"

cleanup() {
  [[ -n "${fixture_root}" && -d "${fixture_root}" ]] && rm -rf -- "${fixture_root}"
}
trap cleanup EXIT

delivery_root="${fixture_root}/delivery"
project_root="${delivery_root}/projects/forge-test"
workspace="${project_root}/workspace"
git_root="${delivery_root}/git-remotes/forge-test"
remote_root="${fixture_root}/remote.git"
fake_bin="${fixture_root}/bin"
platform_config="${fixture_root}/platform.env"

mkdir -p -- "${workspace}" "${project_root}/ops" "${git_root}" "${fake_bin}"
chmod 0700 "${delivery_root}/git-remotes" "${git_root}"

git -C "${workspace}" init --initial-branch=integration >/dev/null
git -C "${workspace}" config user.name 'Git Remote Runtime Test'
git -C "${workspace}" config user.email 'git-remote-runtime@example.invalid'
printf 'fixture\n' >"${workspace}/fixture.txt"
git -C "${workspace}" add -- fixture.txt
git -C "${workspace}" commit -m 'fixture' >/dev/null
git init --bare --initial-branch=integration "${remote_root}" >/dev/null

ssh-keygen -q -t ed25519 -N '' -C 'forge-delivery:forge-test' -f "${git_root}/id_ed25519"
chmod 0600 "${git_root}/id_ed25519"
chmod 0644 "${git_root}/id_ed25519.pub"
ssh-keygen -q -t ed25519 -N '' -C 'fake-git-host' -f "${fixture_root}/host-key"
host_fingerprint="$(ssh-keygen -lf "${fixture_root}/host-key.pub" -E sha256 | awk 'NR == 1 {print $2}')"

cat >"${platform_config}" <<EOF
DELIVERY_ROOT=${delivery_root}
DELIVERY_OWNER=$(id -u)
DELIVERY_GROUP=$(id -g)
DEEPSEEK_KEY_FILE=${fixture_root}/unused-deepseek-key
KIMI_KEY_FILE=${fixture_root}/unused-kimi-key
SHARED_SERVICES_ENV_FILE=${fixture_root}/unused-shared-services.env
DEFAULT_BIND_ADDRESS=127.0.0.1
CONVERSATION_GATEWAY_PORT=13080
EOF

cat >"${project_root}/ops/project.env" <<'EOF'
PROJECT_GIT_REMOTE_REQUIRED=true
PROJECT_GIT_REMOTE_READY=false
PROJECT_GIT_REMOTE_NAME=origin
PROJECT_GIT_REMOTE_URL=ssh://git@fake.test:2222/example/forge-test.git
PROJECT_GIT_REMOTE_BRANCH=integration
EOF
chmod 0600 "${project_root}/ops/project.env"
git -C "${workspace}" remote add origin 'ssh://git@fake.test:2222/example/forge-test.git'

cat >"${fake_bin}/ssh-keyscan" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
host="${!#}"
awk -v host="[${host}]:2222" '{print host " " $1 " " $2}' "${FAKE_HOST_KEY_PUBLIC}"
EOF

cat >"${fake_bin}/ssh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
remote_command="${!#}"
case "${remote_command}" in
  git-upload-pack*) exec git-upload-pack "${FAKE_GIT_REMOTE}" ;;
  git-receive-pack*) exec git-receive-pack "${FAKE_GIT_REMOTE}" ;;
  *) printf 'Unexpected fake SSH command: %s\n' "${remote_command}" >&2; exit 2 ;;
esac
EOF
chmod 0755 "${fake_bin}/ssh-keyscan" "${fake_bin}/ssh"

export PATH="${fake_bin}:${PATH}"
export FAKE_HOST_KEY_PUBLIC="${fixture_root}/host-key.pub"
export FAKE_GIT_REMOTE="${remote_root}"

PLATFORM_CONFIG="${platform_config}" \
  bash "${REPO_ROOT}/scripts/project-gitctl.sh" forge-test attach \
    --host-key-sha256 "${host_fingerprint}" >/dev/null

local_head="$(git -C "${workspace}" rev-parse HEAD)"
remote_head="$(git --git-dir="${remote_root}" rev-parse refs/heads/integration)"
[[ "${local_head}" == "${remote_head}" ]]
grep -Fx 'PROJECT_GIT_REMOTE_READY=true' "${project_root}/ops/project.env" >/dev/null

printf 'PASS project-gitctl attach runtime\n'
