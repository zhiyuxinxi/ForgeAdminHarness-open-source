#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
artifact_input="${1:-${REPO_ROOT}/output/deployment/forge-delivery-toolkit-vpn71-local.tar.gz}"

for command_name in awk git gzip grep mktemp mv sha256sum tar wc; do
  command -v "${command_name}" >/dev/null 2>&1 \
    || { printf 'Required command is unavailable: %s\n' "${command_name}" >&2; exit 1; }
done

artifact_parent="$(dirname -- "${artifact_input}")"
mkdir -p -- "${artifact_parent}"
artifact_parent="$(cd -- "${artifact_parent}" && pwd -P)"
artifact="${artifact_parent}/$(basename -- "${artifact_input}")"
checksum="${artifact}.sha256"
temporary_tar="$(mktemp "${artifact_parent}/.portable-toolkit.XXXXXX.tar")"
temporary_source_tar="$(mktemp "${artifact_parent}/.portable-toolkit-source.XXXXXX.tar")"
temporary_source_tree="$(mktemp -d "${artifact_parent}/.portable-toolkit-source.XXXXXX")"
temporary_regular_list="$(mktemp "${artifact_parent}/.portable-toolkit-regular.XXXXXX.list")"
temporary_executable_list="$(mktemp "${artifact_parent}/.portable-toolkit-executable.XXXXXX.list")"
temporary_gzip="${artifact}.incomplete.$$"
temporary_checksum="${checksum}.incomplete.$$"
# The release evidence file is intentionally excluded because it records this
# artifact's own SHA-256. Including it would make the package self-referential
# and impossible to reproduce. A later evidence record may describe this
# artifact by hash after packaging has completed.
release_evidence_path='docs/validation-evidence/2026-09-01-forge-delivery-toolkit-vpn71-local.md'

cleanup() {
  rm -f -- \
    "${temporary_tar}" \
    "${temporary_source_tar}" \
    "${temporary_regular_list}" \
    "${temporary_executable_list}" \
    "${temporary_gzip}" \
    "${temporary_checksum}"
  rm -rf -- "${temporary_source_tree}"
}
trap cleanup EXIT

cd -- "${REPO_ROOT}"
git_root="$(git rev-parse --show-toplevel)"
git_root="$(cd -- "${git_root}" && pwd -P)"
[[ "${git_root}" == "${REPO_ROOT}" ]] \
  || { printf 'Repository identity changed while packaging.\n' >&2; exit 1; }
[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] \
  || { printf 'Portable packages must be built from a clean committed worktree.\n' >&2; exit 1; }
[[ -f "${release_evidence_path}" ]] \
  || { printf 'Portable package release evidence is missing from the committed worktree: %s\n' "${release_evidence_path}" >&2; exit 1; }
git ls-files --error-unmatch -- "${release_evidence_path}" >/dev/null 2>&1 \
  || { printf 'Portable package release evidence is not committed: %s\n' "${release_evidence_path}" >&2; exit 1; }

source_date_epoch="$(git show -s --format=%ct HEAD)"
[[ "${source_date_epoch}" =~ ^[0-9]+$ ]] \
  || { printf 'Could not derive a stable package timestamp from HEAD.\n' >&2; exit 1; }

# Materialize committed Git blobs before packaging. Reading from the worktree
# would make identical commits produce different archives under autocrlf or
# clean/smudge configurations.
git archive --format=tar --output="${temporary_source_tar}" HEAD
tar --extract --file "${temporary_source_tar}" --directory "${temporary_source_tree}"

executable_pattern='^(docker/harness/(forge-release|forge-prototype-index|forge-delivery|forge-governance|forge-verify)|.+\.sh)$'

# Git's tracked + non-ignored inventory is the inclusion authority. This keeps
# credentials, local environment files, .git and generated output out of the
# package without maintaining a second broad copy list.
git ls-files -z \
  | grep -zv '^TASK_HANDOFF.*\.md$' \
  | grep -zvFx -- "${release_evidence_path}" \
  | grep -zvE "${executable_pattern}" \
  >"${temporary_regular_list}"

git ls-files -z \
  | grep -zv '^TASK_HANDOFF.*\.md$' \
  | grep -zvFx -- "${release_evidence_path}" \
  | grep -zE "${executable_pattern}" \
  >"${temporary_executable_list}"

for inventory_file in "${temporary_regular_list}" "${temporary_executable_list}"; do
  while IFS= read -r -d '' package_path; do
    [[ ! -L "${temporary_source_tree}/${package_path}" ]] \
      || { printf 'Portable package refuses tracked symbolic links: %s\n' "${package_path}" >&2; exit 1; }
  done <"${inventory_file}"
