#!/usr/bin/env python3
"""Prepare one versioned native Host locally; never install, enable or start a unit."""
import argparse
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess


BRANCHES = {'stable': '32.12', 'enhanced': 'main'}
IDENTITY = re.compile(r'[a-z0-9][a-z0-9.-]{0,79}\Z')
COMMIT = re.compile(r'[a-f0-9]{40}\Z')
VERSION = re.compile(r'\d{4}\.\d{2}\.\d{2}\.\d+(?:-[a-z0-9.-]+)?\Z')


def need(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def safe_path(value):
    need(isinstance(value, str) and value.startswith('/')
         and not re.search(r'[\s\x00$`%\\]', value)
         and '..' not in PurePosixPath(value).parts, 'Unsafe target path')
    return value


def target_paths(project_root, channel, release):
    need(channel in BRANCHES and IDENTITY.fullmatch(release), 'Invalid channel or release')
    project_root = safe_path(project_root)
    version = f'{channel}/{release}'
    host = f'{project_root}/verification/runtime-versions/{version}'
    return {
        'runtimeRoot': f'{project_root}/runtime-versions/{version}',
        'hostRoot': host, 'contractPath': f'{host}/host-contract.json',
        'environmentPath': f'{host}/host-runner.env', 'stateRoot': f'{host}/host-state',
        'runnerSocket': f'{host}/ipc/runner.sock', 'sourceSocket': f'{host}/source-ipc/source.sock',
        'issuerSocket': f'{project_root}/acceptance/runtime-versions/{version}/ipc-issuer/issuer.sock',
        'bundleRoot': f'{project_root}/runtime-versions/{version}/host-bundle',
    }


def prepare(snapshot, channel, release, source_commit, bundle, environment_overrides=None):
    """Derive exact local candidates from an actual unit/contract snapshot."""
    need(COMMIT.fullmatch(source_commit), 'Invalid source commit')
    slug = snapshot['projectSlug']
    need(IDENTITY.fullmatch(slug), 'Invalid project slug')
    root = snapshot['projectRoot']
    need(PurePosixPath(root).name == slug, 'Project root does not match slug')
    paths = target_paths(root, channel, release)
    contract = copy.deepcopy(snapshot['contract'])
    old_env = snapshot['environment']
    need(contract['projectSlug'] == slug and contract['executionMode'] == 'host-toolchain', 'Host contract identity differs')
    need(contract['taskspacesRoot'] == root + '/taskspaces', 'Host taskspace scope differs')
    need(old_env['VERIFICATION_PROJECT_SLUG'] == slug
         and old_env['VERIFICATION_CONTRACT'] == snapshot['contractPath'], 'Environment/contract binding differs')
    need(VERSION.fullmatch(bundle['bundleVersion']), 'Invalid bundle version')
    paths['bundleInstallRoot'] = paths['bundleRoot']
    paths['bundleRoot'] += '/versions/' + bundle['bundleVersion']
    need(contract['profileCatalogVersion'] in bundle['compatibleProfileCatalogVersions'], 'Host bundle catalog mismatch')
    command = snapshot['runningCommand']
    need(len(command) == 2 and command[1].endswith('/lib/host-verification-runner.mjs'), 'Unsupported actual Host command')
    safe_path(command[0])
    node_match = re.search(r'/node-v(\d+)\.', command[0])
    need(node_match and int(node_match[1]) in bundle['compatibleNodeMajors'], 'Host Node compatibility unknown or mismatched')
    props = snapshot['properties']
    need(props.get('User') not in ('', 'root') and props.get('NoNewPrivileges') == 'yes'
         and props.get('ProtectSystem') == 'strict', 'Host identity or protections are unavailable')
    need(props.get('EnvironmentFiles', '').strip() == snapshot['environmentPath'] + ' (ignore_errors=no)',
         'Actual unit EnvironmentFiles differs from captured single file')
    need(snapshot['bundleManifest']['bundleVersion'] in command[1], 'Actual Host differs from captured bundle')
    contract['runnerRevision'] = 'forge-host-runner-' + bundle['bundleVersion']
    contract['stateRoot'] = paths['stateRoot']
    contract['toolchains']['forgeGovernance'] = paths['bundleRoot'] + '/bin/forge-governance'
    env = dict(old_env)
    # Linux AF_UNIX limits the address length, not the underlying mounted file path.
    # Keep project-private host sources and expose short names only inside this unit.
    socket_mounts = [(str(PurePosixPath(paths[key]).parent), '/run/forge-runtime-host/' + directory)
                     for key, directory in [('runnerSocket', 'ipc'), ('sourceSocket', 'source-ipc'),
                                            ('issuerSocket', 'ipc-issuer')]]
    env.update(VERIFICATION_CONTRACT=paths['contractPath'],
               VERIFICATION_RUNNER_SOCKET='/run/forge-runtime-host/ipc/runner.sock',
               VERIFICATION_SOURCE_SOCKET='/run/forge-runtime-host/source-ipc/source.sock',
               PROTECTED_ACCEPTANCE_ISSUER_SOCKET='/run/forge-runtime-host/ipc-issuer/issuer.sock')
    overrides = environment_overrides or {}
    need(set(overrides) <= {'FORGE_DEVELOPMENT_MODE', 'FORGE_SEMANTIC_INTENT_ENABLED'}, 'Unsupported Host feature override')
    for key, value in overrides.items():
        need(value in (['direct', 'controlled'] if key == 'FORGE_DEVELOPMENT_MODE' else ['true', 'false']), 'Invalid Host feature override')
    env.update(overrides)
    for key, value in env.items():
        need(re.fullmatch(r'[A-Z][A-Z0-9_]*', key) and isinstance(value, str)
             and not re.search(r'[\r\n\x00]', value), 'Unsafe environment entry')
        need(not re.search(r'(PASSWORD|TOKEN|API_KEY|SECRET)$', key), 'Host preparation accepts secret file references only')
    original_unit = snapshot['unitText']
    need('[Service]' in original_unit and not re.search(r'%[^i%]', original_unit), 'Unsupported unit specifier')
    unit = original_unit.replace('%i', slug)
    old_verify = root + '/verification'
    old_issuer = str(PurePosixPath(old_env['PROTECTED_ACCEPTANCE_ISSUER_SOCKET']).parent)
    writable = shlex.split(props.get('ReadWritePaths', ''))
    need(old_verify in writable and old_issuer in writable, 'Actual Host writable scopes are unavailable')
    # Retain original reviewed extra scopes; replace only the original two Host scopes.
    writable = [paths['hostRoot'] if p == old_verify else str(PurePosixPath(paths['issuerSocket']).parent)
                if p == old_issuer else p for p in writable]
    for entry in writable:
        safe_path(entry.removeprefix('-'))
    unit += '\n# Isolated runtime Host; original unit and drop-ins remain untouched.\n[Service]\n'
    unit += 'EnvironmentFile=\nEnvironmentFile=' + paths['environmentPath'] + '\n'
    unit += 'WorkingDirectory=' + paths['hostRoot'] + '\nExecStart=\nExecStart='
    unit += command[0] + ' ' + paths['bundleRoot'] + '/lib/host-verification-runner.mjs\n'
    unit += 'ReadWritePaths=\n' + ''.join('ReadWritePaths=' + p + '\n' for p in writable)
    unit += ''.join(f'BindPaths={source}:{target}\n' for source, target in socket_mounts)
    # Environment= has higher precedence than EnvironmentFile=; override only selected feature keys.
    unit += ''.join(f'Environment={key}={value}\n' for key, value in sorted(overrides.items()))
    unit_name = f'forge-host-verification-{slug}-{channel}-{release}.service'
    env_text = ''.join(f'{key}={json.dumps(value, ensure_ascii=False)}\n' for key, value in sorted(env.items()))
    return {'schemaVersion': 1, 'projectSlug': slug, 'channel': channel, 'release': release,
            'sourceBranch': BRANCHES[channel], 'sourceCommit': source_commit,
            'unitName': unit_name, 'unitPath': '/etc/systemd/system/' + unit_name,
            'paths': paths, 'contract': contract, 'environment': env, 'environmentText': env_text, 'unitText': unit,
            'bundle': {'version': bundle['bundleVersion'], 'treeSha256': bundle['treeSha256'],
                       'targetRoot': paths['bundleRoot'], 'installRoot': paths['bundleInstallRoot'],
                       'installer': 'bin/forge-host-runner-bundle.mjs', 'action': 'install', 'activationRequired': False},
            'directories': [paths['hostRoot'], paths['stateRoot'], str(PurePosixPath(paths['runnerSocket']).parent),
                            str(PurePosixPath(paths['sourceSocket']).parent)],
            'owner': {'user': props['User'], 'group': props['Group']},
            'preserved': ['project taskspaces', 'dependencySeed', 'preparedDependencies', 'testDatabase', 'inputScopes',
                          'existing unit and drop-ins', 'existing receipt/state directories', 'secret file references',
                          'original unit security and dependency bind mounts'],
            'before': {'unitName': snapshot['unitName'], 'mainPid': props['MainPID'],
                       'unitTextSha256': digest(original_unit.encode()),
                       'contractSha256': digest(json.dumps(snapshot['contract'], sort_keys=True).encode()),
                       'bundleManifestSha256': snapshot['bundleManifestSha256']},
            'preparedOnly': True, 'installed': False, 'started': False}


def run(args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True).stdout


def bind_bundle_sources(source_root, commit, manifest):
    prebuilt = {'docker/harness/backend-source-quality/runtime.zip',
                'docker/harness/backend-source-quality/runtime-manifest.json'}
    dependencies = {}
    for item in manifest['files']:
        target = item['path']
        source = ('scripts/' + target[4:] if target.startswith('bin/') and target != 'bin/forge-governance'
                  else 'docker/harness/' + target.split('/', 1)[1])
        if source in prebuilt:
            need(digest((source_root / source).read_bytes()) == item['sha256'], 'Prebuilt dependency differs from bundle')
            dependencies[source] = item['sha256']
        else:
            need(digest(run(['git', 'show', f'{commit}:{source}'], source_root)) == item['sha256'],
                 'Bundle member differs from fixed commit: ' + source)
    if dependencies:
        need(set(dependencies) == prebuilt, 'Prebuilt dependency inventory is incomplete')
        root = source_root / 'docker/harness/backend-source-quality'
        runtime = json.loads((root / 'runtime-manifest.json').read_text(encoding='utf-8'))
        specification = json.loads(run(['git', 'show', f'{commit}:docker/harness/backend-source-quality/manifest.json'], source_root))
        need(runtime['tools'] == specification['tools'], 'Prebuilt scanner versions differ from committed tools')
        need(runtime['archiveSha256'] == dependencies['docker/harness/backend-source-quality/runtime.zip'],
             'Prebuilt scanner archive differs from its manifest')
    return dependencies


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True, help='One captured Host object, or inventory containing hosts')
    parser.add_argument('--project', required=True)
    parser.add_argument('--channel', choices=BRANCHES, required=True)
    parser.add_argument('--release', required=True)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--bundle-version', required=True)
    parser.add_argument('--node', default='node')
    parser.add_argument('--development-mode', choices=['direct', 'controlled'], required=True)
    parser.add_argument('--semantic-intent-enabled', choices=['true', 'false'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.snapshot.read_text(encoding='utf-8'))
    entries = data.get('hosts', [data])
    matching = [entry for entry in entries if entry['projectSlug'] == args.project]
    need(len(matching) == 1, 'Exactly one actual Host snapshot is required')
    snapshot = matching[0]
    need(COMMIT.fullmatch(args.source_commit), 'Invalid source commit')
    head = run(['git', 'rev-parse', 'HEAD'], args.source_root).decode().strip()
    need(head == args.source_commit, 'Source checkout HEAD differs from fixed commit')
    builder_relative = 'scripts/forge-host-runner-bundle.mjs'
    builder = args.source_root / builder_relative
    need(builder.read_bytes() == run(['git', 'show', f'{head}:{builder_relative}'], args.source_root), 'Bundle builder is not committed at fixed source')
    need(not args.output.exists(), 'Output exists; preserve and inspect the earlier candidate')
    args.output.mkdir(parents=True)
    bundle_root = args.output / 'bundle'
    try:
        node_major = re.search(r'/node-v(\d+)\.', snapshot['runningCommand'][0])
        need(node_major is not None, 'Cannot bind actual Host Node major')
        build = [args.node, str(builder), 'build', '--source-root', str(args.source_root), '--output', str(bundle_root),
                 '--bundle-version', args.bundle_version, '--profile-catalog-version', snapshot['contract']['profileCatalogVersion'],
                 '--node-major', node_major[1]]
        run(build)
        manifest = json.loads((bundle_root / 'runner.manifest.json').read_text())
        # Source members bind to Git. Ignored prebuilt jars bind separately to
        # their runtime manifest and the committed scanner tool versions.
        dependencies = bind_bundle_sources(args.source_root, head, manifest)
        plan = prepare(snapshot, args.channel, args.release, head, manifest,
                       {'FORGE_DEVELOPMENT_MODE': args.development_mode, 'FORGE_SEMANTIC_INTENT_ENABLED': args.semantic_intent_enabled})
        plan['bundle']['manifestSha256'] = digest((bundle_root / 'runner.manifest.json').read_bytes())
        plan['bundle']['prebuiltDependencies'] = dependencies
        contract_file = args.output / 'host-contract.json'
        contract_file.write_text(json.dumps(plan['contract'], indent=2) + '\n', encoding='utf-8')
        # The branch's actual validator must accept the preserved project policy.
        validation = "import fs from 'node:fs';import{pathToFileURL}from'node:url';const m=await import(pathToFileURL(process.argv[1]));m.validateHostVerificationContract(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),process.argv[3]);"
        run([args.node, '--input-type=module', '-e', validation, str(bundle_root/'lib/host-verify-policy.mjs'), str(contract_file), args.project])
        (args.output / 'host-runner.env').write_text(plan['environmentText'], encoding='utf-8')
        (args.output / plan['unitName']).write_text(plan['unitText'], encoding='utf-8')
        (args.output / 'host-spec.json').write_text(json.dumps(plan, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'preparedOnly': True, 'hostSpec': str(args.output/'host-spec.json'), 'unitName': plan['unitName'], 'bundle': plan['bundle']}))
    except Exception as exc:
        error = {'preparedOnly': True, 'status': 'failed', 'error': str(exc), 'candidatePreserved': True}
        if isinstance(exc, subprocess.CalledProcessError): error['stderr'] = exc.stderr.decode('utf-8', 'replace')[:2000]
        (args.output / 'preparation-failure.json').write_text(json.dumps(error, indent=2) + '\n', encoding='utf-8')
        raise


if __name__ == '__main__':
    main()
