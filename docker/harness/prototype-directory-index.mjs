import path from 'node:path';
import process from 'node:process';
import { preparePrototypeDirectory, prototypeLimits } from './prototype-archive.mjs';

function usage() {
  return 'Usage: forge-prototype-index /project-ftp-inputs/<uploaded-folder>';
}

function limitsFromEnvironment(environment) {
  return prototypeLimits({
    directoryStabilityMs: environment.HARNESS_PROTOTYPE_DIRECTORY_STABILITY_MS,
    maxArchiveBytes: environment.HARNESS_PROTOTYPE_MAX_ARCHIVE_BYTES,
    maxCompressionRatio: environment.HARNESS_PROTOTYPE_MAX_COMPRESSION_RATIO,
    maxDepth: environment.HARNESS_PROTOTYPE_MAX_DEPTH,
    maxEntries: environment.HARNESS_PROTOTYPE_MAX_ENTRIES,
    maxFileBytes: environment.HARNESS_PROTOTYPE_MAX_FILE_BYTES,
    maxHtmlAnalysisBytes: environment.HARNESS_PROTOTYPE_MAX_HTML_ANALYSIS_BYTES,
    maxPages: environment.HARNESS_PROTOTYPE_MAX_PAGES,
    maxPathBytes: environment.HARNESS_PROTOTYPE_MAX_PATH_BYTES,
    maxSummaryBytes: environment.HARNESS_PROTOTYPE_MAX_SUMMARY_BYTES,
    maxUncompressedBytes: environment.HARNESS_PROTOTYPE_MAX_UNCOMPRESSED_BYTES,
  });
}

export async function runPrototypeDirectoryIndex(argv = process.argv.slice(2), environment = process.env) {
  if (argv.length !== 1 || argv[0] === '--help' || argv[0] === '-h') {
    if (argv.length === 1) return { help: usage() };
    throw new Error(usage());
  }
  const sourceRoot = path.resolve(argv[0]);
  const allowedRoots = (environment.FORGE_PROTOTYPE_ALLOWED_ROOTS
    ?? '/project-ftp-inputs:/project-shared-inputs:/project-inputs')
    .split(':')
    .filter(Boolean)
    .map((value) => path.resolve(value));
  const outputRoot = path.resolve(environment.FORGE_PROTOTYPE_INDEX_ROOT
    ?? '/workspace/.forge-cache/prototype-index');
  return preparePrototypeDirectory({
    allowedRoots,
    limits: limitsFromEnvironment(environment),
    outputRoot,
    sourcePublicRoot: sourceRoot.split(path.sep).join('/'),
    sourceRoot,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPrototypeDirectoryIndex()
    .then((result) => {
      if (result.help) {
        process.stdout.write(`${result.help}\n`);
        return;
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.code ?? 'PROTOTYPE_INDEX_FAILED'}: ${error.message}\n`);
      process.exitCode = 1;
    });
}
