import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { documentLimits, extractProjectDocument } from './document-extractor.mjs';
import { isPrototypeArchive, preparePrototypeArchive, prototypeLimits } from './prototype-archive.mjs';

export class MaterialReadableError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function publicChild(root, relative) {
  return `${root.replace(/\/$/, '')}/${relative.split(path.sep).join('/')}`;
}

async function existingDocument(finalRoot, publicRoot, sourceSha256) {
  try {
    const current = await lstat(finalRoot);
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw new MaterialReadableError('MATERIAL_DERIVED_CONFLICT', '文档派生路径不是安全目录。');
    }
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  let metadata;
  try {
    metadata = JSON.parse(await readFile(path.join(finalRoot, 'material.json'), 'utf8'));
  } catch {
    throw new MaterialReadableError('MATERIAL_DERIVED_CONFLICT', '已有文档派生目录缺少有效元数据。');
  }
  if (metadata.schemaVersion !== 1 || metadata.sourceSha256 !== sourceSha256) {
    throw new MaterialReadableError('MATERIAL_DERIVED_CONFLICT', '已有文档派生目录与当前资料不一致。');
  }
  return {
    ...metadata.readable,
    derivedRoot: finalRoot,
    idempotent: true,
    path: publicChild(publicRoot, 'README.md'),
    status: 'ready',
  };
}

async function publishDocument({ destinationDirectory, extraction, publicDirectory, sourceLabel, sourceSha256 }) {
  const derivedParent = path.join(destinationDirectory, '.forge-derived');
  await mkdir(derivedParent, { recursive: true, mode: 0o750 });
  if (await realpath(derivedParent) !== derivedParent) {
    throw new MaterialReadableError('MATERIAL_DERIVED_ROOT_INVALID', '文档派生根目录包含符号链接。');
  }
  const derivedName = `document-${sourceSha256.slice(0, 12)}`;
  const finalRoot = path.join(derivedParent, derivedName);
  const publicRoot = publicChild(publicDirectory, `.forge-derived/${derivedName}`);
  const existing = await existingDocument(finalRoot, publicRoot, sourceSha256);
  if (existing !== undefined) return existing;

  let stagingRoot;
  try {
    stagingRoot = await mkdtemp(path.join(derivedParent, '.document-staging-'));
    await chmod(stagingRoot, 0o750);
    await writeFile(path.join(stagingRoot, 'README.md'), extraction.markdown, {
      encoding: 'utf8', flag: 'wx', mode: 0o640,
    });
    const readable = {
      bytes: Buffer.byteLength(extraction.markdown, 'utf8'),
      format: extraction.format,
      truncated: extraction.truncated,
    };
    await writeFile(path.join(stagingRoot, 'material.json'), `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourcePath: sourceLabel,
      sourceSha256,
      readable,
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
    try {
      await rename(stagingRoot, finalRoot);
      stagingRoot = undefined;
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      const raced = await existingDocument(finalRoot, publicRoot, sourceSha256);
      if (raced === undefined) throw error;
      return raced;
    }
    return {
      ...readable,
      derivedRoot: finalRoot,
      idempotent: false,
      path: publicChild(publicRoot, 'README.md'),
      status: 'ready',
    };
  } finally {
    if (stagingRoot !== undefined) await rm(stagingRoot, { force: true, recursive: true }).catch(() => {});
  }
}

export async function prepareReadableMaterial(options) {
  const sourcePath = path.resolve(options.sourcePath);
  const destinationDirectory = path.resolve(options.destinationDirectory);
  if (isPrototypeArchive(options.filename)) {
    return preparePrototypeArchive({
      destinationDirectory,
      limits: prototypeLimits(options.prototypeLimits),
      publicDirectory: options.publicDirectory,
      sourceLabel: options.sourceLabel,
      sourcePath,
      sourceSha256: options.sourceSha256,
    });
  }
  const extraction = await (options.documentExtractor ?? extractProjectDocument)({
    filename: options.filename,
    limits: documentLimits(options.documentLimits),
    sourceLabel: options.sourceLabel,
    sourcePath,
  });
  if (extraction.status === 'native') {
    return { format: extraction.format, path: options.sourceLabel, status: 'native' };
  }
  if (extraction.status !== 'ready') return extraction;
  return publishDocument({
    destinationDirectory,
    extraction,
    publicDirectory: options.publicDirectory,
    sourceLabel: options.sourceLabel,
    sourceSha256: options.sourceSha256,
  });
}
