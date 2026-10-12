{
  "schemaVersion": 1,
  "serviceType": "forge-protected-acceptance-service/v1",
  "projectSlug": "__PROJECT_SLUG__",
  "policyId": "__PROJECT_SLUG__-protected-acceptance",
  "stateRoot": "/var/lib/forge-acceptance",
  "contractTtlSeconds": 900,
  "allowedVerificationProfiles": [
    "governance",
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
  "conversationTaskPreparation": true,
  "roleDecisionTaskIds": [],
  "sourceProvenancePolicies": [],
  "workflowInventoryPolicies": [],
  "conversationSemanticResourceScopes": [],
  "conversationWriterScopes": [
    { "taskProfile": "project-files", "scopeRoot": "current-project", "ownedPaths": [] },
    { "taskProfile": "frontend-admin", "ownedPaths": ["forge-admin-ui/jsconfig.json", "forge-admin-ui/package.json", "forge-admin-ui/pnpm-lock.yaml", "forge-admin-ui/src"] },
    { "taskProfile": "backend", "ownedPaths": ["docker-forge-admin/Dockerfile.admin", "forge-server/forge-business/forge-business-core/src"] },
    { "taskProfile": "migration", "ownedPaths": ["forge-server/db/migration"] },
    { "taskProfile": "shared-owner", "ownedPaths": ["forge-h5-ui/src"] }
  ],
  "trustWindow": { "issuedAt": "__TRUST_ISSUED_AT__", "expiresAt": "__TRUST_EXPIRES_AT__" },
  "keys": {
    "platform": { "keyId": "__PROJECT_SLUG__-platform-v1" },
    "governance": { "keyId": "__PROJECT_SLUG__-governance-v1", "subjectId": "forge-governance-engine" },
    "verification": { "keyId": "__PROJECT_SLUG__-verification-v1", "subjectId": "forge-verification-runner" },
    "semanticReview": { "keyId": "__PROJECT_SLUG__-semantic-v1", "subjectId": "forge-independent-review" },
    "verdict": { "keyId": "__PROJECT_SLUG__-verdict-v1" }
  }
}
