$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$requiredFiles = @(
    'scripts/activate-clean-a9-access-scope.py',
    'scripts/deploy-clean-a9-access-scope.ps1',
    'tests/clean_a9_access_scope_activation_test.py',
    'README.md',
    'AGENTS.md',
    'project.manifest.json',
    'package.json',
    'package-lock.json',
    'DESIGN.md',
    'UX-CONTRACT.md',
    'premium-ui.json',
    'config/versions.env',
    'config/platform.env.example',
    'docker/harness/Dockerfile',
    'docker/harness/Dockerfile.overlay',
    'docker/harness/Dockerfile.taskspace-broker-ownership',
    'docker/harness/Dockerfile.legacy-conversation-surface',
    'docker/harness/apply-legacy-conversation-surface.mjs',
    'docker/harness/tcp-proxy.mjs',
    'docker/harness/project-file-upload.js',
    'docker/harness/conversation-output.js',
    'docker/harness/conversation-output-store.mjs',
    'docker/harness/conversation-output-projection.mjs',
    'docker/harness/conversation-output-service.mjs',
    'docker/harness/upload-server.mjs',
    'docker/harness/document-extractor.mjs',
    'docker/harness/prototype-archive.mjs',
    'docker/harness/prototype-directory-index.mjs',
    'docker/harness/material-readable.mjs',
    'docker/harness/harness-document-extract',
    'docker/harness/forge-prototype-index',
    'docker/harness/forge-delivery',
    'docker/harness/forge-delivery.mjs',
    'docker/harness/forge-governance',
    'docker/harness/forge-governance.mjs',
    'docker/harness/forge-governance-policy.json',
    'docker/harness/forge-governance-runtime.patch.yml',
    'docker/harness/forge-phase-budget-guard.mjs',
    'docker/harness/forge-prepare-task.mjs',
    'docker/harness/forge-conversation-task-proposal.mjs',
    'docker/harness/forge-conversation-task-preparation.mjs',
    'docker/harness/forge-typed-file-removal.mjs',
    'docker/harness/forge-host-verification-receipt.mjs',
    'docker/harness/forge-controlled-command.mjs',
    'docker/harness/forge-task-execution-contract.mjs',
    'docker/harness/forge-delivery-phase-browser-session.mjs',
    'docker/harness/forge-delivery-phase-host-receipts.mjs',
    'docker/harness/forge-delivery-phase-runtime.mjs',
    'docker/harness/forge-delivery-phase-response.mjs',
    'docker/harness/forge-delivery-phase-workspace-observer.mjs',
    'docker/harness/forge-execution-context.mjs',
    'docker/harness/forge-execution-policy.json',
    'docker/harness/forge-prepare-headless-execution.mjs',
    'docker/harness/forge-recover-headless-execution.mjs',
    'docker/harness/forge-protected-session-mode.mjs',
    'scripts/run-forge-protected-headless-recovery.mjs',
    'docker/harness/forge-protected-headless-runner.mjs',
    'docker/harness/forge-execution-capability-registry.json',
    'docker/harness/forge-execution-capability-registry.mjs',
    'docker/harness/forge-capability-negotiator.mjs',
    'docker/harness/forge-execution-pack.mjs',
    'docker/harness/forge-execution-store.mjs',
    'docker/harness/forge-execution-orchestrator.mjs',
    'docker/harness/forge-progress-detector.mjs',
    'docker/harness/forge-change-contract.mjs',
    'docker/harness/forge-business-data-approval.mjs',
    'docker/harness/forge-business-object-mutation.mjs',
    'docker/harness/forge-semantic-resource-lease.mjs',
    'docker/harness/forge-workflow-migration-safety.mjs',
    'docker/harness/forge-ui-edit-session.mjs',
    'docker/harness/forge-behavior-qualification.mjs',
    'docker/harness/forge-reference-adoption-coverage.mjs',
    'docker/harness/forge-reference-adoption-coverage.json',
    'docker/harness/forge-execution-state.mjs',
    'docker/harness/forge-obligation-ledger.mjs',
    'docker/harness/forge-model-qualification.mjs',
    'docker/harness/forge-acceptance-aggregator.mjs',
    'docker/harness/forge-protected-issuer-adapter.mjs',
    'docker/harness/forge-production-task-grant.mjs',
    'docker/harness/forge-cross-layer-runtime-evidence.mjs',
    'docker/harness/forge-protected-acceptance-service.mjs',
    'docker/harness/forge-independent-semantic-review.mjs',
    'docker/harness/forge-quality-capability-registry.mjs',
    'docker/harness/forge-quality-capability-registry.json',
    'docker/harness/forge-ui-contract.mjs',
    'docker/harness/forge-ui-contract.json',
    'docker/harness/forge-release',
    'docker/harness/forge-verify',
    'docker/harness/validate-skill-bundle.mjs',
    'docker/harness/validate-image-build-inputs.mjs',
    'docker/harness/validate-runtime-dependencies.mjs',
    'docker/harness/validate-runtime-tree-metadata.sh',
    'docker/harness/ubuntu.sources',
    'docker/harness/image-build-inputs.json',
    'docker/harness/runtime-dependencies/package.json',
    'docker/harness/runtime-dependencies/package-lock.json',
    'docker/harness/release-policy.mjs',
    'docker/harness/release-runner.mjs',
    'docker/harness/verify-policy.mjs',
    'docker/harness/verification-runner.mjs',
    'docker/harness/host-verify-policy.mjs',
    'docker/harness/host-verification-runner.mjs',
    'docker/harness/host-prepared-dependencies.mjs',
    'docker/harness/verification-cache-tool.mjs',
    'docker/harness/maven-verification-policy.mjs',
    'docker/harness/maven-verification-settings.xml',
    'docker/harness/maven-verification-exec.sh',
    'docker/harness/taskspace-policy.mjs',
    'docker/harness/taskspace-broker.mjs',
    'docker/harness/conversation-policy.mjs',
    'docker/harness/conversation-manager.mjs',
    'docker/harness/project-materials.mjs',
    'docker/harness/conversation-gateway.mjs',
    'docker/harness/project-directory.mjs',
    'docker/harness/conversation-gateway/index.html',
    'docker/harness/conversation-gateway/login.html',
    'docker/harness/conversation-gateway/change-password.html',
    'docker/harness/conversation-gateway/forbidden.html',
    'docker/harness/conversation-gateway/gateway.css',
    'docker/harness/conversation-gateway/gateway.js',
    'docker/harness/conversation-gateway/login.js',
    'docker/harness/conversation-gateway/change-password.js',
    'docker/harness/skills.catalog.json',
    'docker/harness/skills/forge-controlled-release/SKILL.md',
    'docker/harness/skills/forge-dictionary-contract/SKILL.md',
    'docker/harness/skills/forge-git-checkpoint/SKILL.md',
    'docker/harness/skills/forge-release-acceptance/SKILL.md',
    'docker/harness/skills/forge-requirement-coverage/SKILL.md',
    'docker/harness/skills/forge-task-contract/SKILL.md',
    'docker/harness/skills/forge-taskspace-collaboration/SKILL.md',
    'docker/harness/skills/forge-ui-consistency-review/SKILL.md',
    'docker/harness/skills/forge-change-design/SKILL.md',
    'docker/harness/skills/forge-change-design/references/change-design-contract.md',
    'docker/harness/skills/forge-delivery-orchestrator/SKILL.md',
    'docker/harness/skills/forge-delivery-orchestrator/references/orchestration-ledger.md',
    'docker/harness/skills/forge-evidence-truth/SKILL.md',
    'docker/harness/skills/forge-evidence-truth/references/evidence-ledger.md',
    'docker/harness/skills/forge-task-router/references/phase-profiles.json',
    'docker/harness/skills/forge-phase-work-package/SKILL.md',
    'docker/harness/skills/forge-phase-work-package/references/work-package-contract.md',
    'docker/harness/skills/forge-phase-work-package/assets/requirements.md',
    'docker/harness/skills/forge-phase-work-package/assets/domain-contract.md',
    'docker/harness/skills/forge-phase-work-package/assets/database.md',
    'docker/harness/skills/forge-phase-work-package/assets/ui-design.md',
    'docker/harness/skills/forge-phase-work-package/assets/backend.md',
    'docker/harness/skills/forge-phase-work-package/assets/frontend.md',
    'docker/harness/skills/forge-phase-work-package/assets/cross-layer-acceptance.md',
    'docker/harness/forge-phase-work-package.mjs',
    ('docs/ai-delivery-playbook/07-' + [string]::Concat([char[]]@(0x9636, 0x6BB5, 0x5DE5, 0x4F5C, 0x5305)) + '/README.md'),
    'docker/harness/skills/project-document-reader/SKILL.md',
    'tests/harness-proxy.test.mjs',
    'tests/harness-start-supervision.test.mjs',
    'tests/harness-upload.test.mjs',
    'tests/prototype-archive.test.mjs',
    'tests/release-runner.test.mjs',
    'tests/mobile-runtime-upgrade.test.mjs',
    'tests/forge-delivery.test.mjs',
    'tests/skill-bundle-validator.test.mjs',
    'tests/forge-skill-evals.test.mjs',
    'tests/forge-delivery-toolkit-upgrade.test.mjs',
    'tests/image-build-inputs.test.mjs',
    'tests/forge-governance.test.mjs',
    'tests/forge-phase-budget-guard.test.mjs',
    'tests/forge-prepare-task-runtime.test.mjs',
    'tests/forge-conversation-task-proposal.test.mjs',
    'tests/forge-conversation-task-preparation.test.mjs',
    'tests/forge-conversation-task-execution.test.mjs',
    'tests/forge-conversation-task-integration.test.mjs',
    'tests/forge-typed-file-removal.test.mjs',
    'tests/forge-controlled-command.test.mjs',
    'tests/forge-skill-command-closure.test.mjs',
    'tests/forge-task-execution-contract.test.mjs',
    'tests/forge-delivery-phase-runtime.test.mjs',
    'tests/forge-delivery-phase-response.test.mjs',
    'tests/forge-execution-context.test.mjs',
    'tests/forge-protected-session-mode.test.mjs',
    'tests/forge-protected-headless-recovery-host.test.mjs',
    'tests/forge-execution-capability-negotiation.test.mjs',
    'tests/forge-execution-store.test.mjs',
    'tests/forge-execution-orchestrator.test.mjs',
    'tests/forge-progress-detector.test.mjs',
    'tests/forge-change-contract.test.mjs',
    'tests/forge-business-data-approval.test.mjs',
    'tests/forge-business-object-mutation.test.mjs',
    'tests/forge-semantic-resource-lease.test.mjs',
    'tests/forge-workflow-migration-safety.test.mjs',
    'tests/forge-ui-edit-session.test.mjs',
    'tests/forge-behavior-qualification.test.mjs',
    'tests/forge-reference-adoption-coverage.test.mjs',
    'tests/fixtures/forge-change-contract/valid.json',
    'tests/fixtures/forge-business-data-approval/valid.json',
    'tests/fixtures/forge-business-object-mutation/valid.json',
    'tests/fixtures/forge-semantic-resource-lease/valid.json',
    'tests/fixtures/forge-workflow-migration-safety/valid.json',
    'tests/fixtures/forge-ui-edit-session/valid.json',
    'tests/fixtures/forge-behavior-qualification/suite.json',
    'tests/fixtures/forge-behavior-qualification/prompts/feasibility-readonly.v1.md',
    'tests/fixtures/forge-behavior-qualification/prompts/small-fix-routing.v1.md',
    'tests/forge-execution-state.test.mjs',
    'tests/forge-obligation-ledger.test.mjs',
    'tests/forge-model-qualification.test.mjs',
    'tests/forge-acceptance-aggregator.test.mjs',
    'tests/forge-protected-issuer-adapter.test.mjs',
    'tests/forge-production-task-grant.test.mjs',
    'tests/forge-cross-layer-runtime-evidence.test.mjs',
    'tests/forge-cross-layer-runtime-controller.test.mjs',
    'tests/forge-protected-acceptance-service.test.mjs',
    'tests/forge-independent-semantic-review.test.mjs',
    'tests/forge-protected-acceptance-deployment.test.mjs',
    'tests/forge-quality-capability-registry.test.mjs',
    'tests/forge-ui-contract.test.mjs',
    'tests/forge-verification-runner.test.mjs',
    'tests/external-skill-bundle.test.mjs',
    'tests/host-verification-runner.test.mjs',
    'tests/host-prepared-dependencies.test.mjs',
    'tests/host-dependency-seed.test.mjs',
    'tests/prepare-host-dependency-seed.test.mjs',
    'tests/local-host-profile-adapter.test.mjs',
    'tests/host-runner-bundle.test.mjs',
    'tests/split-runtime-template.test.mjs',
    'tests/runtime-dependency-validator.test.mjs',
    'tests/harness-image-config-validator.test.mjs',
    'tests/glm-provider-config.test.mjs',
    'tests/harness-runtime-build-policy.test.mjs',
    'tests/runtime-lock-refresh.test.mjs',
    'tests/forge-delivery-phase-controller.test.mjs',
    'tests/forge-delivery-browser-phase-controller.test.mjs',
    'tests/forge-delivery-phase-browser-session.test.mjs',
    'tests/forge-delivery-phase-host-receipts.test.mjs',
    'tests/forge-phase-work-package.test.mjs',
    'tests/forge-delivery-phase-workspace-observer.test.mjs',
    'tests/forge-harness-behavior-eval-runner.test.mjs',
    'tests/forge-harness-eval-runtime-trust-lock.test.mjs',
    'tests/forge-harness-eval-input-snapshot.test.mjs',
    'tests/forge-harness-docker-resource-state.test.mjs',
    'tests/forge-credential-proxy-contract.test.mjs',
    'tests/local-secret-snapshot.test.mjs',
    'tests/local-forge-verification-cache-prep.test.mjs',
    'tests/frontend-typecheck-capability.test.mjs',
    'tests/connection-status-patch.test.mjs',
    'tests/taskspace-git-exclude-path.test.sh',
    'tests/taskspace-network-pool.test.sh',
    'tests/taskspace-upgrade-network-compatibility.test.sh',
    'tests/taskspace-governance-context.test.sh',
    'tests/taskspace-maintenance-mutator-fence.test.sh',
    'tests/fixtures/forge-skill-evals/forge-admin-bundle.eval.json',
    'tests/taskspace-broker.test.mjs',
    'tests/project-gitctl-runtime.test.sh',
    'tests/project-git-ownership.test.sh',
    'tests/conversation-policy.test.mjs',
    'tests/conversation-manager.test.mjs',
    'tests/forge-phase-host-receipts-manager.test.mjs',
    'tests/conversation-gateway.test.mjs',
    'tests/conversation-gateway-upgrade.test.mjs',
    'tests/conversation-gateway-maintenance.test.mjs',
    'tests/project-directory.test.mjs',
    'tests/conversation-control-plane-migration.test.mjs',
    'tests/live-conversation-isolation.mjs',
    'tests/live-same-user-conversations.mjs',
    'templates/project/compose.yaml',
    'templates/project/frontend-typecheck-capability.json',
    'templates/project/frontend-typecheck-capability.patch',
    'templates/project/project.env.tpl',
    'templates/project/verification-contract.json.tpl',
    'templates/project/host-verification-contract.json.tpl',
    'templates/project/host-verification-runner-config.tpl',
    'templates/project/compose.host-verification.yaml',
    'templates/project/acceptance-service.json.tpl',
    'templates/project/PROJECT_CONTEXT.md.tpl',
    'templates/conversation-control-plane/compose.yaml',
    'templates/project/harness-settings.yaml',
    'templates/taskspace/compose.yaml',
    'templates/taskspace/compose.legacy-v1.yaml',
    'templates/systemd/forge-host-verification@.service',
    'templates/file-gateway/compose.yaml',
    'templates/playbook-portal/compose.yaml',
    'docker/playbook-portal/Dockerfile',
    'docker/playbook-portal/nginx.conf',
    'playbook-portal/package.json',
    'playbook-portal/pnpm-lock.yaml',
    'playbook-portal/src/main.tsx',
    'playbook-portal/src/content.ts',
    'scripts/bootstrap-host.sh',
    'scripts/sync-baseline.sh',
    'scripts/create-project.sh',
    'scripts/upgrade-frontend-typecheck.sh',
    'scripts/project-gitctl.sh',
    'scripts/upgrade-project-git-remote.sh',
    'scripts/upgrade-integration-git-ownership.sh',
    'scripts/upgrade-mobile-runtime.sh',
    'scripts/clone-project-databases.sh',
    'scripts/promote-foundation.sh',
    'scripts/projectctl.sh',
    'scripts/taskspacectl.sh',
    'scripts/forge-skill-bundle.mjs',
    'scripts/forge-host-runner-bundle.mjs',
    'scripts/run-forge-protected-headless-recovery.mjs',
    'scripts/conversation-userctl.sh',
    'scripts/conversation-control-planectl.sh',
    'scripts/backup-conversation-control-plane.sh',
    'scripts/recover-legacy-shared-conversations.sh',
    'scripts/migrate-conversation-control-plane.mjs',
    'scripts/generate-release-contract.sh',
    'scripts/lib/common.sh',
    'scripts/lib/taskspace-compose-network.sh',
    'scripts/lib/frontend-typecheck-capability.sh',
    'scripts/lib/harness-image-verifier.sh',
    'scripts/validate-harness-image-config.mjs',
    'scripts/refresh-harness-runtime-lock.sh',
    'scripts/run-local-forge-harness-evals.sh',
    'scripts/prepare-forge-verification-cache.sh',
    'scripts/prepare-local-forge-harness-eval-cache.sh',
    'scripts/analyze-forge-harness-session.mjs',
    'scripts/snapshot-forge-harness-eval-inputs.mjs',
    'scripts/snapshot-local-secret.mjs',
    'scripts/verify-forge-harness-eval-runtime-lock.mjs',
    'tests/fixtures/forge-harness-behavior-evals/runtime-trust-lock.json',
    'scripts/lib/release-contract.sh',
    'scripts/upgrade-controlled-release.sh',
    'scripts/upgrade-release-runner-readiness.sh',
    'scripts/upgrade-harness-vpn-access.sh',
    'scripts/install-glm-provider-secret.sh',
    'scripts/upgrade-glm-provider.sh',
    'scripts/upgrade-forge-delivery-toolkit.sh',
    'scripts/upgrade-taskspace-isolation.sh',
    'scripts/upgrade-conversation-isolation.sh',
    'scripts/upgrade-unified-conversation-control-plane.sh',
    'scripts/project-materialctl.sh',
    'scripts/upgrade-project-material-isolation.sh',
    'scripts/upgrade-taskspace-tool-cache.sh',
    'scripts/upgrade-prototype-archive-support.sh',
    'scripts/upgrade-project-folder-inputs.sh',
    'scripts/backup-project.sh',
    'scripts/restore-project.sh',
    'scripts/package-portable-toolkit.sh',
    'scripts/deploy-private-git-remote.ps1',
    'scripts/deploy-mobile-runtime.ps1',
    'scripts/deploy-legacy-conversations.ps1',
    'scripts/deploy-integration-git-ownership.ps1',
    'scripts/deploy-forge-base-r75.ps1',
    'scripts/deploy-forge-base-r76.ps1',
    'scripts/deploy-forge-base-r77.ps1',
    'scripts/deploy-forge-base-r78.ps1',
    'scripts/forge-delivery-deploy-root.sh',
    'scripts/forge-delivery-mobile-runtime-root.sh',
    'scripts/forge-delivery-legacy-conversations-root.sh',
    'scripts/install-forge-delivery-deploy-helper.sh',
    'scripts/install-mobile-runtime-deploy-helper.sh',
    'scripts/install-legacy-conversations-deploy-helper.sh',
    'scripts/forge-delivery-integration-git-ownership-root.sh',
    'scripts/install-integration-git-ownership-deploy-helper.sh',
    '.codex/deployment-closeout.policy.json',
    'scripts/acceptance/fault-inject-release-runner.sh',
    'scripts/redis-logical-state.py',
    'scripts/file-gatewayctl.sh',
    'scripts/playbookctl.sh',
    'scripts/file_gateway_admin.py',
    'tests/file_gateway_admin_test.py',
    'tests/redis_logical_state_test.py',
    'tests/file-gateway-integration.ps1',
    'docs/harness-skill-catalog.md'
    'docs/decisions/0005-taskspace-isolation-and-serialized-promotion.md'
    'docs/decisions/0006-authenticated-conversation-gateway.md'
    'docs/decisions/0007-unified-multi-project-conversation-control-plane.md'
    'docs/decisions/0008-private-intake-and-reviewed-project-materials.md'
)

foreach ($relativePath in $requiredFiles) {
    $path = Join-Path $repoRoot $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required file is missing: $relativePath"
    }
}

