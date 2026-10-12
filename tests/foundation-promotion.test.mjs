import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

test('foundation promotion requires an explicit clean public main and preserves fast-forward, tag, audit and new-project consumption', async () => {
  const [promotion, common, versions] = await Promise.all([
    'scripts/promote-foundation.sh', 'scripts/lib/common.sh', 'config/versions.env',
  ].map(async (file) => (await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n')));
  const setup = [
    'set -Eeuo pipefail',
    'fixture="$(mktemp -d -t forge-foundation-test.XXXXXX)"',
    'trap \'rm -rf -- "$fixture"\' EXIT',
    'mkdir -p "$fixture/platform/scripts/lib" "$fixture/platform/config" "$fixture/delivery/baselines" "$fixture/delivery/registry"',
    `printf '%s' ${shellQuote(promotion)} > "$fixture/platform/scripts/promote-foundation.sh"`,
    `printf '%s' ${shellQuote(common)} > "$fixture/platform/scripts/lib/common.sh"`,
    `printf '%s' ${shellQuote(versions)} > "$fixture/platform/config/versions.env"`,
  ].join('\n');
  const scenario = String.raw`
for tool in git flock stat chmod id awk; do command -v "$tool" >/dev/null; done
export LC_ALL=C GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export PLATFORM_CONFIG="$fixture/platform/config/platform.env"
cat > "$PLATFORM_CONFIG" <<EOF
DELIVERY_ROOT='$fixture/delivery'
DELIVERY_OWNER='$(id -un)'
DELIVERY_GROUP='$(id -gn)'
DELIVERY_OWNER_UID='$(id -u)'
DELIVERY_GROUP_GID='$(id -g)'
DEEPSEEK_KEY_FILE='/unused'
KIMI_KEY_FILE='/unused'
SHARED_SERVICES_ENV_FILE='/unused'
DEFAULT_BIND_ADDRESS='127.0.0.1'
EOF
promote="$fixture/platform/scripts/promote-foundation.sh"
foundation="$fixture/delivery/baselines/forge-admin-foundation.git"
candidate="$fixture/public-candidate"
public_origin='ssh://git@public.invalid/owner/forge-admin-foundation.git'
git init --quiet --initial-branch=main "$fixture/seed"
git -C "$fixture/seed" config core.autocrlf false
printf 'public baseline\n' > "$fixture/seed/public.txt"
git -C "$fixture/seed" add public.txt
git -C "$fixture/seed" commit --quiet -m baseline
old="$(git -C "$fixture/seed" rev-parse HEAD)"
git clone --quiet --bare "$fixture/seed" "$foundation"
git --git-dir="$foundation" config receive.denyNonFastforwards true
git clone --quiet "$foundation" "$candidate"
git -C "$candidate" config core.autocrlf false
git -C "$candidate" remote set-url origin "$public_origin"
# No foundation remote exists: destination must come from the platform path.
printf 'bilingual public candidate\n' >> "$candidate/public.txt"
git -C "$candidate" add public.txt
git -C "$candidate" commit --quiet -m bilingual
commit="$(git -C "$candidate" rev-parse HEAD)"
tag=foundation-fixture-1
args=(--source-workspace "$candidate" --source-origin "$public_origin" --source-commit "$commit" --tag "$tag")
reject() {
  local reason="$1"; shift
  if bash "$promote" "$@" > "$fixture/rejected.log" 2>&1; then
    cat "$fixture/rejected.log" >&2; echo 'Unexpected promotion' >&2; exit 21
  fi
  grep -F -- "$reason" "$fixture/rejected.log" >/dev/null || { cat "$fixture/rejected.log" >&2; exit 22; }
  test "$(git --git-dir="$foundation" rev-parse refs/heads/main)" = "$old"
  test ! -e "$fixture/delivery/registry/foundation-promotions.tsv"
  test -z "$(git --git-dir="$foundation" tag --list)"
}
reject 'no implicit project source' --tag "$tag"
reject '40-character public main commit' "@ARGS@" --source-commit short
reject 'origin differs' "@ARGS@" --source-origin 'ssh://git@public.invalid/owner/customer.git'
git -C "$candidate" remote set-url origin 'ssh://git@public.invalid/owner/customer.git'
reject 'origin differs' "@ARGS@"
git -C "$candidate" remote set-url origin "$public_origin"
reject 'HEAD differs' "@ARGS@" --source-commit "$old"
printf 'uncommitted\n' > "$candidate/untracked.txt"
reject 'uncommitted changes' "@ARGS@"
rm "$candidate/untracked.txt"
printf 'dirty\n' >> "$candidate/public.txt"
reject 'uncommitted changes' "@ARGS@"
git -C "$candidate" checkout -- public.txt
git -C "$candidate" switch --quiet -c other
reject 'must be on main' "@ARGS@"
git -C "$candidate" switch --quiet main
git init --quiet --initial-branch=main "$fixture/unrelated"
git -C "$fixture/unrelated" remote add origin "$public_origin"
printf 'unrelated\n' > "$fixture/unrelated/file"
git -C "$fixture/unrelated" add file
git -C "$fixture/unrelated" commit --quiet -m unrelated
unrelated="$(git -C "$fixture/unrelated" rev-parse HEAD)"
reject 'must be a fast-forward' "@ARGS@" --source-workspace "$fixture/unrelated" --source-commit "$unrelated"

# A tag rejection must leave main unchanged as part of the atomic push.
cat > "$foundation/hooks/update" <<'HOOK'
#!/usr/bin/env bash
case "$1" in refs/tags/*) exit 1 ;; esac
HOOK
chmod +x "$foundation/hooks/update"
reject 'atomic push failure' "@ARGS@"
rm "$foundation/hooks/update"
bash "$promote" "@ARGS@"
test "$(git --git-dir="$foundation" rev-parse refs/heads/main)" = "$commit"
test "$(git --git-dir="$foundation" rev-parse "refs/tags/$tag")" = "$commit"
audit="$fixture/delivery/registry/foundation-promotions.tsv"
test "$(wc -l < "$audit")" = 2
awk -F '\t' -v before="$old" -v after="$commit" -v version="$tag" 'NR == 2 {if ($3 != version || $4 != before || $5 != after) exit 1}' "$audit"
test -f "$fixture/delivery/registry/foundation.lock"
test "$(stat -c %a "$audit")" = 640
if bash "$promote" "@ARGS@" > "$fixture/duplicate.log" 2>&1; then exit 23; fi
grep -F 'Foundation tag already exists' "$fixture/duplicate.log" >/dev/null
test "$(wc -l < "$audit")" = 2

# The existing create-project path reads bare main, clones, then checks out
# that exact SHA. No Harness build or customer workspace is involved.
source_commit="$(git --git-dir="$foundation" rev-parse 'refs/heads/main^{commit}')"
git clone --quiet --no-hardlinks "$foundation" "$fixture/new-project"
git -C "$fixture/new-project" checkout --quiet --detach "$source_commit"
git -C "$fixture/new-project" switch --quiet --create delivery/new-project
test "$(git -C "$fixture/new-project" rev-parse HEAD)" = "$commit"
test "$(git -C "$candidate" rev-parse HEAD)" = "$commit"
test -z "$(git -C "$candidate" status --porcelain --untracked-files=all)"
printf 'PASS public-source/commit/clean/main/FF/atomic-tag/audit/new-project\n'
`;
  // Substitute the shell array token after constructing the JavaScript template.
  const result = spawnSync('bash', ['-s'], {
    input: `${setup}\n${scenario.replaceAll('@ARGS@', '${args[@]}')}`,
    encoding: 'utf8', windowsHide: true, timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.match(result.stdout, /PASS public-source\/commit\/clean\/main\/FF\/atomic-tag\/audit\/new-project/u);
});
