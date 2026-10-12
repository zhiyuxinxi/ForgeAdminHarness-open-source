#!/usr/bin/env python3
"""Export forge-base's existing BuildKit dependencies, without network or cache writes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile

PROJECT = Path('/srv/forge-delivery/projects/forge-base')
CANARY = Path('/srv/forge-delivery/canary')
COMPOSE_PROJECT_NAME = 'forge-forge-base'
# The deployed forge-base Compose has no cache namespace argument (evidence 087).
NAMESPACE = ''
SCHEMA = 'forge-buildkit-dependency-export/v1'
INVENTORY = 'export-inventory.json'
MAX_ARCHIVE_BYTES = 4 * 1024**3
MAX_PAYLOAD_BYTES = 4 * 1024**3
MAX_FILE_BYTES = 1024**3
MAX_ARCHIVE_MEMBERS = 250_000
EXCLUSIONS = ['pnpm/store/projects/', 'pnpm/store/v*/projects/', '*.lastUpdated', '*.part', '*.part.lock']
COPY_SCRIPT = r'''import fs from 'node:fs';
import path from 'node:path';
const require = (ok, message) => { if (!ok) throw Error(message); };
require(/^[a-z0-9][a-z0-9.-]{0,95}$/.test(process.argv[2] ?? ''), 'Export run identity is required');
require(!fs.existsSync('/export'), 'Export root already exists');
const roots = [['/root/.m2/repository', '/export/m2/repository'], ['/pnpm-store', '/export/pnpm/store']];
for (const [source, target] of roots) {
  let count = 0;
  const visit = (src, dst, relative = '') => {
    const parts = relative.split('/');
    if (source === '/pnpm-store' && (parts[0] === 'projects'
      || (/^v[0-9]+$/.test(parts[0]) && parts[1] === 'projects'))) return;
    if (/\.(?:lastUpdated|part|part\.lock)$/.test(path.basename(src))) return;
    const before = fs.lstatSync(src, { bigint: true });
    require(!before.isSymbolicLink() && (before.isDirectory() || before.isFile()), 'Non-ordinary dependency node: ' + relative);
    require(!['.npmrc', 'settings.xml', 'settings-security.xml'].includes(path.basename(src)), 'Configuration is not dependency payload');
    if (before.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(src).sort()) visit(path.join(src, name), path.join(dst, name), relative ? relative + '/' + name : name);
    } else {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      const after = fs.lstatSync(src, { bigint: true });
      require(after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
        && before.size === after.size && before.mtimeNs === after.mtimeNs, 'Dependency changed during export: ' + relative);
      count++;
    }
  };
  visit(source, target);
  require(count > 0, 'Existing cache is empty: ' + source);
}
'''


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def no_symlink_ancestors(value):
    for item in [value, *value.parents]:
        try:
            metadata = item.lstat()
        except FileNotFoundError:
            continue
        require(not stat.S_ISLNK(metadata.st_mode), 'Symbolic-link path is not allowed')


def validate_paths(project_root, output_root):
    require(project_root == PROJECT, 'Only the reviewed forge-base project is supported')
    require(output_root.is_absolute() and output_root.parent == CANARY
            and re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,95}', output_root.name) is not None,
            'Output must be a named direct child of the reviewed canary directory')
    no_symlink_ancestors(project_root)
    no_symlink_ancestors(output_root)
    require(project_root.is_dir() and CANARY.is_dir(), 'Reviewed project/canary roots must exist')


def read_source_binding(project_root):
    env_file = project_root / 'ops/project.env'
    no_symlink_ancestors(env_file)
    require(stat.S_ISREG(env_file.lstat().st_mode), 'Project environment is not an ordinary file')
    values = []
    for line in env_file.read_text(encoding='utf-8').splitlines():
        if re.match(r'^\s*COMPOSE_PROJECT_NAME\s*=', line):
            values.append(line.split('=', 1)[1].strip())
    require(values in ([COMPOSE_PROJECT_NAME], ["'" + COMPOSE_PROJECT_NAME + "'"], ['"' + COMPOSE_PROJECT_NAME + '"']),
            'Project Compose namespace differs from the reviewed forge-base namespace')
    compose_file = project_root / 'ops/compose.yaml'
    no_symlink_ancestors(compose_file)
    require(stat.S_ISREG(compose_file.lstat().st_mode), 'Project Compose is not an ordinary file')
    compose = compose_file.read_bytes()
    require(b'BUILDKIT_CACHE_MOUNT_NS' not in compose, 'Actual Compose cache namespace differs from reviewed empty namespace')
    return {'namespace': NAMESPACE, 'composeProjectName': COMPOSE_PROJECT_NAME, 'composeSha256': digest(compose)}


def validate_image(reference, image_id):
    require(re.fullmatch(r'[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?(?:@sha256:[0-9a-f]{64})?', reference) is not None
            and not reference.startswith('sha256:'), 'Parent image must be an existing local named reference')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', image_id) is not None, 'Exact immutable parent image ID is required')


def inspect_image(reference, expected):
    result = subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', reference],
                            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    require(result.stdout.strip() == expected, 'Local parent image does not match its pinned image ID')


def dockerfile():
    return ('ARG PARENT_IMAGE\nFROM ${PARENT_IMAGE} AS dependency-export\nUSER 0:0\n'
            'COPY export-cache.mjs /tmp/forge-export-cache.mjs\n'
            'ARG EXPORT_RUN_ID\n'
            'RUN --network=none --mount=type=cache,target=/root/.m2,sharing=locked,readonly '
            '--mount=type=cache,target=/pnpm-store,sharing=locked,readonly '
            'node /tmp/forge-export-cache.mjs "$EXPORT_RUN_ID"\n'
            'FROM scratch\nCOPY --from=dependency-export /export/ /\n')


def build_argv(context, archive_path, reference, namespace, export_run_id):
    require(namespace == NAMESPACE, 'Unreviewed cache namespace')
    require(re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,95}', export_run_id) is not None, 'Invalid export run identity')
    # --no-cache also invalidates cache mounts (moby/buildkit#1092). A unique RUN
    # input reruns only the export instruction while retaining the source cache.
    return ['docker', 'build', '--pull=false', '--network=none', '--progress=plain',
            '--build-arg', 'BUILDKIT_CACHE_MOUNT_NS=' + namespace,
            '--build-arg', 'PARENT_IMAGE=' + reference,
            '--build-arg', 'EXPORT_RUN_ID=' + export_run_id,
            '--output', 'type=tar,dest=' + str(archive_path), str(context)]


def extract_archive(archive_path, export_root):
    """Expand a retained BuildKit tar into a new private directory; never replay partials."""
    archive_path, export_root = Path(archive_path), Path(export_root)
    no_symlink_ancestors(archive_path)
    no_symlink_ancestors(export_root)
    before = archive_path.lstat()
    require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= MAX_ARCHIVE_BYTES,
            'Archive must be an ordinary file within the fixed size limit')
    require(not export_root.exists(), 'Partial extraction retained; destination must be new')
    require(export_root.parent.is_dir(), 'Extraction parent must already exist')
    export_root.mkdir(mode=0o700)
    seen, count, payload_bytes = set(), 0, 0
    with archive_path.open('rb') as handle:
        opened = os.fstat(handle.fileno())
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                == (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns),
                'Archive changed before extraction')
        with tarfile.open(fileobj=handle, mode='r:') as bundle:
            for index, member in enumerate(bundle, 1):
                require(index <= MAX_ARCHIVE_MEMBERS, 'Archive exceeds the fixed member count limit')
                require(member.type in (tarfile.DIRTYPE, tarfile.REGTYPE, tarfile.AREGTYPE)
                        and member.sparse is None
                        and not any(key.startswith('GNU.sparse') for key in member.pax_headers),
                        'Archive contains a link, special or sparse node')
                name = member.name
                require(not any(value in name for value in ('\\', ':', '\x00')) and not name.startswith('/'),
                        'Archive path is not a safe relative path')
                if name.startswith('./'):
                    name = name[2:]
                if member.isdir() and name.endswith('/'):
                    name = name[:-1]
                if member.isdir() and name in ('', '.'):
                    name = '.'
                else:
                    require(all(part not in ('', '.', '..') for part in name.split('/')),
                            'Archive path contains an empty or escaping component')
                require(name not in seen, 'Archive contains a duplicate path')
                seen.add(name)
                require(name in {'.', 'm2', 'm2/repository', 'pnpm', 'pnpm/store'} and member.isdir()
                        or name.startswith(('m2/repository/', 'pnpm/store/')),
                        'Archive path escaped dependency payload roots')
                target = export_root if name == '.' else export_root.joinpath(*name.split('/'))
                if member.isdir():
                    require(member.size == 0, 'Archive directory has unexpected payload')
                    target.mkdir(mode=0o700, parents=True, exist_ok=True)
                    continue
                require(0 <= member.size <= MAX_FILE_BYTES, 'Archive file exceeds the fixed size limit')
                payload_bytes += member.size
                require(payload_bytes <= MAX_PAYLOAD_BYTES, 'Archive exceeds the fixed payload size limit')
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, target.open('xb') as destination:
                    remaining = member.size
                    while remaining:
                        block = source.read(min(1024 * 1024, remaining))
                        require(bool(block), 'Archive file is truncated')
                        destination.write(block)
                        remaining -= len(block)
                target.chmod(0o700 if member.mode & 0o111 else 0o600)
                count += 1
        after = os.fstat(handle.fileno())
        require((opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
                'Archive changed during extraction')
    require(count > 0, 'Archive contains no dependency files')
    return {'files': count, 'bytes': payload_bytes}


def digest(content):
    return hashlib.sha256(content).hexdigest()


def tree_hash(files):
    return digest(json.dumps(files, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))


def inventory(export_root, require_readonly=False):
    require(export_root.is_dir() and not export_root.is_symlink(), 'Export root must be an ordinary directory')
    require({p.name for p in export_root.iterdir()} - {INVENTORY} == {'m2', 'pnpm'}, 'Unexpected export root inventory')
    files = []

    def visit(entry):
        metadata = entry.lstat()
        require(not stat.S_ISLNK(metadata.st_mode) and (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)),
                'Export contains a link or special node')
        require(not require_readonly or not metadata.st_mode & 0o222, 'Export is not frozen read-only')
        if entry.is_dir():
            relative = entry.relative_to(export_root).as_posix()
            require(relative in {'.', 'm2', 'm2/repository', 'pnpm', 'pnpm/store'}
                    or relative.startswith(('m2/repository/', 'pnpm/store/')), 'Directory escaped dependency payload roots')
            for child in sorted(entry.iterdir()):
                visit(child)
        elif entry.name != INVENTORY or entry.parent != export_root:
            relative = entry.relative_to(export_root).as_posix()
            require(relative.startswith(('m2/repository/', 'pnpm/store/')), 'File escaped dependency payload roots')
            require(metadata.st_nlink == 1, 'Export must contain independent file copies')
            require(entry.name not in {'.npmrc', 'settings.xml', 'settings-security.xml'}
                    and not re.search(r'\.(?:lastUpdated|part|part\.lock)$', entry.name)
                    and not re.match(r'^pnpm/store/(?:v[0-9]+/)?projects(?:/|$)', relative),
                    'Configuration or temporary metadata escaped the export filter')
            content = entry.read_bytes()
            after = entry.lstat()
            require((metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns)
                    == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'Export changed while hashing')
            files.append({'path': relative, 'bytes': len(content), 'sha256': digest(content)})

    visit(export_root)
    files.sort(key=lambda item: item['path'])
    require(all(any(item['path'].startswith(prefix) for item in files)
                for prefix in ('m2/repository/', 'pnpm/store/')), 'Both existing dependency caches must contain files')
    return files


def freeze(root):
    for directory, directories, files in os.walk(root, topdown=False):
        for name in files:
            entry = Path(directory) / name
            entry.chmod(0o555 if entry.lstat().st_mode & 0o111 else 0o444)
        for name in directories:
            (Path(directory) / name).chmod(0o555)
    root.chmod(0o555)


def result(export_root, raw, reused):
    return {'status': 'exported-unverified', 'seedSource': str(export_root),
            'exportInventorySha256': digest(raw), 'reused': reused}


def finalize_export(export_root, source):
    """Inventory and freeze an extracted payload; this does not prove seed compatibility."""
    export_root = Path(export_root)
    files = inventory(export_root)
    document = {'schemaVersion': SCHEMA, 'status': 'exported-unverified', 'source': source,
                'files': files, 'treeSha256': tree_hash(files)}
    raw = (json.dumps(document, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    with (export_root / INVENTORY).open('xb') as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    freeze(export_root)
    require(inventory(export_root, require_readonly=True) == files, 'Frozen export inventory changed')
    return result(export_root, raw, False)


def export_dependencies(project_root, output_root, reference, image_id):
    validate_paths(project_root, output_root)
    binding = read_source_binding(project_root)
    namespace = binding['namespace']
    validate_image(reference, image_id)
    inspect_image(reference, image_id)
    source = {'project': 'forge-base', **binding, 'cacheTargets': ['/root/.m2', '/pnpm-store'],
              'parentImage': {'reference': reference, 'imageId': image_id}, 'exclusions': EXCLUSIONS}
    export_root = output_root / 'export'
    manifest = export_root / INVENTORY
    if output_root.exists():
        no_symlink_ancestors(manifest)
        require(manifest.is_file() and not manifest.is_symlink(), 'Partial export retained; no blind overwrite or replay')
        raw = manifest.read_bytes()
        previous = json.loads(raw)
        files = inventory(export_root, require_readonly=True)
        require(previous == {'schemaVersion': SCHEMA, 'status': 'exported-unverified', 'source': source,
                             'files': files, 'treeSha256': tree_hash(files)}, 'Existing export differs from requested immutable source')
        return result(export_root, raw, True)
    output_root.mkdir(mode=0o700)
    context = output_root / 'context'
    context.mkdir(mode=0o700)
    (context / 'Dockerfile').write_text(dockerfile(), encoding='utf-8', newline='\n')
    (context / 'export-cache.mjs').write_text(COPY_SCRIPT, encoding='utf-8', newline='\n')
    archive_path = output_root / 'payload.tar'
    with (output_root / 'build.log').open('xb') as log:
        subprocess.run(build_argv(context, archive_path, reference, namespace, output_root.name), check=True,
                       env={**os.environ, 'DOCKER_BUILDKIT': '1'}, stdout=log, stderr=subprocess.STDOUT)
    inspect_image(reference, image_id)
    extract_archive(archive_path, export_root)
    return finalize_export(export_root, source)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-root', type=Path, default=PROJECT)
    parser.add_argument('--output-root', type=Path, required=True)
    parser.add_argument('--parent-image', required=True)
    parser.add_argument('--parent-image-id', required=True)
    args = parser.parse_args()
    print(json.dumps(export_dependencies(args.project_root, args.output_root, args.parent_image, args.parent_image_id)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error': str(error), 'outputsRetained': True}), file=sys.stderr)
        sys.exit(1)