$linuxRuntimeFiles = @(
    'docker/harness/conversation-output.js',
    'docker/harness/conversation-output-store.mjs',
    'docker/harness/conversation-output-projection.mjs',
    'docker/harness/conversation-output-service.mjs',
    'config/versions.env',
    'config/platform.env.example',
    'docker/harness/forge-release',
    'docker/harness/forge-delivery',
    'docker/harness/forge-delivery.mjs',
    'docker/harness/forge-verify',
    'docker/harness/validate-skill-bundle.mjs',
    'docker/harness/validate-image-build-inputs.mjs',
    'docker/harness/validate-runtime-tree-metadata.sh',
    'docker/harness/image-build-inputs.json',
    'docker/harness/harness-document-extract',
    'docker/harness/release-policy.mjs',
    'docker/harness/release-runner.mjs',
    'docker/harness/verify-policy.mjs',
    'docker/harness/verification-runner.mjs',
    'docker/harness/verification-cache-tool.mjs',
    'docker/harness/maven-verification-policy.mjs',
    'docker/harness/maven-verification-settings.xml',
    'docker/harness/maven-verification-exec.sh',
    'docker/harness/forge-governance-runtime.patch.yml',
    'docker/harness/forge-phase-budget-guard.mjs',
    'docker/harness/forge-delivery-phase-runtime.mjs',
    'docker/harness/forge-delivery-phase-response.mjs',
    'docker/harness/forge-execution-context.mjs',
    'docker/harness/forge-execution-policy.json',
    'docker/harness/forge-prepare-headless-execution.mjs',
    'docker/harness/forge-recover-headless-execution.mjs',
    'docker/harness/forge-protected-session-mode.mjs',
    'docker/harness/forge-protected-headless-runner.mjs',
    'docker/harness/taskspace-policy.mjs',
    'docker/harness/taskspace-broker.mjs',
    'docker/harness/conversation-policy.mjs',
    'docker/harness/apply-legacy-conversation-surface.mjs',
    'docker/harness/conversation-manager.mjs',
    'docker/harness/project-materials.mjs',
    'docker/harness/prototype-archive.mjs',
    'docker/harness/prototype-directory-index.mjs',
    'docker/harness/material-readable.mjs',
    'docker/harness/forge-prototype-index',
    'docker/harness/conversation-gateway.mjs',
    'docker/harness/project-directory.mjs',
    'docker/harness/conversation-gateway/index.html',
    'docker/harness/conversation-gateway/login.html',
    'docker/harness/conversation-gateway/change-password.html',
    'docker/harness/conversation-gateway/forbidden.html',
    'docker/harness/conversation-gateway/gateway.css',
    'docker/harness/conversation-gateway/gateway.js',
    'docker/harness/conversation-gateway/login.js',
    'docker/harness/conversation-gateway/change-password.js',
    'docker/harness/skills.catalog.json',
    'docker/harness/skills/forge-dictionary-contract/SKILL.md',
    'docker/harness/skills/forge-release-acceptance/SKILL.md',
    'docker/harness/skills/forge-requirement-coverage/SKILL.md',
    'docker/harness/skills/forge-task-contract/SKILL.md',
    'docker/harness/skills/forge-taskspace-collaboration/SKILL.md',
    'docker/harness/skills/forge-ui-consistency-review/SKILL.md',
    'docker/harness/skills/forge-change-design/SKILL.md',
    'docker/harness/skills/forge-change-design/references/change-design-contract.md',
    'docker/harness/skills/forge-delivery-orchestrator/SKILL.md',
    'docker/harness/skills/forge-delivery-orchestrator/references/orchestration-ledger.md',
    'docker/harness/skills/forge-evidence-truth/SKILL.md',
    'docker/harness/skills/forge-evidence-truth/references/evidence-ledger.md',
    'templates/project/project.env.tpl'
    'templates/project/verification-contract.json.tpl'
    'templates/conversation-control-plane/compose.yaml'
    'templates/taskspace/compose.yaml'
    'templates/taskspace/compose.legacy-v1.yaml'
    'scripts/taskspacectl.sh'
    'scripts/lib/common.sh'
    'scripts/lib/taskspace-compose-network.sh'
    'scripts/lib/harness-image-verifier.sh'
    'scripts/validate-harness-image-config.mjs'
    'scripts/refresh-harness-runtime-lock.sh'
    'scripts/run-local-forge-harness-evals.sh'
    'scripts/prepare-forge-verification-cache.sh'
    'scripts/prepare-local-forge-harness-eval-cache.sh'
    'scripts/analyze-forge-harness-session.mjs'
    'scripts/snapshot-forge-harness-eval-inputs.mjs'
    'scripts/verify-forge-harness-eval-runtime-lock.mjs'
    'scripts/upgrade-taskspace-isolation.sh'
    'scripts/upgrade-integration-git-ownership.sh'
    'scripts/conversation-userctl.sh'
    'scripts/conversation-control-planectl.sh'
    'scripts/backup-conversation-control-plane.sh'
    'scripts/upgrade-unified-conversation-control-plane.sh'
    'scripts/project-materialctl.sh'
    'scripts/upgrade-project-material-isolation.sh'
    'scripts/upgrade-taskspace-tool-cache.sh'
    'scripts/upgrade-prototype-archive-support.sh'
    'scripts/upgrade-project-folder-inputs.sh'
    'scripts/upgrade-forge-delivery-toolkit.sh'
    'scripts/upgrade-mobile-runtime.sh'
    'scripts/upgrade-conversation-isolation.sh'
    'scripts/clone-project-databases.sh'
    'scripts/backup-project.sh'
    'scripts/restore-project.sh'
    'scripts/package-portable-toolkit.sh'
    'scripts/forge-delivery-deploy-root.sh'
    'scripts/forge-delivery-mobile-runtime-root.sh'
    'scripts/forge-delivery-legacy-conversations-root.sh'
    'scripts/install-forge-delivery-deploy-helper.sh'
    'scripts/install-mobile-runtime-deploy-helper.sh'
    'scripts/install-legacy-conversations-deploy-helper.sh'
    'scripts/forge-delivery-integration-git-ownership-root.sh'
    'scripts/install-integration-git-ownership-deploy-helper.sh'
    'scripts/acceptance/fault-inject-release-runner.sh'
    'scripts/redis-logical-state.py'
    'docker/harness/Dockerfile.taskspace-broker-ownership'
    'tests/taskspace-maintenance-mutator-fence.test.sh'
    'tests/project-git-ownership.test.sh'
    'tests/taskspace-network-pool.test.sh'
    'tests/taskspace-upgrade-network-compatibility.test.sh'
)
foreach ($relativePath in $linuxRuntimeFiles) {
    $bytes = [IO.File]::ReadAllBytes((Join-Path $repoRoot $relativePath))
    if ([Array]::IndexOf($bytes, [byte]13) -ge 0) {
        throw "Linux runtime file contains CRLF bytes: $relativePath"
    }
}
Write-Host 'PASS Linux runtime files use LF line endings'

$projectManifestPath = Join-Path $repoRoot 'project.manifest.json'
$projectManifestText = [IO.File]::ReadAllText($projectManifestPath)
$projectManifest = $projectManifestText | ConvertFrom-Json
if ($projectManifest.schemaVersion -ne 1 -or
    $projectManifest.projectKey -cne 'forge-admin-harness' -or
    $projectManifest.projectName -cne 'ForgeAdminHarness' -or
    $projectManifest.manifestId -cne 'forge-admin-harness') {
    throw 'project.manifest.json does not contain the exact registered project identity.'
}
if ($projectManifestText -match '(?i)(?:[a-z]:[\\/]|file:|\\\\|/users/|/home/)' -or
    $projectManifestText -match '(?i)(?:password|secret|token|api[_-]?key)') {
    throw 'project.manifest.json contains a machine path or credential-shaped field.'
}
$agentsText = [IO.File]::ReadAllText((Join-Path $repoRoot 'AGENTS.md'))
if ($agentsText -notmatch 'prepare_project_grounded_response' -or
    $agentsText -notmatch 'forge-admin-harness') {
    throw 'AGENTS.md does not enforce manifest-first explicit project grounding.'
}
Write-Host 'PASS stable project manifest and new-session grounding contract'

$runtimeNode = Get-Command node -ErrorAction SilentlyContinue
if (-not $runtimeNode) {
    throw 'Node.js is required to validate the pinned ZIP parser dependency.'
}
$runtimeMetadataJson = & $runtimeNode.Source -e "const p=require(process.argv[1]),l=require(process.argv[2]);process.stdout.write(JSON.stringify({private:p.private,declared:p.dependencies?.yauzl,locked:l.packages?.['node_modules/yauzl']?.version}))" (Join-Path $repoRoot 'package.json') (Join-Path $repoRoot 'package-lock.json')
if ($LASTEXITCODE -ne 0) {
    throw 'The Node runtime dependency manifests could not be read.'
}
$runtimeMetadata = $runtimeMetadataJson | ConvertFrom-Json
$pinnedZipVersion = [string]$runtimeMetadata.declared
if ($runtimeMetadata.private -ne $true -or
    $pinnedZipVersion -cne '3.4.0' -or
    [string]$runtimeMetadata.locked -cne $pinnedZipVersion) {
    throw 'The local safe ZIP parser dependency is not exactly locked.'
}
Write-Host 'PASS pinned local ZIP parser dependency lock'

$projectComposeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'templates/project/compose.yaml'))
$verificationContractText = [IO.File]::ReadAllText((Join-Path $repoRoot 'templates/project/verification-contract.json.tpl'))
$verificationContract = $verificationContractText | ConvertFrom-Json
$forgeGovernanceRuntimePatchText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/forge-governance-runtime.patch.yml'))
$releaseClientText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/forge-release'))
$deliveryClientText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/forge-delivery'))
$deliveryKernelText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/forge-delivery.mjs'))
$skillValidatorText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/validate-skill-bundle.mjs'))
$releaseSkillText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/skills/forge-controlled-release/SKILL.md'))
$gitCheckpointSkillText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/skills/forge-git-checkpoint/SKILL.md'))
$taskContractSkillText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/skills/forge-task-contract/SKILL.md'))
$uiConsistencySkillText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/skills/forge-ui-consistency-review/SKILL.md'))
$releaseAcceptanceSkillText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/skills/forge-release-acceptance/SKILL.md'))
$taskspaceSkillText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/skills/forge-taskspace-collaboration/SKILL.md'))
$changeDesignSkillText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/skills/forge-change-design/SKILL.md'))
$deliveryOrchestratorSkillText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/skills/forge-delivery-orchestrator/SKILL.md'))
$evidenceTruthSkillText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/skills/forge-evidence-truth/SKILL.md'))
$taskspaceComposeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'templates/taskspace/compose.yaml'))
$taskspaceBrokerText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/taskspace-broker.mjs'))
$taskspaceBrokerOwnershipImageText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/Dockerfile.taskspace-broker-ownership'))
$taskspacePolicyText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/taskspace-policy.mjs'))
$taskspaceControlText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/taskspacectl.sh'))
$integrationGitOwnershipUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-integration-git-ownership.sh'))
$commonScriptText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/lib/common.sh'))
$backupProjectText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/backup-project.sh'))
$cloneProjectDatabasesText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/clone-project-databases.sh'))
$promoteFoundationText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/promote-foundation.sh'))
$conversationGatewayText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/conversation-gateway.mjs'))
$conversationManagerText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/conversation-manager.mjs'))
$projectMaterialsText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/project-materials.mjs'))
$prototypeArchiveText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/prototype-archive.mjs'))
$prototypeDirectoryIndexText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/prototype-directory-index.mjs'))
$portablePackageText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/package-portable-toolkit.sh'))
$privateGitDeployText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/deploy-private-git-remote.ps1'))
$privateGitRootHelperText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/forge-delivery-deploy-root.sh'))
$privateGitHelperInstallerText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/install-forge-delivery-deploy-helper.sh'))
$mobileDeployText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/deploy-mobile-runtime.ps1'))
$mobileRootHelperText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/forge-delivery-mobile-runtime-root.sh'))
$mobileHelperInstallerText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/install-mobile-runtime-deploy-helper.sh'))
$mobileUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-mobile-runtime.sh'))
$legacyDeployText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/deploy-legacy-conversations.ps1'))
$legacyRootHelperText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/forge-delivery-legacy-conversations-root.sh'))
$legacyHelperInstallerText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/install-legacy-conversations-deploy-helper.sh'))
$legacyUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-conversation-gateway-ui.sh'))
$integrationGitOwnershipDeployText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/deploy-integration-git-ownership.ps1'))
$integrationGitOwnershipRootHelperText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/forge-delivery-integration-git-ownership-root.sh'))
$integrationGitOwnershipHelperInstallerText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/install-integration-git-ownership-deploy-helper.sh'))
$deploymentPolicyText = [IO.File]::ReadAllText((Join-Path $repoRoot '.codex/deployment-closeout.policy.json'))
$deploymentPolicy = $deploymentPolicyText | ConvertFrom-Json
$harnessOverlayText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/Dockerfile.overlay'))
$materialReadableText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/material-readable.mjs'))
$projectDocumentReaderText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/skills/project-document-reader/SKILL.md'))
$uploadServerText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/upload-server.mjs'))
$projectDirectoryText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/project-directory.mjs'))
$controlPlaneComposeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'templates/conversation-control-plane/compose.yaml'))
$conversationProxyUiText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/conversation-gateway/gateway.js'))
$productSafetyCardMatches = @(
    Get-ChildItem -LiteralPath (Join-Path $repoRoot 'docs/ai-delivery-playbook') -Filter '*.md' -File -Recurse |
        Where-Object { [IO.File]::ReadAllText($_.FullName) -match 'PRODUCT_HARNESS_TRIAL_CARD_V1' }
)
$productSafetyCardText = if ($productSafetyCardMatches.Count -eq 1) {
    [IO.File]::ReadAllText($productSafetyCardMatches[0].FullName)
} else {
    ''
}
$projectContextPolicyText = [IO.File]::ReadAllText((Join-Path $repoRoot 'templates/project/PROJECT_CONTEXT.md.tpl'))
$skillCatalogPath = Join-Path $repoRoot 'docker/harness/skills.catalog.json'
$skillCatalogText = [IO.File]::ReadAllText($skillCatalogPath)
$skillCatalog = $skillCatalogText | ConvertFrom-Json
$skillRoot = Join-Path $repoRoot 'docker/harness/skills'
$skillDirectoryNames = @(Get-ChildItem -LiteralPath $skillRoot -Directory | ForEach-Object Name | Sort-Object)
$catalogSkillNames = @($skillCatalog.skills | ForEach-Object name | Sort-Object)
$skillSetDiff = @(Compare-Object -ReferenceObject $skillDirectoryNames -DifferenceObject $catalogSkillNames)
$skillNamesUnique = @($catalogSkillNames | Select-Object -Unique)
$versionsText = [IO.File]::ReadAllText((Join-Path $repoRoot 'config/versions.env'))
$bundleVersion = [string]$skillCatalog.bundleVersion
$embeddedBundleVersion = [regex]::Match($versionsText, '(?m)^HARNESS_SKILL_BUNDLE_VERSION=(.+)$').Groups[1].Value.Trim()
$externalBundleVersion = [regex]::Match($versionsText, '(?m)^FORGE_EXTERNAL_SKILL_BUNDLE_VERSION=(.+)$').Groups[1].Value.Trim()
$configuredHarnessRevision = [regex]::Match($versionsText, '(?m)^HARNESS_IMAGE_REVISION=(.+)$').Groups[1].Value.Trim()
if ($skillCatalog.schemaVersion -ne 2 -or
    [string]::IsNullOrWhiteSpace($bundleVersion) -or
    [string]::IsNullOrWhiteSpace($embeddedBundleVersion) -or
    [string]::IsNullOrWhiteSpace($externalBundleVersion) -or
    [string]::IsNullOrWhiteSpace($configuredHarnessRevision) -or
    $skillSetDiff.Count -ne 0 -or
    $skillNamesUnique.Count -ne $catalogSkillNames.Count -or
    $externalBundleVersion -cne $bundleVersion) {
    throw 'External Harness Skill catalog, directory inventory, and configured external bundle version are inconsistent.'
}
$configuredHarnessImage = [regex]::Match($versionsText, '(?m)^HARNESS_IMAGE=(.+)$').Groups[1].Value.Trim()
$configuredConversationManagerImage = [regex]::Match($versionsText, '(?m)^CONVERSATION_MANAGER_IMAGE=(.+)$').Groups[1].Value.Trim()
$configuredRunnerImage = [regex]::Match($versionsText, '(?m)^RELEASE_RUNNER_IMAGE=(.+)$').Groups[1].Value.Trim()
$configuredDatabaseOperatorImage = [regex]::Match($versionsText, '(?m)^RELEASE_DB_OPERATOR_IMAGE=(.+)$').Groups[1].Value.Trim()
if ([string]::IsNullOrWhiteSpace($configuredHarnessImage) -or
    [string]::IsNullOrWhiteSpace($configuredConversationManagerImage) -or
    [string]::IsNullOrWhiteSpace($configuredRunnerImage) -or
    $configuredDatabaseOperatorImage -notmatch '@sha256:[a-f0-9]{64}$') {
    throw 'Harness, Conversation Manager, or Release Runner image configuration is missing, or the test-database operator image lacks a valid digest pin.'
}
$skillPolicyMarkers = @{
    'forge-task-contract' = 'FORGE_TASK_CONTRACT_V2'
    'forge-requirement-coverage' = 'FORGE_REQUIREMENT_COVERAGE_V1'
    'forge-dictionary-contract' = 'FORGE_DICTIONARY_CONTRACT_V1'
    'forge-ui-consistency-review' = 'FORGE_UI_CONSISTENCY_REVIEW_V1'
    'forge-release-acceptance' = 'FORGE_RELEASE_ACCEPTANCE_V1'
    'forge-change-design' = 'FORGE_CHANGE_DESIGN_V1'
    'forge-delivery-orchestrator' = 'FORGE_DELIVERY_ORCHESTRATOR_V1'
    'forge-evidence-truth' = 'FORGE_EVIDENCE_TRUTH_V1'
    'forge-task-router' = 'FORGE_TASK_ROUTER_V1'
    'forge-phase-work-package' = 'FORGE_PHASE_WORK_PACKAGE_V1'
    'forge-database-migration' = 'FORGE_DATABASE_MIGRATION_V1'
    'forge-backend-architecture' = 'FORGE_BACKEND_ARCHITECTURE_V1'
    'forge-crud-production' = 'FORGE_CRUD_PRODUCTION_V1'
    'forge-frontend-admin' = 'FORGE_FRONTEND_ADMIN_V1'
    'forge-security-tenancy-permission' = 'FORGE_SECURITY_TENANCY_PERMISSION_V1'
    'forge-workflow-production' = 'FORGE_WORKFLOW_PRODUCTION_V1'
    'forge-testing-observability' = 'FORGE_TESTING_OBSERVABILITY_V1'
}
$harnessDockerfileText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/Dockerfile'))
$harnessOverlayText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/Dockerfile.overlay'))
$startHarnessText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/start-harness.sh'))
$defaultWorkspaceText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/seed-default-workspace.mjs'))
foreach ($imageBuildText in @($harnessDockerfileText, $harnessOverlayText)) {
    if ($imageBuildText -notmatch 'chmod 0755 /usr/local/share/conversation-gateway' -or
        $imageBuildText -notmatch '/usr/local/share/conversation-gateway/\*' -or
        $imageBuildText -notmatch 'seed-default-workspace\.mjs') {
        throw 'Conversation Gateway static assets must be traversable and readable by the non-root image user.'
    }
}
$requiredRuntimeCopyMappings = @(
    @{ Source = 'docker/harness/forge-phase-budget-guard.mjs'; Destination = '/usr/local/lib/forge-phase-budget-guard.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-host-verification-receipt.mjs'; Destination = '/usr/local/lib/forge-host-verification-receipt.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-controlled-command.mjs'; Destination = '/usr/local/lib/forge-controlled-command.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-task-execution-contract.mjs'; Destination = '/usr/local/lib/forge-task-execution-contract.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-delivery-phase-browser-session.mjs'; Destination = '/usr/local/lib/forge-delivery-phase-browser-session.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-delivery-phase-host-receipts.mjs'; Destination = '/usr/local/lib/forge-delivery-phase-host-receipts.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-delivery-phase-workspace-observer.mjs'; Destination = '/usr/local/lib/forge-delivery-phase-workspace-observer.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-delivery-phase-runtime.mjs'; Destination = '/usr/local/lib/forge-delivery-phase-runtime.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-delivery-phase-response.mjs'; Destination = '/usr/local/lib/forge-delivery-phase-response.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-execution-context.mjs'; Destination = '/usr/local/lib/forge-execution-context.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-execution-policy.json'; Destination = '/usr/local/lib/forge-execution-policy.json'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-prepare-headless-execution.mjs'; Destination = '/usr/local/lib/forge-prepare-headless-execution.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-recover-headless-execution.mjs'; Destination = '/usr/local/lib/forge-recover-headless-execution.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-protected-session-mode.mjs'; Destination = '/usr/local/lib/forge-protected-session-mode.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-protected-headless-runner.mjs'; Destination = '/usr/local/lib/forge-protected-headless-runner.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-execution-capability-registry.json'; Destination = '/usr/local/share/forge-execution-capability-registry.json'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-execution-capability-registry.mjs'; Destination = '/usr/local/lib/forge-execution-capability-registry.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-capability-negotiator.mjs'; Destination = '/usr/local/lib/forge-capability-negotiator.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-execution-pack.mjs'; Destination = '/usr/local/lib/forge-execution-pack.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-execution-store.mjs'; Destination = '/usr/local/lib/forge-execution-store.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-execution-orchestrator.mjs'; Destination = '/usr/local/lib/forge-execution-orchestrator.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-progress-detector.mjs'; Destination = '/usr/local/lib/forge-progress-detector.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-change-contract.mjs'; Destination = '/usr/local/lib/forge-change-contract.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-business-data-approval.mjs'; Destination = '/usr/local/lib/forge-business-data-approval.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-business-object-mutation.mjs'; Destination = '/usr/local/lib/forge-business-object-mutation.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-semantic-resource-lease.mjs'; Destination = '/usr/local/lib/forge-semantic-resource-lease.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-workflow-migration-safety.mjs'; Destination = '/usr/local/lib/forge-workflow-migration-safety.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-ui-edit-session.mjs'; Destination = '/usr/local/lib/forge-ui-edit-session.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-behavior-qualification.mjs'; Destination = '/usr/local/lib/forge-behavior-qualification.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-reference-adoption-coverage.mjs'; Destination = '/usr/local/lib/forge-reference-adoption-coverage.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-reference-adoption-coverage.json'; Destination = '/usr/local/lib/forge-reference-adoption-coverage.json'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-execution-state.mjs'; Destination = '/usr/local/lib/forge-execution-state.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-obligation-ledger.mjs'; Destination = '/usr/local/lib/forge-obligation-ledger.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-model-qualification.mjs'; Destination = '/usr/local/lib/forge-model-qualification.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-acceptance-aggregator.mjs'; Destination = '/usr/local/lib/forge-acceptance-aggregator.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-protected-issuer-adapter.mjs'; Destination = '/usr/local/lib/forge-protected-issuer-adapter.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-production-task-grant.mjs'; Destination = '/usr/local/lib/forge-production-task-grant.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-cross-layer-runtime-evidence.mjs'; Destination = '/usr/local/lib/forge-cross-layer-runtime-evidence.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-protected-acceptance-service.mjs'; Destination = '/usr/local/lib/forge-protected-acceptance-service.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-quality-capability-registry.mjs'; Destination = '/usr/local/lib/forge-quality-capability-registry.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-quality-capability-registry.json'; Destination = '/usr/local/share/forge-quality-capability-registry.json'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-ui-contract.mjs'; Destination = '/usr/local/lib/forge-ui-contract.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-ui-contract.json'; Destination = '/usr/local/lib/forge-ui-contract.json'; Mode = '0644' }
    @{ Source = 'docker/harness/forge-verify'; Destination = '/usr/local/bin/forge-verify'; Mode = '0755' }
    @{ Source = 'docker/harness/verify-policy.mjs'; Destination = '/usr/local/lib/verify-policy.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/verification-runner.mjs'; Destination = '/usr/local/lib/verification-runner.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/verification-cache-tool.mjs'; Destination = '/usr/local/lib/verification-cache-tool.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/maven-verification-policy.mjs'; Destination = '/usr/local/lib/maven-verification-policy.mjs'; Mode = '0644' }
    @{ Source = 'docker/harness/maven-verification-settings.xml'; Destination = '/usr/local/lib/maven-verification-settings.xml'; Mode = '0644' }
    @{ Source = 'docker/harness/maven-verification-exec.sh'; Destination = '/usr/local/lib/maven-verification-exec.sh'; Mode = '0644' }
)
$imageInputManifest = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/image-build-inputs.json')) | ConvertFrom-Json
function Test-ReviewedDockerCopyMapping {
    param(
        [Parameter(Mandatory = $true)][string]$DockerfileText,
        [Parameter(Mandatory = $true)][hashtable]$Mapping
    )
    $normalized = $DockerfileText -replace '\\\r?\n\s*', ' '
    $exactPattern = "(?m)^COPY --chmod=$([regex]::Escape($Mapping.Mode)) $([regex]::Escape($Mapping.Source)) $([regex]::Escape($Mapping.Destination))$"
    if ($normalized -match $exactPattern) { return $true }
    $destinationDirectory = $Mapping.Destination.Substring(0, $Mapping.Destination.LastIndexOf('/') + 1)
    $groupedPattern = "(?m)^COPY --chmod=$([regex]::Escape($Mapping.Mode)) (?=[^`r`n]*$([regex]::Escape($Mapping.Source)))(?:[^`r`n]+) $([regex]::Escape($destinationDirectory))$"
    return $normalized -match $groupedPattern
}
foreach ($mapping in $requiredRuntimeCopyMappings) {
    foreach ($imageBuildText in @($harnessDockerfileText, $harnessOverlayText)) {
        if (-not (Test-ReviewedDockerCopyMapping -DockerfileText $imageBuildText -Mapping $mapping)) {
            throw "Harness Dockerfile is missing the reviewed runtime mapping: $($mapping.Source)"
        }
    }
    $manifestMappings = @($imageInputManifest.mappings | Where-Object {
        $_.source -ceq $mapping.Source -and
        $_.destination -ceq $mapping.Destination.TrimStart('/') -and
        $_.type -ceq 'file' -and
        $_.mode -ceq $mapping.Mode
    })
    if ($manifestMappings.Count -ne 1) {
        throw "Harness image-input manifest does not contain one exact reviewed runtime mapping: $($mapping.Source)"
    }
}
Write-Host 'PASS phase guard and controlled-verification image mappings are identical across both Dockerfiles and the manifest'
if ($forgeGovernanceRuntimePatchText -notmatch '(?m)^\s+- id: forge-phase-budget-guard\s*$' -or
    $forgeGovernanceRuntimePatchText -notmatch 'file:///usr/local/lib/forge-phase-budget-guard\.mjs' -or
    $forgeGovernanceRuntimePatchText -notmatch 'FORGE_PHASE_BUDGET_GUARD_V1' -or
    $forgeGovernanceRuntimePatchText -notmatch 'Ordinary development suspends mandatory Skill order' -or
    $forgeGovernanceRuntimePatchText -notmatch 'actual applicable compilation, build, necessary startup' -or
    $forgeGovernanceRuntimePatchText -notmatch 'authority and total resource budgets') {
    throw 'The runtime governance patch must register the guard, suspend drafting rituals and preserve required delivery checks.'
}
Write-Host 'PASS phase-budget guard is registered in the versioned Harness runtime patch'
foreach ($skillName in $catalogSkillNames) {
    $skillPath = Join-Path $skillRoot "$skillName/SKILL.md"
    $skillText = [IO.File]::ReadAllText($skillPath)
    if ($skillText -notmatch "(?m)^name:\s+$([regex]::Escape($skillName))\s*$" -or
        $skillText -notmatch '(?m)^description:\s+\S') {
        throw "Harness Skill frontmatter is invalid or mismatched: $skillName"
    }
    if ($skillPolicyMarkers.ContainsKey($skillName) -and
        $skillText -notmatch [regex]::Escape($skillPolicyMarkers[$skillName])) {
        throw "Harness Skill is missing its reviewed policy marker: $skillName"
    }
}
$pilotSkillNames = @($skillCatalog.skills | Where-Object maturity -eq 'pilot' | ForEach-Object name | Sort-Object)
if (@(Compare-Object -ReferenceObject @($skillPolicyMarkers.Keys | Sort-Object) -DifferenceObject $pilotSkillNames).Count -ne 0) {
    throw 'The pilot Skill inventory must exactly match the reviewed policy-marker set.'
}
if ($harnessDockerfileText -notmatch 'FORGE_HARNESS_SKILL_BUNDLE_VERSION' -or
    $harnessOverlayText -notmatch 'FORGE_HARNESS_SKILL_BUNDLE_VERSION' -or
    $harnessDockerfileText -notmatch 'DSH_BUNDLED_SKILL_DIR=/opt/forge-skill-bundles/current/skills' -or
    $harnessOverlayText -notmatch 'DSH_BUNDLED_SKILL_DIR=/opt/forge-skill-bundles/current/skills' -or
    $harnessOverlayText -notmatch "ARG HARNESS_SKILL_BUNDLE_VERSION=$([regex]::Escape($bundleVersion))" -or
    $harnessOverlayText -notmatch "ARG HARNESS_IMAGE_REVISION=$([regex]::Escape($configuredHarnessRevision))") {
    throw 'Harness fallback image and current overlay do not expose the external versioned Skill authority.'
}
foreach ($imageBuildText in @($harnessDockerfileText, $harnessOverlayText)) {
    if ($imageBuildText -notmatch 'forge-delivery\.mjs' -or
        $imageBuildText -notmatch 'validate-skill-bundle\.mjs' -or
        $imageBuildText -notmatch 'validate-image-build-inputs\.mjs' -or
        $imageBuildText -notmatch 'validate-runtime-dependencies\.mjs' -or
        $imageBuildText -notmatch 'image-build-inputs\.json' -or
        $imageBuildText -notmatch 'runtime-dependencies/package-lock\.json' -or
        $imageBuildText -notmatch 'forge-image-build/receipt\.json' -or
        $imageBuildText -notmatch 'runtime-dependency-receipt\.json' -or
        $imageBuildText -notmatch 'forge-delivery --help') {
        throw 'Harness images do not package and verify the deterministic delivery kernel.'
    }
}
& $runtimeNode.Source (Join-Path $repoRoot 'docker/harness/validate-image-build-inputs.mjs') `
    --mode source `
    --root $repoRoot `
    --spec (Join-Path $repoRoot 'docker/harness/image-build-inputs.json') `
    --json
