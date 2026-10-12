{
  "schemaVersion": 1,
  "projectSlug": "__PROJECT_SLUG__",
  "runnerRevision": "__HARNESS_IMAGE_REVISION__",
  "toolchainImage": "__HARNESS_IMAGE__",
  "cacheRoot": "__DELIVERY_ROOT__/projects/__PROJECT_SLUG__/verification/cache-packs/images/__HARNESS_IMAGE_ID__",
  "stateRoot": "__DELIVERY_ROOT__/projects/__PROJECT_SLUG__/verification/state",
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
    "defaultTimeoutSeconds": 900
  }
}
