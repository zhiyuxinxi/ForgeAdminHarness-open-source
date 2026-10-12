ARG HARNESS_NODE_BASE_IMAGE=node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
ARG HARNESS_MAVEN_BASE_IMAGE=maven:3.9.16-eclipse-temurin-17@sha256:bbcab0adfb03704e65831593df63b1c6b7ee42d5d8603f0d88972e0ee81a3036

FROM ${HARNESS_NODE_BASE_IMAGE} AS node-toolchain

FROM node-toolchain AS runtime-dependencies
USER 0:0
RUN install -d -m 0755 -o 1000 -g 1000 /opt/forge-harness-runtime /tmp/forge-runtime-build
COPY --chmod=0644 docker/harness/validate-runtime-dependencies.mjs /usr/local/lib/validate-runtime-dependencies.mjs
COPY --chown=1000:1000 --chmod=0644 docker/harness/runtime-dependencies/package.json /opt/forge-harness-runtime/package.json
COPY --chown=1000:1000 --chmod=0644 docker/harness/runtime-dependencies/package-lock.json /opt/forge-harness-runtime/package-lock.json
RUN node /usr/local/lib/validate-runtime-dependencies.mjs \
      --mode source --root /opt/forge-harness-runtime
USER 1000:1000
RUN cd /opt/forge-harness-runtime \
    && HOME=/tmp/forge-runtime-build npm ci --omit=dev --no-audit --no-fund --ignore-scripts
RUN --network=none cd /opt/forge-harness-runtime \
    && HOME=/tmp/forge-runtime-build npm rebuild --no-audit --no-fund --strict-allow-scripts \
    && HOME=/tmp/forge-runtime-build npm install-scripts ls --json >/tmp/forge-runtime-install-scripts.json \
    && node -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(JSON.stringify(Object.keys(value))!==JSON.stringify(["allowScripts"])||!Array.isArray(value.allowScripts)||value.allowScripts.length!==0)process.exit(1)' \
      /tmp/forge-runtime-install-scripts.json \
    && HOME=/tmp/forge-runtime-build npm cache clean --force \
    && rm -rf /tmp/forge-runtime-build /tmp/forge-runtime-install-scripts.json

# The Maven image is an assembly input only. The published Harness core is
# flattened from the scrubbed filesystem below, so it does not inherit the
# JDK/Maven layers or their runtime metadata.
FROM ${HARNESS_MAVEN_BASE_IMAGE} AS runtime-root

ARG HARNESS_NODE_BASE_IMAGE
ARG HARNESS_MAVEN_BASE_IMAGE

ARG DSH_VERSION=0.1.1-rc.2
ARG PDFJS_DIST_VERSION=6.2.108
ARG MAMMOTH_VERSION=1.12.1
ARG READ_EXCEL_FILE_VERSION=9.3.10
ARG YAUZL_VERSION=3.4.0

COPY --from=node-toolchain /usr/local/ /usr/local/