if ($LASTEXITCODE -ne 0) {
    throw 'Complete Harness image build-input validation failed.'
}
& $runtimeNode.Source (Join-Path $repoRoot 'docker/harness/validate-skill-bundle.mjs') `
    --skills-root (Join-Path $repoRoot 'docker/harness/skills') `
    --catalog (Join-Path $repoRoot 'docker/harness/skills.catalog.json') `
    --strict
if ($LASTEXITCODE -ne 0) {
    throw 'Strict Harness Skill bundle validation failed.'
}
& $runtimeNode.Source (Join-Path $repoRoot 'docker/harness/validate-skill-bundle.mjs') `
    --skills-root (Join-Path $repoRoot 'docker/harness/skills') `
    --catalog (Join-Path $repoRoot 'docker/harness/skills.catalog.json') `
    --evals (Join-Path $repoRoot 'tests/fixtures/forge-skill-evals') `
    --behavior-suite (Join-Path $repoRoot 'tests/fixtures/forge-harness-behavior-evals/suite.json') `
    --strict
if ($LASTEXITCODE -ne 0) {
    throw 'Harness Skill implicit-routing contract validation failed.'
}
if ($deliveryClientText -notmatch '/usr/local/lib/forge-delivery\.mjs' -or
    $deliveryKernelText -notmatch "'evidence-recorded'" -or
    $deliveryKernelText -notmatch 'executionProven:\s*false' -or
    $deliveryKernelText -notmatch 'verificationProven:\s*false' -or
    $deliveryKernelText -notmatch 'check-ignore.*--no-index' -or
    $deliveryKernelText -notmatch 'ls-files' -or
    $deliveryKernelText -notmatch 'shell:\s*false' -or
    $deliveryKernelText -match "'verified'" -or
    $skillValidatorText -notmatch 'treeSha256' -or
    $skillValidatorText -notmatch 'eval-side-effect-exceeded') {
    throw 'The deterministic delivery kernel must fail closed on unignored state, bind non-self-proving evidence, and preserve fixed-command execution boundaries.'
}
Write-Host "PASS versioned Harness Skill bundle $bundleVersion ($($catalogSkillNames.Count) cataloged Skills)"
if ($taskspaceComposeText -notmatch 'HARNESS_DEFAULT_WORKSPACE:\s*/workspace' -or
    $taskspaceComposeText -notmatch 'HARNESS_DEFAULT_WORKSPACE_TITLE:.*PROJECT_SLUG' -or
    $startHarnessText -notmatch 'node /usr/local/lib/seed-default-workspace\.mjs' -or
    $defaultWorkspaceText -notmatch 'Existing DSH workspace storage has an unsupported schema' -or
    $defaultWorkspaceText -notmatch "reason: 'existing-workspace-preserved'" -or
    $defaultWorkspaceText -notmatch 'rename\(temporaryPath, storagePath\)' -or
    $defaultWorkspaceText -notmatch 'mode: 0o600') {
    throw 'TaskSpace default workspace registration is not versioned, fail-closed, state-preserving, and atomic.'
}
Write-Host 'PASS automatic isolated /workspace registration contract'
if ($projectComposeText -match 'FORGE_RELEASE_RUNNER_TOKEN|RELEASE_RUNNER_TOKEN' -or
    $projectComposeText -match 'FORGE_RELEASE_CONTRACT|/project-runtime/contract\.json' -or
    $projectComposeText -notmatch 'PROJECT_RELEASE_IPC_ROOT.*:/run/forge-release:ro' -or
    $projectComposeText -notmatch 'RELEASE_RUNNER_SOCKET:\s*/run/forge-release/runner\.sock' -or
    $releaseClientText -match 'FORGE_RELEASE_RUNNER_TOKEN|FORGE_RELEASE_CONTRACT|/project-runtime/contract\.json') {
    throw 'Controlled release must use the project-private capability socket without a Harness bearer token or file snapshot.'
}
Write-Host 'PASS token-free project-private controlled-release capability'
if ($taskspaceSkillText -notmatch 'FORGE_TASKSPACE_ISOLATION_V1' -or
    $projectComposeText -notmatch 'profiles:\s*\["legacy-shared-harness"\]' -or
    $projectComposeText -notmatch 'taskspace-broker:' -or
    $projectComposeText -notmatch '\.*/workspace:/workspace:ro' -or
    $taskspaceComposeText -notmatch 'TASKSPACE_ROOT.*?/workspace:/workspace' -or
    $taskspaceComposeText -notmatch 'PROJECT_ROOT.*?/workspace:/integration:ro' -or
    $taskspaceComposeText -notmatch 'PROJECT_SHARED_INPUT_ROOT.*?:/project-shared-inputs:ro' -or
    $taskspaceComposeText -notmatch 'PROJECT_FTP_INPUT_ROOT.*?:/project-ftp-inputs:ro' -or
    $taskspaceComposeText -match 'PROJECT_UPLOAD_ROOT|/project-intake' -or
    $taskspaceComposeText -notmatch 'TASKSPACE_ROOT.*?/dsh-home:/home/node/\.dsh' -or
    $taskspaceComposeText -notmatch 'HARNESS_ACCESS_TOKEN_FILE:\s*/run/forge-taskspace/browser-access-token' -or
    $taskspaceComposeText -notmatch 'FORGE_TASKSPACE_BROKER_URL:\s*http://taskspace-broker:3100' -or
    $taskspaceComposeText -match 'docker\.sock|/run/forge-release/runner\.sock|SHARED_SERVICES_ENV_FILE' -or
    $taskspaceBrokerText -notmatch 'release\.lock' -or
    $taskspaceBrokerText -notmatch "status:\s*'rejected'" -or
    $taskspaceBrokerText -notmatch 'merge.*--ff-only' -or
    $taskspaceBrokerText -notmatch 'candidateCommit' -or
    $taskspaceControlText -notmatch 'git clone --no-hardlinks' -or
    $taskspaceControlText -notmatch 'tokens/browser' -or
    $taskspaceControlText -notmatch 'tokens/broker' -or
    $taskspaceControlText -notmatch 'prepare_delivery_lock.*taskspaces_lock' -or
    $taskspaceControlText -notmatch '(?ms)atomic_metadata_status\(\).*?chmod 0600 "\$\{temporary\}".*?chown "\$\{DELIVERY_OWNER\}:\$\{DELIVERY_GROUP\}" "\$\{temporary\}".*?mv -- "\$\{temporary\}" "\$\{metadata\}"' -or
    $taskspaceControlText -match '(?m)^\s*(?:rm -rf|docker volume rm)') {
    throw 'TaskSpace clone, conversation, credential, ownership-preserving lifecycle, promotion, or non-destructive isolation is incomplete.'
}
$brokerServiceMatch = [regex]::Match(
    $projectComposeText,
    '(?ms)^  taskspace-broker:\s*$.*?(?=^  [a-z0-9-]+:\s*$|^networks:\s*$)'
)
if (-not $brokerServiceMatch.Success -or
    $brokerServiceMatch.Value -match 'docker\.sock|SHARED_SERVICES_ENV_FILE|deepseek-api-key|kimi-api-key|glm-api-key|GLM_KEY_FILE') {
    throw 'TaskSpace Broker must not receive Docker, database, or model credentials.'
}
Write-Host 'PASS isolated TaskSpace clone, access-token, Broker, and persistent release-lock boundaries'
$verificationRunnerServiceMatch = [regex]::Match(
    $projectComposeText,
    '(?ms)^  verification-runner:\s*$.*?(?=^  [a-z0-9-]+:\s*$|^networks:\s*$)'
)
if (-not $verificationRunnerServiceMatch.Success -or
    $verificationRunnerServiceMatch.Value -notmatch 'image:\s*\$\{VERIFICATION_RUNNER_IMAGE:-\$\{HARNESS_IMAGE' -or
    $verificationRunnerServiceMatch.Value -notmatch 'command:\s*\["node", "/usr/local/lib/verification-runner\.mjs"\]' -or
    $verificationRunnerServiceMatch.Value -notmatch 'network_mode:\s*none' -or
    $verificationRunnerServiceMatch.Value -notmatch 'PROJECT_ROOT.*?/taskspaces:.*?PROJECT_ROOT.*?/taskspaces:ro' -or
    $verificationRunnerServiceMatch.Value -notmatch 'PROJECT_VERIFY_ROOT.*?:.*?PROJECT_VERIFY_ROOT' -or
    $verificationRunnerServiceMatch.Value -notmatch 'PROJECT_VERIFY_IPC_ROOT.*?:/run/forge-verify' -or
    $verificationRunnerServiceMatch.Value -notmatch '/usr/bin/docker:/usr/bin/docker:ro' -or
    $verificationRunnerServiceMatch.Value -notmatch '/var/run/docker\.sock:/var/run/docker\.sock' -or
    $verificationRunnerServiceMatch.Value -notmatch 'read_only:\s*true' -or
    $verificationRunnerServiceMatch.Value -match 'SHARED_SERVICES_ENV_FILE|DEEPSEEK_KEY_FILE|KIMI_KEY_FILE|GLM_KEY_FILE|deepseek-api-key|kimi-api-key|glm-api-key|/run/forge-git|PROJECT_GIT_SSH|/run/forge-release|RELEASE_RUNNER_SOCKET|MYSQL_|REDIS_|test-db-operator') {
    throw 'Verification Runner must be networkless, source-read-only, contract-bounded, and isolated from Git, model, database, and release credentials.'
}
if ($brokerServiceMatch.Value -notmatch 'VERIFICATION_RUNNER_SOCKET:\s*/run/forge-verify/runner\.sock' -or
    $brokerServiceMatch.Value -notmatch 'PROJECT_VERIFY_IPC_ROOT.*?:/run/forge-verify:ro' -or
    $brokerServiceMatch.Value -match '/usr/bin/docker|docker\.sock|SHARED_SERVICES_ENV_FILE|deepseek-api-key|kimi-api-key|glm-api-key|GLM_KEY_FILE') {
    throw 'TaskSpace Broker must receive only the read-only verification capability IPC and no Docker or verification-runner credentials.'
}
$dockerSocketServiceNames = @(
    [regex]::Matches(
        $projectComposeText,
        '(?ms)^  (?<name>[a-z0-9-]+):\s*$.*?(?=^  [a-z0-9-]+:\s*$|^networks:\s*$)'
    ) |
        Where-Object { $_.Value -match '/var/run/docker\.sock:/var/run/docker\.sock' } |
        ForEach-Object { $_.Groups['name'].Value } |
        Sort-Object
)
$expectedDockerSocketServiceNames = @('conversation-manager', 'release-runner', 'verification-runner') | Sort-Object
if (@(Compare-Object -ReferenceObject $expectedDockerSocketServiceNames -DifferenceObject $dockerSocketServiceNames).Count -ne 0) {
    throw "Project Docker socket ownership escaped the reviewed control-plane services: $($dockerSocketServiceNames -join ', ')"
}
Write-Host 'PASS Verification Runner and Broker Compose capability, credential, network, and Docker-socket boundaries'

