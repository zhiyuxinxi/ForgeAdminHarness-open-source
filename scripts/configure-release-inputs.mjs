#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, readFile, rename, writeFile, chmod, chown, realpath } from 'node:fs/promises';
import crypto from 'node:crypto';
import { validateReleaseInputs } from '../docker/harness/release-inputs.mjs';
import { validateVerificationInputScopes } from '../docker/harness/verification-inputs.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Source-only configuration preparation. Deployment is deliberately owned by
// the existing release procedure; run --write only with the compatible Runner,
// Host and issuer installed. Existing project definitions are preserved.
export async function configureReleaseInputs(projectRoot, { write = false } = {}) {
  projectRoot = path.resolve(projectRoot);
  if (await realpath(projectRoot) !== projectRoot) throw new Error('Project root must be canonical.');
  const defaults = JSON.parse(await readFile(path.join(repository, 'templates/project/release-inputs.json'), 'utf8'));
  const hostDefaults = JSON.parse(await readFile(path.join(repository, 'templates/project/host-verification-contract.json.tpl'), 'utf8')).inputScopes;
  const planned = [];
  let inspected = 0;
  for (const relative of ['ops/runtime-contract.json', 'verification/host-contract.json']) {
    const file = path.join(projectRoot, relative);
    let info;
    try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(file) !== file) throw new Error('Configuration must be an ordinary private project file.');
    const before = await readFile(file, 'utf8'), value = JSON.parse(before);
    inspected++;
    if (relative.startsWith('ops/')) {
      if (path.resolve(value.projectRoot) !== projectRoot || value.schemaVersion !== 3) throw new Error('Runtime project identity mismatch.');
      value.release.inputModel ??= { ...defaults, services: Object.fromEntries(value.release.allowedReleaseServices.map(service => [service, defaults.services[service]])) };
      validateReleaseInputs(value.release.inputModel, value.release.allowedReleaseServices);
    } else {
      if (value.executionMode !== 'host-toolchain' || value.schemaVersion !== 2
        || path.resolve(value.taskspacesRoot) !== path.join(projectRoot, 'taskspaces')) throw new Error('Host project identity mismatch.');
      value.inputScopes ??= hostDefaults;
      validateVerificationInputScopes(value.inputScopes, value.profiles);
    }
    const after = JSON.stringify(value, null, 2) + '\n';
    if (JSON.stringify(JSON.parse(before)) !== JSON.stringify(value)) planned.push({ file, relative, before, after, mode: info.mode, uid: info.uid, gid: info.gid });
  }
  // Finish all validation before touching either consumer's configuration.
  if (!inspected) throw new Error('No registered release or Host contracts were found.');
  if (write) for (const item of planned) {
    if (await readFile(item.file, 'utf8') !== item.before) throw new Error('Configuration changed after preparation.');
    const temporary = `${item.file}.${crypto.randomUUID()}.inputs`;
    await writeFile(temporary, item.after, { flag: 'wx', mode: item.mode & 0o777 });
    await chmod(temporary, item.mode & 0o777);
    if (process.platform !== 'win32') await chown(temporary, item.uid, item.gid);
    await rename(temporary, item.file);
  }
  return { status: write ? 'configured' : 'planned', files: planned.map(item => item.relative), deploymentPerformed: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length < 2 || args[0] !== '--project-root' || args.length > 3 || args[2] !== undefined && args[2] !== '--write') {
    throw new Error('Usage: configure-release-inputs.mjs --project-root <registered-project> [--write]');
  }
  configureReleaseInputs(args[1], { write: args[2] === '--write' }).then(value => process.stdout.write(JSON.stringify(value) + '\n'))
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