done

tar --null --create --file "${temporary_tar}" \
  --directory "${temporary_source_tree}" \
  --format=gnu --numeric-owner --owner=0 --group=0 \
  --mtime="@${source_date_epoch}" --mode=0644 --no-recursion \
  --files-from "${temporary_regular_list}"

tar --null --append --file "${temporary_tar}" \
  --directory "${temporary_source_tree}" \
  --numeric-owner --owner=0 --group=0 \
  --mtime="@${source_date_epoch}" --mode=0755 --no-recursion \
  --files-from "${temporary_executable_list}"

for required in \
  scripts/create-project.sh \
  scripts/project-gitctl.sh \
  scripts/upgrade-project-git-remote.sh \
  scripts/deploy-private-git-remote.ps1 \
  scripts/forge-delivery-deploy-root.sh \
  scripts/install-forge-delivery-deploy-helper.sh \
  .codex/deployment-closeout.policy.json \
  scripts/clone-project-databases.sh \
  scripts/backup-project.sh \
  scripts/restore-project.sh \
  scripts/conversation-control-planectl.sh \
  scripts/backup-conversation-control-plane.sh \
  scripts/upgrade-unified-conversation-control-plane.sh \
  scripts/upgrade-project-material-isolation.sh \
  scripts/upgrade-taskspace-tool-cache.sh \
  scripts/upgrade-prototype-archive-support.sh \
  scripts/upgrade-project-folder-inputs.sh \
  scripts/upgrade-forge-delivery-toolkit.sh \
  scripts/prepare-forge-verification-cache.sh \
  scripts/prepare-local-forge-harness-eval-cache.sh \
  scripts/project-materialctl.sh \
  scripts/run-forge-protected-headless-recovery.mjs \
  scripts/recover-forge-dead-writer.mjs \
  scripts/acceptance/fault-inject-release-runner.sh \
  templates/project/compose.yaml \
  templates/conversation-control-plane/compose.yaml \
  templates/taskspace/compose.yaml \
  templates/taskspace/compose.legacy-v1.yaml \
  docker/harness/forge-delivery \
  docker/harness/forge-delivery.mjs \
  docker/harness/forge-governance \
  docker/harness/forge-governance.mjs \
  docker/harness/forge-governance-policy.json \
  docker/harness/forge-governance-runtime.patch.yml \
  docker/harness/forge-governance-prompt-guard.mjs \
  docker/harness/forge-completion-claim-guard.mjs \
  docker/harness/forge-host-verification-receipt.mjs \
  docker/harness/forge-backend-source-quality.mjs \
  docker/harness/forge-controlled-command.mjs \
  docker/harness/forge-task-execution-contract.mjs \
  docker/harness/forge-delivery-phase-runtime.mjs \
  docker/harness/forge-delivery-phase-response.mjs \
  docker/harness/forge-execution-context.mjs \
  docker/harness/forge-execution-policy.json \
  docker/harness/forge-prepare-headless-execution.mjs \
  docker/harness/forge-recover-headless-execution.mjs \
  docker/harness/conversation-output.js \
  docker/harness/harness-directory-scope.mjs \
  docker/harness/harness-directory-scope.js \
  docker/harness/conversation-output-store.mjs \
  docker/harness/conversation-output-projection.mjs \
  docker/harness/conversation-output-service.mjs \
  docker/harness/forge-protected-session-mode.mjs \
  docker/harness/forge-protected-headless-runner.mjs \
  docker/harness/forge-execution-capability-registry.json \
  docker/harness/forge-execution-capability-registry.mjs \
  docker/harness/forge-capability-negotiator.mjs \
  docker/harness/forge-execution-pack.mjs \
  docker/harness/forge-execution-store.mjs \
  docker/harness/forge-execution-orchestrator.mjs \
  docker/harness/forge-progress-detector.mjs \
  docker/harness/forge-change-contract.mjs \
  docker/harness/forge-business-data-approval.mjs \
  docker/harness/forge-business-data-preview.mjs \
  docker/harness/forge-managed-files.mjs \
  docker/harness/forge-managed-file-tool.mjs \
  docker/harness/forge-business-object-mutation.mjs \
  docker/harness/forge-semantic-resource-lease.mjs \
  docker/harness/forge-workflow-migration-safety.mjs \
  docker/harness/forge-ui-edit-session.mjs \
  docker/harness/forge-behavior-qualification.mjs \
  docker/harness/forge-reference-adoption-coverage.mjs \
  docker/harness/forge-reference-adoption-coverage.json \
  docker/harness/forge-execution-state.mjs \
  docker/harness/forge-obligation-ledger.mjs \
  docker/harness/forge-model-qualification.mjs \
  docker/harness/forge-acceptance-aggregator.mjs \
  docker/harness/forge-protected-issuer-adapter.mjs \
  docker/harness/forge-production-task-grant.mjs \
  docker/harness/forge-protected-acceptance-service.mjs \
  docker/harness/forge-quality-capability-registry.mjs \
  docker/harness/forge-quality-capability-registry.json \
  docker/harness/forge-phase-budget-guard.mjs \
  docker/harness/forge-writer-scope-client.mjs \
  docker/harness/forge-writer-scope-lease.mjs \
  docker/harness/forge-ui-contract.mjs \
  docker/harness/forge-ui-contract.json \
  docker/harness/forge-agent-preset-policy.mjs \
  docker/harness/forge-agent-preset-prompt-probe.mjs \
  docker/harness/forge-agent-preset-prompt-probe.patch.yml \
  docker/harness/forge-verify \
  docker/harness/verify-policy.mjs \
  docker/harness/verification-runner.mjs \
  docker/harness/verification-cache-tool.mjs \
  docker/harness/maven-verification-policy.mjs \
  docker/harness/maven-verification-settings.xml \
  docker/harness/maven-verification-exec.sh \
  docker/harness/taskspace-policy.mjs \
  docker/harness/taskspace-broker.mjs \
  docker/harness/image-build-inputs.json \
  docker/harness/ubuntu.sources \
  docker/harness/validate-image-build-inputs.mjs \
  docker/harness/validate-runtime-dependencies.mjs \
  docker/harness/validate-runtime-tree-metadata.sh \
  docker/harness/validate-skill-bundle.mjs \
  docker/harness/forge-delivery-phase-controller.mjs \
  docker/harness/forge-delivery-phase-browser-session.mjs \
  docker/harness/forge-cross-layer-runtime-evidence.mjs \
  docker/harness/forge-phase-work-package.mjs \
  docker/harness/forge-delivery-phase-workspace-observer.mjs \
  docker/harness/runtime-dependencies/package.json \
  docker/harness/runtime-dependencies/package-lock.json \
  docker/harness/skills.catalog.json \
  docker/harness/skills/forge-change-design/SKILL.md \
  docker/harness/skills/forge-change-design/references/change-design-contract.md \
  docker/harness/skills/forge-delivery-orchestrator/SKILL.md \
  docker/harness/skills/forge-delivery-orchestrator/references/orchestration-ledger.md \
  docker/harness/skills/forge-evidence-truth/SKILL.md \
  docker/harness/skills/forge-evidence-truth/references/evidence-ledger.md \
  docker/harness/skills/forge-task-router/SKILL.md \
  docker/harness/skills/forge-task-router/references/routing-contract.md \
  docker/harness/skills/forge-task-router/references/phase-profiles.json \
  docker/harness/skills/forge-phase-work-package/SKILL.md \
  docker/harness/skills/forge-phase-work-package/references/work-package-contract.md \
  docker/harness/skills/forge-phase-work-package/assets/requirements.md \
  docker/harness/skills/forge-phase-work-package/assets/domain-contract.md \
  docker/harness/skills/forge-phase-work-package/assets/database.md \
  docker/harness/skills/forge-phase-work-package/assets/ui-design.md \
  docker/harness/skills/forge-phase-work-package/assets/backend.md \
  docker/harness/skills/forge-phase-work-package/assets/frontend.md \
  docker/harness/skills/forge-phase-work-package/assets/access-wiring.md \
  docker/harness/skills/forge-phase-work-package/assets/cross-layer-acceptance.md \
  docs/ai-delivery-playbook/07-阶段工作包/README.md \
  docker/harness/skills/forge-database-migration/SKILL.md \
  docker/harness/skills/forge-database-migration/references/database-contract.md \
  docker/harness/skills/forge-backend-architecture/SKILL.md \
  docker/harness/skills/forge-backend-architecture/references/backend-contract.md \
  docker/harness/skills/forge-crud-production/SKILL.md \
  docker/harness/skills/forge-crud-production/references/crud-contract.md \
  docker/harness/skills/forge-frontend-admin/SKILL.md \
  docker/harness/skills/forge-frontend-admin/references/frontend-contract.md \
  docker/harness/skills/forge-security-tenancy-permission/SKILL.md \
  docker/harness/skills/forge-security-tenancy-permission/references/security-contract.md \
  docker/harness/skills/forge-workflow-production/SKILL.md \
  docker/harness/skills/forge-workflow-production/references/workflow-contract.md \
  docker/harness/skills/forge-testing-observability/SKILL.md \
  docker/harness/skills/forge-testing-observability/references/testing-observability-contract.md \
  tests/fixtures/forge-skill-evals/forge-admin-bundle.eval.json \
  tests/fixtures/forge-harness-behavior-evals/suite.json \
  tests/fixtures/forge-harness-behavior-evals/runtime-trust-lock.json \
  tests/fixtures/forge-harness-behavior-evals/headless-audit.patch.yml \
  tests/fixtures/forge-harness-behavior-evals/prompts/crud-complete.v1.md \
  tests/fixtures/forge-harness-behavior-evals/prompts/edge-pagination-shared-owner.v1.md \
  tests/fixtures/forge-harness-behavior-evals/prompts/frontend-aicrudpage-api-contract.v1.md \
  tests/fixtures/forge-harness-behavior-evals/prompts/adversarial-shortcuts.v1.md \
  scripts/run-local-forge-harness-evals.sh \
  scripts/snapshot-forge-harness-eval-inputs.mjs \
  scripts/snapshot-local-secret.mjs \
  scripts/verify-forge-harness-eval-runtime-lock.mjs \
  scripts/refresh-harness-runtime-lock.sh \
  scripts/analyze-forge-harness-session.mjs \
  scripts/validate-harness-image-config.mjs \
  tests/forge-governance.test.mjs \
  tests/forge-governance-runtime-instructions.test.mjs \
  tests/forge-delivery-phase-controller.test.mjs \
  tests/forge-delivery-browser-phase-controller.test.mjs \
  tests/forge-delivery-phase-browser-session.test.mjs \
  tests/forge-phase-work-package.test.mjs \
  tests/forge-delivery-phase-workspace-observer.test.mjs \
  tests/forge-harness-behavior-eval-runner.test.mjs \
  tests/forge-harness-eval-runtime-trust-lock.test.mjs \
  tests/forge-harness-eval-input-snapshot.test.mjs \
  tests/forge-harness-docker-resource-state.test.mjs \
  tests/forge-credential-proxy-contract.test.mjs \
  tests/local-secret-snapshot.test.mjs \
  tests/local-forge-verification-cache-prep.test.mjs \
  tests/harness-image-config-validator.test.mjs \
  tests/harness-runtime-build-policy.test.mjs \
  tests/runtime-dependency-validator.test.mjs \
  tests/runtime-lock-refresh.test.mjs \
  scripts/taskspacectl.sh \
  scripts/lib/common.sh \
  scripts/lib/managed-file-compose.mjs \
  scripts/lib/taskspace-compose-network.sh \
  scripts/lib/harness-image-verifier.sh \
  templates/project/verification-contract.json.tpl \
  templates/project/acceptance-service.json.tpl \
  tests/conversation-gateway-maintenance.test.mjs \
  tests/forge-phase-budget-guard.test.mjs \
  tests/forge-controlled-command.test.mjs \
  tests/forge-task-execution-contract.test.mjs \
  tests/forge-delivery-phase-runtime.test.mjs \
  tests/forge-delivery-phase-response.test.mjs \
  tests/forge-execution-context.test.mjs \
  tests/forge-recover-headless-execution.test.mjs \
  tests/forge-protected-headless-recovery-host.test.mjs \
  tests/forge-protected-session-mode.test.mjs \
  tests/forge-execution-capability-negotiation.test.mjs \
  tests/forge-execution-store.test.mjs \
  tests/forge-execution-orchestrator.test.mjs \
  tests/forge-progress-detector.test.mjs \
  tests/forge-change-contract.test.mjs \
  tests/fixtures/forge-change-contract/valid.json \
  tests/forge-business-data-approval.test.mjs \
  tests/forge-business-data-preview.test.mjs \
  tests/fixtures/forge-business-data-approval/valid.json \
  tests/forge-business-object-mutation.test.mjs \
  tests/fixtures/forge-business-object-mutation/valid.json \
  tests/forge-semantic-resource-lease.test.mjs \
  tests/forge-writer-scope-lease.test.mjs \
  tests/recover-forge-dead-writer.test.mjs \
  tests/fixtures/forge-semantic-resource-lease/valid.json \
  tests/forge-workflow-migration-safety.test.mjs \
  tests/fixtures/forge-workflow-migration-safety/valid.json \
  tests/forge-ui-edit-session.test.mjs \
  tests/fixtures/forge-ui-edit-session/valid.json \
  tests/forge-behavior-qualification.test.mjs \
  tests/fixtures/forge-behavior-qualification/suite.json \
  tests/fixtures/forge-behavior-qualification/prompts/feasibility-readonly.v1.md \
  tests/fixtures/forge-behavior-qualification/prompts/small-fix-routing.v1.md \
  tests/fixtures/forge-behavior-qualification/prompts/eval-nonexistent-tool.v1.md \
  tests/fixtures/forge-behavior-qualification/prompts/eval-stale-reference.v1.md \
  tests/fixtures/forge-behavior-qualification/prompts/eval-fake-test-output.v1.md \
  tests/forge-reference-adoption-coverage.test.mjs \
  tests/forge-execution-state.test.mjs \
  tests/forge-obligation-ledger.test.mjs \
  tests/forge-model-qualification.test.mjs \
  tests/forge-acceptance-aggregator.test.mjs \
  tests/forge-protected-issuer-adapter.test.mjs \
  tests/forge-production-task-grant.test.mjs \
  tests/forge-protected-acceptance-service.test.mjs \
  tests/forge-protected-acceptance-deployment.test.mjs \
  tests/forge-quality-capability-registry.test.mjs \
  tests/forge-ui-contract.test.mjs \
  tests/forge-verification-runner.test.mjs \
  tests/forge-verification-upgrade.test.mjs \
  tests/image-build-inputs.test.mjs \
  tests/taskspace-broker.test.mjs \
  tests/taskspace-git-exclude-path.test.sh \
  tests/validate.ps1 \
  docs/harness-skill-catalog.md \
  docs/forge-governance-reference-adoption.md \
  docs/harness-quality-gate-backlog.md \
  docs/architecture.md \
  docs/security.md \
  README.md \
  docs/decisions/0007-unified-multi-project-conversation-control-plane.md \
  docs/decisions/0008-private-intake-and-reviewed-project-materials.md \
  docs/decisions/0009-direct-sftp-project-folder-inputs.md \
  docs/decisions/0010-mandatory-private-git-remote.md \
  docs/multi-user-delivery-baseline.md \
  docs/validation-evidence/2026-08-28-project-replica-resilience-vpn37.md \
  docs/validation-evidence/2026-08-28-unified-multi-project-vpn39.md \
  docs/validation-evidence/2026-08-28-project-material-isolation-vpn42.md \
  docs/validation-evidence/2026-08-28-direct-sftp-axure-folder-vpn46.md; do
  tar --list --file "${temporary_tar}" | grep -Fx -- "${required}" >/dev/null \
    || { printf 'Portable package is missing required file: %s\n' "${required}" >&2; exit 1; }
