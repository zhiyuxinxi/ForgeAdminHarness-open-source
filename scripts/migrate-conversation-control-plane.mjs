#!/usr/bin/env node

import crypto from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONVERSATION_STATE_SCHEMA_VERSION } from '../docker/harness/conversation-policy.mjs';
import { parseProjectRegistry } from '../docker/harness/project-directory.mjs';

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--delivery-root', '--target-state-root', '--canonical-project'].includes(key) || value === undefined) {
      throw new Error('Usage: migrate-conversation-control-plane.mjs --delivery-root <path> --target-state-root <path> --canonical-project <slug>');
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertSourceState(state, slug) {
  if (![1, CONVERSATION_STATE_SCHEMA_VERSION].includes(state?.schemaVersion)
    || !Array.isArray(state.users)
    || !Array.isArray(state.sessions)
    || !Array.isArray(state.conversations)) {
    throw new Error(`Conversation state for ${slug} is unsupported.`);
  }
}

function stableSourceDigests(sources) {
  return Object.fromEntries(sources.map((source) => [source.slug, source.digest]).sort(([left], [right]) => left.localeCompare(right)));
}

function sameDigests(left, right) {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

async function optionalText(file) {
  try { return await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function migrateConversationControlPlane({ deliveryRoot, targetStateRoot, canonicalProject }) {
  if (!path.isAbsolute(deliveryRoot) || !path.isAbsolute(targetStateRoot)) throw new Error('Migration paths must be absolute.');
  const expectedTarget = path.join(path.resolve(deliveryRoot), 'conversation-control-plane', 'state');
  if (path.resolve(targetStateRoot) !== expectedTarget) throw new Error('Target state root is outside the reviewed control-plane boundary.');
  const registryPath = path.join(deliveryRoot, 'registry', 'projects.tsv');
  const projects = parseProjectRegistry(await readFile(registryPath, 'utf8'));
  if (!projects.some((project) => project.slug === canonicalProject)) throw new Error('Canonical project is not registered.');

  const ordered = [
    projects.find((project) => project.slug === canonicalProject),
    ...projects.filter((project) => project.slug !== canonicalProject),
  ];
  const sources = [];
  for (const project of ordered) {
    const statePath = path.join(deliveryRoot, 'projects', project.slug, 'conversation-gateway', 'state.json');
    const raw = await optionalText(statePath);
    if (raw === undefined) continue;
    const state = JSON.parse(raw);
    assertSourceState(state, project.slug);
    sources.push({ slug: project.slug, raw, digest: digest(raw), state });
  }
  if (sources.length === 0 || sources[0].slug !== canonicalProject) {
    throw new Error('Canonical project conversation state is missing.');
  }

  const sourceDigests = stableSourceDigests(sources);
  const targetPath = path.join(targetStateRoot, 'state.json');
  const existingRaw = await optionalText(targetPath);
  if (existingRaw !== undefined) {
    const existing = JSON.parse(existingRaw);
    if (existing.schemaVersion === CONVERSATION_STATE_SCHEMA_VERSION
      && sameDigests(existing.migration?.sourceDigests, sourceDigests)) {
      return { changed: false, users: existing.users.length, conversations: existing.conversations.length, collisions: existing.migration?.usernameCollisions ?? [] };
    }
    throw new Error('Unified conversation state already exists with a different migration identity; refusing to overwrite active state.');
  }

  const users = [];
  const usersByUsername = new Map();
  const userIdMap = new Map();
  const memberships = [];
  const membershipKeys = new Set();
  const conversations = [];
  const conversationIds = new Set();
  const taskIds = new Set();
  const usernameCollisions = [];

  for (const source of sources) {
    for (const sourceUser of source.state.users) {
      let targetUser = usersByUsername.get(sourceUser.username);
      if (targetUser === undefined) {
        targetUser = structuredClone(sourceUser);
        if (source.slug !== canonicalProject && targetUser.role === 'admin') targetUser.role = 'member';
        users.push(targetUser);
        usersByUsername.set(targetUser.username, targetUser);
      } else if (source.slug !== canonicalProject
        && (targetUser.id !== sourceUser.id || targetUser.passwordHash !== sourceUser.passwordHash)) {
        usernameCollisions.push({ username: sourceUser.username, canonicalProject, mergedFromProject: source.slug });
      }
      userIdMap.set(`${source.slug}:${sourceUser.id}`, targetUser.id);
      const membershipKey = `${targetUser.id}:${source.slug}`;
      if (!membershipKeys.has(membershipKey)) {
        membershipKeys.add(membershipKey);
        memberships.push({
          userId: targetUser.id,
          projectSlug: source.slug,
          access: sourceUser.role === 'auditor' ? 'audit' : 'member',
          createdAt: sourceUser.createdAt,
          updatedAt: sourceUser.updatedAt,
        });
      }
    }
    for (const sourceConversation of source.state.conversations) {
      if (conversationIds.has(sourceConversation.id) || taskIds.has(sourceConversation.taskId)) {
        throw new Error(`Conversation or TaskSpace identity collision while importing ${source.slug}.`);
      }
      const ownerUserId = userIdMap.get(`${source.slug}:${sourceConversation.ownerUserId}`);
      if (ownerUserId === undefined) throw new Error(`Conversation owner is missing while importing ${source.slug}.`);
      conversationIds.add(sourceConversation.id);
      taskIds.add(sourceConversation.taskId);
      conversations.push({ ...structuredClone(sourceConversation), projectSlug: source.slug, ownerUserId });
    }
  }

  const migratedAt = new Date().toISOString();
  const auditLines = [];
  for (const source of sources) {
    const rawAudit = await optionalText(path.join(deliveryRoot, 'projects', source.slug, 'conversation-gateway', 'audit.jsonl'));
    if (rawAudit === undefined) continue;
    for (const line of rawAudit.split('\n').filter(Boolean)) {
      let event;
      try { event = JSON.parse(line); } catch { throw new Error(`Audit log for ${source.slug} contains invalid JSON.`); }
      auditLines.push(JSON.stringify({ ...event, projectSlug: source.slug }));
    }
  }
  auditLines.push(JSON.stringify({ at: migratedAt, projectSlug: 'platform', actor: 'operator', action: 'control-plane.migrate', targetType: 'platform', targetId: null, result: 'success', sourceProjectCount: sources.length, sessionsRevoked: true }));

  const state = {
    schemaVersion: CONVERSATION_STATE_SCHEMA_VERSION,
    revision: 1,
    users,
    sessions: [],
    conversations,
    idempotency: [],
    memberships,
    migration: {
      kind: 'project-gateways-to-unified-control-plane',
      canonicalProject,
      migratedAt,
      sourceDigests,
      usernameCollisions,
      sessionsRevoked: true,
    },
  };

  await mkdir(targetStateRoot, { recursive: true, mode: 0o700 });
  await chmod(targetStateRoot, 0o700).catch(() => {});
  const nonce = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const temporary = `${targetPath}.tmp.${nonce}`;
  const auditPath = path.join(targetStateRoot, 'audit.jsonl');
  const temporaryAudit = `${auditPath}.tmp.${nonce}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await writeFile(temporaryAudit, `${auditLines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  // state.json is the commit marker. Publishing the audit first means a crash
  // can leave only a replaceable audit, never an active state without audit.
  await rename(temporaryAudit, auditPath);
  await rename(temporary, targetPath);
  await chmod(targetPath, 0o600).catch(() => {});
  await chmod(auditPath, 0o600).catch(() => {});

  return { changed: true, users: users.length, conversations: conversations.length, collisions: usernameCollisions };
}

async function main() {
  const argumentsValue = parseArguments(process.argv.slice(2));
  const result = await migrateConversationControlPlane({
    deliveryRoot: path.resolve(argumentsValue['delivery-root']),
    targetStateRoot: path.resolve(argumentsValue['target-state-root']),
    canonicalProject: argumentsValue['canonical-project'],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Conversation control-plane migration failed: ${error.message}\n`);
    process.exit(1);
  });
}
