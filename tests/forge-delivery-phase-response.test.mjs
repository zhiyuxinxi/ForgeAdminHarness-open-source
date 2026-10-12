import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  beginForgeDeliveryPhase,
  completeForgeDeliveryPhase,
  createForgeDeliveryPhaseArtifact,
  createForgeDeliveryPhaseState,
} from '../docker/harness/forge-delivery-phase-runtime.mjs';
import {
  FORGE_DELIVERY_PHASE_PROPOSAL_SCHEMA,
  FORGE_DELIVERY_PHASE_RESPONSE_END,
  FORGE_DELIVERY_PHASE_RESPONSE_START,
  buildForgeDeliveryPhasePrompt,
  createForgeDeliveryPhaseArtifactFromProposal,
  extractForgeDeliveryPhaseHumanResponse,
  parseForgeDeliveryPhaseProposal,
} from '../docker/harness/forge-delivery-phase-response.mjs';

const catalog = JSON.parse(await readFile(new URL(
  '../docker/harness/skills/forge-task-router/references/phase-profiles.json',
  import.meta.url,
), 'utf8'));
const sha = (character) => character.repeat(64);
const digest = (value) => createHash('sha256').update(value).digest('hex');

function state() {
  return createForgeDeliveryPhaseState({
    catalog,
    workflowId: 'crud-production',
    caseFamily: 'crud-complete',
    taskId: 'eval-crud-complete',
    sessionId: 'session-phased-crud',
    sourceCommit: '6eb2881e6f6af85a5348acf3da63cef53a873b0e',
    now: '2026-09-03T00:00:00.000Z',
  });
}

function payload(phase, changedPaths = []) {
  return Object.fromEntries(phase.requiredPayloadKeys.map((key) => [key, key === 'changedPaths' ? changedPaths : []]));
}

function acceptPhase(current, phase, executionGeneration, payloadOverrides = {}) {
  const started = beginForgeDeliveryPhase({
    state: current,
    catalog,
    phaseId: phase.id,
    rpcId: `rpc-${phase.id}`,
    promptDigest: sha(String(executionGeneration)),
    executionGeneration,
    now: `2026-09-03T00:0${executionGeneration}:00.000Z`,
  });
  const changedPaths = phase.patchScope === 'phase'
    ? [`${phase.ownedPaths[0]}/phase-${phase.id}.txt`]
    : [];
  const sourceFingerprint = digest(`cumulative-patch-${executionGeneration}`);
  const patchDigest = phase.patchScope === 'none'
    ? null
    : phase.patchScope === 'cumulative' ? sourceFingerprint : digest(`phase-patch-${executionGeneration}`);
  const artifact = createForgeDeliveryPhaseArtifact({
    state: started,
    catalog,
    phaseId: phase.id,
    attemptId: started.activeAttempt.attemptId,
    sourceFingerprint,
    changedPaths,
    patchDigest,
    payload: {
      ...payload(phase, changedPaths),
      ...payloadOverrides,
    },
  });
  const accepted = completeForgeDeliveryPhase({
    state: started,
    catalog,
    decision: 'accepted',
    artifact,
    hostReceipts: phase.hostVerificationProfiles.map((profile, profileIndex) => ({
      profile,
      status: 'passed',
      receiptDigest: digest(`host-${executionGeneration}-${profileIndex}-${profile}`),
      patchDigest: sourceFingerprint,
    })),
    now: `2026-09-03T00:0${executionGeneration}:30.000Z`,
  });
  return { state: accepted.state, artifact };
}

// Synthetic prompt-generation input only; loader and Controller integration validate real files elsewhere.
function promptRuntimeEvidence(current, acceptedArtifacts) {
  const acceptedA7 = acceptedArtifacts.at(-1);
  const runtimeCommit = '745782f4d26b933406f00a0cb841df916defae5d';
  return {
    manifestSha256: sha('a'),
    subject: {
      workflowId: current.workflowId,
      taskId: current.taskId,
      catalogVersion: current.catalogVersion,
      catalogDigest: current.catalogDigest,
      stateDigest: current.stateDigest,
      baseSourceCommit: current.sourceCommit,
      cumulativePatchSha256: acceptedA7.sourceFingerprint,
    },
    runtimeSource: {
      commit: runtimeCommit,
      tree: '7'.repeat(40),
      workspaceFingerprint: sha('b'),
    },
    evidence: {
      deployment: {
        schemaVersion: 1,
        releaseState: { commit: runtimeCommit, status: 'success' },
        checks: ['healthy'],
      },
      api: { schemaVersion: 1, sourceCommit: runtimeCommit, checks: 31, failures: [] },
      browser: { schemaVersion: 1, sourceCommit: runtimeCommit, checks: 14, unknown: [] },
      database: { schemaVersion: 1, sourceCommit: runtimeCommit, checks: 8, failures: [] },
    },
    sourceLineage: {
      baseCommit: current.sourceCommit,
      runtimeCommit,
      runtimeTree: '7'.repeat(40),
      materializedTree: '7'.repeat(40),
      acceptedPatch: { path: 'accepted.patch', sha256: acceptedA7.sourceFingerprint },
      repairs: [],
    },
  };
}