done

forge_verify_mode="$(tar --list --verbose --file "${temporary_tar}" -- docker/harness/forge-verify | awk 'NR == 1 { print $1 }')"
[[ "${forge_verify_mode}" == '-rwxr-xr-x' ]] \
  || { printf 'Portable package executable mode mismatch for docker/harness/forge-verify: %s\n' "${forge_verify_mode:-missing}" >&2; exit 1; }

if tar --list --file "${temporary_tar}" | grep -Fx -- "${release_evidence_path}" >/dev/null; then
  printf 'Portable package must exclude its own hash-bearing release evidence.\n' >&2
  exit 1
fi

if tar --list --file "${temporary_tar}" \
  | grep -Ei '(^|/)(服务器账号密码|文件网关初始账号|bootstrap-credentials|acceptance-credentials|id_ed25519)(\.|$)|(^|/)project\.env$|\.pem$|^(output|\.git|backups?|recovery)/' >/dev/null; then
  printf 'Portable package contains a forbidden credential or runtime path.\n' >&2
  exit 1
fi

gzip -n -c -- "${temporary_tar}" >"${temporary_gzip}"
mv -- "${temporary_gzip}" "${artifact}"
hash="$(sha256sum -- "${artifact}" | awk '{print $1}')"
printf '%s  %s\n' "${hash}" "$(basename -- "${artifact}")" >"${temporary_checksum}"
mv -- "${temporary_checksum}" "${checksum}"

printf 'artifact=%s\nsha256=%s\nentries=%s\n' \
  "${artifact}" "${hash}" "$(tar --list --gzip --file "${artifact}" | wc -l)"
