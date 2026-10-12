#!/usr/bin/env node

import crypto from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256 = /^[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key)) {
      fail('Arguments must be unique --name value pairs.');
    }
    values.set(key, value);
  }
  const allowed = new Set([
    '--bundle-root', '--manifest-sha256', '--contract', '--task-id', '--profile',
    '--selectors', '--output',
  ]);
  for (const key of values.keys()) if (!allowed.has(key)) fail(`Unsupported argument: ${key}`);
  for (const key of allowed) if (!values.get(key)) fail(`${key} is required.`);
  return Object.fromEntries(values);
}

function ordinaryPath(value, kind, label) {
  if (!path.isAbsolute(value) || !existsSync(value)) fail(`${label} must be an existing absolute path.`);
  const before = lstatSync(value);
  if (before.isSymbolicLink()) fail(`${label} must not be a symbolic link.`);
  const resolved = realpathSync(value);
  const info = lstatSync(resolved);
  if ((kind === 'file' && !info.isFile()) || (kind === 'directory' && !info.isDirectory())) {
    fail(`${label} has the wrong node type.`);
  }
  return resolved;
}

function stableSha256(file) {
  const before = lstatSync(file);
  const first = readFileSync(file);
  const middle = lstatSync(file);
  const second = readFileSync(file);
  const after = lstatSync(file);
  const identity = (info) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.nlink].join(':');
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || identity(before) !== identity(middle) || identity(middle) !== identity(after)
    || !first.equals(second)) fail('Host Runner manifest changed during stable read.');
  return crypto.createHash('sha256').update(first).digest('hex');
}

export async function executeHostVerificationOnce(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const bundleRoot = ordinaryPath(options['--bundle-root'], 'directory', '--bundle-root');
  const manifestPath = ordinaryPath(path.join(bundleRoot, 'runner.manifest.json'), 'file', 'runner manifest');
  const expectedManifestSha256 = options['--manifest-sha256'];
  if (!SHA256.test(expectedManifestSha256) || stableSha256(manifestPath) !== expectedManifestSha256) {
    fail('Host Runner manifest does not match the reviewed SHA-256.');
  }
  const contractPath = ordinaryPath(options['--contract'], 'file', '--contract');
  const selectorsPath = ordinaryPath(options['--selectors'], 'file', '--selectors');
  const output = path.resolve(options['--output']);
  if (!path.isAbsolute(options['--output']) || existsSync(output)) fail('--output must be a new absolute file.');
  ordinaryPath(path.dirname(output), 'directory', '--output parent');

  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const selectors = JSON.parse(readFileSync(selectorsPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const managerPath = ordinaryPath(path.join(bundleRoot, 'bin', 'forge-host-runner-bundle.mjs'), 'file', 'bundle manager');
  const runnerPath = ordinaryPath(path.join(bundleRoot, manifest.entrypoint ?? ''), 'file', 'Host Runner entrypoint');
  const managerModule = await import(pathToFileURL(managerPath).href);
  const validatedBundle = await managerModule.validateHostRunnerBundle(bundleRoot, {
    profileCatalogVersion: contract.profileCatalogVersion,
    nodeMajor: process.versions.node.split('.')[0],
  });
  if (validatedBundle.manifest.bundleVersion !== manifest.bundleVersion) fail('Validated Host Runner version changed.');
  const { HostVerificationRunner } = await import(pathToFileURL(runnerPath).href);
  const runner = new HostVerificationRunner({ projectSlug: contract.projectSlug, contract });
  mkdirSync(runner.stateRoot, { recursive: true, mode: 0o700 });
  const admission = await runner.admit(options['--task-id'], [options['--profile']]);
  const receipt = await runner.run(options['--task-id'], {
    action: 'run',
    profile: options['--profile'],
    selectors,
    idempotencyKey: `local-matrix:${options['--task-id']}:${options['--profile']}`,
    admissionId: admission.admissionId,
  });
  if (stableSha256(manifestPath) !== expectedManifestSha256) fail('Host Runner manifest changed during execution.');
  const exportedLog = path.join(path.dirname(output), 'host-profile.log.txt');
  if (existsSync(exportedLog)) fail('Host Runner exported log path already exists.');
  const logBytes = readFileSync(receipt.logs.path);
  writeFileSync(exportedLog, logBytes, { flag: 'wx', mode: 0o600 });
  const envelope = {
    schemaVersion: 1,
    receiptType: 'forge-local-matrix/host-profile',
    bundle: {
      version: manifest.bundleVersion,
      manifestSha256: expectedManifestSha256,
      treeSha256: validatedBundle.treeSha256,
    },
    admission: {
      projectSlug: admission.projectSlug,
      taskId: admission.taskId,
      profiles: admission.profiles,
      profileCatalogVersion: admission.profileCatalogVersion,
      profilePolicyDigest: admission.profilePolicyDigest,
    },
    exportedLog: {
      path: path.basename(exportedLog),
      bytes: logBytes.length,
      sha256: crypto.createHash('sha256').update(logBytes).digest('hex'),
      redacted: receipt.logs.redacted,
    },
    receipt,
  };
  writeFileSync(output, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return envelope;
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  executeHostVerificationOnce().then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: result.receipt.status === 'passed', status: result.receipt.status })}\n`);
    if (result.receipt.status !== 'passed') process.exitCode = 2;
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error.message,
      stack: String(error.stack ?? '').split(/\r?\n/u).slice(0, 8),
    })}\n`);
    process.exitCode = 1;
  });
}
