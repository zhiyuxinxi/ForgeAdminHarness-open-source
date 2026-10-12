"""Prepare one frozen offline image context. Never invokes Git, Docker or SSH.

Root supplies a git-archive TAR of the final reviewed commit. Existing cached
mysql2 bytes supply only seven new packages; all old runtime bytes are inherited.
"""
import argparse
import copy
import hashlib
import json
import pathlib
import re
import shlex
import tarfile

TAG = 'forge-harness:delivery-center-20261007-4'
BASE_REFERENCE = 'forge-delivery/deepseek-harness:0.1.1-rc.2-vpn77-base'
BASE = 'sha256:c5f2c1c506d82a4212a271d1c9ef5c0bde9715deda25e733b5fe54356c0f30bb'
CACHE_SHA = '86ce52b70df2220fd9e0c81cbb0c345c47080392e862f2075cffeb169183385c'
BASE_LOCK_SHA = '03ee6414309bd0899578f2b588b3acd2b7c02321e046d4f13328a883fee6d58e'
BASE_LOCK_CANONICAL_SHA = '09e5aa9125e65ca385614d9b6e17ae9dd45436de8a020fcf7a969d9ca7dfc113'
ADDED = ['aws-ssl-profiles', 'generate-function', 'is-property', 'lru.min', 'mysql2', 'named-placeholders', 'sql-escaper']
HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def put(root, name, data):
    portable = pathlib.PurePosixPath(name)
    assert not portable.is_absolute() and '..' not in portable.parts
    target = root.joinpath(*portable.parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    target.chmod(0o644)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-archive', type=pathlib.Path, required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--cache', type=pathlib.Path, default=REPO / 'output/delivery-center-cache/delivery-center-9ec54dad12d12a7ea6e31f5144c12ef7f35bd90d4e61ab6e3a05250a29b0da0d.tar.gz')
    args = parser.parse_args()
    assert re.fullmatch('[a-f0-9]{40}', args.commit), 'Full reviewed commit required'
    assert re.fullmatch('[A-Za-z0-9._-]+', args.revision)
    assert not args.output.exists(), 'Preserve prior preparation; select a new explicit output'
    assert sha(args.cache.read_bytes()) == CACHE_SHA, 'Cached dependency archive changed'
    lock_name = 'docker/harness/runtime-dependencies/package-lock.json'
    with tarfile.open(args.source_archive) as archive:
        assert archive.pax_headers.get('comment') == args.commit, 'Source archive must be git archive of the exact commit'
        members = {member.name: member for member in archive.getmembers()}

        def source(name):
            member = members[name]
            assert member.isfile() and member.size <= 16 * 1024 * 1024, name
            return archive.extractfile(member).read()

        spec = json.loads(source('docker/harness/image-build-inputs.json'))
        consumer_program = source('scripts/verify-delivery-center-image.mjs')
        selected = {'config/delivery-center-image.json', 'docker/harness/skills.catalog.json', *spec['dockerfiles']}
        for mapping in spec['mappings']:
            if mapping['type'] == 'file':
                selected.add(mapping['source'])
            else:
                assert mapping['type'] == 'tree'
                prefix = mapping['source'].rstrip('/') + '/'
                selected.update(name for name, item in members.items() if name.startswith(prefix) and item.isfile())
        assert len(selected) < 1000
        frozen = {name: source(name) for name in sorted(selected)}
    new_lock = json.loads(frozen[lock_name])
    expected_added = {'node_modules/' + name for name in ADDED}
    # Derive the reviewed baseline expectation, independently pinned by hash.
    # This avoids relying on an unrelated historical preparation script.
    old_lock = copy.deepcopy(new_lock)
    for name in expected_added:
        del old_lock['packages'][name]
    del old_lock['packages']['']['dependencies']['mysql2']
    old_lock_raw = json.dumps(old_lock, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    assert sha(old_lock_raw) == BASE_LOCK_CANONICAL_SHA, 'Existing runtime lock bindings must remain unchanged'
    assert all(not new_lock['packages'][key].get('hasInstallScript') for key in expected_added)
    overlay = frozen['docker/harness/Dockerfile.overlay'].decode('utf-8')
    first, second, remainder = overlay.split('\n', 2)
    assert first.startswith('ARG HARNESS_BASE_IMAGE=') and second.strip() == 'FROM ${HARNESS_BASE_IMAGE}'
    assert 'INSTALL_DOCUMENT_DEPENDENCIES' in remainder
    values = dict(row.split('=', 1) for row in frozen['config/versions.env'].decode().splitlines()
                  if row and not row.startswith('#') and '=' in row)
    # The delivery center uses dedicated runtime env pins. Preserve global
    # Harness/Manager/Acceptance/Runner version settings from the source commit.
    pin = json.loads(frozen['config/delivery-center-image.json'])
    assert pin == {'schemaVersion': 1, 'image': TAG, 'revision': args.revision, 'projectSlug': 'forge-base'}
    added_files = {}
    with tarfile.open(args.cache) as cache:
        manifest = json.load(cache.extractfile('bundle-manifest.json'))
        for name, evidence in manifest['files'].items():
            if not any(name.startswith('node_modules/' + package + '/') for package in ADDED):
                continue
            member = cache.getmember(name)
            assert member.isfile() and member.size == evidence['bytes']
            raw = cache.extractfile(member).read()
            assert sha(raw) == evidence['sha256'], name
            added_files[name.removeprefix('node_modules/')] = raw
    for name in ADDED:
        package = json.loads(added_files[name + '/package.json'])
        assert package['name'] == name and package['version'] == new_lock['packages']['node_modules/' + name]['version']
        assert not set(package.get('scripts', {})) & {'preinstall', 'install', 'postinstall'}
    context = args.output / 'context'
    context.mkdir(parents=True)
    put(args.output, 'verify-delivery-center-image.mjs', consumer_program)
    for name, raw in frozen.items():
        put(context, name, raw)
    for name, raw in added_files.items():
        put(context, '.delivery-center-runtime/packages/' + name, raw)
    put(context, '.delivery-center-runtime/old-package-lock.json', old_lock_raw)
    put(context, '.delivery-center-runtime/added.json', json.dumps(sorted(expected_added)).encode())
    # A real receipt is generated after adding the seven packages. No parent
    # receipt is rewritten to pretend the old dependency tree already had them.
    seed = '''import fs from 'node:fs';
import assert from 'node:assert/strict';
const root='/opt/forge-harness-runtime';
const old=JSON.parse(fs.readFileSync('/tmp/delivery-runtime/old-package-lock.json'));
const current=JSON.parse(fs.readFileSync(root+'/package-lock.json'));
const hidden=JSON.parse(fs.readFileSync(root+'/node_modules/.package-lock.json'));
const added=JSON.parse(fs.readFileSync('/tmp/delivery-runtime/added.json'));
for(const [key,value] of Object.entries(old.packages))if(key)assert.deepEqual(current.packages[key],value);
assert.deepEqual(Object.keys(current.packages).filter(key=>!Object.hasOwn(old.packages,key)).sort(),added);
for(const key of added){assert(!Object.hasOwn(hidden.packages,key));hidden.packages[key]=current.packages[key];}
fs.writeFileSync(root+'/node_modules/.package-lock.json',JSON.stringify(hidden,null,2)+'\\n',{mode:0o644});
'''
    put(context, '.delivery-center-runtime/seed.mjs', seed.encode())
    seed_stage = f'''ARG HARNESS_BASE_IMAGE={BASE_REFERENCE}
FROM ${{HARNESS_BASE_IMAGE}} AS delivery-runtime
USER 0:0
RUN node /usr/local/lib/validate-runtime-dependencies.mjs --root /opt/forge-harness-runtime --smoke --json >/tmp/delivery-parent-receipt.json \\
 && node -e 'const f=require("fs");const a=JSON.parse(f.readFileSync("/tmp/delivery-parent-receipt.json"));const b=JSON.parse(f.readFileSync("/usr/local/share/forge-image-build/runtime-dependency-receipt.json"));if(a.digest!==b.digest)process.exit(1)' \\
 && test "$(sha256sum /opt/forge-harness-runtime/package-lock.json | cut -d ' ' -f 1)" = '{BASE_LOCK_SHA}'
COPY --chown=0:0 --chmod=0644 docker/harness/runtime-dependencies/package.json docker/harness/runtime-dependencies/package-lock.json /opt/forge-harness-runtime/
COPY --chown=0:0 .delivery-center-runtime/packages/ /opt/forge-harness-runtime/node_modules/
COPY --chown=0:0 --chmod=0644 .delivery-center-runtime/old-package-lock.json .delivery-center-runtime/added.json .delivery-center-runtime/seed.mjs /tmp/delivery-runtime/
RUN chmod 0755 /opt/forge-harness-runtime /opt/forge-harness-runtime/node_modules \\
 && node /tmp/delivery-runtime/seed.mjs \\
 && /usr/local/lib/validate-runtime-tree-metadata.sh /opt/forge-harness-runtime \\
 && node /usr/local/lib/validate-runtime-dependencies.mjs --root /opt/forge-harness-runtime --smoke --json >/usr/local/share/forge-image-build/runtime-dependency-receipt.json \\
 && NODE_PATH=/opt/forge-harness-runtime/node_modules node -e 'if(typeof require("mysql2/promise").createPool!=="function")process.exit(1)' \\
 && rm -rf /tmp/delivery-runtime /tmp/delivery-parent-receipt.json
FROM delivery-runtime
'''
    recipe = seed_stage + remainder
    put(context, 'Dockerfile.delivery-center', recipe.encode())
    for directory in [context, *[entry for entry in context.rglob('*') if entry.is_dir()]]:
        directory.chmod(0o755)
    build = ['docker', 'buildx', 'build', '--load', '--network=none', '--pull=false',
             '--build-arg', 'HARNESS_BASE_IMAGE=' + BASE_REFERENCE, '--build-arg', 'HARNESS_BASE_IMAGE_ID=' + BASE,
             '--build-arg', 'INSTALL_DOCUMENT_DEPENDENCIES=false', '--tag', TAG,
             '--label', 'org.opencontainers.image.source-commit=' + args.commit]
    for key in ['DSH_VERSION', 'HARNESS_IMAGE_REVISION', 'HARNESS_SKILL_BUNDLE_VERSION', 'HARNESS_RUNTIME_PROFILE',
                'PDFJS_DIST_VERSION', 'MAMMOTH_VERSION', 'READ_EXCEL_FILE_VERSION', 'YAUZL_VERSION']:
        build += ['--build-arg', key + '=' + (args.revision if key == 'HARNESS_IMAGE_REVISION' else values[key])]
    build += ['--file', 'Dockerfile.delivery-center', '.']
    hashes = {name: sha(raw) for name, raw in frozen.items()}
    image_files = {}
    for row in spec['mappings']:
        if row['type'] == 'file':
            image_files['/' + row['destination']] = hashes[row['source']]
        else:
            prefix = row['source'].rstrip('/') + '/'
            image_files.update({'/' + row['destination'].rstrip('/') + '/' + name[len(prefix):]: value
                                for name, value in hashes.items() if name.startswith(prefix)})
    proof = {'schemaVersion': 1, 'sourceCommit': args.commit, 'sourceArchiveSha256': sha(args.source_archive.read_bytes()),
             'baseImageReference': BASE_REFERENCE, 'baseImageId': BASE, 'tag': TAG, 'revision': args.revision, 'sourceFiles': hashes,
             'imageFiles': image_files, 'newPackages': sorted(expected_added),
             'dependencyArchiveSha256': CACHE_SHA, 'dependencyFiles': {name: sha(raw) for name, raw in added_files.items()},
             'recipeSha256': sha(recipe.encode()), 'buildArguments': build,
             'workingTreeSourceBytesUsed': 0, 'buildsExecuted': 0, 'remoteWrites': 0}
    put(args.output, 'preparation.json', (json.dumps(proof, indent=2) + '\n').encode())
    put(args.output, 'build-command.txt', (shlex.join(build) + '\n').encode())
    print(json.dumps({'status': 'prepared-only', 'sourceCommit': args.commit, 'mappedFiles': len(image_files),
                      'newPackages': len(ADDED), 'dependencyFiles': len(added_files), 'buildsExecuted': 0}))


if __name__ == '__main__':
    main()
