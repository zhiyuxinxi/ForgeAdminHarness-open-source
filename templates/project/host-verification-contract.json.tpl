{
  "schemaVersion": 2,
  "executionMode": "host-toolchain",
  "processIsolation": "bubblewrap",
  "independentReview": "api-error-and-auth-contract",
  "projectSlug": "__PROJECT_SLUG__",
  "runnerRevision": "forge-host-runner-__FORGE_HOST_RUNNER_BUNDLE_VERSION__",
  "profileCatalogVersion": "__FORGE_PHASE_PROFILE_CATALOG_VERSION__",
  "taskspacesRoot": "__DELIVERY_ROOT__/projects/__PROJECT_SLUG__/taskspaces",
  "stateRoot": "__DELIVERY_ROOT__/projects/__PROJECT_SLUG__/verification/host-state",
  "dependencySeed": null,
  "preparedDependencies": null,
  "toolchains": {
    "java": "__HOST_JAVA_PATH__",
    "javaHome": "__HOST_JAVA_HOME__",
    "maven": "__HOST_MAVEN_PATH__",
    "node": "__HOST_NODE_PATH__",
    "pnpm": "__HOST_PNPM_PATH__",
    "git": "__HOST_GIT_PATH__",
    "forgeGovernance": "__HOST_FORGE_GOVERNANCE_PATH__"
  },
  "profiles": [
    "governance",
    "backend-red-test",
    "frontend-red-test",
    "backend-module-compile",
    "backend-module-test",
    "backend-test-class",
    "frontend-admin-lint",
    "frontend-admin-test",
    "frontend-admin-typecheck",
    "frontend-admin-build",
    "frontend-h5-test",
    "frontend-h5-build",
    "changed-safe",
    "full-regression"
  ],
  "limits": {
    "maxFiles": 250000,
    "maxBytes": 4294967296,
    "maxLogBytes": 8388608,
    "defaultTimeoutSeconds": 900,
    "maxConcurrent": 2
  }
}