$expectedVerificationProfiles = @(
    'governance'
    'backend-red-test'
    'frontend-red-test'
    'backend-module-compile'
    'backend-module-test'
    'backend-test-class'
    'frontend-admin-lint'
    'frontend-admin-test'
    'frontend-admin-typecheck'
    'frontend-admin-build'
    'frontend-h5-build'
    'changed-safe'
    'full-regression'
) | Sort-Object
$actualVerificationProfiles = @($verificationContract.profiles | ForEach-Object { [string]$_ } | Sort-Object)
if ($verificationContract.schemaVersion -ne 1 -or
    $verificationContract.projectSlug -cne '__PROJECT_SLUG__' -or
    $verificationContract.runnerRevision -cne '__HARNESS_IMAGE_REVISION__' -or
    $verificationContract.toolchainImage -cne '__HARNESS_IMAGE__' -or
    $verificationContract.cacheRoot -cne '/srv/forge-delivery/projects/__PROJECT_SLUG__/verification/cache-packs/images/__HARNESS_IMAGE_ID__' -or
    $verificationContract.stateRoot -cne '/srv/forge-delivery/projects/__PROJECT_SLUG__/verification/state' -or
    @(Compare-Object -ReferenceObject $expectedVerificationProfiles -DifferenceObject $actualVerificationProfiles).Count -ne 0 -or
    $verificationContract.limits.maxFiles -ne 250000 -or
    $verificationContract.limits.maxBytes -ne 4294967296 -or
    $verificationContract.limits.maxLogBytes -ne 8388608 -or
    $verificationContract.limits.defaultTimeoutSeconds -ne 900) {
    throw 'Verification contract template does not expose the exact reviewed immutable-image, profile, state, and resource-limit surface.'
}
Write-Host 'PASS controlled-verification contract template has a fixed immutable-image, profile, and resource-limit surface'
$verificationCacheToolText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/verification-cache-tool.mjs'))
$mavenVerificationPolicyText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/maven-verification-policy.mjs'))
$mavenVerificationSettingsText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/maven-verification-settings.xml'))
$mavenVerificationExecText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/maven-verification-exec.sh'))
$verificationCacheWarmScriptText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/prepare-forge-verification-cache.sh'))
$cacheDockerRunCount = [regex]::Matches($verificationCacheWarmScriptText, '(?m)\bdocker run\b').Count
$networklessCacheDockerRunCount = [regex]::Matches($verificationCacheWarmScriptText, '(?m)\bdocker run --rm --network none\b').Count
$cacheWarmValueOptionCount = [regex]::Matches($verificationCacheWarmScriptText, '(?m)^\s+--[a-z][a-z-]*\)').Count
if ($verificationCacheWarmScriptText -notmatch 'Usage: %s --project <slug> \[--task <task-id>\] --confirm-cache-warm <slug>' -or
    $cacheWarmValueOptionCount -ne 3 -or
    $verificationCacheWarmScriptText -notmatch '(?m)^\s+--project\) project_slug=' -or
    $verificationCacheWarmScriptText -notmatch '(?m)^\s+--task\) task_id=' -or
    $verificationCacheWarmScriptText -notmatch '(?m)^\s+--confirm-cache-warm\) confirmation=' -or
    $verificationCacheWarmScriptText -notmatch '\$\{confirmation\}.*==.*\$\{project_slug\}' -or
    $verificationCacheWarmScriptText -notmatch 'project_root="\$\{DELIVERY_ROOT\}/projects/\$\{project_slug\}"' -or
    $verificationCacheWarmScriptText -notmatch '\$\{task_id\}.*\^\[a-z0-9\]\[a-z0-9-\]\{1,47\}\$' -or
    $verificationCacheWarmScriptText -notmatch 'task_root="\$\{project_root\}/taskspaces/\$\{task_id\}"' -or
    $verificationCacheWarmScriptText -notmatch '\.taskId \| strings.*\$\{task_id\}' -or
    $verificationCacheWarmScriptText -notmatch '\.status \| strings.*== active' -or
    $verificationCacheWarmScriptText -notmatch 'workspace="\$\{task_root\}/workspace"' -or
    $verificationCacheWarmScriptText -notmatch "jq -er '\.toolchainImage \| strings'" -or
    $verificationCacheWarmScriptText -notmatch '\^sha256:\[0-9a-f\]\{64\}\$' -or
    $verificationCacheWarmScriptText -notmatch 'expected_project.*\.projectSlug' -or
    $verificationCacheWarmScriptText -notmatch 'expected_image=.*VERIFICATION_TOOLCHAIN_IMAGE' -or
    $verificationCacheWarmScriptText -notmatch 'expected_image.*==.*toolchain_image' -or
    $verificationCacheWarmScriptText -notmatch 'docker image inspect "\$\{toolchain_image\}"' -or
    $cacheDockerRunCount -ne 8 -or
    $networklessCacheDockerRunCount -ne 7 -or
    $verificationCacheWarmScriptText -notmatch '(?ms)fingerprint_json=.*?docker run --rm --network none.*?verification-cache-tool\.mjs fingerprint.*?--workspace /workspace --contract /contract\.json' -or
    $verificationCacheWarmScriptText -notmatch '(?ms)docker run --rm --network none.*?verification-cache-tool\.mjs verify.*?--contract /contract\.json --fingerprint "\$\{fingerprint\}"' -or
    $verificationCacheWarmScriptText -notmatch '(?ms)# This is the sole network-enabled dependency step\..*?docker run --rm --read-only.*?--user 1000:1000.*?--tmpfs /tmp:rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700.*?"\$\{toolchain_image\}" bash -Eeuo pipefail -c ''.*?/proc/self/mountinfo.*?forge-exec-probe.*?mvn --strict-checksums --settings /usr/local/lib/maven-verification-settings\.xml.*?-f /workspace/forge-server/pom\.xml.*?-Dmaven\.repo\.local=/warm/m2/repository -Penable-tests -DskipTests dependency:go-offline.*?Failed to load native library\|failed to map segment.*?pnpm --dir /workspace/forge-admin-ui fetch.*?--ignore-scripts.*?--store-dir /warm/pnpm/store.*?--virtual-store-dir /warm/scratch/forge-admin-virtual-store.*?--modules-dir /warm/scratch/forge-admin-node_modules.*?pnpm_admin_warm_log.*?preinstall\|install\|postinstall.*?pnpm --dir /workspace/forge-h5-ui fetch.*?--ignore-scripts.*?--store-dir /warm/pnpm/store.*?--virtual-store-dir /warm/scratch/forge-h5-virtual-store.*?--modules-dir /warm/scratch/forge-h5-node_modules.*?pnpm_h5_warm_log.*?preinstall\|install\|postinstall.*?\s*''' -or
    $verificationCacheWarmScriptText -notmatch 'chmod -R a-w "\$\{stage\}"' -or
    $verificationCacheWarmScriptText -notmatch '(?ms)docker run --rm --network none.*?verification-cache-tool\.mjs compatibility.*?--node-base-image "\$\{node_base_image\}" --maven-base-image "\$\{maven_base_image\}"' -or
    $verificationCacheWarmScriptText -notmatch '(?ms)docker run --rm --network none.*?verification-cache-tool\.mjs publish.*?--workspace /workspace --contract /contract\.json --staging /staging.*?--fingerprint "\$\{fingerprint\}" --node-base-image "\$\{node_base_image\}".*?--maven-base-image "\$\{maven_base_image\}"' -or
    $verificationCacheWarmScriptText -match '(?i)\beval\b|docker\s+pull|\bcurl\b|\bwget\b|\bssh\b|https?://|--(?:command|image|url)\b|bash\s+-Eeuo\s+pipefail\s+-c\s+["'']?\$\{' -or
    $verificationCacheWarmScriptText -match 'DEEPSEEK|KIMI|API_KEY|PASSWORD|SHARED_SERVICES_ENV_FILE|MYSQL_|REDIS_' -or
    $verificationCacheToolText -notmatch "\['compatibility', 'fingerprint', 'promote', 'publish', 'verify'\]" -or
    $verificationCacheToolText -notmatch "\['--workspace', '--contract'\]" -or
    $verificationCacheToolText -notmatch "\['--workspace', '--contract', '--staging', '--fingerprint', '--node-base-image', '--maven-base-image'\]" -or
    $verificationCacheToolText -notmatch "\['--workspace', '--contract', '--fingerprint'\]" -or
    $verificationCacheToolText -notmatch "import \{ spawnSync \} from 'node:child_process'" -or
    $verificationCacheToolText -notmatch "probedVersion\('corepack', \['--version'\]" -or
    $verificationCacheToolText -notmatch "probedVersion\('pnpm', \['--version'\]" -or
    $verificationCacheToolText -notmatch "imageRuntime\s*\? probedVersion\(MAVEN_VERIFICATION_EXEC_PATH, \['mvn', '--version'\]" -or
    $verificationCacheToolText -notmatch "probedVersion\('java', \['-version'\]" -or
    $verificationCacheToolText -notmatch 'forge-verification-cache-compatibility/v2' -or
    $verificationCacheToolText -notmatch 'forge-verification-cache-producer-topology/v8' -or
    $verificationCacheToolText -notmatch 'mavenAcquisitionPolicyDigest' -or
    $mavenVerificationPolicyText -notmatch "'--strict-checksums'" -or
    $mavenVerificationPolicyText -notmatch "MAVEN_VERIFICATION_JANSI_TMPDIR = '/tmp/forge-maven-jansi'" -or
    $mavenVerificationExecText -notmatch 'install -d -m 0700 -- "\$\{jansi_tmpdir\}"' -or
    $mavenVerificationExecText -notmatch 'trap cleanup EXIT HUP INT TERM' -or
    ($verificationCacheWarmScriptText + $verificationCacheToolText + $mavenVerificationPolicyText + $mavenVerificationExecText) -match '/home/node/\.cache/jansi|/tmp/jansi' -or
    $mavenVerificationSettingsText -notmatch '<mirrorOf>central,aliyun,public</mirrorOf>' -or
    $mavenVerificationSettingsText -match '<mirrorOf>[^<]*(?:\*|external:)[^<]*</mirrorOf>' -or
    $mavenVerificationSettingsText -match '<(?:servers?|proxies?|username|password|privateKey|passphrase)\b' -or
    $verificationCacheToolText -match "\bspawn\(|\bexec\(|\bexecFile|\bfork\(") {
    throw 'Operator verification-cache warming must bind one confirmed project and immutable contract image, expose only fixed cache actions, and allow network only for the fixed dependency warm step.'
}
Write-Host 'PASS operator verification-cache warmer has confirmed project scope, immutable image identity, fixed commands, and one network-enabled phase'
if ($commonScriptText -notmatch '(?m)^run_as_delivery_owner\(\)' -or
    $commonScriptText -notmatch '(?m)^prepare_delivery_lock\(\)' -or
    $commonScriptText -match '%F' -or
    $commonScriptText -cmatch 'stat -c ''%U:%G' -or
    $commonScriptText -notmatch "stat -c '%u:%g:%a:%h'" -or
    $commonScriptText -notmatch 'DELIVERY_OWNER_UID' -or
    $commonScriptText -notmatch 'DELIVERY_GROUP_GID' -or
    $commonScriptText -notmatch '(?m)^project_git_readonly\(\)' -or
    $commonScriptText -notmatch 'GIT_OPTIONAL_LOCKS=0' -or
    $commonScriptText -notmatch 'runuser -u.*DELIVERY_OWNER' -or
    $backupProjectText -notmatch 'project_git_readonly.*status --porcelain' -or
    $cloneProjectDatabasesText -notmatch 'project_git_readonly.*status --porcelain' -or
    $promoteFoundationText -notmatch 'project_git_readonly.*status --porcelain' -or
    $promoteFoundationText -notmatch 'prepare_delivery_lock.*foundation_lock' -or
    $promoteFoundationText -notmatch 'chown.*DELIVERY_OWNER.*DELIVERY_GROUP.*audit_file' -or
    $taskspaceControlText -notmatch 'project_git_readonly.*integration_workspace.*status --porcelain' -or
    $projectComposeText -notmatch 'image:\s*\$\{TASKSPACE_BROKER_IMAGE:-\$\{RELEASE_RUNNER_IMAGE' -or
    $taskspaceBrokerText -notmatch 'TASKSPACE_INTEGRATION_GIT_METADATA_UNREADABLE' -or
    $taskspaceBrokerText -notmatch 'TASKSPACE_PLATFORM_MAINTENANCE' -or
    $taskspaceBrokerText -notmatch "GIT_OPTIONAL_LOCKS: '0'" -or
    $taskspaceBrokerText -notmatch 'integrationReadiness' -or
    $taskspaceBrokerText -notmatch 'maintenanceState' -or
    $taskspaceBrokerText -notmatch 'integration\.ok \? 200 : 503' -or
    $taskspaceBrokerOwnershipImageText -notmatch 'taskspace-broker-ownership-patch' -or
    $taskspaceBrokerOwnershipImageText -notmatch 'taskspace-broker-source-sha256' -or
    $taskspaceBrokerOwnershipImageText -notmatch 'taskspace-broker-base-image-id' -or
    $integrationGitOwnershipUpgradeText -notmatch "PATCH_VERSION='integration-git-ownership-v1'" -or
    $integrationGitOwnershipUpgradeText -notmatch 'find.*git_dir.*! -user.*DELIVERY_OWNER.*! -group.*DELIVERY_GROUP' -or
    $integrationGitOwnershipUpgradeText -notmatch 'index\.lock exists; no lock was removed automatically' -or
    $integrationGitOwnershipUpgradeText -notmatch 'taskspaces\.lock' -or
    $integrationGitOwnershipUpgradeText -notmatch 'enter_broker_maintenance' -or
    $integrationGitOwnershipUpgradeText -notmatch 'release_platform_release_fence' -or
    $integrationGitOwnershipUpgradeText -notmatch 'repair_taskspace_git_ownership' -or
    $integrationGitOwnershipUpgradeText -notmatch 'Running TaskSpace container has an unsafe user identity' -or
    $integrationGitOwnershipUpgradeText -notmatch "-name '\*\.lock'" -or
    $integrationGitOwnershipUpgradeText -notmatch 'chmod g\+s' -or
    $integrationGitOwnershipUpgradeText -notmatch 'repair_published_project_control_ownership' -or
    $integrationGitOwnershipUpgradeText -notmatch 'repair_known_delivery_locks' -or
    $integrationGitOwnershipUpgradeText -notmatch 'upsert_env TASKSPACE_BROKER_IMAGE' -or
    $integrationGitOwnershipUpgradeText -notmatch 'force-recreate --no-deps taskspace-broker' -or
    $integrationGitOwnershipUpgradeText -notmatch 'application-container-ids\.before' -or
    $integrationGitOwnershipUpgradeText -notmatch 'application-container-ids\.after' -or
    $integrationGitOwnershipUpgradeText -notmatch 'compose ps --all --quiet' -or
    $integrationGitOwnershipUpgradeText -notmatch "printf '%s=absent" -or
    $integrationGitOwnershipUpgradeText -notmatch 'TASKSPACE_COMPOSE_PROJECT_NAME' -or
    $integrationGitOwnershipUpgradeText -match 'down\s+--volumes|docker volume rm') {
    throw 'Integration Git metadata ownership prevention, diagnosis, image, template, or idempotent upgrade contract is incomplete.'
}
Write-Host 'PASS integration Git ownership prevention, Broker diagnosis, and Broker-only upgrade path'
$gatewayServiceMatch = [regex]::Match(
    $controlPlaneComposeText,
    '(?ms)^  conversation-gateway:\s*$.*?(?=^  [a-z0-9-]+:\s*$|^networks:\s*$)'
)
$managerServiceMatch = [regex]::Match(
    $projectComposeText,
    '(?ms)^  conversation-manager:\s*$.*?(?=^  [a-z0-9-]+:\s*$|^networks:\s*$)'
)
if ($projectComposeText -match '(?m)^  conversation-gateway:\s*$' -or
    -not $gatewayServiceMatch.Success -or
    $gatewayServiceMatch.Value -match 'docker\.sock|/workspace|SHARED_SERVICES_ENV_FILE|deepseek-api-key|kimi-api-key' -or
    $gatewayServiceMatch.Value -notmatch 'CONVERSATION_PROJECT_REGISTRY_FILE' -or
    $gatewayServiceMatch.Value -notmatch 'CONVERSATION_PROJECT_CAPABILITY_ROOT' -or
    $gatewayServiceMatch.Value -notmatch '/projects:/run/forge-projects:ro' -or
    $gatewayServiceMatch.Value -notmatch 'CONVERSATION_GATEWAY_INTERNAL_SOCKET:\s*/run/forge-conversation-auth/authorize\.sock' -or
    $controlPlaneComposeText -match '(?m)^  conversation-auth:\s*$|name:\s*forge-conversation-auth' -or
    -not $managerServiceMatch.Success -or
    $managerServiceMatch.Value -notmatch 'image:\s*\$\{CONVERSATION_MANAGER_IMAGE:-\$\{HARNESS_IMAGE:' -or
    $managerServiceMatch.Value -match 'image:\s*\$\{RELEASE_RUNNER_IMAGE' -or
    $managerServiceMatch.Value -match '(?m)^\s+ports:' -or
    $managerServiceMatch.Value -notmatch 'network_mode:\s*none' -or
    $managerServiceMatch.Value -notmatch 'CONVERSATION_MANAGER_SOCKET:\s*/run/forge-manager/manager\.sock' -or
    $managerServiceMatch.Value -notmatch 'TASKSPACE_CONTROL_CONFIG_MODE:\s*project' -or
    $managerServiceMatch.Value -notmatch 'TASKSPACE_CONTROL_DELIVERY_ROOT' -or
    $managerServiceMatch.Value -notmatch 'TASKSPACE_CONTROL_DELIVERY_OWNER' -or
    $managerServiceMatch.Value -notmatch 'TASKSPACE_CONTROL_DELIVERY_GROUP' -or
    $managerServiceMatch.Value -notmatch 'TASKSPACE_CONTROL_DELIVERY_UID' -or
    $managerServiceMatch.Value -notmatch 'TASKSPACE_CONTROL_DELIVERY_GID' -or
    $managerServiceMatch.Value -notmatch 'PLATFORM_CONVERSATION_PROJECT_ROOT.*?/ipc:/run/forge-manager' -or
    $managerServiceMatch.Value -notmatch 'PROJECT_UPLOAD_ROOT.*?:/project-intake:ro' -or
    $managerServiceMatch.Value -notmatch 'CONVERSATION_PROJECT_INTAKE_ROOT:\s*/project-intake' -or
    $taskspaceComposeText -match 'platform-conversation-auth:|name:\s*forge-conversation-auth' -or
    $taskspaceComposeText -notmatch 'PLATFORM_CONVERSATION_AUTH_ROOT.*?:/run/forge-conversation-auth:ro' -or
    $taskspaceComposeText -notmatch 'HARNESS_ACCESS_AUTHZ_SOCKET:\s*/run/forge-conversation-auth/authorize\.sock' -or
    $taskspaceComposeText -notmatch 'PROJECT_SLUG:\s*\$\{PROJECT_SLUG:\?PROJECT_SLUG is required\}' -or
    $conversationGatewayText -notmatch 'ownerUserId' -or
    $conversationGatewayText -notmatch 'sessionVersion' -or
    $conversationGatewayText -notmatch 'memberships' -or
    $conversationGatewayText -notmatch 'projectSlug' -or
    $conversationGatewayText -notmatch '/forge-gateway/api/projects' -or
    $conversationGatewayText -notmatch '/forge-gateway/api/materials' -or
    $conversationGatewayText -notmatch 'internal/taskspace-authorize' -or
    $projectDirectoryText -notmatch 'RegistryProjectDirectory' -or
    $projectDirectoryText -notmatch 'manager-token' -or
    $projectDirectoryText -notmatch 'manager\.sock' -or
    $conversationManagerText -notmatch "spawn\('bash', \[controlScript, projectSlug, \.\.\.args\]" -or
    $conversationManagerText -notmatch "await execute\(\['preflight'\]\)" -or
    $taskspaceControlText -notmatch 'TASKSPACE_CONTROL_CONFIG_MODE.*project' -or
    $taskspaceControlText -notmatch 'TASKSPACE_CONTROL_DELIVERY_ROOT' -or
    $taskspaceControlText -notmatch 'TASKSPACE_CONTROL_DELIVERY_UID' -or
    $taskspaceControlText -notmatch 'TASKSPACE_CONTROL_DELIVERY_GID' -or
    $taskspaceControlText -notmatch 'TASKSPACE_GOVERNANCE_CONTEXT_REQUIRED' -or
    $taskspaceControlText -notmatch 'taskspace_governance_context_required' -or
    $taskspaceControlText -notmatch 'if \[\[ "\$\{action\}" == preflight \]\]' -or
    $conversationManagerText -notmatch 'CONVERSATION_MANAGER_SOCKET' -or
    $conversationProxyUiText -match 'innerHTML|outerHTML|localStorage|sessionStorage|alert\(|confirm\(|prompt\(') {
    throw 'Unified Conversation Gateway must enforce platform/project/user/conversation authorization through scoped capabilities without Docker or UI-only security.'
}
Write-Host 'PASS unified project directory, membership, conversation ownership, and scoped Manager capability boundaries'
if ($projectMaterialsText -notmatch 'O_NOFOLLOW' -or
    $projectMaterialsText -notmatch 'MATERIAL_SOURCE_CHANGED' -or
    $projectMaterialsText -notmatch 'MATERIAL_NAME_CONFLICT' -or
    $projectMaterialsText -notmatch "action: 'material.promote'" -or
    $projectMaterialsText -notmatch 'legacy-unattributed' -or
    $projectMaterialsText -notmatch '\.forge-derived' -or
    $materialReadableText -notmatch 'preparePrototypeArchive' -or
    $prototypeArchiveText -notmatch 'PROTOTYPE_ARCHIVE_UNSAFE_PATH' -or
    $prototypeArchiveText -notmatch 'PROTOTYPE_ARCHIVE_RATIO_LIMIT' -or
    $prototypeArchiveText -notmatch 'crc32' -or
    $prototypeArchiveText -notmatch 'maxUncompressedBytes' -or
    $prototypeArchiveText -notmatch 'preparePrototypeDirectory' -or
    $prototypeDirectoryIndexText -notmatch 'FORGE_PROTOTYPE_ALLOWED_ROOTS' -or
    $portablePackageText -notmatch 'forge-prototype-index' -or
    $harnessOverlayText -notmatch '/opt/forge-harness-runtime/node_modules' -or
    $projectDocumentReaderText -notmatch 'Axure' -or
    $projectDocumentReaderText -notmatch 'PROTOTYPE_DIRECTORY_READER_V2' -or
    $projectDocumentReaderText -notmatch '/project-ftp-inputs' -or
    $projectDocumentReaderText -notmatch 'forge-prototype-index' -or
    $uploadServerText -notmatch 'schemaVersion:\s*2' -or
    $uploadServerText -notmatch 'taskspace-private' -or
    $uploadServerText -notmatch 'project-intake' -or
    $taskspaceComposeText -notmatch 'HARNESS_UPLOAD_SCOPE_TYPE:\s*taskspace-private' -or
    $taskspaceComposeText -notmatch 'HARNESS_DOCUMENT_INPUT_ROOTS:\s*/project-inputs:/project-ftp-inputs:/project-shared-inputs' -or
    $projectComposeText -notmatch 'CONVERSATION_PROJECT_MATERIAL_ACCESS_MODE' -or
    $projectComposeText -notmatch 'HARNESS_UPLOAD_SCOPE_TYPE:\s*project-intake') {
    throw 'Project material intake, approval, provenance, and immutable audit boundaries are incomplete.'
}
Write-Host 'PASS private upload, quarantined intake, reviewed sharing, safe prototype expansion, and audit-v2 boundaries'
$guanghuiDeploymentPolicy = $deploymentPolicy.environment.name -ceq 'wuhan-demoteam-phase2'
$safetyDeploymentPolicy = $deploymentPolicy.environment.name -ceq 'wuhan-safety-project-management'
if ($safetyDeploymentPolicy) {
    if ($deploymentPolicy.mode -cne 'auto-deploy' -or
        @($deploymentPolicy.repository.allowedBranches).Count -ne 1 -or
        $deploymentPolicy.repository.allowedBranches[0] -cne 'codex/safety-project-management-20260917' -or
        @($deploymentPolicy.commands.preflight).Count -ne 1 -or
        @($deploymentPolicy.commands.verify).Count -ne 1 -or
        (@($deploymentPolicy.commands.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'deploy,preflight,verify' -or
        $deploymentPolicy.authorization.reference -notin @('owner-confirmed-safety-project-create-20260917', 'owner-confirmed-safety-project-application-20260917')) {
        throw 'The safety project policy must keep its exact authorized branch and three command stages.'
    }
    $safetyApplicationBootstrap = $deploymentPolicy.authorization.reference -ceq 'owner-confirmed-safety-project-application-20260917'
    foreach ($stage in @('preflight', 'deploy', 'verify')) {
        $stageCommand = if ($stage -ceq 'deploy') { $deploymentPolicy.commands.deploy } else { $deploymentPolicy.commands.$stage[0] }
        $expectedArgv = if ($safetyApplicationBootstrap) {
            @('python', 'scripts/deploy-safety-project-management-application.py', $stage, '--manifest',
                'docs/validation-evidence/2026-09-17-safety-project-management-application-manifest.json')
        } else {
            @('python', 'scripts/deploy-safety-project-management.py', $stage, '--manifest',
                'docs/validation-evidence/2026-09-17-safety-project-management-activation-manifest.json')
        }
        $expectedId = if ($safetyApplicationBootstrap) { "safety-project-management-application-$stage" } else { "safety-project-management-$stage" }
        if ($stageCommand.id -cne $expectedId -or @($stageCommand.argv).Count -ne $expectedArgv.Count) {
            throw "The safety project $stage command identity differs."
        }
        for ($argumentIndex = 0; $argumentIndex -lt $expectedArgv.Count; $argumentIndex++) {
            if ($stageCommand.argv[$argumentIndex] -cne $expectedArgv[$argumentIndex]) {
                throw "The safety project $stage command differs from its exact reviewed argv."
            }
        }
    }
}
if ($guanghuiDeploymentPolicy) {
    if ($deploymentPolicy.mode -cne 'auto-deploy' -or
        @($deploymentPolicy.repository.allowedBranches).Count -ne 1 -or
        $deploymentPolicy.repository.allowedBranches[0] -cne 'codex/demoteam-phase2-activation' -or
        @($deploymentPolicy.commands.preflight).Count -ne 1 -or
        @($deploymentPolicy.commands.verify).Count -ne 1 -or
        (@($deploymentPolicy.commands.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'deploy,preflight,verify') {
        throw 'The demoteam Phase 2 activation policy must keep its exact branch and three reviewed command stages.'
    }
    $guanghuiApplicationBootstrap = $deploymentPolicy.authorization.reference -ceq 'owner-confirmed-complete-demoteam-phase2-application-login-20260915'
    foreach ($stage in @('preflight', 'deploy', 'verify')) {
        $stageCommand = if ($stage -ceq 'deploy') { $deploymentPolicy.commands.deploy } else { $deploymentPolicy.commands.$stage[0] }
        $expectedArgv = if ($guanghuiApplicationBootstrap) {
            @('python', 'scripts/deploy-demoteam-phase2-application.py', $stage, '--manifest',
                'docs/validation-evidence/2026-09-15-demoteam-phase2-application-manifest.json')
        } else {
            @('python', 'scripts/deploy-demoteam-phase2.py', $stage, '--manifest',
                'docs/validation-evidence/2026-09-15-demoteam-phase2-activation-manifest.json')
        }
        $expectedId = if ($guanghuiApplicationBootstrap) { "demoteam-phase2-application-$stage" } else { "demoteam-phase2-$stage" }
        if ($stageCommand.id -cne $expectedId -or @($stageCommand.argv).Count -ne $expectedArgv.Count) {
            throw "The demoteam Phase 2 $stage command identity or argument count differs from the reviewed activation."
        }
        for ($argumentIndex = 0; $argumentIndex -lt $expectedArgv.Count; $argumentIndex++) {
            if ($stageCommand.argv[$argumentIndex] -cne $expectedArgv[$argumentIndex]) {
                throw "The demoteam Phase 2 $stage command differs from its exact reviewed Python argv."
            }
        }
    }
}
if ($deploymentPolicy.schemaVersion -ne 1 -or
    $deploymentPolicy.status -cne 'owner-authorized' -or
    $deploymentPolicy.mode -notin @('auto-deploy', 'preview-only') -or
    ($deploymentPolicy.environment.name -cne 'wuhan-forge-delivery' -and -not $guanghuiDeploymentPolicy -and -not $safetyDeploymentPolicy) -or
    $deploymentPolicy.repository.expectedRemoteIdentity -cne 'github.com/zhiyuxinxi/forgeadminharness' -or
    $deploymentPolicy.execution.requireVerifiedGitPush -ne $true -or
    $deploymentPolicy.execution.persistCommandOutput -ne $false -or
    $deploymentPolicy.execution.automaticRollback -ne $false -or
    (-not $guanghuiDeploymentPolicy -and -not $safetyDeploymentPolicy -and $deploymentPolicy.mode -ceq 'auto-deploy' -and
        (($deploymentPolicyText -notmatch 'deploy-conversation-archive\.ps1' -or
          $deploymentPolicyText -notmatch 'wuhan-conversation-archive-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-lyl-conversation-repair\.ps1' -or
          $deploymentPolicyText -notmatch 'lyl-conversation-repair-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-lyl-release-guidance\.ps1' -or
          $deploymentPolicyText -notmatch 'lyl-release-guidance-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-liuhc-legacy-governance\.py' -or
          $deploymentPolicyText -notmatch 'liuhc-governance-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-liuhc-semantic-review\.py' -or
          $deploymentPolicyText -notmatch 'liuhc-semantic-review-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-liuhc-review-recovery\.py' -or
          $deploymentPolicyText -notmatch 'liuhc-review-recovery-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-liuhc-client-compat\.py' -or
          $deploymentPolicyText -notmatch 'liuhc-client-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-liuhc-connection-status\.py' -or
          $deploymentPolicyText -notmatch 'liuhc-connection-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-member03-client-compat\.py' -or
          $deploymentPolicyText -notmatch 'member03-client-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-liuhc-task-preparation\.py' -or
          $deploymentPolicyText -notmatch 'liuhc-preparation-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-liuhc-confirmation\.py' -or
          $deploymentPolicyText -notmatch 'liuhc-confirmation-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-member03-background-verification\.py' -or
          $deploymentPolicyText -notmatch 'member03-background-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-member03-review-input\.py' -or
          $deploymentPolicyText -notmatch 'member03-review-input-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-member03-review-format\.py' -or
          $deploymentPolicyText -notmatch 'member03-review-format-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-member03-review-history\.py' -or
          $deploymentPolicyText -notmatch 'member03-review-history-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-independent-review-suspension\.py' -or
          $deploymentPolicyText -notmatch 'independent-review-suspension-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-progress-heuristics-suspension\.py' -or
          $deploymentPolicyText -notmatch 'progress-heuristics-suspension-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-workflow-friction-suspension\.py' -or
          $deploymentPolicyText -notmatch 'workflow-friction-suspension-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-unified-harness-canary\.py' -or
          $deploymentPolicyText -notmatch 'unified-harness-canary-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-development-flow-canary\.py' -or
          $deploymentPolicyText -notmatch 'devflow-canary-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-fce722-verification-continuation\.py' -or
          $deploymentPolicyText -notmatch 'fce722-verification-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-fce722-dependency-preload\.py' -or
          $deploymentPolicyText -notmatch 'fce722-dependency-preload-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-main-todo-20260921\.py' -or
          $deploymentPolicyText -notmatch 'main-todo-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-direct-dependencies-20260921\.py' -or
          $deploymentPolicyText -notmatch 'direct-dependencies-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-maven-origin-20260921\.py' -or
          $deploymentPolicyText -notmatch 'maven-origin-deploy') -and
         ($deploymentPolicyText -notmatch 'repair-prepared-dependency-access\.py' -or
          $deploymentPolicyText -notmatch 'prepared-access-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-preinstalled-receipts-20260921\.py' -or
          $deploymentPolicyText -notmatch 'preinstalled-receipts-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-conversation-continuation-20260921\.py' -or
          $deploymentPolicyText -notmatch 'conversation-continuation-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-checkpoint-continuation-20260921\.py' -or
          $deploymentPolicyText -notmatch 'checkpoint-continuation-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-codex-route-repair-20260922\.py' -or
          $deploymentPolicyText -notmatch 'codex-route-repair-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-task-preparation-feedback-20260922\.py' -or
          $deploymentPolicyText -notmatch 'task-preparation-feedback-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-scoped-verification-20260921\.py' -or
          $deploymentPolicyText -notmatch 'scoped-verification-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-frontend-test-scope-20260922\.py' -or
          $deploymentPolicyText -notmatch 'frontend-test-scope-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-recovered-task-continuation-20260922\.py' -or
          $deploymentPolicyText -notmatch 'recovered-task-continuation-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-scoped-analysis-intent-20260922\.py' -or
          $deploymentPolicyText -notmatch 'scoped-analysis-intent-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-covered-repair-continuation-20260922\.py' -or
          $deploymentPolicyText -notmatch 'covered-repair-continuation-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-layer-scope-20260922\.py' -or
          $deploymentPolicyText -notmatch 'layer-scope-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-focused-acceptance-20260922\.py' -or
          $deploymentPolicyText -notmatch 'focused-acceptance-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-verification-intent-20260922\.py' -or
          $deploymentPolicyText -notmatch 'verification-intent-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-source-transition-observer-20260922\.py' -or
          $deploymentPolicyText -notmatch 'source-transition-observer-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-coordinated-release-20260922\.py' -or
          $deploymentPolicyText -notmatch 'coordinated-release-deploy') -and
         ($deploymentPolicyText -notmatch 'upgrade-unified-workpod-defaults\.py' -or
          $deploymentPolicyText -notmatch 'unified-defaults-deploy') -and
         ($deploymentPolicyText -notmatch 'upgrade-unified-host-runners\.py' -or
          $deploymentPolicyText -notmatch 'unified-host-deploy') -and
         ($deploymentPolicyText -notmatch 'upgrade-unified-shared-consumers\.py' -or
          $deploymentPolicyText -notmatch 'unified-shared-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-admin-codex-proxy\.py' -or
          $deploymentPolicyText -notmatch 'admin-codex-proxy-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-platform-codex\.py' -or
          $deploymentPolicyText -notmatch 'platform-codex-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-project-release-status\.py' -or
          $deploymentPolicyText -notmatch 'project-release-status-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-verify-observation\.py' -or
          $deploymentPolicyText -notmatch 'verify-observation-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-current-task-continuation\.py' -or
          $deploymentPolicyText -notmatch 'current-task-continuation-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-job-output\.py' -or
          $deploymentPolicyText -notmatch 'job-output-deploy') -and
         ($deploymentPolicyText -notmatch 'upgrade-unified-workpods\.py' -or
          $deploymentPolicyText -notmatch 'unified-workpods-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-prepromotion-startup\.py' -or
          $deploymentPolicyText -notmatch 'prepromotion-startup-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-startup-readiness\.py' -or
          $deploymentPolicyText -notmatch 'startup-readiness-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-member03-review-reasoning\.py' -or
          $deploymentPolicyText -notmatch 'member03-review-reasoning-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-lyl-host-red-receipt\.py' -or
          $deploymentPolicyText -notmatch 'lyl-host-red-deploy') -and
         ($deploymentPolicyText -notmatch '\u90e8\u7f72-\u9636\u6bb520-\u5408\u540c\u7eed\u63a5\u4fee\u590d\.py' -or
           $deploymentPolicyText -notmatch 'lyl-contract-continuation-deploy') -and
         ($deploymentPolicyText -notmatch '\u90e8\u7f72-\u9636\u6bb520-\u5386\u53f2\u56de\u6267\u590d\u6838\.py' -or
          $deploymentPolicyText -notmatch 'lyl-receipt-revalidation-deploy') -and
         ($deploymentPolicyText -notmatch '\\u90e8\\u7f72-\\u9636\\u6bb520-SQL\\u72ec\\u5ba1\\u8f93\\u5165\.py' -or
          $deploymentPolicyText -notmatch 'lyl-sql-review-input-deploy') -and
         ($deploymentPolicyText -notmatch '\\u90e8\\u7f72-\\u9636\\u6bb520-SQL\\u6267\\u884c\\u4e0a\\u4e0b\\u6587\.py' -or
          $deploymentPolicyText -notmatch 'lyl-sql-execution-context-deploy') -and
         ($deploymentPolicyText -notmatch '\u90e8\u7f72-\u9636\u6bb520-\u72ec\u5ba1\u53d1\u5e03\u57fa\u7ebf\.py' -or
          $deploymentPolicyText -notmatch 'lyl-semantic-release-base-deploy') -and
         ($deploymentPolicyText -notmatch '\u90e8\u7f72-\u9636\u6bb520-\u72ec\u5ba1\u4e8b\u5b9e\u53cd\u9988\.py' -or
          $deploymentPolicyText -notmatch 'lyl-semantic-fact-feedback-deploy') -and
         ($deploymentPolicyText -notmatch '\u90e8\u7f72-\u9636\u6bb520-\u72ec\u5ba1\u53d8\u66f4\u4f9d\u636e\.py' -or
          $deploymentPolicyText -notmatch 'lyl-semantic-change-basis-deploy') -and
         ($deploymentPolicyText -notmatch '\u90e8\u7f72-\u9636\u6bb520-\u72ec\u5ba1\u62d2\u7edd\u4f9d\u636e\.py' -or
          $deploymentPolicyText -notmatch 'lyl-semantic-rejection-basis-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-clean-a9-capture\.ps1' -or
          $deploymentPolicyText -notmatch 'phase-capture-deploy') -and
         ($deploymentPolicyText -notmatch 'deploy-clean-a9-access-scope\.ps1' -or
          $deploymentPolicyText -notmatch 'access-scope-deploy'))) -or
    (-not $guanghuiDeploymentPolicy -and -not $safetyDeploymentPolicy -and $deploymentPolicy.mode -ceq 'preview-only' -and
        ($deploymentPolicyText -notmatch 'deploy-clean-a9-capture\.ps1' -or
         $deploymentPolicyText -notmatch 'wuhan-clean-a9-capture-deploy')) -or
    $deploymentPolicyText -match '(?i)(password|passwd|token|secret|api[-_]?key)\s*[=:]' -or
    $integrationGitOwnershipDeployText -notmatch "ValidateSet\('credential-check', 'package', 'preflight', 'deploy', 'verify', 'stage-helper'\)" -or
    $integrationGitOwnershipDeployText -notmatch 'StrictHostKeyChecking=yes' -or
    $integrationGitOwnershipDeployText -match 'Get-FileHash' -or
    $integrationGitOwnershipDeployText -notmatch 'Security\.Cryptography\.SHA256' -or
    $integrationGitOwnershipDeployText -notmatch 'sudo -n \$remoteHelper \$Command' -or
    $integrationGitOwnershipDeployText -match 'sudo -n (?:bash|docker)' -or
    $integrationGitOwnershipDeployText -notmatch '(?s)function Invoke-Preflight.*?Publish-Artifact.*?Invoke-RootHelper preflight' -or
    $integrationGitOwnershipRootHelperText -notmatch 'upgrade-integration-git-ownership\.sh' -or
    $integrationGitOwnershipRootHelperText -notmatch 'project_slugs' -or
    $integrationGitOwnershipRootHelperText -notmatch 'GIT_OPTIONAL_LOCKS=0' -or
    $integrationGitOwnershipRootHelperText -match 'down\s+--volumes|docker volume rm' -or
    $integrationGitOwnershipHelperInstallerText -notmatch 'NOPASSWD: /usr/local/sbin/forge-delivery-integration-git-ownership-deploy credential-check' -or
    $integrationGitOwnershipHelperInstallerText -match 'NOPASSWD: (?:ALL|/usr/local/sbin/(?:bash|docker))' -or
    ($integrationGitOwnershipDeployText + $integrationGitOwnershipRootHelperText + $integrationGitOwnershipHelperInstallerText) -match '(?i)(BEGIN .*PRIVATE KEY|--password|--token)') {
    throw 'The active archive/conversation/capture repair policy or retained integration Git ownership orchestrator is incomplete or contains credential-shaped material.'
}
if (
    $legacyDeployText -notmatch "ValidateSet\('credential-check', 'package', 'preflight', 'deploy', 'verify', 'stage-helper'\)" -or
    $legacyDeployText -notmatch 'StrictHostKeyChecking=yes' -or
    $legacyDeployText -match 'Get-FileHash' -or
    $legacyDeployText -notmatch 'Security\.Cryptography\.SHA256' -or
    $legacyDeployText -notmatch 'sudo -n \$remoteHelper \$Command' -or
    $legacyDeployText -match 'sudo -n (?:bash|docker)' -or
    $legacyRootHelperText -notmatch 'upgrade-conversation-gateway-ui\.sh' -or
    $legacyRootHelperText -notmatch 'CURRENT_GATEWAY_IMAGE_ID' -or
    $legacyRootHelperText -notmatch 'CURRENT_ARCHIVE_IMAGE_ID' -or
    $legacyRootHelperText -notmatch 'FOUNDATION_IMAGE' -or
    $legacyRootHelperText -notmatch 'ARCHIVE_BASE_IMAGE_ID' -or
    $legacyUpgradeText -notmatch 'UPSTREAM_STARTUP_RETRY_MS = 30_000' -or
    $legacyUpgradeText -notmatch 'proxyHarnessRequestWithStartupRetry' -or
    $legacyRootHelperText -notmatch 'protected-container-ids\.before' -or
    $legacyRootHelperText -notmatch 'rsync -a --checksum --delete.*platform_backup.*PLATFORM_ROOT' -or
    $legacyRootHelperText -notmatch 'chown -R.*DELIVERY_OWNER.*DELIVERY_GROUP.*PLATFORM_ROOT' -or
    $legacyRootHelperText -notmatch 'legacy-session' -or
    $legacyRootHelperText -notmatch '\u5468\u957f\u5e86-\u6d4b\u8bd5-\u5371\u5e9f\u529f\u80fd\u5f00\u53d1' -or
    $legacyRootHelperText -notmatch '\u5468\u957f\u5e86-\u6d4b\u8bd5-APP\u529f\u80fd' -or
    $legacyHelperInstallerText -notmatch 'NOPASSWD: /usr/local/sbin/forge-delivery-legacy-conversations-deploy credential-check' -or
    $legacyHelperInstallerText -match 'NOPASSWD: (?:ALL|/usr/local/sbin/(?:bash|docker))' -or
    ($legacyDeployText + $legacyRootHelperText + $legacyHelperInstallerText) -match '(?i)(WSwhr|BEGIN .*PRIVATE KEY|--password|--token)') {
    throw 'The reusable vpn55 legacy-conversation orchestrator is incomplete or contains credential-shaped material.'
}
if (
    $mobileDeployText -notmatch "ValidateSet\('credential-check', 'package', 'preflight', 'deploy', 'verify', 'stage-helper'\)" -or
    $mobileDeployText -notmatch 'StrictHostKeyChecking=yes' -or
    $mobileDeployText -match 'Get-FileHash' -or
    $mobileDeployText -notmatch 'Security\.Cryptography\.SHA256' -or
    $mobileDeployText -notmatch 'sudo -n \$remoteHelper \$Command' -or
    $mobileDeployText -match 'sudo -n (?:bash|docker)' -or
    $mobileRootHelperText -notmatch 'status --require-synchronized' -or
    $mobileRootHelperText -notmatch 'upgrade-mobile-runtime\.sh' -or
    $mobileRootHelperText -notmatch 'candidate commit changed after review' -or
    $mobileRootHelperText -notmatch "stat -c '%U:%G:%a'.*PLATFORM_ROOT" -or
    $mobileRootHelperText -notmatch 'rsync -a --checksum --delete.*backup_root.*PLATFORM_ROOT' -or
    $mobileRootHelperText -notmatch 'chown.*DELIVERY_OWNER.*DELIVERY_GROUP.*PLATFORM_ROOT' -or
    $mobileRootHelperText -notmatch 'chmod 0750.*PLATFORM_ROOT' -or
    $mobileRootHelperText -notmatch 'forge-app started before the reviewed business candidate release' -or
    $mobileRootHelperText -notmatch '\^c-\[a-f0-9\]\{24\}\$' -or
    $mobileHelperInstallerText -notmatch '\^c-\[a-f0-9\]\{24\}\$' -or
    $mobileUpgradeText -notmatch '\^c-\[a-f0-9\]\{24\}\$' -or
    ($mobileRootHelperText + $mobileHelperInstallerText + $mobileUpgradeText) -match '\^c-\[a-f0-9\]\{20\}\$' -or
    $mobileHelperInstallerText -notmatch 'NOPASSWD: /usr/local/sbin/forge-delivery-mobile-runtime-deploy credential-check' -or
    $mobileHelperInstallerText -match 'NOPASSWD: (?:ALL|/usr/local/sbin/(?:bash|docker))' -or
    ($mobileDeployText + $mobileRootHelperText + $mobileHelperInstallerText) -match '(?i)(WSwhr|BEGIN .*PRIVATE KEY|--password|--token)') {
    throw 'The reusable vpn51 mobile-runtime deployment orchestrator is incomplete or contains credential-shaped material.'
}
if ($portablePackageText -notmatch 'git status --porcelain=v1 --untracked-files=all' -or
    $portablePackageText -match 'git ls-files -co' -or
    $portablePackageText -notmatch 'git ls-files -z') {
    throw 'Portable deployment packages must come only from a clean committed Git inventory.'
}
Write-Host 'PASS reviewed integration Git ownership deployment plus reusable vpn55/vpn51 deployment contracts'
if ($releaseSkillText -notmatch 'READ_ONLY_INSPECTION_GUARD_V1' -or
    $releaseSkillText -notmatch 'STRUCTURED_RELEASE_DIAGNOSIS_V1' -or
    $releaseSkillText -notmatch 'TEST_DATABASE_SANDBOX_V1' -or
    $releaseSkillText -notmatch 'TEST_DATABASE_RECOVERY_V2' -or
    $releaseSkillText -notmatch 'forge-release diagnose') {
    throw 'Controlled-release Skill must preserve read-only intent, structured diagnosis, and automatic test-schema recovery.'
}
Write-Host 'PASS controlled-release read-only intent and truthful-reporting guard'
if ($taskContractSkillText -notmatch 'PRODUCT_SAFE_DECISION_CARD_V1' -or
    $taskContractSkillText -notmatch 'ONE_ACTIVE_TASK_GUARD_V1' -or
    $releaseSkillText -notmatch 'PRODUCT_OPERATOR_ESCALATION_GUARD_V1' -or
    $uiConsistencySkillText -notmatch 'FORGE_UI_REFERENCE_CONTRACT_V1' -or
    $releaseAcceptanceSkillText -notmatch 'PRODUCT_UAT_BOUNDARY_V1' -or
    $productSafetyCardText -notmatch 'PRODUCT_HARNESS_TRIAL_CARD_V1' -or
    $projectContextPolicyText -notmatch 'PRODUCT_COLLABORATION_BOUNDARY_V1') {
    throw 'Product-safe Harness rules, escalation boundaries, UI reference contract, UAT split, or trial card are incomplete.'
}
Write-Host 'PASS product-safe decision, single-task, release escalation, UI reference, and UAT boundaries'
if ($gitCheckpointSkillText -notmatch 'FORGE_GIT_CHECKPOINT_GUARD_V1' -or
    $gitCheckpointSkillText -notmatch 'git add -- <path' -or
    $gitCheckpointSkillText -notmatch 'LOCAL_COMMIT_DOES_NOT_AUTHORIZE_PUSH_V1' -or
    $releaseSkillText -notmatch 'forge-git-checkpoint') {
    throw 'Git checkpoint Skill must enforce explicit staging, shared-workspace safety, and no implicit remote push.'
}
$createProjectText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/create-project.sh'))
$projectGitControlText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/project-gitctl.sh'))
$projectGitUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-project-git-remote.sh'))
$projectEnvironmentTemplateText = [IO.File]::ReadAllText((Join-Path $repoRoot 'templates/project/project.env.tpl'))
if ($projectEnvironmentTemplateText -notmatch '(?m)^TASKSPACE_GOVERNANCE_CONTEXT_REQUIRED=true$' -or
    $projectEnvironmentTemplateText -notmatch '(?m)^PROJECT_VERIFY_ROOT=/srv/forge-delivery/projects/__PROJECT_SLUG__/verification$' -or
    $projectEnvironmentTemplateText -notmatch '(?m)^PROJECT_VERIFY_IPC_ROOT=/srv/forge-delivery/projects/__PROJECT_SLUG__/verification/ipc$' -or
    $projectEnvironmentTemplateText -notmatch '(?m)^PROJECT_VERIFY_STATE_ROOT=/srv/forge-delivery/projects/__PROJECT_SLUG__/verification/state$' -or
    $projectEnvironmentTemplateText -notmatch '(?m)^PROJECT_VERIFY_CACHE_ROOT=/srv/forge-delivery/projects/__PROJECT_SLUG__/verification/cache-packs$' -or
    $projectEnvironmentTemplateText -notmatch '(?m)^PROJECT_VERIFICATION_MODE=container-toolchain$' -or
    $projectEnvironmentTemplateText -notmatch '(?m)^PROJECT_VERIFICATION_CONTRACT=/srv/forge-delivery/projects/__PROJECT_SLUG__/verification/contract.json$' -or
    $projectEnvironmentTemplateText -notmatch '(?m)^CONVERSATION_MANAGER_IMAGE=__CONVERSATION_MANAGER_IMAGE__$' -or
    $projectEnvironmentTemplateText -notmatch '(?m)^VERIFICATION_RUNNER_IMAGE=__HARNESS_IMAGE__$' -or
    $projectEnvironmentTemplateText -notmatch '(?m)^VERIFICATION_TOOLCHAIN_IMAGE=__HARNESS_IMAGE__$' -or
    $createProjectText -notmatch '(?ms)chmod 2700.*?"\$\{stage_path\}/verification".*?"\$\{stage_path\}/verification/ipc".*?"\$\{stage_path\}/verification/state".*?"\$\{stage_path\}/verification/cache-packs"' -or
    $createProjectText -notmatch 'verification-contract\.json\.tpl' -or
    $createProjectText -notmatch '__PROJECT_SLUG__/\$\{slug\}' -or
    $createProjectText -notmatch '__HARNESS_IMAGE_REVISION__/\$\{HARNESS_IMAGE_REVISION\}' -or
    $createProjectText -notmatch '__HARNESS_IMAGE__/\$\{harness_image_id\}' -or
    $createProjectText -notmatch '__HARNESS_IMAGE_ID__/\$\{harness_cache_image_id\}' -or
    $createProjectText -notmatch '__CONVERSATION_MANAGER_IMAGE__/\$\{conversation_manager_image_id\}' -or
    $createProjectText -notmatch 'printf.*verification_contract.*stage_path.*verification/contract\.json' -or
    $createProjectText -notmatch 'chmod 0600 "\$\{stage_path\}/verification/contract\.json"' -or
    $createProjectText -notmatch 'harness_image_id="\$\(resolve_configured_harness_image_id\)"') {
    throw 'Project creation does not render an immutable-image verification contract into private setgid project-scoped state with reviewed permissions.'
}
Write-Host 'PASS project creation renders private setgid controlled-verification state and immutable-image contract'
if ($createProjectText -notmatch 'git clone --no-hardlinks' -or
    $createProjectText -notmatch 'forge-delivery\.project-slug' -or
    $createProjectText -notmatch 'rev-parse --is-inside-work-tree' -or
    $createProjectText -notmatch 'status --porcelain=v1 --untracked-files=all' -or
    $createProjectText -notmatch '--git-url is required' -or
    $createProjectText -notmatch 'ssh-keygen.*ed25519' -or
    $createProjectText -match 'ops/git-remote' -or
    $createProjectText -notmatch 'git_remotes_root="\$\{DELIVERY_ROOT\}/git-remotes"' -or
    $projectGitControlText -notmatch 'git_remotes_root="\$\{DELIVERY_ROOT\}/git-remotes"' -or
    $projectGitControlText -notmatch 'git_root="\$\{git_remotes_root\}/\$\{slug\}"' -or
    $projectGitControlText -match 'ops/git-remote' -or
    $projectGitControlText -notmatch 'StrictHostKeyChecking=yes' -or
    $projectGitControlText -notmatch 'host-key-sha256' -or
    $projectGitControlText -notmatch 'install -m 0600 "\$\{verified_hosts\}" "\$\{known_hosts\}"' -or
    $projectGitControlText -notmatch 'Integration workspace must be clean before remote attachment' -or
    $projectGitControlText -notmatch 'Pinned Git known_hosts differs from the reviewed fingerprint' -or
    $projectGitControlText -notmatch 'Remote branch already contains a different commit' -or
    $projectGitControlText -match '(?i)password|credential\.helper' -or
    $projectGitUpgradeText -notmatch '--confirm-maintenance-window project-git-remote' -or
    $projectGitUpgradeText -notmatch 'HARNESS_IMAGE_REVISION' -or
    $projectGitUpgradeText -notmatch 'application-container-ids\.before' -or
    $projectGitUpgradeText -notmatch 'restoring prior env, Compose, and Broker' -or
    $projectGitUpgradeText -notmatch 'up --detach --force-recreate --no-deps taskspace-broker') {
    throw 'Project creation must initialize and verify a clean, project-identified Git worktree.'
}
$releaseRunnerBlock = [regex]::Match(
    $projectComposeText,
    '(?ms)^  release-runner:\r?\n.*?(?=^  verification-runner:)'
).Value
$conversationManagerBlock = [regex]::Match(
    $projectComposeText,
    '(?ms)^  conversation-manager:\r?\n.*?(?=^  release-runner:)'
).Value
$taskspaceBrokerBlock = [regex]::Match(
    $projectComposeText,
    '(?ms)^  taskspace-broker:\r?\n.*?(?=^networks:)'
).Value
if ($taskspaceBrokerBlock -notmatch 'PROJECT_GIT_SSH_ROOT.*:/run/forge-git:ro' -or
    $taskspaceBrokerBlock -notmatch 'TASKSPACE_GIT_REMOTE_REQUIRED' -or
    $taskspaceBrokerBlock -notmatch 'TASKSPACE_GIT_SSH_COMMAND' -or
    $taskspaceBrokerBlock -notmatch 'networks:\s*\[taskspaces, git-remote\]' -or
    $conversationManagerBlock -match 'TASKSPACE_GIT_|/run/forge-git' -or
    $releaseRunnerBlock -match 'TASKSPACE_GIT_|/run/forge-git' -or
    $taskspaceBrokerText -notmatch 'TASKSPACE_GIT_REMOTE_DIVERGED' -or
    $taskspaceBrokerText -notmatch "'push'.*candidate\.head" -or
    $taskspaceBrokerText -notmatch 'pushedHead') {
    throw 'Project Git remote durability, credential isolation, or remote drift guards are incomplete.'
}
Write-Host 'PASS mandatory per-project private Git remote and fast-forward durability guard'
$cloneProjectDatabasesText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/clone-project-databases.sh'))
$backupProjectText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/backup-project.sh'))
$restoreProjectText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/restore-project.sh'))
$runnerFaultAcceptanceText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/acceptance/fault-inject-release-runner.sh'))
$releaseContractText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/lib/release-contract.sh'))
$redisLogicalStateText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/redis-logical-state.py'))
if ($createProjectText -notmatch '--source-project' -or
    $createProjectText -notmatch '--source-commit' -or
    $createProjectText -notmatch 'Source project changed during replication' -or
    $cloneProjectDatabasesText -notmatch '--confirm-target' -or
    $cloneProjectDatabasesText -notmatch 'Target main database already exists' -or
    $cloneProjectDatabasesText -notmatch 'strategy:"empty-rebuild"' -or
    $cloneProjectDatabasesText -notmatch '(?ms)chown.*DELIVERY_OWNER.*temporary.*?mv -- "\$\{temporary\}" "\$\{receipt\}"' -or
    $backupProjectText -notmatch '--confirm-maintenance-window' -or
    $backupProjectText -notmatch 'registry/\$\{slug\}\.recovery\.lock' -or
    $backupProjectText -notmatch 'tar --acls --xattrs --numeric-owner' -or
    $backupProjectText -notmatch "--exclude='\*\.sock'" -or
    $restoreProjectText -notmatch '--confirm-destructive-restore' -or
    $restoreProjectText -notmatch 'sha256sum --check SHA256SUMS' -or
    $restoreProjectText -notmatch 'Recovery manifest requests a service outside the current project Compose model' -or
    $restoreProjectText -notmatch 'invalid or duplicate service/TaskSpace entries' -or
    $restoreProjectText -notmatch 'Restored TaskSpace metadata identity differs from the recovery manifest' -or
    $restoreProjectText -notmatch '(?ms)taskspace_control_files_ready\(\).*?stat -c ''%u:%g:%a''.*?HOST_UID.*?HOST_GID' -or
    $restoreProjectText -notmatch '(?ms)if \[\[ "\$\{all_running\}" == true \]\].*?taskspace_control_files_ready.*?forge-api/auth/captcha' -or
    $restoreProjectText -notmatch 'wait_for_restored_runtime' -or
    $restoreProjectText -notmatch 'rollback_on_failure' -or
    $restoreProjectText -notmatch '(?ms)chown.*DELIVERY_OWNER.*receipt_temp.*?mv -- "\$\{receipt_temp\}"' -or
    $restoreProjectText -match 'down\s+--volumes|docker volume rm' -or
    $runnerFaultAcceptanceText -notmatch 'Fault injection is permanently disabled for forge-base' -or
    $runnerFaultAcceptanceText -notmatch '--confirm-validation-project' -or
    $runnerFaultAcceptanceText -notmatch 'candidate-build\|test-database-migration' -or
    $runnerFaultAcceptanceText -notmatch 'docker kill --signal KILL' -or
    $runnerFaultAcceptanceText -notmatch 'runner-restart-recovery' -or
    $runnerFaultAcceptanceText -notmatch '(?ms)chown.*DELIVERY_OWNER.*temporary.*?mv -- "\$\{temporary\}" "\$\{evidence_file\}"' -or
    $releaseContractText -notmatch '(?ms)chmod 0640.*temp_file.*?chown.*temp_file.*?mv -- "\$\{temp_file\}" "\$\{output_file\}"' -or
    $redisLogicalStateText -notmatch 'FLUSHDB' -or
    $redisLogicalStateText -notmatch '--confirm-database' -or
    $redisLogicalStateText -match '(?i)\b(?:SAVE|BGSAVE|FLUSHALL|CONFIG)\b') {
    throw 'Registered-project replication, TaskSpace control-file ownership, and exact-project recovery boundaries are incomplete.'
}
Write-Host 'PASS exact clean-source project replication, DBA clone, and rollback-capable project recovery boundaries'
$vpnUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-harness-vpn-access.sh'))
$deliveryToolkitUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-forge-delivery-toolkit.sh'))
$deliveryToolkitUpgradeWithoutRequiredServiceBootstrap = $deliveryToolkitUpgradeText.Replace(
    'project_compose "${slug}" up --detach --no-deps protected-acceptance',
    ''
).Replace(
    'project_compose "${slug}" up --detach --no-deps verification-runner',
    ''
)
$projectMaterialUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-project-material-isolation.sh'))
$harnessImageVerifierText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/lib/harness-image-verifier.sh'))
if ($vpnUpgradeText -notmatch 'session state changed in the last two minutes' -or
    $vpnUpgradeText -notmatch 'vpn20_compose_hash=.ef96f87a0b25c2a0b9792284f194350537e302761127937b4cae4951f7899234.' -or
    $vpnUpgradeText -notmatch 'vpn21_compose_hash=.cfd253a5b8d2348e8db45119fdddeca55ba1c1c2497ee5f960d4b70527f25802.' -or
    $vpnUpgradeText -notmatch 'current_compose_hash.*vpn20_compose_hash' -or
    $vpnUpgradeText -notmatch 'current_compose_hash.*vpn21_compose_hash' -or
    $vpnUpgradeText -notmatch 'Release Runner is not healthy; Harness upgrade will not recreate or repair it implicitly' -or
    $vpnUpgradeText -notmatch 'force-recreate --no-deps harness-upload harness' -or
    $vpnUpgradeText -notmatch 'force-recreate --no-deps --remove-orphans harness-upload harness' -or
    $vpnUpgradeText -notmatch 'FORGE_SKILL_BUNDLE_ROOT' -or
    $vpnUpgradeText -notmatch 'forge-skill-bundle\.mjs.*doctor' -or
    $vpnUpgradeText -notmatch 'FORGE_EXTERNAL_SKILL_BUNDLE_VERSION' -or
    $vpnUpgradeText -notmatch 'treeSha256' -or
    $vpnUpgradeText -notmatch 'DSH_BUNDLED_SKILL_DIR' -or
    $vpnUpgradeText -notmatch 'test ! -e /usr/local/share/dsh-skills' -or
    $vpnUpgradeText -notmatch '! command -v mvn' -or
    $vpnUpgradeText -notmatch 'forge-delivery --help' -or
    $vpnUpgradeText -notmatch 'TaskSpace-managed projects must use upgrade-forge-delivery-toolkit\.sh' -or
    $vpnUpgradeText -notmatch 'HARNESS_SKILL_BUNDLE_VERSION' -or
    $vpnUpgradeText -notmatch 'forge-delivery\.project-slug') {
    throw 'Existing-project Harness upgrades must accept the reviewed vpn20 predecessor, refuse arbitrary Compose drift or active sessions, preserve a healthy Runner, and install the versioned Skill bundle idempotently.'
}
if ($deliveryToolkitUpgradeText -notmatch '--confirm-maintenance-window forge-delivery-toolkit' -or
    $deliveryToolkitUpgradeText -notmatch 'all_runtime_ready' -or
    $deliveryToolkitUpgradeText -notmatch 'already active for future TaskSpaces; deferred active TaskSpaces were not recreated' -or
    $deliveryToolkitUpgradeText -notmatch 'verify_target_harness_image' -or
    $deliveryToolkitUpgradeText -notmatch 'runtime_inventory_exact' -or
    $deliveryToolkitUpgradeText -notmatch '(?ms)freeze_project_verification_modes\(\).*?project_verification_mode\["\$\{slug\}"\]="\$\{mode\}"' -or
    $deliveryToolkitUpgradeText -notmatch '(?ms)project_compose\(\).*?case "\$\{mode\}" in\s+host\) compose\+=\(--file "\$\{root\}/ops/compose\.host-verification\.yaml"\)' -or
    $deliveryToolkitUpgradeText -notmatch 'Host Verification requires exactly one retained, stopped legacy Verification Runner' -or
    $deliveryToolkitUpgradeText -notmatch '(?ms)host_verification_is_ready\(\).*?schemaVersion==2.*?executionMode=="host-toolchain".*?systemctl is-active --quiet "forge-host-verification@\$\{slug\}\.service".*?source_socket.*?controlled-source-observer' -or
    $deliveryToolkitUpgradeText -notmatch '(?ms)broker_uses_host_verification\(\).*?value\.projectSlug===slug.*?value\.runnerRevision===revision' -or
    $deliveryToolkitUpgradeText -notmatch '(?ms)if project_uses_host_verification "\$\{slug\}"; then\s+verification_id="\$\(selected_id "\$\{slug\}" verification-runner\)".*?else\s+if \[\[ -f "\$\{FORGE_CUTOVER_RECORD_ROOT\}/\$\{slug\}-verification\.json" \]\]' -or
    $deliveryToolkitUpgradeText -notmatch '(?ms)rollback\(\) \{\s+local code=\$\?\s+trap - ERR EXIT\s+set \+e' -or
    $harnessImageVerifierText -notmatch 'validate-image-build-inputs\.mjs' -or
    $harnessImageVerifierText -notmatch 'HARNESS_PRIVILEGED_API_MODE=trusted-host' -or
    $deliveryToolkitUpgradeText -match 'upgrade-(?:prototype-archive-support|project-material-isolation)\.sh' -or
    $deliveryToolkitUpgradeText -notmatch 'generationPolicy.*new-taskspaces-only' -or
    $deliveryToolkitUpgradeText -notmatch 'deferred-active' -or
    $deliveryToolkitUpgradeText -notmatch 'capture_preserved_topology' -or
    $deliveryToolkitUpgradeText -notmatch 'cmp.*preserved\.before\.tsv.*preserved\.after\.tsv' -or
    $deliveryToolkitUpgradeText -notmatch 'forge_cutover_prepare gateway' -or
    $deliveryToolkitUpgradeText -notmatch 'forge_cutover_prepare "\$\{slug\}-manager"' -or
    $deliveryToolkitUpgradeText -notmatch 'forge_cutover_prepare "\$\{slug\}-release"' -or
    $deliveryToolkitUpgradeText -notmatch 'forge_cutover_prepare "\$\{slug\}-broker"' -or
    $deliveryToolkitUpgradeText -notmatch 'forge_cutover_activate "\$\{FORGE_CUTOVER_RECORD_ROOT\}/\$\{slug\}-release\.json"' -or
    $deliveryToolkitUpgradeText -notmatch 'render_release_contract "\$\{slug\}"' -or
    $deliveryToolkitUpgradeText -notmatch 'release_runtime_contract_ready "\$\{slug\}"' -or
    $deliveryToolkitUpgradeText -notmatch 'write_gateway_fence maintenance' -or
    $deliveryToolkitUpgradeText -notmatch 'backup_control_state' -or
    $deliveryToolkitUpgradeText -notmatch 'selected\.rollback\.tsv' -or
    $deliveryToolkitUpgradeText -notmatch 'Existing optional Verification Runner must be running and healthy or absent' -or
    $deliveryToolkitUpgradeWithoutRequiredServiceBootstrap -match 'project_compose .*\bup\b|control_compose .*\bup\b' -or
    $deliveryToolkitUpgradeText -notmatch 'upsert_env "\$\{staged_env\}" RELEASE_RUNNER_IMAGE "\$\{target_image_id\}"' -or
    $deliveryToolkitUpgradeText -match 'upsert_env .*task_env' -or
    $taskspaceControlText -notmatch '/\.forge-delivery/' -or
    $projectMaterialUpgradeText -notmatch '/\.forge-delivery/' -or
    $projectMaterialUpgradeText -notmatch 'forge-admin forge-app forge-flow forge-ui' -or
    $projectMaterialUpgradeText -notmatch 'Active TaskSpace.*did not converge' -or
    $projectMaterialUpgradeText -notmatch 'validate-skill-bundle\.mjs' -or
    $projectMaterialUpgradeText -notmatch 'forge-delivery --help' -or
    $projectMaterialUpgradeText -notmatch 'assert_runtime_inventory_exact' -or
    $projectMaterialUpgradeText -notmatch 'write_gateway_fence committed' -or
    $projectMaterialUpgradeText -notmatch 'wait_project_runner_idle') {
    throw 'The TaskSpace-aware Forge Delivery Toolkit upgrade must be idempotent, session-safe, rollback-capable, and verify every active worker without recreating application services.'
}
$projectCtlText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/projectctl.sh'))
if ($projectCtlText -notmatch 'harness-capabilities\|harness-vpn-access') {
    throw 'Project lifecycle must expose the versioned Harness capability upgrade through a stable command.'
}
$taskspaceUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-taskspace-isolation.sh'))
if ($projectCtlText -notmatch 'taskspace-isolation' -or
    $projectCtlText -notmatch 'taskspace <command>' -or
    $taskspaceUpgradeText -notmatch 'session state changed in the last two minutes' -or
    $taskspaceUpgradeText -notmatch 'workspace is active/dirty' -or
    $taskspaceUpgradeText -notmatch '\.result\.active == false' -or
    $taskspaceUpgradeText -notmatch 'predecessor_compose_hash' -or
    $taskspaceUpgradeText -notmatch 'pre-taskspace-isolation' -or
    $taskspaceUpgradeText -notmatch '\.broker/release\.lock' -or
    $taskspaceUpgradeText -notmatch 'task_env_backups' -or
    $taskspaceUpgradeText -notmatch 'active_task_env_files' -or
    $taskspaceUpgradeText -notmatch 'task_compose.*down --remove-orphans' -or
    $taskspaceUpgradeText -notmatch '\.Config\.Image.*target_image' -or
    $taskspaceUpgradeText -notmatch 'legacy-shared-harness' -or
    $taskspaceUpgradeText -notmatch 'taskspace-broker' -or
    $taskspaceUpgradeText -match 'down\s+--volumes|docker volume rm') {
    throw 'Existing-project TaskSpace migration must be gated, idempotent, recoverable, and volume-preserving.'
}
Write-Host 'PASS reusable new-project template and guarded existing-project TaskSpace upgrade path'
$conversationUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-conversation-isolation.sh'))
$unifiedConversationUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-unified-conversation-control-plane.sh'))
$conversationControlText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/conversation-control-planectl.sh'))
$conversationMigrationText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/migrate-conversation-control-plane.mjs'))
$legacyConversationRecoveryText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/recover-legacy-shared-conversations.sh'))
$conversationUserCtlText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/conversation-userctl.sh'))
$projectMaterialCtlText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/project-materialctl.sh'))
$projectMaterialUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-project-material-isolation.sh'))
if ($conversationUpgradeText -notmatch 'upgrade-unified-conversation-control-plane\.sh' -or
    $unifiedConversationUpgradeText -notmatch '--confirm-maintenance-window' -or
    $unifiedConversationUpgradeText -notmatch 'unified-conversation-control-plane' -or
    $unifiedConversationUpgradeText -notmatch 'Freeze all legacy writers before taking the migration snapshot' -or
    $unifiedConversationUpgradeText -notmatch 'pre-unified-conversation' -or
    $unifiedConversationUpgradeText -notmatch 'restore_project_files' -or
    $unifiedConversationUpgradeText -notmatch 'application-container-ids\.before' -or
    $unifiedConversationUpgradeText -notmatch 'application-container-ids\.after' -or
    $unifiedConversationUpgradeText -notmatch 'manager\.sock' -or
    $unifiedConversationUpgradeText -notmatch 'PLATFORM_CONVERSATION_AUTH_ROOT' -or
    $unifiedConversationUpgradeText -notmatch 'legacy-taskspace-auth\.override\.yaml' -or
    $unifiedConversationUpgradeText -notmatch 'HARNESS_ACCESS_AUTHZ_URL' -or
    $unifiedConversationUpgradeText -notmatch 'runtime-contract\.json' -or
    $unifiedConversationUpgradeText -notmatch 'generate-release-contract\.sh' -or
    $unifiedConversationUpgradeText -notmatch 'verify_release_contract_readable' -or
    $unifiedConversationUpgradeText -notmatch 'wait_project_service_health.*release-runner' -or
    $unifiedConversationUpgradeText -notmatch 'wait_project_service_health.*taskspace-broker' -or
    $unifiedConversationUpgradeText -notmatch 'wait_project_service_health.*conversation-manager' -or
    $unifiedConversationUpgradeText -notmatch 'failed\.log' -or
    $unifiedConversationUpgradeText -notmatch 'chown.*DELIVERY_OWNER.*DELIVERY_GROUP.*task_env' -or
    $unifiedConversationUpgradeText -notmatch 'chmod 0600.*task_env' -or
    $unifiedConversationUpgradeText -notmatch 'chown.*DELIVERY_OWNER.*DELIVERY_GROUP.*env_file' -or
    $unifiedConversationUpgradeText -notmatch 'chmod 0600.*env_file' -or
    $unifiedConversationUpgradeText -notmatch 'control-plane-state\.failed' -or
    $unifiedConversationUpgradeText -notmatch 'control-plane-state\.stale' -or
    $unifiedConversationUpgradeText -match 'forge-conversation-gateway:3120|forge-conversation-auth' -or
    $conversationControlText -notmatch 'auth-ipc' -or
    $conversationControlText -notmatch 'migrate-conversation-control-plane\.mjs' -or
    $conversationControlText -notmatch '--network none' -or
    $conversationControlText -notmatch 'docker/harness:/opt/docker/harness:ro' -or
    $conversationControlText -notmatch 'chown.*DELIVERY_OWNER.*DELIVERY_GROUP.*state_root.*state\.json' -or
    $conversationMigrationText -notmatch 'canonicalProject' -or
    $conversationMigrationText -notmatch 'sessions:\s*\[\]' -or
    $conversationMigrationText -notmatch 'sourceDigests' -or
    $legacyConversationRecoveryText -notmatch 'legacy-shared-conversations' -or
    $legacyConversationRecoveryText -notmatch 'backup-conversation-control-plane\.sh' -or
    $legacyConversationRecoveryText -notmatch 'zstd -t' -or
    $legacyConversationRecoveryText -notmatch 'flock --exclusive --nonblock' -or
    $legacyConversationRecoveryText -notmatch 'role=="admin" and \.status=="active"' -or
    $legacyConversationRecoveryText -notmatch 'Partial legacy archive state exists' -or
    $legacyConversationRecoveryText -notmatch 'conversation\.legacy-archive-recover' -or
    $legacyConversationRecoveryText -notmatch 'conversation\.legacy-sessions-surface' -or
    $legacyConversationRecoveryText -notmatch 'conversationKind:\s*"legacy-session"' -or
    $legacyConversationRecoveryText -notmatch 'hiddenFromList:true' -or
    $legacyConversationRecoveryText -notmatch '\u5468\u957f\u5e86-\u6d4b\u8bd5-\u5371\u5e9f\u529f\u80fd\u5f00\u53d1' -or
    $legacyConversationRecoveryText -notmatch '\u5468\u957f\u5e86-\u6d4b\u8bd5-APP\u529f\u80fd' -or
    $legacyConversationRecoveryText -notmatch 'conversation\.orphan-taskspace-recover' -or
    $legacyConversationRecoveryText -notmatch 'session_count > 0' -or
    $legacyConversationRecoveryText -notmatch 'compose up --detach --no-deps conversation-gateway' -or
    $legacyConversationRecoveryText -match 'rm -rf|down\s+--volumes|docker volume rm' -or
    $taskspacePolicyText -notmatch "'accessMode'" -or
    $taskspacePolicyText -notmatch "\['token', 'conversation'\]" -or
    $unifiedConversationUpgradeText -match 'down\s+--volumes|docker volume rm' -or
    $conversationUserCtlText -notmatch 'unix-socket' -or
    $conversationUserCtlText -notmatch 'projectSlugs' -or
    $conversationUserCtlText -match 'Authorization: Bearer.*curl') {
    throw 'Unified conversation control-plane migration and account/membership operator path must be gated, recoverable, non-destructive, and secret-safe.'
}
Write-Host 'PASS reusable unified conversation control plane and guarded multi-project migration path'
if ($projectMaterialUpgradeText -notmatch '--confirm-maintenance-window' -or
    $projectMaterialUpgradeText -notmatch 'pre-project-material-isolation' -or
    $projectMaterialUpgradeText -notmatch 'application-container-ids.before' -or
    $projectMaterialUpgradeText -notmatch 'application-container-ids.after' -or
    $projectMaterialUpgradeText -notmatch 'PROJECT_SHARED_INPUT_ROOT' -or
    $projectMaterialUpgradeText -notmatch 'restore_project_files' -or
    $projectMaterialUpgradeText -notmatch 'trap rollback ERR EXIT' -or
    $projectMaterialUpgradeText -notmatch 'chmod 0755.*runtime_directory' -or
    $projectMaterialUpgradeText -notmatch 'TaskSpace control script is not executable after package extraction' -or
    $projectMaterialUpgradeText -notmatch 'wait_conversation_gateway' -or
    $projectMaterialUpgradeText -notmatch 'assert_project_release_idle' -or
    $projectMaterialUpgradeText -notmatch 'active == false' -or
    $projectMaterialUpgradeText -notmatch 'force-recreate --no-deps release-runner' -or
    $projectMaterialUpgradeText -notmatch 'force-recreate --no-deps taskspace-broker' -or
    $projectMaterialUpgradeText -notmatch 'wait_project_service_health.*release-runner' -or
    $projectMaterialUpgradeText -notmatch 'wait_project_service_health.*taskspace-broker' -or
    $projectMaterialUpgradeText -notmatch 'upsert_env.*DELIVERY_ROOT' -or
    $projectMaterialUpgradeText -notmatch 'upsert_env.*DELIVERY_OWNER' -or
    $projectMaterialUpgradeText -notmatch 'upsert_env.*DELIVERY_GROUP' -or
    $projectMaterialUpgradeText -notmatch 'task-compose' -or
    $projectMaterialUpgradeText -notmatch 'templates/taskspace/compose\.yaml' -or
    $projectMaterialUpgradeText -notmatch 'task_compose.*up --detach' -or
    $projectMaterialUpgradeText -match 'down\s+--volumes|docker volume rm|rm -rf' -or
    $projectMaterialCtlText -notmatch 'sha256sum' -or
    $projectMaterialCtlText -notmatch 'project-intake relative path' -or
    $projectMaterialCtlText -match '(?m)^\s*(?:rm|mv)\s') {
    throw 'Project material isolation upgrade and operator path must be gated, hash-verified, recoverable, and non-destructive.'
}
Write-Host 'PASS reusable project-material isolation and guarded operator approval path'
$taskspaceToolCacheUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-taskspace-tool-cache.sh'))
if ($projectCtlText -notmatch 'taskspace-tool-cache' -or
    $taskspaceComposeText -notmatch 'TASKSPACE_ROOT.*?/cache/m2:/workspace/\.forge-cache/m2' -or
    $taskspaceComposeText -notmatch 'TASKSPACE_ROOT.*?/cache/npm:/workspace/\.forge-cache/npm' -or
    $taskspaceComposeText -notmatch 'TASKSPACE_ROOT.*?/cache/pnpm:/workspace/\.forge-cache/pnpm' -or
    $taskspaceComposeText -notmatch 'TASKSPACE_ROOT.*?/cache/general:/workspace/\.forge-cache/general' -or
    $taskspaceComposeText -match '(?m)^\s*- harness-(?:m2|npm|pnpm|cache):' -or
    $taskspaceComposeText -notmatch 'jansi\.tmpdir=/workspace/\.forge-cache/general/jansi' -or
    $taskspaceComposeText -notmatch 'XDG_DATA_HOME: /workspace/\.forge-cache/pnpm/data' -or
    $taskspaceComposeText -notmatch 'XDG_STATE_HOME: /workspace/\.forge-cache/general/state' -or
    $taskspaceControlText -notmatch 'task_root}/cache/m2' -or
    $taskspaceControlText -notmatch 'task_root}/cache/general' -or
    $taskspaceControlText -notmatch 'task_root}/cache/general/jansi' -or
    $taskspaceControlText -notmatch 'task_root}/cache/pnpm/home' -or
    $taskspaceControlText -notmatch 'ensure_taskspace_cache_contract' -or
    $taskspaceControlText -notmatch '/\.forge-cache/' -or
    $taskspaceControlText -match 'local task_root="\$1" workspace="\$\{task_root\}' -or
    $projectMaterialUpgradeText -notmatch 'task_root}/cache/m2' -or
    $projectMaterialUpgradeText -notmatch 'task_root}/cache/general' -or
    $projectMaterialUpgradeText -notmatch 'task_root}/cache/general/jansi' -or
    $projectMaterialUpgradeText -notmatch 'task_root}/cache/pnpm/home' -or
    $projectMaterialUpgradeText -notmatch 'workspace/\.forge-cache/m2' -or
    $projectMaterialUpgradeText -notmatch '/\.forge-cache/' -or
    $projectMaterialUpgradeText -notmatch '/\.forge-delivery/' -or
    $taskspaceControlText -notmatch '/\.forge-delivery/' -or
    $taskspaceToolCacheUpgradeText -notmatch '--confirm-maintenance-window taskspace-tool-cache' -or
    $taskspaceToolCacheUpgradeText -notmatch 'upgrade-project-material-isolation\.sh' -or
    $taskspaceToolCacheUpgradeText -match 'down\s+--volumes|docker volume rm|rm -rf') {
    throw 'TaskSpace tool caches must be uid-correct, per-conversation, upgradeable, and volume-preserving.'
}
Write-Host 'PASS uid-correct sandbox-writable isolated TaskSpace Maven/npm/pnpm cache contract'
$prototypeUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-prototype-archive-support.sh'))
if ($projectCtlText -notmatch 'prototype-archive-support' -or
    $prototypeUpgradeText -notmatch '--confirm-maintenance-window prototype-archive-support' -or
    $prototypeUpgradeText -notmatch 'YAUZL_VERSION' -or
    $prototypeUpgradeText -notmatch 'verify_target_harness_image' -or
    $prototypeUpgradeText -notmatch 'upgrade-project-material-isolation\.sh' -or
    $prototypeUpgradeText -match 'down\s+--volumes|docker volume rm|rm -rf') {
    throw 'Prototype archive support must use a pinned image and the rollback-capable all-project cutover.'
}
Write-Host 'PASS versioned safe prototype-archive upgrade path'
$folderInputUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-project-folder-inputs.sh'))
if ($projectCtlText -notmatch 'project-folder-inputs' -or
    $folderInputUpgradeText -notmatch '--confirm-maintenance-window project-folder-inputs' -or
    $folderInputUpgradeText -notmatch 'upgrade-prototype-archive-support\.sh' -or
    $projectMaterialUpgradeText -notmatch 'PROJECT_MATERIAL_ACCESS_MODE direct' -or
    $projectMaterialUpgradeText -notmatch 'PROJECT_FTP_INPUT_ROOT' -or
    $folderInputUpgradeText -match 'down\s+--volumes|docker volume rm|rm -rf') {
    throw 'Direct project folder inputs must use an explicit, rollback-capable, all-project versioned cutover.'
}
Write-Host 'PASS versioned direct SFTP project-folder input path'
$runnerReadinessUpgradeText = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts/upgrade-release-runner-readiness.sh'))
if ($runnerReadinessUpgradeText -notmatch '\.active == false' -or
    $runnerReadinessUpgradeText -notmatch 'force-recreate --no-deps release-runner' -or
    $runnerReadinessUpgradeText -notmatch 'Project workspace is active/dirty' -or
    $runnerReadinessUpgradeText -notmatch 'structured preflight result' -or
    $runnerReadinessUpgradeText -notmatch 'forge-release diagnose' -or
    $runnerReadinessUpgradeText -notmatch 'vpn22_compose_hash=.ad54a64585364c29ac4578bce304df9e90666cba50f3bcea84a5e2786b8da7c7.' -or
    $runnerReadinessUpgradeText -notmatch 'RELEASE_RUNNER_IMAGE' -or
    $runnerReadinessUpgradeText -notmatch 'RELEASE_DB_OPERATOR_IMAGE' -or
    $runnerReadinessUpgradeText -notmatch 'test-database-snapshots' -or
    $runnerReadinessUpgradeText -notmatch 'backup_compose' -or
    $runnerReadinessUpgradeText -notmatch 'harness_container_before' -or
    $runnerReadinessUpgradeText -match 'print "HARNESS_IMAGE=" image' -or
    $runnerReadinessUpgradeText -match 'force-recreate[^\r\n]*(?:harness-upload|\sharness(?:\s|$))') {
    throw 'Release-runner upgrades must preserve Harness, migrate only reviewed Compose, update only the Runner image, and expose diagnosis.'
}
if ($projectComposeText -notmatch 'image:\s+\$\{RELEASE_RUNNER_IMAGE:-\$\{HARNESS_IMAGE:' -or
    $projectComposeText -notmatch '/backups:\$\{PROJECT_ROOT:\?PROJECT_ROOT is required\}/backups' -or
    [IO.File]::ReadAllText((Join-Path $repoRoot 'templates/project/project.env.tpl')) -notmatch '(?m)^RELEASE_RUNNER_IMAGE=__RELEASE_RUNNER_IMAGE__$' -or
    $createProjectText -notmatch [regex]::Escape('rendered_env="${rendered_env//__RELEASE_RUNNER_IMAGE__/${RELEASE_RUNNER_IMAGE:-${harness_image_id}}}"') -or
    [IO.File]::ReadAllText((Join-Path $repoRoot 'templates/project/project.env.tpl')) -notmatch '(?m)^RELEASE_DB_OPERATOR_IMAGE=__RELEASE_DB_OPERATOR_IMAGE__$') {
    throw 'New project templates do not separate the Release Runner image lifecycle from Harness.'
}
$testDatabaseOperatorText = [IO.File]::ReadAllText((Join-Path $repoRoot 'docker/harness/test-db-operator.sh'))
if ($testDatabaseOperatorText -notmatch 'drop-schema-objects-only' -or
    $testDatabaseOperatorText -notmatch 'verified-snapshot-import' -or
    $testDatabaseOperatorText -notmatch 'FORGE_BACKUP_SHA256' -or
    $testDatabaseOperatorText -notmatch 'FORGE_TEST_DATABASE' -or
    $testDatabaseOperatorText -notmatch 'FORGE_RUNTIME_DATABASE' -or
    $testDatabaseOperatorText -notmatch 'GET_LOCK' -or
    $testDatabaseOperatorText -match '(?i)DROP\s+(?:DATABASE|SCHEMA)') {
    throw 'Test-database operator must remain schema-name bound, locked, and unable to drop a database.'
}
Write-Host 'PASS snapshot-and-restore test-database recovery contract'
Write-Host 'PASS per-project Git worktree and safe milestone checkpoint guard'

$playbookRoot = Join-Path $repoRoot 'docs/ai-delivery-playbook'
$playbookDocuments = @(Get-ChildItem -LiteralPath $playbookRoot -Filter '*.md' -File -Recurse)
if ($playbookDocuments.Count -lt 80) {
    throw "Expected at least 80 governed playbook documents, found $($playbookDocuments.Count)."
}
$emptyPlaybookDocuments = @($playbookDocuments | Where-Object { $_.Length -lt 20 })
if ($emptyPlaybookDocuments.Count -gt 0) {
    throw "Playbook contains empty or placeholder documents: $($emptyPlaybookDocuments.FullName -join ', ')"
}
Write-Host "PASS playbook document inventory ($($playbookDocuments.Count) non-empty Markdown files)"

$playbookCorpus = ($playbookDocuments | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n"
$humanUsabilityMarkers = @(
    'PLAYBOOK_HUMAN_PREFILL_V1',
    'PLAYBOOK_AI_PREFILL_V1',
    'PLAYBOOK_ROLE_ROUTING_V1',
    'PLAYBOOK_UAT_SPLIT_V1',
    'PRODUCT_HARNESS_TRIAL_CARD_V1',
    'PLAYBOOK_GOLDEN_RECIPE_ENTRY_V1'
)
foreach ($marker in $humanUsabilityMarkers) {
    if (-not $playbookCorpus.Contains($marker)) {
        throw "Playbook human-usability contract is missing marker: $marker"
    }
}

$recipeTasks = @($playbookDocuments | Where-Object {
    [IO.File]::ReadAllText($_.FullName).Contains('GOLDEN_RECIPE_START_CARD_V1')
})
if ($recipeTasks.Count -ne 4) {
    throw "Expected four human-startable golden recipes, found $($recipeTasks.Count)."
}
foreach ($recipe in $recipeTasks) {
    $recipeText = [IO.File]::ReadAllText($recipe.FullName)
    if (-not $recipeText.Contains('GOLDEN_RECIPE_HUMAN_DECISION_V1')) {
        throw "Golden recipe must expose human-owned decisions: $($recipe.Name)"
    }
}
Write-Host 'PASS playbook human-first input ownership, AI-prefill, UAT split and golden-recipe contracts'

$bashPath = $null
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
    $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
    $gitBash = Join-Path $gitRoot 'bin/bash.exe'
    if (Test-Path -LiteralPath $gitBash -PathType Leaf) {
        $bashPath = $gitBash
    }
}
if (-not $bashPath) {
    $bash = Get-Command bash -ErrorAction SilentlyContinue
    if ($bash -and $bash.Source -notlike "$env:WINDIR\System32\bash.exe") {
        $bashPath = $bash.Source
    }
}
if ($bashPath) {
    $shellScripts = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'scripts') -Filter '*.sh' -Recurse
    foreach ($script in $shellScripts) {
        & $bashPath -n $script.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "bash syntax validation failed: $($script.FullName)"
        }
    }
    Write-Host "PASS bash syntax ($($shellScripts.Count) scripts)"

    if ($env:OS -eq 'Windows_NT') {
        $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
        if (-not $wsl) {
            throw 'WSL is required on Windows for the project-gitctl Linux permission runtime test.'
        }
        & $wsl.Source --cd $repoRoot bash tests/project-gitctl-runtime.test.sh
        if ($LASTEXITCODE -eq 0) {
            & $wsl.Source --cd $repoRoot bash tests/taskspace-git-exclude-path.test.sh
        }
        if ($LASTEXITCODE -eq 0) {
            & $wsl.Source --cd $repoRoot bash tests/taskspace-upgrade-network-compatibility.test.sh
        }
        if ($LASTEXITCODE -eq 0) {
            & $wsl.Source --cd $repoRoot bash tests/taskspace-governance-context.test.sh
        }
        if ($LASTEXITCODE -eq 0) {
            & $wsl.Source --cd $repoRoot bash tests/taskspace-maintenance-mutator-fence.test.sh
        }
        if ($LASTEXITCODE -eq 0) {
            & $wsl.Source --cd $repoRoot bash tests/project-git-ownership.test.sh
        }
    } else {
        & $bashPath (Join-Path $repoRoot 'tests/project-gitctl-runtime.test.sh')
        if ($LASTEXITCODE -eq 0) {
            & $bashPath (Join-Path $repoRoot 'tests/taskspace-git-exclude-path.test.sh')
        }
        if ($LASTEXITCODE -eq 0) {
            & $bashPath (Join-Path $repoRoot 'tests/taskspace-upgrade-network-compatibility.test.sh')
        }
        if ($LASTEXITCODE -eq 0) {
            & $bashPath (Join-Path $repoRoot 'tests/taskspace-governance-context.test.sh')
        }
        if ($LASTEXITCODE -eq 0) {
            & $bashPath (Join-Path $repoRoot 'tests/taskspace-maintenance-mutator-fence.test.sh')
        }
        if ($LASTEXITCODE -eq 0) {
            & $bashPath (Join-Path $repoRoot 'tests/project-git-ownership.test.sh')
        }
    }
    if ($LASTEXITCODE -ne 0) {
        throw 'Project Git Linux runtime validation failed.'
    }
} else {
    Write-Warning 'bash is unavailable; shell syntax validation was skipped.'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $yauzlPackage = Join-Path $repoRoot 'node_modules/yauzl/package.json'
    if (-not (Test-Path -LiteralPath $yauzlPackage -PathType Leaf)) {
        $npm = Get-Command npm -ErrorAction SilentlyContinue
        if (-not $npm) {
            throw 'npm is required to install the pinned local ZIP parser dependency.'
        }
        Push-Location $repoRoot
        try {
            & $npm.Source ci --ignore-scripts --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) {
                throw 'Pinned Node runtime dependency installation failed.'
            }
        } finally {
            Pop-Location
        }
    }
    & $node.Source --check (Join-Path $repoRoot 'tests/live-conversation-isolation.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'Live conversation-isolation acceptance script syntax validation failed.'
    }
    & $node.Source --check (Join-Path $repoRoot 'tests/live-same-user-conversations.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'Live same-user multi-conversation acceptance script syntax validation failed.'
    }
    & $node.Source --check (Join-Path $repoRoot 'scripts/snapshot-forge-harness-eval-inputs.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'Forge Harness evaluation input snapshot script syntax validation failed.'
    }
    & $node.Source --check (Join-Path $repoRoot 'scripts/verify-forge-harness-eval-runtime-lock.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'Forge Harness evaluation runtime trust-lock verifier syntax validation failed.'
    }
    & $node.Source --check (Join-Path $repoRoot 'docker/harness/apply-legacy-conversation-surface.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'Pinned legacy conversation surface transformer syntax validation failed.'
    }
    & $node.Source --check (Join-Path $repoRoot 'docker/harness/verification-cache-tool.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'Controlled verification-cache tool syntax validation failed.'
    }
    & $node.Source --check (Join-Path $repoRoot 'docker/harness/maven-verification-policy.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'Maven verification repository policy syntax validation failed.'
    }
    & $node.Source --check (Join-Path $repoRoot 'docker/harness/host-verify-policy.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'Host verification profile policy syntax validation failed.'
    }
    & $node.Source --check (Join-Path $repoRoot 'docker/harness/host-verification-runner.mjs')
    & $node.Source --check (Join-Path $repoRoot 'docker/harness/host-prepared-dependencies.mjs')
    & $node.Source --check (Join-Path $repoRoot 'scripts/prepare-host-installed-dependencies.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'Host verification Runner syntax validation failed.'
    }
    & $node.Source --check (Join-Path $repoRoot 'docker/harness/forge-phase-work-package.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'Forge phase work-package syntax validation failed.'
    }
    & $node.Source --check (Join-Path $repoRoot 'docker/harness/forge-cross-layer-runtime-evidence.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'Forge cross-layer runtime evidence syntax validation failed.'
    }
    & $node.Source --check (Join-Path $repoRoot 'scripts/forge-skill-bundle.mjs')
    & $node.Source --check (Join-Path $repoRoot 'scripts/forge-host-runner-bundle.mjs')
    & $node.Source --check (Join-Path $repoRoot 'scripts/run-forge-protected-headless-recovery.mjs')
    & $node.Source --check (Join-Path $repoRoot 'scripts/run-host-verification-once.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'External Skill bundle lifecycle syntax validation failed.'
    }
    # Bound file-level concurrency so shell-backed integration tests retain their request deadlines.
    & $node.Source --test --test-concurrency=4 `
        (Join-Path $repoRoot 'tests/harness-proxy.test.mjs') `
        (Join-Path $repoRoot 'tests/harness-start-supervision.test.mjs') `
        (Join-Path $repoRoot 'tests/harness-upload.test.mjs') `
        (Join-Path $repoRoot 'tests/conversation-output-ui.test.mjs') `
        (Join-Path $repoRoot 'tests/conversation-output-store.test.mjs') `
        (Join-Path $repoRoot 'tests/conversation-output-projection.test.mjs') `
        (Join-Path $repoRoot 'tests/conversation-output-service.test.mjs') `
        (Join-Path $repoRoot 'tests/prototype-archive.test.mjs') `
        (Join-Path $repoRoot 'tests/release-runner.test.mjs') `
        (Join-Path $repoRoot 'tests/mobile-runtime-upgrade.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-delivery.test.mjs') `
        (Join-Path $repoRoot 'tests/skill-bundle-validator.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-skill-evals.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-delivery-toolkit-upgrade.test.mjs') `
        (Join-Path $repoRoot 'tests/image-build-inputs.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-governance.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-phase-budget-guard.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-prepare-task-runtime.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-conversation-task-proposal.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-conversation-task-preparation.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-conversation-task-execution.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-conversation-task-integration.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-typed-file-removal.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-controlled-command.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-skill-command-closure.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-task-execution-contract.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-delivery-phase-runtime.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-delivery-phase-response.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-execution-context.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-recover-headless-execution.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-protected-headless-recovery-host.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-protected-session-mode.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-execution-capability-negotiation.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-execution-store.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-execution-orchestrator.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-progress-detector.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-change-contract.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-business-data-approval.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-business-object-mutation.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-semantic-resource-lease.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-workflow-migration-safety.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-ui-edit-session.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-behavior-qualification.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-reference-adoption-coverage.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-execution-state.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-obligation-ledger.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-model-qualification.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-acceptance-aggregator.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-protected-issuer-adapter.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-production-task-grant.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-cross-layer-runtime-evidence.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-cross-layer-runtime-controller.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-protected-acceptance-service.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-independent-semantic-review.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-protected-acceptance-deployment.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-quality-capability-registry.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-ui-contract.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-verification-runner.test.mjs') `
        (Join-Path $repoRoot 'tests/external-skill-bundle.test.mjs') `
        (Join-Path $repoRoot 'tests/host-verification-runner.test.mjs') `
        (Join-Path $repoRoot 'tests/host-prepared-dependencies.test.mjs') `
        (Join-Path $repoRoot 'tests/host-dependency-seed.test.mjs') `
        (Join-Path $repoRoot 'tests/prepare-host-dependency-seed.test.mjs') `
        (Join-Path $repoRoot 'tests/local-host-profile-adapter.test.mjs') `
        (Join-Path $repoRoot 'tests/host-runner-bundle.test.mjs') `
        (Join-Path $repoRoot 'tests/split-runtime-template.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-verification-upgrade.test.mjs') `
        (Join-Path $repoRoot 'tests/runtime-dependency-validator.test.mjs') `
        (Join-Path $repoRoot 'tests/harness-image-config-validator.test.mjs') `
        (Join-Path $repoRoot 'tests/glm-provider-config.test.mjs') `
        (Join-Path $repoRoot 'tests/taskspace-proxy-config.test.mjs') `
        (Join-Path $repoRoot 'tests/taskspace-codex-authorization.test.mjs') `
        (Join-Path $repoRoot 'tests/codex-credentials-sync.test.mjs') `
        (Join-Path $repoRoot 'tests/harness-runtime-build-policy.test.mjs') `
        (Join-Path $repoRoot 'tests/runtime-lock-refresh.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-delivery-phase-controller.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-delivery-browser-phase-controller.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-delivery-phase-browser-session.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-delivery-phase-host-receipts.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-phase-work-package.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-delivery-phase-workspace-observer.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-harness-behavior-eval-runner.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-harness-eval-runtime-trust-lock.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-harness-eval-input-snapshot.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-harness-docker-resource-state.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-credential-proxy-contract.test.mjs') `
        (Join-Path $repoRoot 'tests/local-secret-snapshot.test.mjs') `
        (Join-Path $repoRoot 'tests/local-forge-verification-cache-prep.test.mjs') `
        (Join-Path $repoRoot 'tests/frontend-typecheck-capability.test.mjs') `
        (Join-Path $repoRoot 'tests/connection-status-patch.test.mjs') `
        (Join-Path $repoRoot 'tests/taskspace-broker.test.mjs') `
        (Join-Path $repoRoot 'tests/default-workspace.test.mjs') `
        (Join-Path $repoRoot 'tests/conversation-policy.test.mjs') `
        (Join-Path $repoRoot 'tests/conversation-manager.test.mjs') `
        (Join-Path $repoRoot 'tests/forge-phase-host-receipts-manager.test.mjs') `
        (Join-Path $repoRoot 'tests/conversation-gateway.test.mjs') `
        (Join-Path $repoRoot 'tests/project-release-status.test.mjs') `
        (Join-Path $repoRoot 'tests/conversation-gateway-output-ui.test.mjs') `
        (Join-Path $repoRoot 'tests/conversation-gateway-upgrade.test.mjs') `
        (Join-Path $repoRoot 'tests/conversation-gateway-maintenance.test.mjs') `
        (Join-Path $repoRoot 'tests/project-directory.test.mjs') `
        (Join-Path $repoRoot 'tests/conversation-control-plane-migration.test.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'Harness capability tests failed.'
    }
    Write-Host 'PASS Harness proxy, upload and controlled-release trust-boundary tests'
} else {
    Write-Warning 'node is unavailable; Harness proxy tests were skipped.'
}

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    $python = Get-Command python3 -ErrorAction SilentlyContinue
}
if ($python) {
    Push-Location $repoRoot
    try {
        & $python.Source -m unittest discover -s tests -p '*_test.py'
        if ($LASTEXITCODE -ne 0) {
            throw 'File gateway provisioning tests failed.'
        }
    } finally {
        Pop-Location
    }
    Write-Host 'PASS file gateway and Redis logical-backup tests'
} else {
    Write-Warning 'python is unavailable; file gateway provisioning tests were skipped.'
}

