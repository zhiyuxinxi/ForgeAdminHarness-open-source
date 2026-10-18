// Run in the candidate image as its non-root user. No external API or project data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'forge-agent-tools-smoke-'));
const env = { ...process.env, HOME: root, XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config') };
const session = `forge-smoke-${process.pid}`;
const selected = new Set((process.env.FORGE_AGENT_TOOLS_SMOKE ?? 'ast-grep,bruno,browser').split(','));
async function run(command, args, { cwd = root } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} timed out`)); }, 90000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`${command} exit ${code}: ${stdout}\n${stderr}`));
      else resolve(stdout);
    });
  });
}
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', source: 'isolated-fixture' }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Forge tool fixture</title><label>Name <input id="name"></label><button onclick="document.querySelector(\'output\').textContent=\'Saved \'+document.querySelector(\'input\').value">Save</button><output></output>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  if (selected.has('ast-grep')) {
  const code = join(root, 'fixture.js');
  await writeFile(code, 'console.log("needle");\nconsole.warn("other");\n');
  const matches = JSON.parse(await run('ast-grep', ['run', '--lang', 'js', '--pattern', 'console.log($A)', '--json=compact', code]));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].text, 'console.log("needle")');
  console.log('PASS ast-grep real structural match');
  }

  if (selected.has('bruno')) {
  const collection = join(root, 'collection');
  await mkdir(collection);
  await writeFile(join(collection, 'bruno.json'), JSON.stringify({ version: '1', name: 'Forge fixture', type: 'collection' }));
  await writeFile(join(collection, 'health.bru'), `meta {\n  name: Health\n  type: http\n  seq: 1\n}\nget {\n  url: ${origin}/health\n  body: none\n  auth: none\n}\nassert {\n  res.status: 200\n  res.body.status: ok\n}\n`);
  const bruno = await run('bru', ['run', 'health.bru', '--sandbox', 'safe'], { cwd: collection });
  assert.match(bruno, /res\.body\.status: ok/u);
  console.log('PASS Bruno real local HTTP request and response assertions');
  }

  if (selected.has('browser')) {
  await run('playwright-cli', [`-s=${session}`, 'open', origin]);
  await run('playwright-cli', [`-s=${session}`, 'fill', "getByRole('textbox', { name: 'Name' })", 'Forge']);
  await run('playwright-cli', [`-s=${session}`, 'click', "getByRole('button', { name: 'Save' })"]);
  const snapshot = await run('playwright-cli', [`-s=${session}`, 'snapshot']);
  assert.match(snapshot, /Saved Forge/u);
  console.log('PASS Playwright CLI real headless Chromium interaction across CLI calls');
  }
} finally {
  if (selected.has('browser')) await run('playwright-cli', [`-s=${session}`, 'close']).catch(error => console.error(`Browser cleanup: ${error.message}`));
  await new Promise(resolve => server.close(resolve));
}
