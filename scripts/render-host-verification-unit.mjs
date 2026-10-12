import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

function unitPath(value, name) {
  // These values appear in systemd path and ExecStart fields, not shell input.
  // Reject whitespace, specifiers and escapes instead of changing their meaning.
  if (typeof value !== 'string' || !/^\/[a-zA-Z0-9_./-]+$/u.test(value)
      || path.posix.normalize(value) !== value || value.endsWith('/')) {
    throw new Error(`${name} must be an absolute normalized Linux path without whitespace, specifiers or escapes.`);
  }
  return value;
}

function unitAccount(value, name) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(value) || value === 'root') {
    throw new Error(`${name} must be a non-root Linux account name.`);
  }
  return value;
}

export async function renderHostVerificationUnit(options) {
  const replacements = {
    __DELIVERY_ROOT__: unitPath(options.deliveryRoot ?? '/srv/forge-delivery', 'deliveryRoot'),
    __DELIVERY_OWNER__: unitAccount(options.deliveryOwner, 'deliveryOwner'),
    __DELIVERY_GROUP__: unitAccount(options.deliveryGroup, 'deliveryGroup'),
    __HOST_NODE_PATH__: unitPath(options.hostNodePath, 'hostNodePath'),
    __HOST_RUNNER_ROOT__: unitPath(options.hostRunnerRoot, 'hostRunnerRoot'),
  };
  const template = await readFile(new URL('../templates/systemd/forge-host-verification@.service', import.meta.url), 'utf8');
  return template.replace(/__[A-Z_]+__/gu, (token) => {
    if (!Object.hasOwn(replacements, token)) throw new Error(`Unknown Host unit placeholder: ${token}`);
    return replacements[token];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries([
      'delivery-root', 'delivery-owner', 'delivery-group', 'host-node-path', 'host-runner-root',
    ].map((key) => [key, { type: 'string' }])), allowPositionals: false });
    process.stdout.write(await renderHostVerificationUnit({
      deliveryRoot: values['delivery-root'], deliveryOwner: values['delivery-owner'],
      deliveryGroup: values['delivery-group'], hostNodePath: values['host-node-path'],
      hostRunnerRoot: values['host-runner-root'],
    }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