COPY --chmod=0644 docker/harness/ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources
RUN update_attempt=1 \
    && until rm -rf /var/lib/apt/lists/* \
      && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update \
      && apt-cache show iproute2 jq ripgrep util-linux >/dev/null; do \
      [ "${update_attempt}" -lt 3 ] || exit 100; \
      update_attempt=$((update_attempt + 1)); \
    done \
    && install_attempt=1 \
    && until apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install --yes --no-install-recommends \
        ca-certificates \
        curl \
        git \
        iproute2 \
        jq \
        openssh-client \
        procps \
        ripgrep \
        util-linux; do \
      [ "${install_attempt}" -lt 3 ] || exit 100; \
      install_attempt=$((install_attempt + 1)); \
    done \
    && rm -rf /var/lib/apt/lists/* \
    && if ! getent group 1000 >/dev/null; then groupadd --gid 1000 node; fi \
    && if ! getent passwd 1000 >/dev/null; then useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash node; fi \
    && install -d -m 0755 -o 1000 -g 1000 \
      /home/node \
      /workspace \
    && dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\n' \
      | LC_ALL=C sort > /usr/local/share/forge-os-package-inventory.tsv

# Release identity must not invalidate the pinned operating-system dependency
# layer. Keeping these ARGs below apt makes a candidate-only version bump reuse
# the already verified snapshot packages while all versioned assets below still
# receive the new values.
ARG HARNESS_IMAGE_REVISION=vpn-forge-delivery-toolkit-77-base
ARG HARNESS_SKILL_BUNDLE_VERSION=2026.09.01.5
ARG HARNESS_RUNTIME_PROFILE=loopback-safe

COPY --from=runtime-dependencies --chown=0:0 /opt/forge-harness-runtime/ /opt/forge-harness-runtime/
COPY --chmod=0644 docker/harness/forge-connection-status-patch.mjs /usr/local/lib/forge-connection-status-patch.mjs
RUN node /usr/local/lib/forge-connection-status-patch.mjs /opt/forge-harness-runtime/node_modules
COPY --chmod=0644 docker/harness/forge-session-reappearance-patch.mjs /usr/local/lib/forge-session-reappearance-patch.mjs
RUN node /usr/local/lib/forge-session-reappearance-patch.mjs /opt/forge-harness-runtime/node_modules
COPY --chmod=0644 docker/harness/forge-question-history.mjs docker/harness/forge-question-history-patch.mjs docker/harness/forge-question-history-client.js /usr/local/lib/
RUN node /usr/local/lib/forge-question-history-patch.mjs /opt/forge-harness-runtime/node_modules
COPY --chmod=0644 docker/harness/forge-prompt-admission-patch.mjs /usr/local/lib/forge-prompt-admission-patch.mjs
RUN node /usr/local/lib/forge-prompt-admission-patch.mjs /opt/forge-harness-runtime/node_modules
COPY --chmod=0644 docker/harness/forge-model-selection-patch.mjs /usr/local/lib/forge-model-selection-patch.mjs
RUN node /usr/local/lib/forge-model-selection-patch.mjs /opt/forge-harness-runtime/node_modules
COPY --chmod=0644 docker/harness/forge-codex-sse-patch.mjs /usr/local/lib/forge-codex-sse-patch.mjs
RUN node /usr/local/lib/forge-codex-sse-patch.mjs /opt/forge-harness-runtime/node_modules
COPY --chmod=0644 docker/harness/forge-job-completion-wakeup-patch.mjs /usr/local/lib/forge-job-completion-wakeup-patch.mjs
RUN node /usr/local/lib/forge-job-completion-wakeup-patch.mjs /opt/forge-harness-runtime/node_modules
COPY --chmod=0644 docker/harness/forge-compaction-budget-patch.mjs /usr/local/lib/forge-compaction-budget-patch.mjs
RUN node /usr/local/lib/forge-compaction-budget-patch.mjs /opt/forge-harness-runtime/node_modules
COPY --chmod=0644 docker/harness/validate-runtime-dependencies.mjs /usr/local/lib/validate-runtime-dependencies.mjs
COPY --chmod=0755 docker/harness/validate-runtime-tree-metadata.sh /usr/local/lib/validate-runtime-tree-metadata.sh
COPY --chmod=0644 docker/harness/forge-agent-preset-policy.mjs /usr/local/lib/forge-agent-preset-policy.mjs
ENV NODE_PATH=/opt/forge-harness-runtime/node_modules
RUN node /usr/local/lib/forge-agent-preset-policy.mjs apply \
      --root /opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh/config/agent-presets \
      >/tmp/forge-agent-preset-policy.json \
    && /usr/local/lib/validate-runtime-tree-metadata.sh /opt/forge-harness-runtime \
    && rm -f /usr/local/bin/dsh \
    && printf '%s\n' \
      '#!/bin/sh' \
      'exec node --expose-internals /opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"' \
      >/usr/local/bin/dsh \
    && chmod 0755 /usr/local/bin/dsh \
    && dsh --version \
    && test -x /usr/local/bin/dsh \
    && rm -f /tmp/forge-agent-preset-policy.json

# Empty named volumes inherit these ownership bits on first mount.
RUN install -d -m 0750 -o 1000 -g 1000 \
      /home/node/.cache \
      /home/node/.dsh \
      /home/node/.npm

COPY --chmod=0755 docker/harness/start-harness.sh /usr/local/bin/start-harness
COPY --chmod=0755 scripts/recover-forge-dead-writer.mjs /usr/local/bin/recover-forge-dead-writer.mjs
COPY --chmod=0644 docker/harness/forge-governance-runtime.patch.yml /usr/local/share/forge-governance-runtime.patch.yml
COPY --chmod=0644 docker/harness/forge-governance-prompt-guard.mjs /usr/local/lib/forge-governance-prompt-guard.mjs
COPY --chmod=0644 docker/harness/forge-completion-claim-guard.mjs /usr/local/lib/forge-completion-claim-guard.mjs
COPY --chmod=0644 docker/harness/forge-host-verification-receipt.mjs /usr/local/lib/forge-host-verification-receipt.mjs
COPY --chmod=0644 docker/harness/forge-controlled-command.mjs /usr/local/lib/forge-controlled-command.mjs
COPY --chmod=0644 docker/harness/forge-task-execution-contract.mjs /usr/local/lib/forge-task-execution-contract.mjs
COPY --chmod=0644 docker/harness/forge-delivery-phase-controller.mjs /usr/local/lib/forge-delivery-phase-controller.mjs
COPY --chmod=0644 docker/harness/forge-delivery-phase-browser-session.mjs /usr/local/lib/forge-delivery-phase-browser-session.mjs
COPY --chmod=0644 docker/harness/forge-delivery-phase-host-receipts.mjs /usr/local/lib/forge-delivery-phase-host-receipts.mjs
COPY --chmod=0644 docker/harness/forge-delivery-phase-workspace-observer.mjs /usr/local/lib/forge-delivery-phase-workspace-observer.mjs
COPY --chmod=0644 docker/harness/forge-cross-layer-runtime-evidence.mjs /usr/local/lib/forge-cross-layer-runtime-evidence.mjs
COPY --chmod=0644 docker/harness/forge-cross-layer-preparation.mjs /usr/local/lib/forge-cross-layer-preparation.mjs
COPY --chmod=0644 docker/harness/forge-phase-work-package.mjs /usr/local/lib/forge-phase-work-package.mjs
COPY --chmod=0644 docker/harness/forge-delivery-phase-runtime.mjs /usr/local/lib/forge-delivery-phase-runtime.mjs
COPY --chmod=0644 docker/harness/forge-delivery-phase-response.mjs /usr/local/lib/forge-delivery-phase-response.mjs
COPY --chmod=0644 docker/harness/forge-execution-context.mjs /usr/local/lib/forge-execution-context.mjs
COPY --chmod=0644 docker/harness/forge-execution-policy.json /usr/local/lib/forge-execution-policy.json
COPY --chmod=0644 docker/harness/forge-prepare-headless-execution.mjs /usr/local/lib/forge-prepare-headless-execution.mjs
COPY --chmod=0644 docker/harness/forge-recover-headless-execution.mjs /usr/local/lib/forge-recover-headless-execution.mjs
COPY --chmod=0644 docker/harness/forge-protected-session-mode.mjs /usr/local/lib/forge-protected-session-mode.mjs
COPY --chmod=0644 docker/harness/forge-protected-headless-runner.mjs /usr/local/lib/forge-protected-headless-runner.mjs
COPY --chmod=0644 docker/harness/forge-execution-capability-registry.mjs /usr/local/lib/forge-execution-capability-registry.mjs
COPY --chmod=0644 docker/harness/forge-capability-negotiator.mjs /usr/local/lib/forge-capability-negotiator.mjs
COPY --chmod=0644 docker/harness/forge-execution-pack.mjs /usr/local/lib/forge-execution-pack.mjs
COPY --chmod=0644 docker/harness/forge-execution-store.mjs /usr/local/lib/forge-execution-store.mjs
COPY --chmod=0644 docker/harness/forge-execution-orchestrator.mjs /usr/local/lib/forge-execution-orchestrator.mjs
COPY --chmod=0644 docker/harness/forge-progress-detector.mjs /usr/local/lib/forge-progress-detector.mjs
COPY --chmod=0644 docker/harness/forge-change-contract.mjs /usr/local/lib/forge-change-contract.mjs
COPY --chmod=0644 docker/harness/forge-business-data-approval.mjs /usr/local/lib/forge-business-data-approval.mjs
COPY --chmod=0644 docker/harness/forge-business-data-preview.mjs /usr/local/lib/forge-business-data-preview.mjs
COPY --chmod=0644 docker/harness/forge-managed-files.mjs /usr/local/lib/forge-managed-files.mjs
COPY --chmod=0644 docker/harness/forge-managed-file-tool.mjs /usr/local/lib/forge-managed-file-tool.mjs
COPY --chmod=0644 docker/harness/forge-business-data-consumption.mjs /usr/local/lib/forge-business-data-consumption.mjs
COPY --chmod=0644 docker/harness/forge-business-object-mutation.mjs /usr/local/lib/forge-business-object-mutation.mjs
COPY --chmod=0644 docker/harness/forge-semantic-resource-lease.mjs /usr/local/lib/forge-semantic-resource-lease.mjs
COPY --chmod=0644 docker/harness/forge-workflow-migration-safety.mjs /usr/local/lib/forge-workflow-migration-safety.mjs
COPY --chmod=0644 docker/harness/forge-ui-edit-session.mjs /usr/local/lib/forge-ui-edit-session.mjs
COPY --chmod=0644 docker/harness/forge-behavior-qualification.mjs /usr/local/lib/forge-behavior-qualification.mjs
COPY --chmod=0644 docker/harness/forge-reference-adoption-coverage.mjs /usr/local/lib/forge-reference-adoption-coverage.mjs
COPY --chmod=0644 docker/harness/forge-reference-adoption-coverage.json /usr/local/lib/forge-reference-adoption-coverage.json
COPY --chmod=0644 docker/harness/forge-execution-capability-registry.json /usr/local/share/forge-execution-capability-registry.json
COPY --chmod=0644 docker/harness/forge-execution-state.mjs /usr/local/lib/forge-execution-state.mjs
COPY --chmod=0644 docker/harness/forge-obligation-ledger.mjs /usr/local/lib/forge-obligation-ledger.mjs
COPY --chmod=0644 docker/harness/forge-model-qualification.mjs /usr/local/lib/forge-model-qualification.mjs
COPY --chmod=0644 docker/harness/forge-acceptance-aggregator.mjs /usr/local/lib/forge-acceptance-aggregator.mjs
COPY --chmod=0644 docker/harness/forge-protected-issuer-adapter.mjs /usr/local/lib/forge-protected-issuer-adapter.mjs
COPY --chmod=0644 docker/harness/forge-production-task-grant.mjs /usr/local/lib/forge-production-task-grant.mjs
COPY --chmod=0644 docker/harness/forge-protected-acceptance-service.mjs /usr/local/lib/forge-protected-acceptance-service.mjs
COPY --chmod=0644 docker/harness/forge-conversation-task-proposal.mjs /usr/local/lib/forge-conversation-task-proposal.mjs
COPY --chmod=0644 docker/harness/forge-conversation-task-preparation.mjs /usr/local/lib/forge-conversation-task-preparation.mjs
COPY --chmod=0644 docker/harness/forge-prepare-task.mjs /usr/local/lib/forge-prepare-task.mjs
COPY --chmod=0644 docker/harness/forge-quality-capability-registry.mjs /usr/local/lib/forge-quality-capability-registry.mjs
COPY --chmod=0644 docker/harness/forge-quality-capability-registry.json /usr/local/share/forge-quality-capability-registry.json
COPY --chmod=0644 docker/harness/forge-phase-budget-guard.mjs /usr/local/lib/forge-phase-budget-guard.mjs
COPY --chmod=0644 docker/harness/forge-writer-scope-client.mjs /usr/local/lib/forge-writer-scope-client.mjs
COPY --chmod=0644 docker/harness/forge-writer-scope-lease.mjs /usr/local/lib/forge-writer-scope-lease.mjs
COPY --chmod=0644 docker/harness/forge-typed-file-removal.mjs /usr/local/lib/forge-typed-file-removal.mjs
COPY --chmod=0644 docker/harness/forge-ui-contract.mjs /usr/local/lib/forge-ui-contract.mjs
COPY --chmod=0644 docker/harness/forge-ui-contract.json /usr/local/lib/forge-ui-contract.json
COPY --chmod=0644 docker/harness/forge-agent-preset-prompt-probe.mjs /usr/local/lib/forge-agent-preset-prompt-probe.mjs
COPY --chmod=0644 docker/harness/forge-agent-preset-prompt-probe.patch.yml /usr/local/share/forge-agent-preset-prompt-probe.patch.yml
COPY --chmod=0644 docker/harness/seed-default-workspace.mjs /usr/local/lib/seed-default-workspace.mjs
COPY --chmod=0644 docker/harness/tcp-proxy.mjs /usr/local/lib/harness-tcp-proxy.mjs
COPY --chmod=0644 docker/harness/project-file-upload.js /usr/local/lib/project-file-upload.js
COPY --chmod=0644 docker/harness/harness-directory-scope.mjs /usr/local/lib/harness-directory-scope.mjs
COPY --chmod=0644 docker/harness/harness-directory-scope.js /usr/local/lib/harness-directory-scope.js
COPY --chmod=0644 docker/harness/conversation-output.js /usr/local/lib/conversation-output.js
COPY --chmod=0644 docker/harness/conversation-prompt-queue.js /usr/local/lib/conversation-prompt-queue.js
COPY --chmod=0644 docker/harness/conversation-output-store.mjs /usr/local/lib/conversation-output-store.mjs
COPY --chmod=0644 docker/harness/output-file-presentation.mjs /usr/local/lib/output-file-presentation.mjs
COPY --chmod=0644 docker/harness/phase-work-package-files.mjs /usr/local/lib/phase-work-package-files.mjs
COPY --chmod=0644 docker/harness/conversation-output-projection.mjs /usr/local/lib/conversation-output-projection.mjs
COPY --chmod=0644 docker/harness/conversation-output-service.mjs /usr/local/lib/conversation-output-service.mjs
COPY --chmod=0644 docker/harness/upload-server.mjs /usr/local/lib/harness-upload-server.mjs
COPY --chmod=0644 docker/harness/document-extractor.mjs /usr/local/lib/document-extractor.mjs
COPY --chmod=0644 docker/harness/prototype-archive.mjs /usr/local/lib/prototype-archive.mjs
COPY --chmod=0644 docker/harness/prototype-directory-index.mjs /usr/local/lib/prototype-directory-index.mjs
COPY --chmod=0644 docker/harness/material-readable.mjs /usr/local/lib/material-readable.mjs
COPY --chmod=0755 docker/harness/harness-document-extract /usr/local/bin/harness-document-extract
COPY --chmod=0755 docker/harness/forge-prototype-index /usr/local/bin/forge-prototype-index
COPY --chmod=0755 docker/harness/forge-release /usr/local/bin/forge-release
COPY --chmod=0755 docker/harness/forge-delivery /usr/local/bin/forge-delivery
COPY --chmod=0755 docker/harness/forge-verify /usr/local/bin/forge-verify
COPY --chmod=0644 docker/harness/forge-delivery.mjs /usr/local/lib/forge-delivery.mjs
COPY --chmod=0755 docker/harness/forge-governance /usr/local/bin/forge-governance
COPY --chmod=0644 docker/harness/forge-governance.mjs /usr/local/lib/forge-governance.mjs
COPY --chmod=0644 docker/harness/forge-reference-provenance.mjs /usr/local/lib/forge-reference-provenance.mjs
COPY --chmod=0644 docker/harness/forge-governance-policy.json /usr/local/share/forge-governance-policy.json
COPY --chmod=0644 docker/harness/validate-skill-bundle.mjs /usr/local/lib/validate-skill-bundle.mjs
COPY --chmod=0644 docker/harness/forge-capability-inventory.mjs /usr/local/lib/forge-capability-inventory.mjs
COPY --chmod=0644 docker/harness/validate-image-build-inputs.mjs /usr/local/lib/validate-image-build-inputs.mjs
COPY --chmod=0644 docker/harness/release-policy.mjs /usr/local/lib/release-policy.mjs
COPY --chmod=0644 docker/harness/release-runner.mjs /usr/local/lib/release-runner.mjs
COPY --chmod=0644 docker/harness/forge-candidate-auth-client.mjs /usr/local/lib/forge-candidate-auth-client.mjs
COPY --chmod=0644 docker/harness/runtime-download-evidence.mjs /usr/local/lib/runtime-download-evidence.mjs
COPY --chmod=0644 docker/harness/verify-policy.mjs /usr/local/lib/verify-policy.mjs
COPY --chmod=0644 docker/harness/host-verify-policy.mjs /usr/local/lib/host-verify-policy.mjs
COPY --chmod=0644 docker/harness/forge-backend-source-quality.mjs /usr/local/lib/forge-backend-source-quality.mjs
COPY --chmod=0644 docker/harness/frontend-typecheck.mjs /usr/local/lib/frontend-typecheck.mjs
COPY --chmod=0644 docker/harness/vue-typecheck-entity-compat.mjs /usr/local/lib/vue-typecheck-entity-compat.mjs
COPY --chmod=0644 docker/harness/forge-independent-semantic-review.mjs /usr/local/lib/forge-independent-semantic-review.mjs
COPY --chmod=0644 docker/harness/verification-runner.mjs /usr/local/lib/verification-runner.mjs
COPY --chmod=0644 docker/harness/verification-cache-tool.mjs /usr/local/lib/verification-cache-tool.mjs
COPY --chmod=0644 docker/harness/maven-verification-policy.mjs /usr/local/lib/maven-verification-policy.mjs
COPY --chmod=0644 docker/harness/maven-verification-settings.xml /usr/local/lib/maven-verification-settings.xml
COPY --chmod=0644 docker/harness/maven-verification-exec.sh /usr/local/lib/maven-verification-exec.sh
RUN install -m 0755 /usr/local/lib/maven-verification-exec.sh /usr/local/bin/maven-verification-exec
COPY --chmod=0644 docker/harness/taskspace-policy.mjs /usr/local/lib/taskspace-policy.mjs
COPY --chmod=0644 docker/harness/taskspace-broker.mjs /usr/local/lib/taskspace-broker.mjs
COPY --chmod=0644 docker/harness/project-release-status.mjs /usr/local/lib/project-release-status.mjs
COPY --chmod=0644 docker/harness/conversation-policy.mjs /usr/local/lib/conversation-policy.mjs
COPY --chmod=0644 docker/harness/project-directory.mjs /usr/local/lib/project-directory.mjs
COPY --chmod=0644 docker/harness/project-materials.mjs /usr/local/lib/project-materials.mjs
COPY --chmod=0644 docker/harness/conversation-manager.mjs /usr/local/lib/conversation-manager.mjs
COPY --chmod=0644 docker/harness/conversation-gateway.mjs /usr/local/lib/conversation-gateway.mjs
COPY --chmod=0644 docker/harness/delivery-center-config.mjs docker/harness/delivery-center-http.mjs docker/harness/delivery-center-service.mjs docker/harness/delivery-center-store.mjs docker/harness/delivery-center-assets.mjs docker/harness/delivery-center-asset-projection.mjs docker/harness/delivery-center-semantics.mjs docker/harness/delivery-center-document-source.mjs docker/harness/delivery-center-checkpoint-documents.mjs docker/harness/delivery-center-checkpoint-source.mjs docker/harness/delivery-center-views.mjs docker/harness/delivery-center-diagrams.mjs docker/harness/delivery-center-projection.mjs docker/harness/delivery-center-import.mjs docker/harness/delivery-center-release-snapshot.mjs docker/harness/delivery-center-schema.sql /usr/local/lib/
COPY --chmod=0644 docker/harness/conversation-gateway/ /usr/local/share/conversation-gateway/
COPY --chmod=0755 docker/harness/test-db-operator.sh /usr/local/lib/test-db-operator.sh
COPY --chmod=0644 scripts/configure-codex-model-route.py /usr/local/lib/configure-codex-model-route.py
COPY --chmod=0644 docker/harness/Dockerfile /usr/local/share/forge-image-build/Dockerfile
COPY --chmod=0644 docker/harness/Dockerfile.overlay /usr/local/share/forge-image-build/Dockerfile.overlay
COPY --chmod=0644 config/versions.env /usr/local/share/forge-image-build/versions.env
COPY --chmod=0644 docker/harness/image-build-inputs.json /usr/local/share/forge-image-build/image-build-inputs.json
COPY --chmod=0644 docker/harness/forge-tool-worker.mjs /usr/local/lib/forge-tool-worker.mjs
COPY --chmod=0644 docker/harness/forge-tool-worker-wire.mjs /usr/local/lib/forge-tool-worker-wire.mjs
COPY --chmod=0644 docker/harness/forge-tool-worker-provider.mjs /usr/local/lib/forge-tool-worker-provider.mjs
COPY --chmod=0644 docker/harness/forge-tool-worker-bash.mjs /usr/local/lib/forge-tool-worker-bash.mjs
COPY --chmod=0644 docker/harness/forge-tool-worker-start.mjs /usr/local/lib/forge-tool-worker-start.mjs
COPY --chmod=0644 docker/harness/forge-tool-worker-native-patch.mjs /usr/local/lib/forge-tool-worker-native-patch.mjs
COPY --chmod=0644 docker/harness/forge-tool-worker.json /usr/local/share/forge-tool-worker.json

RUN --network=none \
    --mount=type=bind,source=docker/harness/skills.catalog.json,target=/run/forge-image-build/skills.catalog.json,ro \
    node /usr/local/lib/forge-tool-worker-native-patch.mjs /opt/forge-harness-runtime/node_modules \
    && find /usr/local/share/conversation-gateway -type d -exec chmod 0755 '{}' + \
    && chmod 0755 /usr/local/share/conversation-gateway \
      /usr/local/share/forge-image-build \
    && chmod 0644 \
      /usr/local/share/forge-governance-policy.json \
      /usr/local/lib/forge-agent-preset-policy.mjs \
      /usr/local/lib/forge-agent-preset-prompt-probe.mjs \
      /usr/local/lib/forge-governance-prompt-guard.mjs \
      /usr/local/lib/forge-completion-claim-guard.mjs \
      /usr/local/lib/forge-host-verification-receipt.mjs \
      /usr/local/lib/forge-controlled-command.mjs \
      /usr/local/lib/forge-task-execution-contract.mjs \
      /usr/local/lib/forge-delivery-phase-controller.mjs \
      /usr/local/lib/forge-delivery-phase-browser-session.mjs \
      /usr/local/lib/forge-delivery-phase-host-receipts.mjs \
      /usr/local/lib/forge-delivery-phase-workspace-observer.mjs \
      /usr/local/lib/forge-cross-layer-runtime-evidence.mjs \
      /usr/local/lib/forge-cross-layer-preparation.mjs \
      /usr/local/lib/forge-candidate-auth-client.mjs \
      /usr/local/lib/runtime-download-evidence.mjs \
      /usr/local/lib/forge-phase-work-package.mjs \
      /usr/local/lib/forge-delivery-phase-runtime.mjs \
      /usr/local/lib/forge-delivery-phase-response.mjs \
      /usr/local/lib/forge-execution-context.mjs \
      /usr/local/lib/forge-execution-policy.json \
      /usr/local/lib/forge-prepare-headless-execution.mjs \
      /usr/local/lib/forge-recover-headless-execution.mjs \
      /usr/local/lib/forge-protected-session-mode.mjs \
      /usr/local/lib/forge-protected-headless-runner.mjs \
      /usr/local/lib/forge-execution-capability-registry.mjs \
      /usr/local/lib/forge-capability-negotiator.mjs \
      /usr/local/lib/forge-execution-pack.mjs \
      /usr/local/lib/forge-execution-store.mjs \
      /usr/local/lib/forge-execution-orchestrator.mjs \
      /usr/local/lib/forge-progress-detector.mjs \
      /usr/local/lib/forge-change-contract.mjs \
      /usr/local/lib/forge-business-data-approval.mjs \
      /usr/local/lib/forge-business-data-preview.mjs \
      /usr/local/lib/forge-managed-files.mjs \
      /usr/local/lib/forge-managed-file-tool.mjs \
      /usr/local/lib/forge-business-data-consumption.mjs \
      /usr/local/lib/forge-business-object-mutation.mjs \
      /usr/local/lib/forge-semantic-resource-lease.mjs \
      /usr/local/lib/forge-workflow-migration-safety.mjs \
      /usr/local/lib/forge-ui-edit-session.mjs \
      /usr/local/lib/forge-behavior-qualification.mjs \
      /usr/local/lib/forge-reference-adoption-coverage.mjs \
      /usr/local/lib/forge-reference-adoption-coverage.json \
      /usr/local/share/forge-execution-capability-registry.json \
      /usr/local/lib/forge-execution-state.mjs \
      /usr/local/lib/forge-obligation-ledger.mjs \
      /usr/local/lib/forge-model-qualification.mjs \
      /usr/local/lib/forge-acceptance-aggregator.mjs \
      /usr/local/lib/forge-protected-issuer-adapter.mjs \
      /usr/local/lib/forge-production-task-grant.mjs \
      /usr/local/lib/forge-protected-acceptance-service.mjs \
      /usr/local/lib/forge-conversation-task-proposal.mjs \
      /usr/local/lib/forge-conversation-task-preparation.mjs \
      /usr/local/lib/forge-prepare-task.mjs \
      /usr/local/lib/forge-quality-capability-registry.mjs \
      /usr/local/share/forge-quality-capability-registry.json \
      /usr/local/lib/forge-phase-budget-guard.mjs \
      /usr/local/lib/forge-writer-scope-client.mjs \
      /usr/local/lib/forge-writer-scope-lease.mjs \
      /usr/local/lib/forge-typed-file-removal.mjs \
      /usr/local/lib/forge-ui-contract.mjs \
      /usr/local/lib/forge-ui-contract.json \
      /usr/local/lib/verify-policy.mjs \
      /usr/local/lib/host-verify-policy.mjs \
      /usr/local/lib/verification-runner.mjs \
      /usr/local/lib/verification-cache-tool.mjs \
      /usr/local/lib/maven-verification-policy.mjs \
      /usr/local/lib/maven-verification-settings.xml \
      /usr/local/lib/validate-image-build-inputs.mjs \
      /usr/local/lib/validate-runtime-dependencies.mjs \
      /opt/forge-harness-runtime/package.json \
      /opt/forge-harness-runtime/package-lock.json \
      /usr/local/share/forge-image-build/Dockerfile \
      /usr/local/share/forge-image-build/Dockerfile.overlay \
      /usr/local/share/forge-image-build/versions.env \
      /usr/local/share/forge-image-build/image-build-inputs.json \
    && find /usr/local/share/conversation-gateway -type f -exec chmod 0644 '{}' + \
    && node --check /usr/local/lib/forge-delivery.mjs \
    && /usr/local/bin/forge-delivery --help >/dev/null \
    && printf '%s\n' 'PASS image smoke: delivery CLI' \
    && node --check /usr/local/lib/forge-governance.mjs \
    && /usr/local/bin/forge-governance catalog >/dev/null \
    && printf '%s\n' 'PASS image smoke: governance CLI' \
    && node --check /usr/local/lib/forge-host-verification-receipt.mjs \
    && node --check /usr/local/lib/forge-controlled-command.mjs \
    && node --check /usr/local/lib/forge-task-execution-contract.mjs \
    && node --check /usr/local/lib/forge-phase-work-package.mjs \
    && node --check /usr/local/lib/forge-delivery-phase-controller.mjs \
    && node --check /usr/local/lib/forge-delivery-phase-browser-session.mjs \
    && node --check /usr/local/lib/forge-delivery-phase-host-receipts.mjs \
    && node --check /usr/local/lib/forge-delivery-phase-workspace-observer.mjs \
    && node --check /usr/local/lib/forge-cross-layer-runtime-evidence.mjs \
    && node --check /usr/local/lib/forge-cross-layer-preparation.mjs \
    && node --check /usr/local/lib/forge-delivery-phase-runtime.mjs \
    && node --check /usr/local/lib/forge-delivery-phase-response.mjs \
    && node --check /usr/local/lib/forge-execution-context.mjs \
    && node --check /usr/local/lib/forge-prepare-headless-execution.mjs \
    && node --check /usr/local/lib/forge-recover-headless-execution.mjs \
    && node --check /usr/local/lib/forge-protected-session-mode.mjs \
    && node --check /usr/local/lib/forge-protected-headless-runner.mjs \
    && install -d -m 0700 /tmp/forge-protected-execution-smoke \
    && ln -s /opt/forge-harness-runtime/node_modules /tmp/forge-protected-execution-smoke/node_modules \
    && ln -s /usr/local/lib/forge-protected-session-mode.mjs /tmp/forge-protected-execution-smoke/forge-protected-session-mode.mjs \
    && ln -s /usr/local/lib/forge-protected-headless-runner.mjs /tmp/forge-protected-execution-smoke/forge-protected-headless-runner.mjs \
    && node --preserve-symlinks --input-type=module -e 'const {loadExecutionPolicy}=await import("/usr/local/lib/forge-execution-context.mjs");await import("/usr/local/lib/forge-prepare-headless-execution.mjs");await import("/usr/local/lib/forge-recover-headless-execution.mjs");const runner=await import("file:///tmp/forge-protected-execution-smoke/forge-protected-headless-runner.mjs");const policy=await loadExecutionPolicy("/usr/local/lib/forge-execution-policy.json");if(policy.policyMode!=="production"||policy.defaultActionCeiling!=="read-only"||policy.writerRoutes.length!==0||runner.name!=="forge-protected-headless-runner"||!Array.isArray(runner.inject)||typeof runner.apply!=="function")process.exit(1)' \
    && rm -rf /tmp/forge-protected-execution-smoke \
    && printf '%s\n' 'PASS image smoke: protected execution policy' \
    && node --check /usr/local/lib/forge-execution-capability-registry.mjs \
    && node --check /usr/local/lib/forge-capability-negotiator.mjs \
    && node --check /usr/local/lib/forge-execution-pack.mjs \
    && node --check /usr/local/lib/forge-execution-store.mjs \
    && node --check /usr/local/lib/forge-execution-orchestrator.mjs \
    && node --check /usr/local/lib/forge-progress-detector.mjs \
    && node --check /usr/local/lib/forge-change-contract.mjs \
    && node --check /usr/local/lib/forge-business-data-approval.mjs \
    && node --input-type=module -e 'await import("/usr/local/lib/forge-business-data-preview.mjs")' \
    && node --input-type=module -e 'const m=await import("/usr/local/lib/forge-business-data-consumption.mjs");if(typeof m.executeForgeBusinessDataConsumption!=="function"||typeof m.createFixedBusinessDataConsumer!=="function")process.exit(1)' \
    && node --check /usr/local/lib/forge-business-object-mutation.mjs \
    && node --check /usr/local/lib/forge-semantic-resource-lease.mjs \
    && node --check /usr/local/lib/forge-workflow-migration-safety.mjs \
    && node --check /usr/local/lib/forge-ui-edit-session.mjs \
    && node --check /usr/local/lib/forge-behavior-qualification.mjs \
    && node --check /usr/local/lib/forge-reference-adoption-coverage.mjs \
    && node --input-type=module -e 'import("/usr/local/lib/forge-execution-capability-registry.mjs").then(async ({loadCurrentExecutionCapabilityRegistry})=>{const registry=await loadCurrentExecutionCapabilityRegistry();if(registry.schemaVersion!==1||registry.capabilities.length!==11||registry.demandProfiles.length!==3||!registry.registryDigest.startsWith("sha256:"))process.exit(1)})' \
    && printf '%s\n' 'PASS image smoke: execution capability registry' \
    && node --check /usr/local/lib/forge-execution-state.mjs \
    && node --check /usr/local/lib/forge-obligation-ledger.mjs \
    && node --check /usr/local/lib/forge-model-qualification.mjs \
    && node --check /usr/local/lib/forge-acceptance-aggregator.mjs \
    && node --check /usr/local/lib/forge-protected-issuer-adapter.mjs \
    && node --check /usr/local/lib/forge-production-task-grant.mjs \
    && node --check /usr/local/lib/forge-protected-acceptance-service.mjs \
    && printf '%s\n' 'PASS image smoke: protected acceptance modules' \
    && node --check /usr/local/lib/forge-quality-capability-registry.mjs \
    && node --input-type=module -e 'import("/usr/local/lib/forge-quality-capability-registry.mjs").then(async ({loadCurrentForgeQualityCapabilityRegistry})=>{const registry=await loadCurrentForgeQualityCapabilityRegistry({skillCatalogPath:"/run/forge-image-build/skills.catalog.json"});if(registry.schemaVersion!==2||registry.coverage.total!==42||registry.coverage.statusCounts.enforced!==3||registry.blockingGaps.length!==39)process.exit(1)})' \
    && printf '%s\n' 'PASS image smoke: quality capability registry' \
    && node --check /usr/local/lib/forge-ui-contract.mjs \
    && node --check /usr/local/lib/forge-phase-budget-guard.mjs \
    && node --input-type=module -e 'await import("/usr/local/lib/forge-writer-scope-client.mjs"); await import("/usr/local/lib/forge-writer-scope-lease.mjs")' \
    && node --check /usr/local/bin/recover-forge-dead-writer.mjs \
    && node --check /usr/local/lib/forge-typed-file-removal.mjs \
    && node --check /usr/local/lib/verification-runner.mjs \
    && node --check /usr/local/lib/verification-cache-tool.mjs \
    && node --check /usr/local/lib/maven-verification-policy.mjs \
    && node --input-type=module -e 'await import("/usr/local/lib/forge-protected-acceptance-service.mjs")' \
    && sh -n /usr/local/bin/maven-verification-exec \
    && node --input-type=module -e 'const {readCacheCompatibilityImplementation}=await import("/usr/local/lib/verification-cache-tool.mjs");const files=await readCacheCompatibilityImplementation();const expected=["verification-cache-tool.mjs","verification-runner.mjs","verify-policy.mjs","maven-verification-policy.mjs","maven-verification-settings.xml","maven-verification-exec.sh"];if(JSON.stringify(files.map(x=>x.path))!==JSON.stringify(expected)||files.some(x=>!/^[0-9a-f]{64}$/.test(x.sha256)||!Number.isSafeInteger(x.bytes)||x.bytes<1))process.exit(1)' \
    && node --input-type=module -e 'const {readMavenVerificationPolicy}=await import("/usr/local/lib/maven-verification-policy.mjs");const policy=await readMavenVerificationPolicy();if(policy.descriptor.strictChecksums!==true||policy.descriptor.credentials!=="forbidden"||policy.descriptor.publicRepositoryMirror.mirrorOf.join(",")!=="central,aliyun,public"||policy.descriptor.snapshots!=="disabled-by-default"||policy.descriptor.runtime.jansiTmpdir!=="/tmp/forge-maven-jansi"||policy.descriptor.runtime.mavenOpts!=="-Djansi.tmpdir=/tmp/forge-maven-jansi")process.exit(1)' \
    && /usr/local/bin/forge-verify --help >/dev/null \
    && printf '%s\n' 'PASS image smoke: verification runtime' \
    && node /usr/local/lib/forge-agent-preset-policy.mjs verify \
      --root /opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh/config/agent-presets \
      > /usr/local/share/forge-image-build/agent-preset-policy.json \
    && install -d -m 0755 /run/forge-tool-worker /workspace \
    && ( node /usr/local/lib/forge-tool-worker-start.mjs --config /usr/local/share/forge-tool-worker.json & \
      tool_worker_pid=$!; \
      trap 'kill "$tool_worker_pid" 2>/dev/null || true; wait "$tool_worker_pid" 2>/dev/null || true' EXIT; \
      for tool_worker_attempt in 1 2 3 4 5 6 7 8 9 10; do \
        node /usr/local/lib/forge-tool-worker-start.mjs --health /run/forge-tool-worker/worker.sock >/dev/null 2>&1 && break; sleep 1; \
      done; \
      node /usr/local/lib/forge-tool-worker-start.mjs --health /run/forge-tool-worker/worker.sock \
      && FORGE_TOOL_WORKER_SOCKET=/run/forge-tool-worker/worker.sock \
      FORGE_AGENT_PRESET_PROMPT_RECEIPT=/usr/local/share/forge-image-build/agent-preset-prompt-contract.json \
      FORGE_CAPABILITY_INVENTORY_RECEIPT=/usr/local/share/forge-image-build/capability-inventory.json \
      DSH_HOME=/tmp/forge-prompt-probe-home \
      dsh web \
        --patch /usr/local/share/forge-governance-runtime.patch.yml \
        --patch /usr/local/share/forge-agent-preset-prompt-probe.patch.yml ) \
    && test -s /usr/local/share/forge-image-build/agent-preset-prompt-contract.json \
    && test -s /usr/local/share/forge-image-build/capability-inventory.json \
    && printf '%s\n' 'PASS image smoke: agent preset prompt contract' \
    && node /usr/local/lib/validate-runtime-dependencies.mjs --root /opt/forge-harness-runtime --smoke --json > /usr/local/share/forge-image-build/runtime-dependency-receipt.json \
    && node /usr/local/lib/document-extractor.mjs --check-dependencies \
    && node -e 'const root="/opt/forge-harness-runtime/node_modules";const expected=JSON.parse(process.argv[1]);for(const [name,version] of Object.entries(expected)){if(require(`${root}/${name}/package.json`).version!==version)process.exit(1)}' "{\"@deepseek-ai/dsh\":\"${DSH_VERSION}\",\"pdfjs-dist\":\"${PDFJS_DIST_VERSION}\",\"mammoth\":\"${MAMMOTH_VERSION}\",\"read-excel-file\":\"${READ_EXCEL_FILE_VERSION}\",\"yauzl\":\"${YAUZL_VERSION}\"}" \
    && node --input-type=module -e 'await import("/usr/local/lib/prototype-archive.mjs");await import("/usr/local/lib/prototype-directory-index.mjs")' \
    && node --check /usr/local/lib/conversation-output.js \
    && node --input-type=module -e 'await import("/usr/local/lib/harness-tcp-proxy.mjs");await import("/usr/local/lib/harness-upload-server.mjs");await import("/usr/local/lib/conversation-manager.mjs");const store=await import("/usr/local/lib/conversation-output-store.mjs");const projection=await import("/usr/local/lib/conversation-output-projection.mjs");const service=await import("/usr/local/lib/conversation-output-service.mjs");const history=await import("/usr/local/lib/forge-recover-headless-execution.mjs");if(typeof store.createConversationOutputStore!=="function"||typeof projection.projectConversationOutput!=="function"||typeof service.createConversationOutputService!=="function"||typeof history.readPinnedDshConversationHistory!=="function")process.exit(1)' \
    && printf '%s\n' 'PASS image smoke: conversation output consumers' \
    && /usr/local/bin/forge-prototype-index --help >/dev/null \
    && printf '%s\n' 'PASS image smoke: pinned runtime dependencies' \
    && node /usr/local/lib/validate-image-build-inputs.mjs \
      --mode image \
      --root / \
      --spec /usr/local/share/forge-image-build/image-build-inputs.json \
      --json > /usr/local/share/forge-image-build/receipt.json \
    && printf '%s\n' 'PASS image smoke: image input closure' \
    && chmod 0644 \
      /usr/local/share/forge-image-build/receipt.json \
      /usr/local/share/forge-image-build/agent-preset-policy.json \
      /usr/local/share/forge-image-build/agent-preset-prompt-contract.json \
      /usr/local/share/forge-image-build/runtime-dependency-receipt.json \
      /usr/local/share/forge-os-package-inventory.tsv

RUN rm -rf /opt/java /usr/share/maven /root/.m2 \
    && rm -f \
      /usr/bin/mvn \
      /usr/local/bin/mvn-entrypoint.sh \
      /usr/local/bin/pnpm \
      /usr/local/lib/node_modules/corepack/shims/pnpm \
      /usr/local/lib/node_modules/corepack/shims/pnpm.cmd \
      /usr/local/lib/node_modules/corepack/shims/pnpm.ps1 \
      /usr/local/lib/node_modules/corepack/shims/nodewin/pnpm \
      /usr/local/lib/node_modules/corepack/shims/nodewin/pnpm.cmd \
      /usr/local/lib/node_modules/corepack/shims/nodewin/pnpm.ps1 \
      /usr/local/lib/node_modules/corepack/dist/pnpm.js \
    && ! command -v java \
    && ! command -v javac \
    && ! command -v mvn \
    && ! command -v pnpm \
    && test ! -e /opt/forge-harness-runtime/node_modules/pnpm \
    && test ! -e /usr/local/share/dsh-skills \
    && test ! -e /usr/local/share/dsh-skills.catalog.json

FROM scratch AS harness-core

ARG HARNESS_NODE_BASE_IMAGE
ARG HARNESS_MAVEN_BASE_IMAGE
ARG DSH_VERSION
ARG HARNESS_IMAGE_REVISION
ARG HARNESS_SKILL_BUNDLE_VERSION
ARG HARNESS_RUNTIME_PROFILE

COPY --from=runtime-root / /

LABEL org.opencontainers.image.title="Forge Delivery DeepSeek Harness"
LABEL org.opencontainers.image.description="Pinned DeepSeek Harness core with external Skills and host verification"
LABEL org.opencontainers.image.source="https://github.com/deepseek-ai/deepseek-harness"
LABEL org.opencontainers.image.version="${DSH_VERSION}"
LABEL org.opencontainers.image.revision="${HARNESS_IMAGE_REVISION}"
LABEL io.forge.tool-worker="v1"
LABEL com.forge-delivery.harness-skill-bundle="${HARNESS_SKILL_BUNDLE_VERSION}"
LABEL com.forge-delivery.harness-runtime-profile="${HARNESS_RUNTIME_PROFILE}"
LABEL com.forge-delivery.harness-node-base-manifest="${HARNESS_NODE_BASE_IMAGE}"
LABEL com.forge-delivery.harness-maven-base-manifest="${HARNESS_MAVEN_BASE_IMAGE}"

ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_PATH=/opt/forge-harness-runtime/node_modules \
    LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8 \
    HOME=/home/node \
    DSH_HOME=/home/node/.dsh \
    DSH_BUNDLED_SKILL_DIR=/opt/forge-skill-bundles/current/skills \
    DSH_TELEMETRY_DISABLED=1 \
    FORGE_HARNESS_SKILL_BUNDLE_VERSION=${HARNESS_SKILL_BUNDLE_VERSION} \
    HARNESS_DOCUMENT_INPUT_ROOT=/project-inputs \
    HARNESS_DOCUMENT_MAX_OUTPUT_BYTES=1048576 \
    HARNESS_DOCUMENT_MAX_PDF_PAGES=200 \
    HARNESS_DOCUMENT_MAX_SOURCE_BYTES=26214400 \
    HARNESS_DOCUMENT_MAX_SPREADSHEET_COLUMNS=100 \
    HARNESS_DOCUMENT_MAX_SPREADSHEET_ROWS=2000 \
    HARNESS_PROTOTYPE_MAX_ARCHIVE_BYTES=52428800 \
    HARNESS_PROTOTYPE_MAX_COMPRESSION_RATIO=100 \
    HARNESS_PROTOTYPE_MAX_DEPTH=24 \
    HARNESS_PROTOTYPE_MAX_ENTRIES=5000 \
    HARNESS_PROTOTYPE_MAX_FILE_BYTES=16777216 \
    HARNESS_PROTOTYPE_MAX_HTML_ANALYSIS_BYTES=4194304 \
    HARNESS_PROTOTYPE_MAX_PAGES=200 \
    HARNESS_PROTOTYPE_MAX_PATH_BYTES=1024 \
    HARNESS_PROTOTYPE_MAX_SUMMARY_BYTES=2097152 \
    HARNESS_PROTOTYPE_MAX_UNCOMPRESSED_BYTES=268435456 \
    HARNESS_HISTORY_PAGE_MESSAGES=5 \
    HARNESS_PRIVILEGED_API_MODE=loopback-only

WORKDIR /workspace
USER 1000:1000
ENTRYPOINT []

# DSH remains on container loopback. A small HTTP/WebSocket compatibility proxy
# exposes it to Docker on the exact host VPN IP.
CMD ["/usr/local/bin/start-harness"]
