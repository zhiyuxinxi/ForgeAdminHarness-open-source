import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { browserCliCommand } from './forge-browser.mjs';

// Lives INSIDE the existing sandbox for its entire lifetime. Its private /tmp
// and CLI daemon survive individual commands; the owner terminates the whole
// confined process tree on close/cancel/policy change. No model-selected code.
const directory = mkdtempSync('/tmp/forge-browser-');
process.chdir(directory);
const cli = '/opt/forge-agent-tools/node_modules/@playwright/cli/playwright-cli.js';
const config = '/usr/local/share/forge-playwright.config.json';
async function run(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '-s=forge', command.action, ...command.args,
      ...(command.action === 'open' ? [`--config=${config}`] : [])], {
      cwd: directory, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/opt/forge-agent-tools/browsers',
        PLAYWRIGHT_CLI_SESSION: 'forge', HOME: directory, XDG_CONFIG_HOME: `${directory}/config`,
        XDG_CACHE_HOME: `${directory}/cache` }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', truncated = false;
    const append = bytes => { output += bytes.toString('utf8'); if (output.length > 200000) { output = output.slice(-200000); truncated = true; } };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', reject); child.on('close', exitCode => resolve({ exitCode, output, truncated }));
  });
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line.length > 40000) throw new Error('BROWSER_REQUEST_LIMIT');
  const request = JSON.parse(line);
  if (typeof request.id !== 'string' || request.id.length > 80) throw new Error('BROWSER_REQUEST_ID');
  try {
    const command = browserCliCommand({ action: request.action, args: request.args });
    const result = await run(command);
    process.stdout.write(`${JSON.stringify({ id: request.id, ...result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: request.id, exitCode: 1, output: String(error.message), truncated: false })}\n`);
  }
}
