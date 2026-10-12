import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installVueTypecheckEntityCompatibility } from './vue-typecheck-entity-compat.mjs';

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative);
}

function fail(message) {
  throw new Error(`VERIFY_TYPECHECK_SCOPE_INVALID: ${message}`);
}

// This file is installed with the runner. The runner, not model selectors,
// derives these roots from Git and the snapshot inventory.
export function prepareFrontendTypecheck({ repositoryRoot, project, files }) {
  const root = fs.realpathSync(repositoryRoot);
  if (typeof project !== 'string' || path.isAbsolute(project)
    || project.split(/[\\/]/u).some(part => part === '..' || part === '.')) fail('Invalid project path.');
  const projectRoot = fs.realpathSync(path.resolve(root, project));
  if (!inside(root, projectRoot)) fail('Project must be inside the snapshot.');
  if (!Array.isArray(files) || files.length === 0) fail('No applicable changed source roots.');
  const roots = [...new Set(files)].sort().map(file => {
    if (typeof file !== 'string' || path.isAbsolute(file) || file.includes('\\')
      || file.split('/').some(part => part === '..' || part === '.' || part === '')
      || !/\.(?:vue|[cm]?[jt]sx?)$/u.test(file)) fail('Invalid changed source root.');
    const resolved = fs.realpathSync(path.resolve(root, file));
    if (!inside(projectRoot, resolved) || !fs.statSync(resolved).isFile()) fail('Changed root escaped its project.');
    return resolved;
  });
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  const vueTscPackage = projectRequire.resolve('vue-tsc/package.json');
  const fromTsc = createRequire(vueTscPackage);
  const ts = fromTsc('typescript');
  const configPath = path.join(projectRoot, 'jsconfig.json');
  const input = ts.readConfigFile(configPath, ts.sys.readFile);
  const formatErrors = errors => ts.formatDiagnostics(errors, {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => projectRoot,
    getNewLine: () => '\n',
  });
  if (input.error) throw new Error(formatErrors([input.error]));
  const parsed = ts.parseJsonConfigFileContent(input.config, ts.sys, projectRoot, {}, configPath, undefined,
    [{ extension: '.vue', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }]);
  if (parsed.errors.length > 0) throw new Error(formatErrors(parsed.errors));
  // Keep the ambient roots selected by the original config. Imported modules,
  // reference directives and package types remain the compiler's responsibility.
  const ambient = parsed.fileNames.filter(file => /\.d\.[cm]?ts$/u.test(file));
  const config = { extends: configPath, files: [...new Set([...roots, ...ambient])].sort(), include: [] };
  if (parsed.projectReferences) config.references = parsed.projectReferences.map(reference => ({
    path: reference.path,
    ...(reference.prepend === undefined ? {} : { prepend: reference.prepend }),
    ...(reference.circular === undefined ? {} : { circular: reference.circular }),
  }));
  const temporary = fs.mkdtempSync(path.join(projectRoot, '.forge-typecheck-'));
  const scopedConfig = path.join(temporary, 'jsconfig.json');
  const cleanup = () => {
    if (path.dirname(temporary) !== projectRoot || !path.basename(temporary).startsWith('.forge-typecheck-')) {
      throw new Error('Invalid typecheck temporary directory.');
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  };
  try {
    fs.writeFileSync(scopedConfig, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  } catch (error) { cleanup(); throw error; }
  const manifest = JSON.parse(fs.readFileSync(vueTscPackage, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['vue-tsc'];
  if (typeof bin !== 'string') { cleanup(); fail('Installed vue-tsc executable is missing.'); }
  return { projectRequire, fromTsc, cli: path.resolve(path.dirname(vueTscPackage), bin), scopedConfig,
    cleanup, summary: { project, files: [...new Set(files)].sort(), ambientFiles: ambient.length,
      configSha256: crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex'),
      vueTscVersion: manifest.version, typescriptVersion: ts.version } };
}

export function runFrontendTypecheck(argv = process.argv.slice(2)) {
  if (argv.length !== 4 || argv[0] !== '--project' || argv[2] !== '--files') fail('Expected project and trusted source roots.');
  const prepared = prepareFrontendTypecheck({ repositoryRoot: process.cwd(), project: argv[1], files: JSON.parse(argv[3]) });
  const originalArgv = process.argv;
  const originalDirectory = process.cwd();
  process.once('exit', prepared.cleanup);
  try {
    const compatibility = installVueTypecheckEntityCompatibility(prepared.projectRequire);
    process.stdout.write(`${JSON.stringify({ type: 'forge-frontend-typecheck-scope', ...prepared.summary, compatibility })}\n`);
    process.argv = [process.execPath, prepared.cli, '--noEmit', '--project', prepared.scopedConfig, '--pretty', 'false'];
    process.chdir(path.dirname(path.dirname(prepared.scopedConfig)));
    prepared.fromTsc(prepared.cli);
  } finally {
    process.argv = originalArgv;
    process.chdir(originalDirectory);
    process.removeListener('exit', prepared.cleanup);
    prepared.cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runFrontendTypecheck(); }
  catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }
}