$tempBase = [IO.Path]::GetTempPath()
$tempDir = Join-Path $tempBase ("forge-delivery-validation-" + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($tempDir) | Out-Null
$tempSecret = Join-Path $tempDir 'deepseek-api-key'
[IO.File]::WriteAllText($tempSecret, 'validation-key', [Text.UTF8Encoding]::new($false))
$tempSharedEnv = Join-Path $tempDir 'shared-services.env'
[IO.File]::WriteAllText(
    $tempSharedEnv,
    "MYSQL_HOST=127.0.0.1`nMYSQL_PORT=3306`nMYSQL_USER=test`nMYSQL_PASSWORD=test`nREDIS_HOST=127.0.0.1`nREDIS_PORT=6379`nREDIS_PASSWORD=test`n",
    [Text.UTF8Encoding]::new($false)
)

$templatePath = Join-Path $repoRoot 'templates/project/project.env.tpl'
$rendered = [IO.File]::ReadAllText($templatePath)
$replacements = [ordered]@{
    '__PROJECT_SLUG__' = 'validation-project'
    '__FORGE_ADMIN_REF__' = 'v1.1.2'
    '__FORGE_ADMIN_COMMIT__' = '6eb2881e6f6af85a5348acf3da63cef53a873b0e'
    '__PROJECT_SOURCE_KIND__' = 'registered-project'
    '__PROJECT_SOURCE_SLUG__' = 'forge-base'
    '__PROJECT_SOURCE_COMMIT__' = '6eb2881e6f6af85a5348acf3da63cef53a873b0e'
    '__PROJECT_GIT_REMOTE_URL__' = 'ssh://git@192.0.2.20/example/validation-project.git'
    '__PROJECT_GIT_REMOTE_BRANCH__' = 'delivery/validation-project'
    '__FORGE_BIND_ADDRESS__' = '127.0.0.1'
    '__FORGE_UI_PORT__' = '18080'
    '__HARNESS_PORT__' = '13080'
    '__HARNESS_PRIVILEGED_API_MODE__' = 'trusted-host'
    '__HARNESS_UPLOAD_TOKEN__' = ('a' * 64)
    '__HOST_UID__' = '1000'
    '__HOST_GID__' = '1000'
    '__DOCKER_GID__' = '984'
    '__DELIVERY_ROOT__' = $tempDir.Replace('\', '/')
    '__PLATFORM_ROOT__' = $repoRoot.Replace('\', '/')
    '__DELIVERY_OWNER__' = 'validation-owner'
    '__DELIVERY_GROUP__' = 'validation-group'
    '__DEEPSEEK_KEY_FILE__' = $tempSecret.Replace('\', '/')
    '__KIMI_KEY_FILE__' = $tempSecret.Replace('\', '/')
    '__GLM_KEY_FILE__' = $tempSecret.Replace('\', '/')
    '__SHARED_SERVICES_ENV_FILE__' = $tempSharedEnv.Replace('\', '/')
    '__MYSQL_DATABASE__' = 'forge_validation_project'
    '__MYSQL_TEST_DATABASE__' = 'forge_validation_project_test'
    '__REDIS_DATABASE__' = '1'
    '__REDIS_TEST_DATABASE__' = '15'
    '__HARNESS_IMAGE__' = $configuredHarnessImage
    '__HARNESS_IMAGE_SOURCE__' = $configuredHarnessImage
    '__FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED__' = 'true'
    '__FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED__' = 'true'
    '__FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED__' = 'true'
    '__FORGE_CHANGED_VERIFICATION_SUPPORTED__' = 'true'
    '__FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED__' = 'true'
    '__FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED__' = 'true'
    '__CONVERSATION_MANAGER_IMAGE__' = $configuredConversationManagerImage
    '__RELEASE_DB_OPERATOR_IMAGE__' = $configuredDatabaseOperatorImage
}
foreach ($entry in $replacements.GetEnumerator()) {
    $rendered = $rendered.Replace($entry.Key, $entry.Value)
}
if ($rendered.Contains('__')) {
    throw 'The rendered project environment still contains template placeholders.'
}

$projectContextTemplate = [IO.File]::ReadAllText((Join-Path $repoRoot 'templates/project/PROJECT_CONTEXT.md.tpl'))
if ($projectContextTemplate -notmatch '__HARNESS_SKILL_BUNDLE_VERSION__' -or
    $createProjectText -notmatch '__HARNESS_SKILL_BUNDLE_VERSION__' -or
    $projectContextTemplate -notmatch 'forge-task-contract' -or
    $projectContextTemplate -notmatch 'forge-release-acceptance') {
    throw 'New projects do not record the selected Harness Skill bundle and its stage/acceptance routing.'
}

try {
    $tempEnv = Join-Path $tempDir 'project.env'
    [IO.File]::WriteAllText($tempEnv, $rendered, [Text.UTF8Encoding]::new($false))

    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if ($docker) {
        & $docker.Source compose --env-file $tempEnv --file (Join-Path $repoRoot 'templates/project/compose.yaml') config --quiet
        if ($LASTEXITCODE -ne 0) {
            throw 'Docker Compose validation failed.'
        }
        $projectServices = @(& $docker.Source compose --env-file $tempEnv --file (Join-Path $repoRoot 'templates/project/compose.yaml') config --services)
        $expectedProjectServices = @('conversation-manager', 'forge-admin', 'forge-app', 'forge-flow', 'forge-ui', 'protected-acceptance', 'release-runner', 'taskspace-broker', 'verification-runner') | Sort-Object
        if (@(Compare-Object -ReferenceObject $expectedProjectServices -DifferenceObject @($projectServices | Sort-Object)).Count -ne 0) {
            throw "Project Compose service model differs from the Runner contract: $($projectServices -join ', ')"
        }
        Write-Host 'PASS project Docker Compose interpolation and schema'

        $controlPlaneRoot = Join-Path $tempDir 'conversation-control-plane'
        [IO.Directory]::CreateDirectory($controlPlaneRoot) | Out-Null
        $registryPath = Join-Path $tempDir 'projects.tsv'
        [IO.File]::WriteAllText(
            $registryPath,
            "slug`tdisplay_name`tui_port`tharness_port`tforge_ref`tforge_commit`tcreated_at`tproject_kind`tmysql_database`tmysql_test_database`tredis_database`tredis_test_database`nvalidation-project`tValidation Project`t18080`t13080`tv1.1.2`t$('a' * 40)`t2026-08-28T00:00:00Z`tdelivery`tforge_validation_project`tforge_validation_project_test`t1`t15`n",
            [Text.UTF8Encoding]::new($false)
        )
        $controlPlaneEnv = Join-Path $tempDir 'control-plane.env'
        [IO.File]::WriteAllText(
            $controlPlaneEnv,
            "CONVERSATION_CONTROL_PLANE_ROOT=$($controlPlaneRoot.Replace('\', '/'))`n" +
            "CONVERSATION_GATEWAY_BIND_ADDRESS=127.0.0.1`n" +
            "CONVERSATION_GATEWAY_PORT=13080`n" +
            "CONVERSATION_GATEWAY_COOKIE_SECURE=false`n" +
            "PLATFORM_PROJECT_REGISTRY_FILE=$($registryPath.Replace('\', '/'))`n" +
            "HARNESS_IMAGE=$configuredHarnessImage`nHOST_UID=1000`nHOST_GID=1000`nTZ=Asia/Shanghai`n",
            [Text.UTF8Encoding]::new($false)
        )
        & $docker.Source compose --env-file $controlPlaneEnv --file (Join-Path $repoRoot 'templates/conversation-control-plane/compose.yaml') config --quiet
        if ($LASTEXITCODE -ne 0) {
            throw 'Unified conversation control-plane Docker Compose validation failed.'
        }
        $controlPlaneServices = @(& $docker.Source compose --env-file $controlPlaneEnv --file (Join-Path $repoRoot 'templates/conversation-control-plane/compose.yaml') config --services)
        if (@(Compare-Object -ReferenceObject @('conversation-gateway') -DifferenceObject @($controlPlaneServices)).Count -ne 0) {
            throw "Unified control-plane Compose must contain only conversation-gateway: $($controlPlaneServices -join ', ')"
        }
        Write-Host 'PASS unified control-plane Docker Compose interpolation and schema'

        $taskspaceRoot = Join-Path $tempDir 'taskspace'
        [IO.Directory]::CreateDirectory((Join-Path $taskspaceRoot 'workspace')) | Out-Null
        [IO.Directory]::CreateDirectory((Join-Path $taskspaceRoot 'dsh-home')) | Out-Null
        [IO.Directory]::CreateDirectory((Join-Path $taskspaceRoot 'uploads')) | Out-Null
        [IO.Directory]::CreateDirectory((Join-Path $taskspaceRoot 'shared-inputs')) | Out-Null
        [IO.Directory]::CreateDirectory((Join-Path $taskspaceRoot 'ftp-inputs')) | Out-Null
        [IO.Directory]::CreateDirectory((Join-Path $taskspaceRoot 'tokens')) | Out-Null
        [IO.File]::WriteAllText((Join-Path $taskspaceRoot 'tokens/browser'), ('b' * 64), [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $taskspaceRoot 'tokens/broker'), ('c' * 64), [Text.UTF8Encoding]::new($false))
        $taskspaceEnv = Join-Path $tempDir 'taskspace.env'
        [IO.File]::WriteAllText(
            $taskspaceEnv,
            "TASKSPACE_COMPOSE_PROJECT_NAME=forge-validation-project-task-validation-task`n" +
            "PROJECT_COMPOSE_NAME=forge-validation-project`n" +
            "PROJECT_ROOT=$($tempDir.Replace('\', '/'))`n" +
            "PROJECT_FTP_INPUT_ROOT=$($taskspaceRoot.Replace('\', '/'))/ftp-inputs`n" +
            "PROJECT_SHARED_INPUT_ROOT=$($taskspaceRoot.Replace('\', '/'))/shared-inputs`n" +
            "PLATFORM_CONVERSATION_AUTH_ROOT=$($controlPlaneRoot.Replace('\', '/'))/auth-ipc`n" +
            "TASKSPACE_ROOT=$($taskspaceRoot.Replace('\', '/'))`n" +
            "PROJECT_SLUG=validation-project`n" +
            "TASKSPACE_ID=validation-task`n" +
            "TASKSPACE_ACTOR_ID=validation-actor`n" +
            "TASKSPACE_ACTOR_USER_ID=11111111-1111-4111-8111-111111111111`n" +
            "TASKSPACE_CONVERSATION_ID=validation-conversation`n" +
            "FORGE_SKILL_BUNDLE_ROOT=/srv/forge-delivery/skill-bundles`n" +
            "FORGE_BIND_ADDRESS=127.0.0.1`n" +
            "TASKSPACE_HARNESS_PORT=21080`n" +
            "HARNESS_PRIVILEGED_API_MODE=trusted-host`n" +
            "HARNESS_HISTORY_PAGE_MESSAGES=5`n" +
            "HARNESS_UPLOAD_TOKEN=$('d' * 64)`n" +
            "HOST_UID=1000`nHOST_GID=1000`n" +
            "DEEPSEEK_KEY_FILE=$($tempSecret.Replace('\', '/'))`n" +
            "KIMI_KEY_FILE=$($tempSecret.Replace('\', '/'))`n" +
            "GLM_KEY_FILE=$($tempSecret.Replace('\', '/'))`n" +
            "HARNESS_IMAGE=$configuredHarnessImage`nTZ=Asia/Shanghai`n",
            [Text.UTF8Encoding]::new($false)
        )
        & $docker.Source compose --env-file $taskspaceEnv --file (Join-Path $repoRoot 'templates/taskspace/compose.yaml') config --quiet
        if ($LASTEXITCODE -ne 0) {
            throw 'TaskSpace Docker Compose validation failed.'
        }
        Write-Host 'PASS TaskSpace Docker Compose interpolation and schema'

        $gatewayEnv = Join-Path $tempDir 'file-gateway.env'
        [IO.File]::WriteAllText(
            $gatewayEnv,
            "SFTPGO_RUNTIME_IMAGE=sha256:c728f5d433b5a377d96573002f5dba728d084bea9f831bf0b418e2053a832b78`n" +
            "FILE_GATEWAY_BIND_ADDRESS=127.0.0.1`n" +
            "FILE_GATEWAY_HTTP_PORT=14080`n" +
            "FILE_GATEWAY_SFTP_PORT=14022`n" +
            "FILE_GATEWAY_UID=1000`n" +
            "FILE_GATEWAY_GID=1000`n" +
            "FILE_GATEWAY_DATA_ROOT=$($tempDir.Replace('\', '/'))/gateway-data`n" +
            "FILE_GATEWAY_STATE_ROOT=$($tempDir.Replace('\', '/'))/gateway-state`n" +
            "FILE_GATEWAY_BACKUP_ROOT=$($tempDir.Replace('\', '/'))/gateway-backups`n" +
            "SFTPGO_DEFAULT_ADMIN_USERNAME=validation-admin`n" +
            "SFTPGO_DEFAULT_ADMIN_PASSWORD=validation-password`n" +
            "TZ=Asia/Shanghai`n",
            [Text.UTF8Encoding]::new($false)
        )
        & $docker.Source compose --env-file $gatewayEnv --file (Join-Path $repoRoot 'templates/file-gateway/compose.yaml') config --quiet
        if ($LASTEXITCODE -ne 0) {
            throw 'File gateway Docker Compose validation failed.'
        }
        Write-Host 'PASS file gateway Compose interpolation and schema'

        $playbookEnv = Join-Path $tempDir 'playbook.env'
        [IO.File]::WriteAllText(
            $playbookEnv,
            "PLAYBOOK_RUNTIME_IMAGE=sha256:916f384e5474752809636d5aa3be999b3c995992ba5fc4a9304e31fd64d9ecd5`n" +
            "PLAYBOOK_BIND_ADDRESS=127.0.0.1`n" +
            "PLAYBOOK_HTTP_PORT=15080`n",
            [Text.UTF8Encoding]::new($false)
        )
        & $docker.Source compose --env-file $playbookEnv --file (Join-Path $repoRoot 'templates/playbook-portal/compose.yaml') config --quiet
        if ($LASTEXITCODE -ne 0) {
            throw 'Playbook portal Docker Compose validation failed.'
        }
        Write-Host 'PASS playbook portal Compose interpolation and schema'
    } else {
        Write-Warning 'docker is unavailable; Compose validation was skipped.'
    }
}
finally {
    $resolvedTemp = [IO.Path]::GetFullPath($tempDir)
    $resolvedBase = [IO.Path]::GetFullPath($tempBase)
    if ($resolvedTemp.StartsWith($resolvedBase, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path $resolvedTemp -Leaf).StartsWith('forge-delivery-validation-', [StringComparison]::Ordinal)) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}

Write-Host 'All available validations passed.'
