#!/usr/bin/env python3
"""Prepare only pnpm 10.34.5; never activate a toolchain or modify a Host contract."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import urllib.request

VERSION = '10.34.5'
REGISTRY = 'https://registry.npmjs.org/'
METADATA = REGISTRY + 'pnpm/' + VERSION
TARBALL = REGISTRY + 'pnpm/-/pnpm-' + VERSION + '.tgz'


class PreparationError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, message):
    if not condition:
        raise PreparationError('PNPM_PREPARATION_INVALID', message)


def ordinary_parents(directory, create=False):
    directory = Path(os.path.abspath(directory))
    for item in reversed([directory, *directory.parents]):
        if not item.exists() and create:
            item.mkdir(mode=0o700)
        metadata = item.lstat()
        require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), 'Directory ancestor is not ordinary')
    return directory


def ordinary_file(file):
    metadata = file.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, 'Toolchain file is not an ordinary single-link file')
    return metadata


def file_digest(file, algorithm):
    digest = hashlib.new(algorithm)
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest


def sha256(file):
    return file_digest(file, 'sha256').hexdigest()


def safe_relative(value):
    require(isinstance(value, str) and value and '\\' not in value and ':' not in value
            and not any(ord(c) < 32 for c in value)
            and all(part not in ('', '.', '..') for part in value.split('/')), 'Unsafe relative toolchain path')
    return value


def tree_inventory(root, readonly=False):
    files = []
    ordinary_parents(root)
    for directory, names, leaves in os.walk(root, followlinks=False):
        base = Path(directory)
        info = base.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode), 'Toolchain directory is not ordinary')
        if readonly and os.name != 'nt':
            require(info.st_mode & 0o222 == 0, 'Toolchain directory is writable')
        for name in names:
            info = (base / name).lstat()
            require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode), 'Toolchain directory contains a link')
        for name in leaves:
            file = base / name
            info = ordinary_file(file)
            if readonly and os.name != 'nt':
                require(info.st_mode & 0o222 == 0, 'Toolchain file is writable')
            files.append({'path': safe_relative(file.relative_to(root).as_posix()), 'bytes': info.st_size,
                          'sha256': sha256(file), 'executable': bool(info.st_mode & 0o111)})
    files.sort(key=lambda item: item['path'])
    require(bool(files), 'Toolchain is empty')
    digest = hashlib.sha256()
    for item in files:
        digest.update((item['path'] + '\0' + item['sha256'] + '\0' + str(item['bytes']) + '\0').encode())
    return files, digest.hexdigest()


def fixed_dist(value):
    require(isinstance(value, dict) and value.get('tarball') == TARBALL, 'Only the fixed official pnpm tarball is allowed')
    integrity = value.get('integrity', '')
    require(isinstance(integrity, str) and integrity.startswith('sha512-'), 'Official SHA-512 tarball integrity is required')
    try:
        decoded = base64.b64decode(integrity[7:], validate=True)
    except Exception as error:
        raise PreparationError('PNPM_PREPARATION_INVALID', 'Invalid tarball integrity') from error
    require(len(decoded) == 64, 'Invalid tarball integrity length')
    return {'tarball': TARBALL, 'integrity': integrity}


def verify_tarball(file, dist):
    ordinary_file(file)
    actual = file_digest(file, 'sha512').digest()
    require(actual == base64.b64decode(dist['integrity'][7:], validate=True), 'Official pnpm tarball integrity mismatch')


def run(argv, env, cwd):
    completed = subprocess.run(argv, env=env, cwd=cwd, capture_output=True, text=True, timeout=180)
    if completed.returncode:
        detail = (completed.stderr + completed.stdout)[-1800:]
        if 'ENOTCACHED' in detail:
            raise PreparationError('PNPM_OFFLINE_CACHE_MISS', 'Required official pnpm@10.34.5 metadata or tarball is absent from the supplied npm cache')
        raise PreparationError('PNPM_COMMAND_FAILED', 'Fixed pnpm preparation command failed: ' + detail)
    return completed.stdout


def official_get(url, maximum):
    require(url in (METADATA, TARBALL), 'Unexpected download URL')
    with urllib.request.urlopen(url, timeout=60) as response:
        require(response.geturl() == url, 'Unexpected official package redirect')
        data = response.read(maximum + 1)
    require(len(data) <= maximum, 'Official package response exceeds its bound')
    return data


def validate_installed(root, node, env, invoke=run):
    package = root / 'lib/node_modules/pnpm'
    ordinary_file(package / 'package.json')
    metadata = json.loads((package / 'package.json').read_text())
    require(metadata.get('name') == 'pnpm' and metadata.get('version') == VERSION, 'Installed pnpm identity differs from the fixed version')
    bin_path = safe_relative(metadata.get('bin', {}).get('pnpm'))
    entrypoint = 'lib/node_modules/pnpm/' + bin_path
    ordinary_file(root / entrypoint)
    require(invoke([str(node), str(root / entrypoint), '--version'], env, root).strip() == VERSION, 'Installed pnpm version probe failed')
    return entrypoint


def private_cache_copy(cache, work):
    source = ordinary_parents(cache / '_cacache')
    before, digest = tree_inventory(source)
    target = work / 'source-cache' / '_cacache'
    shutil.copytree(source, target, copy_function=shutil.copyfile)
    require(tree_inventory(source) == (before, digest) and tree_inventory(target)[1] == digest,
            'Source npm cache changed while making its private copy')
    for directory, _, leaves in os.walk(target):
        Path(directory).chmod(0o700)
        for name in leaves:
            (Path(directory) / name).chmod(0o600)
    return target.parent


def prepare(candidate_root, npm_cache, node, npm_cli, allow_download=False, invoke=run, fetch=official_get,
            package_tarball=None, dist_json=None):
    require(bool(package_tarball) == bool(dist_json), 'Both fixed package tarball and dist JSON are required')
    require(bool(npm_cache) != bool(package_tarball), 'Choose either a source npm cache or the two fixed package files')
    require(not (package_tarball and allow_download), 'Fixed package files must be consumed offline')
    candidate = ordinary_parents(candidate_root, create=True)
    cache = ordinary_parents(npm_cache) if npm_cache else None
    node, npm_cli = Path(node), Path(npm_cli)
    require(node.is_absolute() and npm_cli.is_absolute(), 'Explicit absolute Node and npm CLI paths are required')
    ordinary_file(npm_cli)
    require(node.is_file(), 'Preparation Node executable is missing')
    versions = ordinary_parents(candidate / 'toolchains/versions', create=True)
    target = versions / ('pnpm-' + VERSION)
    receipt_file = candidate / 'toolchains' / ('pnpm-' + VERSION + '.receipt.json')
    work = Path(tempfile.mkdtemp(prefix='.pnpm-' + VERSION + '-prepare-', dir=candidate / 'toolchains'))
    for name in ('home', 'logs', 'downloads', 'install-cache'):
        (work / name).mkdir(mode=0o700)
    for name in ('user.npmrc', 'global.npmrc'):
        (work / name).write_text('')
    env = {'PATH': str(node.parent) + os.pathsep + os.defpath, 'HOME': str(work / 'home'),
           'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'NO_COLOR': '1'}
    if os.name == 'nt':
        for name in ('SystemRoot', 'WINDIR'):
            if name in os.environ:
                env[name] = os.environ[name]
        env.update({'TEMP': str(work / 'logs'), 'TMP': str(work / 'logs')})
    if target.exists() or target.is_symlink():
        require(receipt_file.is_file() and not receipt_file.is_symlink(), 'Existing toolchain has no preparation receipt; refusing to replace it')
        receipt = json.loads(receipt_file.read_text())
        fixed_dist(receipt.get('source'))
        files, tree_hash = tree_inventory(target, readonly=True)
        require(receipt.get('schemaVersion') == 1 and receipt.get('package') == 'pnpm' and receipt.get('version') == VERSION
                and receipt.get('files') == files and receipt.get('treeSha256') == tree_hash, 'Existing toolchain differs from its receipt')
        require(validate_installed(target, node, env, invoke) == receipt.get('entrypoint'), 'Existing toolchain entrypoint differs')
        return {'status': 'ready', 'idempotent': True, 'root': str(target), 'receipt': str(receipt_file), 'receiptSha256': sha256(receipt_file), 'treeSha256': tree_hash}
    require(not receipt_file.exists(), 'Orphaned receipt exists; refusing to overwrite it')
    base = [str(node), str(npm_cli), '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--update-notifier=false',
            '--registry=' + REGISTRY, '--userconfig=' + str(work / 'user.npmrc'), '--globalconfig=' + str(work / 'global.npmrc'),
            '--logs-dir=' + str(work / 'logs')]
    archive = work / 'downloads' / ('pnpm-' + VERSION + '.tgz')
    dist = None
    if package_tarball:
        package_tarball, dist_json = Path(package_tarball), Path(dist_json)
        ordinary_parents(package_tarball.parent)
        ordinary_parents(dist_json.parent)
        require(ordinary_file(package_tarball).st_size <= 64 * 1024 * 1024, 'Fixed package tarball exceeds its bound')
        require(ordinary_file(dist_json).st_size <= 1024 * 1024, 'Fixed dist JSON exceeds its bound')
        dist = fixed_dist(json.loads(dist_json.read_text()))
        verify_tarball(package_tarball, dist)
        shutil.copyfile(package_tarball, archive)
    else:
        private_cache = private_cache_copy(cache, work)
        try:
            dist = fixed_dist(json.loads(invoke([*base, '--cache=' + str(private_cache), 'view', 'pnpm@' + VERSION, 'dist', '--json'], env, work)))
            packed = json.loads(invoke([*base, '--cache=' + str(private_cache), 'pack', 'pnpm@' + VERSION,
                                        '--pack-destination=' + str(work / 'downloads'), '--json'], env, work))
            require(isinstance(packed, list) and len(packed) == 1 and packed[0].get('filename') == archive.name, 'Unexpected npm pack output')
        except PreparationError as error:
            if error.code != 'PNPM_OFFLINE_CACHE_MISS' or not allow_download:
                raise
            if dist is None:
                metadata = json.loads(fetch(METADATA, 1024 * 1024))
                require(metadata.get('name') == 'pnpm' and metadata.get('version') == VERSION, 'Official package identity mismatch')
                dist = fixed_dist(metadata.get('dist'))
            archive.write_bytes(fetch(TARBALL, 64 * 1024 * 1024))
    verify_tarball(archive, dist)
    stage = work / 'version'
    stage.mkdir(mode=0o700)
    invoke([*base, '--cache=' + str(work / 'install-cache'), '--global', '--prefix=' + str(stage),
            '--bin-links=false', '--package-lock=false', 'install', str(archive)], env, work)
    tree_inventory(stage)
    entrypoint = validate_installed(stage, node, env, invoke)
    for directory, _, leaves in os.walk(stage, topdown=False):
        for name in leaves:
            file = Path(directory) / name
            executable = bool(file.stat().st_mode & 0o111) or file == stage / entrypoint
            file.chmod(0o555 if executable else 0o444)
        Path(directory).chmod(0o555)
    files, tree_hash = tree_inventory(stage, readonly=True)
    receipt = {'schemaVersion': 1, 'package': 'pnpm', 'version': VERSION, 'entrypoint': entrypoint,
               'source': {**dist, 'sha256': sha256(archive)}, 'files': files, 'treeSha256': tree_hash}
    require(not target.exists() and not target.is_symlink(), 'Target appeared during preparation; existing version is preserved')
    stage.rename(target)
    with receipt_file.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(receipt, stream, ensure_ascii=True, indent=2)
        stream.write('\n')
    receipt_file.chmod(0o444)
    return {'status': 'ready', 'idempotent': False, 'root': str(target), 'receipt': str(receipt_file),
            'receiptSha256': sha256(receipt_file), 'treeSha256': tree_hash, 'entrypoint': entrypoint}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('candidate-root', 'node', 'npm-cli'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--npm-cache')
    parser.add_argument('--package-tarball')
    parser.add_argument('--dist-json')
    parser.add_argument('--allow-download', action='store_true', help='Fetch only missing official pnpm 10.34.5 metadata/tarball after an offline cache miss')
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.candidate_root, args.npm_cache, args.node, args.npm_cli, args.allow_download,
                                 package_tarball=args.package_tarball, dist_json=args.dist_json)))
    except PreparationError as error:
        print(json.dumps({'status': 'cache-miss' if error.code == 'PNPM_OFFLINE_CACHE_MISS' else 'failed', 'code': error.code, 'message': str(error)}))
        return 4 if error.code == 'PNPM_OFFLINE_CACHE_MISS' else 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