test('requirements prompt exposes only the current phase Skill and mutation closure', () => {
  const prompt = buildForgeDeliveryPhasePrompt({
    state: state(),
    catalog,
    originalRequest: 'Implement employee CRUD.',
  });
  assert.match(prompt, /"phaseId": "requirements"/u);
  assert.match(prompt, /"sourceCommit": "6eb2881e6f6af85a5348acf3da63cef53a873b0e"/u);
  assert.match(prompt, new RegExp(`"catalogVersion": "${catalog.catalogVersion}"`, 'u'));
  assert.match(prompt, new RegExp(`"catalogDigest": "${state().catalogDigest}"`, 'u'));
  assert.match(prompt, /"forge-requirement-coverage"/u);
  assert.doesNotMatch(prompt, /"forge-database-migration"/u);
  assert.match(prompt, /This phase is read-only/u);
  assert.match(prompt, /unresolvedDecisions is a JSON array of unique non-empty strings, never objects/u);
});

test('requirements prompt keeps user-facing output direct and defers later implementation choices', () => {
  const prompt = buildForgeDeliveryPhasePrompt({
    state: state(),
    catalog,
    originalRequest: '实现供应商档案；literal endpoint 与权限码由 domain/API 阶段确定。',
  });
  const originalRequestIndex = prompt.indexOf('ORIGINAL REQUEST:');
  const authorityIndex = prompt.indexOf('CURRENT PHASE AUTHORITY (machine-owned):');
  const upstreamIndex = prompt.indexOf('ACCEPTED UPSTREAM PAYLOADS (digest-bound):');
  const humanResponseIndex = prompt.indexOf('HUMAN-FACING RESPONSE:');
  const artifactFormatIndex = prompt.indexOf('Your final answer must contain exactly one artifact block');

  assert.ok(originalRequestIndex < authorityIndex);
  assert.ok(authorityIndex < upstreamIndex);
  assert.ok(upstreamIndex < humanResponseIndex);
  assert.ok(humanResponseIndex < artifactFormatIndex);
  assert.match(prompt, /Start the final response directly with the concrete business result/u);
  assert.match(prompt, /Every word before the machine artifact is visible to the user/u);
  assert.match(prompt, /Do not add a technical preface, reasoning summary, or a label such as "Human-facing answer:"/u);
  assert.match(prompt, /technical delivery checklist, satisfy it in the machine artifact/u);
  assert.match(prompt, /Do not hide, omit, or soften unverified facts or limitations/u);
  assert.match(prompt, /in the machine artifact, express the permission matrix/u);
  assert.match(prompt, /exact business role keys × business operations × data scope/u);
  assert.match(prompt, /Do not pre-decide permission codes, unspecified endpoint prefixes, schemas, or seed constants/u);
  assert.match(prompt, /dataOwnership describes business ownership and scope/u);
  assert.match(prompt, /do not introduce a seed tenant constant/u);
});

test('dictionary-consuming field type stays distinct in the generated machine prompt', async () => {
  const originalRequest = await readFile(new URL(
    './fixtures/forge-harness-behavior-evals/prompts/crud-complete.v1.md',
    import.meta.url,
  ), 'utf8');
  const requirements = catalog.workflows[0].phases[0];
  const requirementsPrompt = buildForgeDeliveryPhasePrompt({
    state: state(), catalog, originalRequest,
  });

  assert.ok(requirementsPrompt.includes(`ORIGINAL REQUEST:\n${originalRequest.trimEnd()}\n`));
  assert.match(requirementsPrompt, /When a business field consumes a dictionary, the business field's own value\/wire type and the dictionary type\/code\/value\/label types are distinct contract facts/u);
  assert.match(requirementsPrompt, /If ORIGINAL REQUEST fixes both, preserve each explicitly in the machine payload; saying only that the field reuses a string-valued dictionary does not establish the business field's type/u);
  assert.match(requirementsPrompt, /Human-facing simplification and display-name rules apply only to prose outside the artifact block/u);
  assert.match(requirementsPrompt, /Explain a particular technical implementation in the normal answer only when ORIGINAL REQUEST explicitly asks about it/u);

  const accepted = acceptPhase(state(), requirements, 1, {
    businessRules: [{ field: 'status', rule: 'upstream-field-type-marker' }],
  });
  const domainPrompt = buildForgeDeliveryPhasePrompt({
    state: accepted.state,
    catalog,
    originalRequest,
    upstreamArtifacts: [accepted.artifact],
  });
  const upstreamPayloads = JSON.parse(domainPrompt
    .split('ACCEPTED UPSTREAM PAYLOADS (digest-bound):\n')[1]
    .split('\n\nHUMAN-FACING RESPONSE:')[0]);
  assert.deepEqual(upstreamPayloads[accepted.artifact.artifactKind], accepted.artifact.payload);
  assert.ok(domainPrompt.includes(`ORIGINAL REQUEST:\n${originalRequest.trimEnd()}\n`));
});

test('proposal parser requires one exact phase block and exact payload keys', () => {
  const phase = catalog.workflows[0].phases[0];
  const proposal = {
    schemaVersion: FORGE_DELIVERY_PHASE_PROPOSAL_SCHEMA,
    phaseId: phase.id,
    unresolvedDecisions: [],
    payload: payload(phase),
  };
  const block = `${FORGE_DELIVERY_PHASE_RESPONSE_START}${JSON.stringify(proposal)}${FORGE_DELIVERY_PHASE_RESPONSE_END}`;
  assert.deepEqual(parseForgeDeliveryPhaseProposal({ text: block, phase }), proposal);
  assert.throws(() => parseForgeDeliveryPhaseProposal({ text: `${block}${block}`, phase }), /exactly one/u);
  assert.throws(() => parseForgeDeliveryPhaseProposal({
    text: `${FORGE_DELIVERY_PHASE_RESPONSE_START}${JSON.stringify({ ...proposal, extra: true })}${FORGE_DELIVERY_PHASE_RESPONSE_END}`,
    phase,
  }), /reviewed schema/u);
  assert.throws(() => parseForgeDeliveryPhaseProposal({
    text: `${FORGE_DELIVERY_PHASE_RESPONSE_START}${JSON.stringify({
      ...proposal,
      unresolvedDecisions: [{ id: 'DEC-1', question: 'Choose a dictionary owner.' }],
    })}${FORGE_DELIVERY_PHASE_RESPONSE_END}`,
    phase,
  }), /unresolved decisions are invalid/u);
});

test('proposal parser marks only single-block JSON syntax failures as format-retryable', () => {
  const phase = catalog.workflows[0].phases[0];
  const proposal = {
    schemaVersion: FORGE_DELIVERY_PHASE_PROPOSAL_SCHEMA,
    phaseId: phase.id,
    unresolvedDecisions: [],
    payload: payload(phase),
  };
  const block = (raw) => `${FORGE_DELIVERY_PHASE_RESPONSE_START}${raw}${FORGE_DELIVERY_PHASE_RESPONSE_END}`;
  const malformed = block('{"phaseId":"domain-contract","unresolvedDecisions":["approve"],');
  assert.throws(() => parseForgeDeliveryPhaseProposal({ text: malformed, phase }), (error) => {
    assert.equal(error.code, 'PHASE_RESPONSE_INVALID');
    assert.deepEqual(error.payloadShapeIssue, { kind: 'invalid-proposal-json' });
    assert.equal(error.phaseProposal, undefined);
    return true;
  });
  for (const text of ['No artifact block', `${malformed}${malformed}`]) {
    assert.throws(() => parseForgeDeliveryPhaseProposal({ text, phase }), (error) => {
      assert.equal(error.code, 'PHASE_RESPONSE_INVALID');
      assert.equal(error.payloadShapeIssue, undefined);
      assert.equal(error.phaseProposal, undefined);
      return true;
    });
  }
  for (const invalid of [
    { ...proposal, phaseId: 'domain-contract' },
    { ...proposal, payload: { actors: [] } },
    { ...proposal, schemaVersion: 'unreviewed/v2' },
  ]) {
    assert.throws(() => parseForgeDeliveryPhaseProposal({ text: block(JSON.stringify(invalid)), phase }), (error) => {
      assert.equal(error.code, 'PHASE_RESPONSE_INVALID');
      assert.equal(error.payloadShapeIssue, undefined);
      return true;
    });
  }
});

test('only otherwise valid payloads with extra keys expose a bounded format-correction reason', () => {
  const phase = catalog.workflows[0].phases.find((entry) => entry.id === 'database');
  const proposal = {
    schemaVersion: FORGE_DELIVERY_PHASE_PROPOSAL_SCHEMA,
    phaseId: phase.id,
    unresolvedDecisions: [],
    payload: { ...payload(phase), verificationStatus: { executed: false } },
  };
  const response = (value) => `${FORGE_DELIVERY_PHASE_RESPONSE_START}${JSON.stringify(value)}${FORGE_DELIVERY_PHASE_RESPONSE_END}`;
  const original = JSON.stringify(proposal);
  assert.throws(() => parseForgeDeliveryPhaseProposal({ text: response(proposal), phase }), (error) => {
    assert.equal(error.code, 'PHASE_RESPONSE_INVALID');
    assert.deepEqual(error.payloadShapeIssue, {
      kind: 'unexpected-payload-keys',
      unexpectedKeys: ['verificationStatus'],
      requiredPayloadKeys: phase.requiredPayloadKeys,
    });
    assert.deepEqual(error.phaseProposal, proposal);
    return true;
  });
  assert.equal(JSON.stringify(proposal), original);
  const missingRequired = { ...proposal.payload };
  delete missingRequired.migrationTest;
  for (const invalid of [
    { ...proposal, payload: missingRequired },
    { ...proposal, payload: [] },
    { ...proposal, phaseId: 'backend' },
    { ...proposal, schemaVersion: 'unreviewed/v2' },
    { ...proposal, unresolvedDecisions: [{}] },
    { ...proposal, extra: true },
  ]) {
    assert.throws(() => parseForgeDeliveryPhaseProposal({ text: response(invalid), phase }), (error) => {
      assert.equal(error.code, 'PHASE_RESPONSE_INVALID');
      assert.equal(error.payloadShapeIssue, undefined);
      return true;
    });
  }
  const corrected = {
    ...proposal,
    payload: { ...payload(phase), migrationTest: { verificationStatus: { executed: false } } },
  };
  assert.deepEqual(parseForgeDeliveryPhaseProposal({ text: response(corrected), phase }), corrected);
});

test('all eight prompts require a concise phase-specific business response while preserving the machine block', () => {
  const originalRequest = '供应商字段 supplierCode、supplierName、contactName、contactEmail、qualificationLevel、status；角色关联条件 role_status=1 AND del_flag=0；本业务仅逻辑删除。';
  const focusMarkers = {
    requirements: 'who will use the capability, what business tasks they need to complete',
    'domain-contract': 'business records or concepts involved, the actions people take on them',
    database: 'how business data will be saved, how duplicates are prevented',
    'ui-design': 'where users enter the capability, what they see',
    backend: 'how each business operation is handled',
    frontend: 'how the page presents business information',
    'access-wiring': 'which kinds of users can see the capability',
    'cross-layer-acceptance': 'business outcomes actually verified',
  };
  let current = state();
  const artifacts = [];
  for (const phase of catalog.workflows[0].phases) {
    const upstreamArtifacts = artifacts.filter(
      (artifact) => phase.requiresArtifacts.includes(artifact.artifactKind),
    );
    const prompt = buildForgeDeliveryPhasePrompt({
      state: current,
      catalog,
      originalRequest,
      upstreamArtifacts,
      ...(phase.id === 'cross-layer-acceptance'
        ? { runtimeEvidence: promptRuntimeEvidence(current, upstreamArtifacts) }
        : {}),
    });
    assert.match(prompt, /same primary language as ORIGINAL REQUEST/u);
    assert.match(prompt, /payload must contain exactly the requiredPayloadKeys shown above, with no additional keys/u);
    assert.match(prompt, /Keep verification details inside the relevant existing payload field; do not add a separate verificationStatus field/u);
    assert.match(prompt, /1 to 3 short paragraphs/u);
    assert.match(prompt, /business people who need only a description of business functionality/u);
    assert.match(prompt, /business fields by their user-facing display names in the primary language/u);
    assert.match(prompt, /use the Chinese display name for a Chinese request/u);
    assert.match(prompt, /Human-facing simplification and display-name rules apply only to prose outside the artifact block/u);
    assert.match(prompt, /must not remove, translate, or rename machine-contract facts in the payload/u);
    assert.match(prompt, /In the current phase payload, preserve exact field identifiers, fixed values and types, HTTP methods and fixed path fragments, business role keys, operations, data scopes, and precise binding conditions/u);
    assert.match(prompt, /when ORIGINAL REQUEST fixes them or this phase defines them for an actual downstream consumer/u);
    assert.match(prompt, /Display names may accompany machine identifiers but cannot replace them/u);
    assert.match(prompt, /Do not copy unrelated history into every phase/u);
    assert.match(prompt, /Do not generalize constraints fixed by ORIGINAL REQUEST or add exceptions it did not authorize/u);
    assert.match(prompt, /Keep the human-facing prose and machine artifact consistent about the same business facts/u);
    assert.ok(prompt.includes(originalRequest));
    assert.match(prompt, /Do not reproduce the implementation checklist item by item/u);
    assert.match(prompt, /internal variable names, table fields, frameworks, methods, permission codes, API paths, phase IDs, or Host Runner/u);
    assert.match(prompt, /complete technical detail in the machine artifact/u);
    assert.match(prompt, /only when ORIGINAL REQUEST explicitly asks about it and it is relevant/u);
    assert.match(prompt, /Implementation requirements and a required technical delivery checklist are not a request for technical explanations in the user-facing prose/u);
    assert.match(prompt, /Retain conditions that change the business outcome/u);
    assert.match(prompt, /when uniqueness applies only to active records, explain "同一业务范围内的有效档案中，该编号不能重复"/u);
    assert.match(prompt, /only a conditional wording illustration, not a required sentence or a claim/u);
    assert.match(prompt, /platform runs Host Runner verification and the Controller decides whether the workflow advances/u);
    assert.match(prompt, /platform process control, not a request for the user to manually approve every phase/u);
    assert.match(prompt, /next business stage and its passing condition/u);
    assert.match(prompt, /Do not ask for routine manual approval or claim that verification or advancement has already happened/u);
    assert.match(prompt, /Ask a question only when unresolvedDecisions contains a real business choice/u);
    assert.match(prompt, /candidate is not accepted, deployed, live, or user-approved/u);
    assert.match(prompt, new RegExp(focusMarkers[phase.id], 'u'));
    if (phase.id === 'cross-layer-acceptance') {
      assert.match(prompt, /PRIOR ACCEPTED PHASE EVIDENCE \(Controller-bound\):/u);
    } else {
      assert.doesNotMatch(prompt, /PRIOR ACCEPTED PHASE EVIDENCE \(Controller-bound\):/u);
    }
    if (phase.id === 'requirements') {
      assert.match(prompt, /exact business role keys × business operations × data scope/u);
      assert.match(prompt, /Preserve API methods and relative path fragments already fixed by ORIGINAL REQUEST verbatim in this payload/u);
    } else {
      assert.doesNotMatch(prompt, /Requirements boundary:/u);
    }
    if (phase.id === 'domain-contract') {
      assert.match(prompt, /distinguish persistence\/entity types from HTTP\/JSON\/TypeScript wire types/u);
      assert.match(prompt, /exact parameter locations and request\/response shapes, including body encoding/u);
      assert.match(prompt, /Inspect the adjacent Controller and frontend adapter together/u);
      assert.match(prompt, /For each actual endpoint response DTO\/VO, specify its repository-relative owner path, complete returned fields, and each field's HTTP\/JSON\/TypeScript wire type in that endpoint's existing response shape/u);
      assert.match(prompt, /Where entity-to-VO conversion is needed, identify the responsible existing owner/u);
      assert.match(prompt, /A void\/no-body response requires no invented VO fields/u);
      assert.match(prompt, /inspect the existing seed owner and lookup visibility before choosing a tenant scope or constant/u);
      assert.match(prompt, /For each new and reused dictionary, record in the existing dictionaries payload how its values become visible to the required business tenants/u);
      assert.match(prompt, /the responsible implementation phase, and the later check that will prove visibility/u);
      assert.match(prompt, /how the target business tenants are selected through existing project setup/u);
      assert.match(prompt, /A later check verifies the provisioning plan; it cannot replace that plan/u);
    } else {
      assert.doesNotMatch(prompt, /Domain contract precision:/u);
      assert.doesNotMatch(prompt, /For each actual endpoint response DTO\/VO/u);
    }
    assert.equal((prompt.match(/<forge-phase-artifact>/gu) ?? []).length, 1);
    assert.equal((prompt.match(/<\/forge-phase-artifact>/gu) ?? []).length, 1);

    const proposal = {
      schemaVersion: FORGE_DELIVERY_PHASE_PROPOSAL_SCHEMA,
      phaseId: phase.id,
      unresolvedDecisions: [],
      payload: payload(phase, phase.sourceMutation ? [`${phase.ownedPaths[0]}/phase-${phase.id}.txt`] : []),
    };
    const response = `已说明当前阶段的业务结果和实际下一步。\n\n${FORGE_DELIVERY_PHASE_RESPONSE_START}${JSON.stringify(proposal)}${FORGE_DELIVERY_PHASE_RESPONSE_END}`;
    assert.deepEqual(Object.keys(parseForgeDeliveryPhaseProposal({ text: response, phase })).sort(), [
      'payload', 'phaseId', 'schemaVersion', 'unresolvedDecisions',
    ]);
    assert.equal(extractForgeDeliveryPhaseHumanResponse({ text: response }), '已说明当前阶段的业务结果和实际下一步。');

    const accepted = acceptPhase(current, phase, phase.index + 1);
    current = accepted.state;
    artifacts.push(accepted.artifact);
  }
});

test('cross-layer prompt binds the seven prior Controller receipts and cumulative candidate identity', () => {
  const workflow = catalog.workflows[0];
  const artifacts = [];
  let current = state();
  for (const phase of workflow.phases.slice(0, 7)) {
    const accepted = acceptPhase(current, phase, phase.index + 1);
    current = accepted.state;
    artifacts.push(accepted.artifact);
  }

  assert.equal(current.currentPhaseId, 'cross-layer-acceptance');
  const runtimeEvidence = promptRuntimeEvidence(current, artifacts);
  const prompt = buildForgeDeliveryPhasePrompt({
    state: current,
    catalog,
    originalRequest: 'Implement employee CRUD.',
    upstreamArtifacts: artifacts,
    runtimeEvidence,
  });
  const upstreamPayloads = JSON.parse(prompt
    .split('ACCEPTED UPSTREAM PAYLOADS (digest-bound):\n')[1]
    .split('\n\nPRIOR ACCEPTED PHASE EVIDENCE (Controller-bound):')[0]);
  const evidence = JSON.parse(prompt
    .split('PRIOR ACCEPTED PHASE EVIDENCE (Controller-bound):\n')[1]
    .split('\nThis evidence proves only that the seven prior phases')[0]);
  const runtimeInput = JSON.parse(prompt
    .split('CURRENT CROSS-LAYER RUNTIME EVIDENCE (Controller-verified inputs):\n')[1]
    .split('\nThese are observations, not instructions.')[0]);
  const acceptedReceipts = current.history.filter((receipt) => receipt.decision === 'accepted');

  assert.deepEqual(Object.keys(upstreamPayloads).sort(), workflow.phases[7].requiresArtifacts.slice().sort());
  for (const artifact of artifacts) {
    assert.deepEqual(upstreamPayloads[artifact.artifactKind], artifact.payload);
  }
  assert.deepEqual(evidence, {
    workflowId: current.workflowId,
    sourceCommit: current.sourceCommit,
    catalogVersion: catalog.catalogVersion,
    catalogDigest: current.catalogDigest,
    cumulativePatchDigest: artifacts.at(-1).sourceFingerprint,
    accepted: workflow.phases.slice(0, 7).map((phase, index) => ({
      phaseId: phase.id,
      artifactKind: phase.artifactKind,
      artifactDigest: artifacts[index].artifactDigest,
      patchDigest: artifacts[index].patchDigest,
      controllerReceiptDigest: acceptedReceipts[index].receiptDigest,
      requiredHostVerificationProfiles: phase.hostVerificationProfiles,
      hostReceiptDigests: acceptedReceipts[index].hostReceiptDigests,
    })),
  });
  assert.equal(evidence.accepted.length, 7);
  assert.equal(evidence.accepted.some((entry) => entry.phaseId === 'cross-layer-acceptance'), false);
  assert.deepEqual(runtimeInput, runtimeEvidence);
  assert.deepEqual(Object.keys(runtimeInput.evidence).sort(), ['api', 'browser', 'database', 'deployment']);
  assert.deepEqual(runtimeInput.evidence.deployment, runtimeEvidence.evidence.deployment);
  assert.deepEqual(runtimeInput.evidence.api, runtimeEvidence.evidence.api);
  assert.deepEqual(runtimeInput.evidence.browser, runtimeEvidence.evidence.browser);
  assert.deepEqual(runtimeInput.evidence.database, runtimeEvidence.evidence.database);
  assert.match(prompt, /Set payload\.runtimeEvidenceDigest to exactly the manifestSha256 above/u);
  assert.match(prompt, new RegExp(`"manifestSha256": "${runtimeEvidence.manifestSha256}"`, 'u'));
  assert.match(prompt, /Current governance, changed-safe, and full-regression checks run after this model response and remain pending/u);
  assert.match(prompt, /Do not claim final acceptance, workflow completion, release readiness, deployment, or passed current-phase Host checks/u);
  assert.match(prompt, /If no separate human or AI review evidence is present, state that independent review evidence was not provided/u);
  assert.match(prompt, /this model response is not independent review evidence/u);

  assert.throws(() => buildForgeDeliveryPhasePrompt({
    state: current,
    catalog,
    originalRequest: 'Implement employee CRUD.',
    upstreamArtifacts: artifacts,
  }), /runtime evidence is missing or bound to another candidate/ui);
  for (const invalidRuntimeEvidence of [
    { ...runtimeEvidence, subject: { ...runtimeEvidence.subject, stateDigest: sha('0') } },
    { ...runtimeEvidence, subject: { ...runtimeEvidence.subject, baseSourceCommit: '1'.repeat(40) } },
    { ...runtimeEvidence, subject: { ...runtimeEvidence.subject, cumulativePatchSha256: sha('0') } },
  ]) {
    assert.throws(() => buildForgeDeliveryPhasePrompt({
      state: current,
      catalog,
      originalRequest: 'Implement employee CRUD.',
      upstreamArtifacts: artifacts,
      runtimeEvidence: invalidRuntimeEvidence,
    }), /runtime evidence is missing or bound to another candidate/ui);
  }

  assert.throws(() => buildForgeDeliveryPhasePrompt({
    state: current,
    catalog,
    originalRequest: 'Implement employee CRUD.',
    upstreamArtifacts: artifacts.slice(0, -1),
    runtimeEvidence,
  }), /Upstream artifact set does not match/u);
  const staleArtifacts = [...artifacts];
  staleArtifacts[0] = acceptPhase(state(), workflow.phases[0], 1, { actors: ['different'] }).artifact;
  assert.throws(() => buildForgeDeliveryPhasePrompt({
    state: current,
    catalog,
    originalRequest: 'Implement employee CRUD.',
    upstreamArtifacts: staleArtifacts,
    runtimeEvidence,
  }), /stale/u);
});

test('human response extraction is conservative for legacy artifact-only responses', () => {
  const phase = catalog.workflows[0].phases[0];
  const block = `${FORGE_DELIVERY_PHASE_RESPONSE_START}${JSON.stringify({
    schemaVersion: FORGE_DELIVERY_PHASE_PROPOSAL_SCHEMA,
    phaseId: phase.id,
    unresolvedDecisions: [],
    payload: payload(phase),
  })}${FORGE_DELIVERY_PHASE_RESPONSE_END}`;
  assert.equal(extractForgeDeliveryPhaseHumanResponse({ text: block }), null);
});

test('backend prompt directly carries the accepted UI contract payload and digest', () => {
  const artifacts = [];
  let current = state();
  for (const [phaseIndex, payloadOverrides] of [
    [0, {}],
    [1, {}],
    [2, {}],
    [3, {
      apiBindings: { consumerMarker: 'backend-must-implement-ui-api-binding' },
      fields: { consumerMarker: 'backend-must-project-ui-fields' },
    }],
  ]) {
    const accepted = acceptPhase(
      current,
      catalog.workflows[0].phases[phaseIndex],
      phaseIndex + 1,
      payloadOverrides,
    );
    current = accepted.state;
    artifacts.push(accepted.artifact);
  }

  assert.equal(current.currentPhaseId, 'backend');
  const prompt = buildForgeDeliveryPhasePrompt({
    state: current,
    catalog,
    originalRequest: 'Implement employee CRUD.',
    upstreamArtifacts: artifacts,
  });
  const authorityText = prompt
    .split('CURRENT PHASE AUTHORITY (machine-owned):\n')[1]
    .split('\n\nACCEPTED UPSTREAM PAYLOADS (digest-bound):')[0];
  const upstreamPayloadsText = prompt
    .split('ACCEPTED UPSTREAM PAYLOADS (digest-bound):\n')[1]
    .split('\n\nHUMAN-FACING RESPONSE:')[0];
  const authority = JSON.parse(authorityText);
  const upstreamPayloads = JSON.parse(upstreamPayloadsText);
  const uiArtifact = artifacts.at(-1);

  assert.equal(
    authority.upstreamArtifactDigests['ui-interaction-contract'],
    uiArtifact.artifactDigest,
  );
  assert.deepEqual(upstreamPayloads['ui-interaction-contract'], uiArtifact.payload);
  assert.equal(
    upstreamPayloads['ui-interaction-contract'].apiBindings.consumerMarker,
    'backend-must-implement-ui-api-binding',
  );
});

test('frontend prompt directly carries database dictionary results with UI and backend contracts', () => {
  const artifacts = [];
  let current = state();
  for (const [phaseIndex, payloadOverrides] of [
    [0, {}],
    [1, {}],
    [2, {
      dictionaryExcelSeed: {
        consumerMarker: 'frontend-must-use-implemented-dictionary-values',
        type: 'accident_status',
        codes: ['pending', 'completed'],
      },
    }],
    [3, {
      fields: { consumerMarker: 'frontend-must-render-ui-fields' },
    }],
    [4, {
      apiImplementation: { consumerMarker: 'frontend-must-call-implemented-api' },
    }],
  ]) {
    const accepted = acceptPhase(
      current,
      catalog.workflows[0].phases[phaseIndex],
      phaseIndex + 1,
      payloadOverrides,
    );
    current = accepted.state;
    artifacts.push(accepted.artifact);
  }

  assert.equal(current.currentPhaseId, 'frontend');
  const prompt = buildForgeDeliveryPhasePrompt({
    state: current,
    catalog,
    originalRequest: 'Implement employee CRUD.',
    upstreamArtifacts: artifacts,
  });
  const authority = JSON.parse(prompt
    .split('CURRENT PHASE AUTHORITY (machine-owned):\n')[1]
    .split('\n\nACCEPTED UPSTREAM PAYLOADS (digest-bound):')[0]);
  const upstreamPayloads = JSON.parse(prompt
    .split('ACCEPTED UPSTREAM PAYLOADS (digest-bound):\n')[1]
    .split('\n\nHUMAN-FACING RESPONSE:')[0]);
  const databaseArtifact = artifacts.find(
    (artifact) => artifact.artifactKind === 'database-implementation',
  );

  assert.equal(
    authority.upstreamArtifactDigests['database-implementation'],
    databaseArtifact.artifactDigest,
  );
  assert.deepEqual(upstreamPayloads['database-implementation'], databaseArtifact.payload);
  assert.equal(
    upstreamPayloads['database-implementation'].dictionaryExcelSeed.consumerMarker,
    'frontend-must-use-implemented-dictionary-values',
  );
  assert.equal(
    upstreamPayloads['ui-interaction-contract'].fields.consumerMarker,
    'frontend-must-render-ui-fields',
  );
  assert.equal(
    upstreamPayloads['backend-implementation'].apiImplementation.consumerMarker,
    'frontend-must-call-implemented-api',
  );
});

test('model changed paths cannot differ from operator-observed Git paths', () => {
  let current = state();
  const requirements = catalog.workflows[0].phases[0];
  current = beginForgeDeliveryPhase({
    state: current,
    catalog,
    phaseId: requirements.id,
    rpcId: 'rpc-requirements',
    promptDigest: sha('1'),
    executionGeneration: 1,
    now: '2026-09-03T00:01:00.000Z',
  });
  const requirementsArtifact = createForgeDeliveryPhaseArtifact({
    state: current,
    catalog,
    phaseId: requirements.id,
    attemptId: current.activeAttempt.attemptId,
    sourceFingerprint: sha('2'),
    payload: payload(requirements),
  });
  current = completeForgeDeliveryPhase({
    state: current,
    catalog,
    decision: 'accepted',
    artifact: requirementsArtifact,
    now: '2026-09-03T00:01:30.000Z',
  }).state;
  const domain = catalog.workflows[0].phases[1];
  current = beginForgeDeliveryPhase({
    state: current,
    catalog,
    phaseId: domain.id,
    rpcId: 'rpc-domain',
    promptDigest: sha('3'),
    executionGeneration: 2,
    now: '2026-09-03T00:02:00.000Z',
  });
  const domainArtifact = createForgeDeliveryPhaseArtifact({
    state: current,
    catalog,
    phaseId: domain.id,
    attemptId: current.activeAttempt.attemptId,
    sourceFingerprint: sha('4'),
    payload: payload(domain),
  });
  current = completeForgeDeliveryPhase({
    state: current,
    catalog,
    decision: 'accepted',
    artifact: domainArtifact,
    now: '2026-09-03T00:02:30.000Z',
  }).state;
  const database = catalog.workflows[0].phases[2];
  const databasePrompt = buildForgeDeliveryPhasePrompt({
    state: current,
    catalog,
    originalRequest: 'Implement employee CRUD.',
    upstreamArtifacts: [requirementsArtifact, domainArtifact],
  });
  assert.match(databasePrompt, /"changedPaths": \[\s+"<required:current-phase-repository-relative-path>"\s+\]/u);
  assert.match(databasePrompt, /exclude paths carried from accepted upstream phases/u);
  current = beginForgeDeliveryPhase({
    state: current,
    catalog,
    phaseId: database.id,
    rpcId: 'rpc-database',
    promptDigest: sha('5'),
    executionGeneration: 3,
    now: '2026-09-03T00:03:00.000Z',
  });
  const declared = ['forge-server/db/migration/V1.0.134__employee.sql'];
  const proposal = {
    schemaVersion: FORGE_DELIVERY_PHASE_PROPOSAL_SCHEMA,
    phaseId: database.id,
    unresolvedDecisions: [],
    payload: payload(database, declared),
  };
  assert.throws(() => createForgeDeliveryPhaseArtifactFromProposal({
    state: current,
    catalog,
    proposal,
    sourceFingerprint: sha('6'),
    changedPaths: ['forge-server/db/migration/V1.0.135__employee.sql'],
    patchDigest: sha('7'),
  }), /operator-observed Git paths/u);
});
