#!/usr/bin/env python3
"""Prepare branch-bound control services from actual containers; never replace them."""
import argparse
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import urllib.parse

ROLES = ('protected-acceptance', 'verification-runner', 'release-runner', 'taskspace-broker', 'conversation-manager')
ENV_KEYS = ('FORGE_DEVELOPMENT_MODE', 'FORGE_SEMANTIC_INTENT_ENABLED',
            'FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED', 'FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED',
            'FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED', 'FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED',
            'FORGE_CHANGED_VERIFICATION_SUPPORTED', 'FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED',
            'FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def run(argv):
    result = subprocess.run(argv, capture_output=True, timeout=30, check=False)
    if result.returncode:
        raise RuntimeError('Command failed: %s; stderrSha256=%s' % (argv[0], hashlib.sha256(result.stderr).hexdigest()))
    return result.stdout


def inspect(identity):
    return json.loads(run(['docker', 'inspect', identity]))[0]


def contained(path, root):
    path, root = Path(path), Path(root)
    if not path.is_absolute() or path == root or root not in path.parents or any(c in str(path) for c in '\n\r\0$`'):
        raise ValueError('Runtime path is outside its expected project directory.')
    return str(path)


def env_dict(container):
    entries = container['Config'].get('Env') or []
    values = dict(item.split('=', 1) for item in entries)
    if len(values) != len(entries):
        raise ValueError('Source container has duplicate environment keys.')
    return values


def source_fingerprint(container):
    value = {key: container[key] for key in ('Id', 'Image', 'Config', 'HostConfig')}
    value['Networks'] = {name: {key: endpoint.get(key) for key in ('IPAMConfig', 'Aliases', 'DriverOpts', 'Links')}
                         for name, endpoint in (container.get('NetworkSettings', {}).get('Networks') or {}).items()}
    return digest(value)


def mount_sources(container):
    return {item['Destination']: item['Source'] for item in container.get('Mounts', [])}


def replace_mount_sources(host, replacements):
    seen = set()
    binds = []
    for bind in host.get('Binds') or []:
        pieces = bind.split(':')
        if len(pieces) not in (2, 3):
            raise ValueError('Unexpected source bind syntax.')
        if pieces[1] in replacements:
            pieces[0] = replacements[pieces[1]]
            seen.add(pieces[1])
        binds.append(':'.join(pieces))
    if host.get('Binds') is not None:
        host['Binds'] = binds
    for mount in host.get('Mounts') or []:
        target = mount.get('Target')
        if target in replacements:
            if mount.get('Type') != 'bind':
                raise ValueError('A runtime IPC/state target is not a host bind.')
            mount['Source'] = replacements[target]
            seen.add(target)
    if set(replacements) - seen:
        raise ValueError('A required runtime mount was absent from source HostConfig.')


def endpoints(container, service, name):
    result = {}
    for network, source in (container.get('NetworkSettings', {}).get('Networks') or {}).items():
        if network == 'none':
            continue
        ipam = source.get('IPAMConfig') or {}
        if ipam.get('IPv4Address') or ipam.get('IPv6Address') or ipam.get('LinkLocalIPs') or source.get('Links'):
            raise ValueError('Static network addressing/links require an explicit runtime network plan.')
        result[network] = {'Aliases': [service, name]}
        if source.get('DriverOpts'):
            result[network]['DriverOpts'] = copy.deepcopy(source['DriverOpts'])
    return result


def candidate(container, role, project, release, binding, platform_root, verification_contract):
    channel = binding['channel']
    slug = project.name
    runtime = project / 'runtime-versions' / channel / release
    acceptance = project / 'acceptance/runtime-versions' / channel / release
    verification = project / 'verification/runtime-versions' / channel / release
    service = role + '-' + channel
    name = 'forge-%s-%s-%s' % (slug, service, release)
    config, host = copy.deepcopy(container['Config']), copy.deepcopy(container['HostConfig'])
    if host.get('PortBindings') or host.get('Privileged') or host.get('AutoRemove'):
        raise ValueError('Control service has unexpected ports, privilege or auto-removal.')
    if any(str(host.get(key, '')).startswith('container:') for key in ('NetworkMode', 'IpcMode', 'PidMode')):
        raise ValueError('Shared container namespaces cannot be duplicated.')
    if host.get('NetworkMode') == 'host':
        raise ValueError('Host networking is not supported for runtime control services.')
    config['Image'] = binding['harnessImage']
    config['Hostname'] = '' if config.get('Hostname') == container['Id'][:12] else config.get('Hostname', '')
    labels = config.setdefault('Labels', {})
    labels.update({'com.docker.compose.project': 'forge-' + slug, 'com.docker.compose.service': service,
                   'io.forge.runtime.channel': channel, 'io.forge.runtime.version-id': binding['versionId'],
                   'io.forge.runtime.release': release, 'io.forge.runtime.source-container': container['Id']})
    labels.pop('com.docker.compose.config-hash', None)
    labels.pop('com.docker.compose.depends_on', None)
    environment = env_dict(container)
    environment.update(binding['environment'])
    if role in ('conversation-manager', 'taskspace-broker'):
        environment.update(FORGE_RUNTIME_CHANNEL=channel, FORGE_RUNTIME_VERSION_ID=binding['versionId'])
    sources = mount_sources(container)
    replacements = {}
    for suffix in ('control', 'issuer', 'resolver', 'scope'):
        target = '/run/forge-acceptance-' + suffix
        if target in sources:
            replacements[target] = str(acceptance / ('ipc-' + suffix))
    for target in ('/run/forge-manager', '/run/forge-conversation-manager'):
        if target in sources:
            replacements[target] = str(runtime / 'manager')
    for target, directory in (('/run/forge-release', runtime / 'release'),
                              ('/run/forge-verify', verification / 'ipc'),
                              ('/run/forge-verify-source', verification / 'source-ipc')):
        if target in sources:
            replacements[target] = str(directory)
    if role == 'protected-acceptance':
        replacements['/var/lib/forge-acceptance'] = str(acceptance / 'state')
        replacements['/etc/forge-acceptance/service.json'] = str(acceptance / 'service.json')
    if role == 'conversation-manager':
        for private in ('acceptance', 'verification'):
            mask = next((m for m in container['Mounts'] if m['Destination'] == str(project / private)), None)
            if not mask or mask.get('RW') or mask.get('Type', 'bind') != 'bind':
                raise ValueError('Manager lacks the required read-only private-state mask.')
        old_catalog = environment.get('CONVERSATION_PHASE_CATALOG_FILE')
        environment['CONVERSATION_PHASE_CATALOG_FILE'] = str(Path(binding['skillBundleRoot']) / 'current/skills/forge-task-router/references/phase-profiles.json')
        if old_catalog:
            old_skill_root = old_catalog.split('/current/skills/', 1)[0]
            if old_skill_root in sources:
                replacements[old_skill_root] = binding['skillBundleRoot']
                # Keep the original container target and point catalog to that target.
                environment['CONVERSATION_PHASE_CATALOG_FILE'] = old_skill_root + '/current/skills/forge-task-router/references/phase-profiles.json'
        old_platform = environment.get('TASKSPACE_CONTROL_PLATFORM_ROOT') or environment.get('PLATFORM_ROOT')
        if old_platform and old_platform in sources:
            replacements[old_platform] = platform_root
        elif '/opt/forge-delivery-platform' in sources:
            replacements['/opt/forge-delivery-platform'] = platform_root
        else:
            raise ValueError('Manager platform source mount could not be identified.')
    if role == 'taskspace-broker':
        replacements['/etc/forge-phase-catalog/phase-profiles.json'] = str(Path(binding['skillBundleRoot']) / 'current/skills/forge-task-router/references/phase-profiles.json')
        replacements['/etc/forge-verification/inventory-contract.json'] = verification_contract
        status = str(runtime / 'broker')
        host.setdefault('Binds', []).append(status + ':' + status + ':rw')
        environment['TASKSPACE_BROKER_STATUS_SOCKET'] = status + '/project-status.sock'
    if role == 'verification-runner':
        environment['VERIFICATION_CONTRACT'] = verification_contract
    replace_mount_sources(host, replacements)
    config['Env'] = [key + '=' + value for key, value in environment.items()]
    host['ContainerIDFile'] = ''
    request = {**config, 'HostConfig': host, 'NetworkingConfig': {'EndpointsConfig': endpoints(container, service, name)}}
    return {'role': role, 'name': name, 'sourceId': container['Id'], 'sourceFingerprint': source_fingerprint(container),
            'request': request, 'sourceMountReplacements': replacements}


def build_plan(project_root, release, binding, platform_root, containers, documents):
    project = Path(project_root)
    if not project.is_absolute() or not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,47}', project.name):
        raise ValueError('Project identity is invalid.')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}', release):
        raise ValueError('Release directory identity is invalid.')
    channel = binding.get('channel')
    if channel not in ('stable', 'enhanced') or not re.fullmatch(r'sha256:[a-f0-9]{64}', binding.get('harnessImage', '')):
        raise ValueError('Channel and immutable local image ID are required.')
    if not re.fullmatch(r'[a-f0-9]{64}', binding.get('versionId', '')):
        raise ValueError('Runtime version identity is invalid.')
    runtime = project / 'runtime-versions' / channel / release
    acceptance = project / 'acceptance/runtime-versions' / channel / release
    verification = project / 'verification/runtime-versions' / channel / release
    if binding.get('managerSocket') != str(runtime / 'manager/manager.sock'):
        raise ValueError('Manager socket differs from the release directory.')
    contained(binding['skillBundleRoot'], project / 'runtime-versions' / channel)
    if set(binding.get('environment', {})) != set(ENV_KEYS):
        raise ValueError('Runtime capability configuration is incomplete.')
    for key, value in binding['environment'].items():
        if value not in (('direct', 'controlled') if key == 'FORGE_DEVELOPMENT_MODE' else ('true', 'false')):
            raise ValueError('Runtime capability value is invalid.')
    selected = {}
    for item in containers:
        labels = item['Config'].get('Labels') or {}
        role = labels.get('com.docker.compose.service')
        if labels.get('com.docker.compose.project') == 'forge-' + project.name and role in ROLES and item['State'].get('Running'):
            if role in selected:
                raise ValueError('Ambiguous default control service.')
            selected[role] = item
    missing = set(ROLES) - {'verification-runner'} - set(selected)
    blockers = ['Default control services are absent or stopped: ' + ','.join(sorted(missing))] if missing else []
    native = 'verification-runner' not in selected
    contract_name = 'host-contract.json' if native else 'contract.json'
    contract_path = str(verification / contract_name)
    plan = {'schemaVersion': 1, 'projectRoot': str(project), 'channel': channel, 'release': release,
            'versionId': binding['versionId'], 'image': binding['harnessImage'], 'containers': [], 'files': [],
            'directories': [], 'blockers': blockers, 'nativeHostSpec': None}
    if blockers:
        return plan
    if not documents.get('businessBaseReady'):
        plan['blockers'].append('Project business workspace/runtime contract or running business base is unavailable.')
    source_service = documents['acceptanceService']
    if source_service['value'].get('stateRoot') != '/var/lib/forge-acceptance':
        raise ValueError('Acceptance state path differs from the inspected private-state mount.')
    plan['files'].append({'source': source_service['path'], 'sourceSha256': source_service['sha256'],
                          'path': str(acceptance / 'service.json'), 'content': source_service['value']})
    if native:
        plan['nativeHostSpec'] = {'sourceContract': str(project / 'verification/host-contract.json'),
                                 'sourceEnvironment': str(project / 'verification/host-runner.env'),
                                 'contract': contract_path, 'stateRoot': str(verification / 'host-state'),
                                 'runnerSocket': str(verification / 'ipc/runner.sock'),
                                 'sourceSocket': str(verification / 'source-ipc/source.sock'),
                                 'issuerSocket': str(acceptance / 'ipc-issuer/issuer.sock'),
                                 'requiredAction': 'Prepare and start the branch-bound native Host separately before --start.'}
    else:
        source_contract = documents['verificationContract']
        contract = copy.deepcopy(source_contract['value'])
        contract.update(stateRoot=str(verification / 'state'), toolchainImage=binding['harnessImage'],
                        cacheRoot=str(verification / 'cache-packs' / binding['harnessImage'].split(':')[1]))
        plan['files'].append({'source': source_contract['path'], 'sourceSha256': source_contract['sha256'],
                              'path': contract_path, 'content': contract})
    for role in ROLES:
        if role in selected:
            plan['containers'].append(candidate(selected[role], role, project, release, binding, platform_root, contract_path))
    dirs = {runtime / 'manager', runtime / 'release', runtime / 'broker', acceptance / 'state', verification / 'state',
            verification / 'ipc', verification / 'source-ipc', verification / 'cache-packs'}
    dirs.update(acceptance / ('ipc-' + suffix) for suffix in ('control', 'issuer', 'resolver', 'scope'))
    plan['directories'] = [str(p) for p in sorted(dirs)]
    return plan


class DockerConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__('localhost', timeout=30)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')


def docker_api(method, endpoint, payload=None):
    connection = DockerConnection()
    try:
        connection.request(method, endpoint, None if payload is None else json.dumps(payload), {'Content-Type': 'application/json'})
        response = connection.getresponse()
        body = response.read()
        if response.status >= 300:
            raise RuntimeError('Docker API status %s; responseSha256=%s' % (response.status, hashlib.sha256(body).hexdigest()))
        return json.loads(body) if body else None
    finally:
        connection.close()


def private_write(path, content):
    path = Path(path)
    if path.exists():
        raise ValueError('Candidate output already exists; retain it and choose a new release/plan.')
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        json.dump(content, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def apply_plan(plan, start=False):
    if plan['blockers']:
        raise ValueError('Plan has unresolved prerequisites; existing services remain unchanged.')
    project = Path(plan['projectRoot']).resolve(strict=True)
    if inspect(plan['image'])['Id'] != plan['image']:
        raise ValueError('The selected image does not match its immutable local identity.')
    previous = run(['docker', 'ps', '-a', '--quiet', '--filter', 'label=com.docker.compose.project=forge-' + project.name,
                    '--filter', 'label=io.forge.runtime.channel=' + plan['channel']]).decode().strip()
    if previous:
        raise ValueError('This project/channel already has runtime services; no duplicate aliases were created.')
    existing = run(['docker', 'ps', '-a', '--format', '{{.Names}}']).decode().splitlines()
    active_services = run(['docker', 'ps', '--filter', 'label=com.docker.compose.project=forge-' + project.name,
                           '--format', '{{.Label "com.docker.compose.service"}}']).decode().splitlines()
    if not (project / 'workspace/.git').exists() or not (project / 'ops/runtime-contract.json').is_file() \
            or not set(active_services).intersection(('forge-admin', 'forge-app', 'forge-ui')):
        raise ValueError('The project business base is unavailable; no runtime service was created.')
    for item in plan['containers']:
        current = inspect(item['sourceId'])
        if item['name'] in existing or not current['State'].get('Running') or source_fingerprint(current) != item['sourceFingerprint']:
            raise ValueError('A candidate exists or an actual source configuration changed.')
    for document in plan['files']:
        if hashlib.sha256(Path(document['source']).read_bytes()).hexdigest() != document['sourceSha256']:
            raise ValueError('Source service/verification configuration changed.')
    for raw in plan['directories']:
        location = Path(contained(raw, project))
        if location.is_symlink() or location.resolve() != location:
            raise ValueError('Runtime output directory is indirect.')
    if start and plan['nativeHostSpec']:
        spec = plan['nativeHostSpec']
        for key in ('runnerSocket', 'sourceSocket'):
            if not Path(spec[key]).exists() or not stat.S_ISSOCK(Path(spec[key]).stat().st_mode):
                raise ValueError('The branch-bound native Host is not running; no new service was started.')
    user = plan['containers'][0]['request'].get('User', '')
    if not re.fullmatch(r'\d+:\d+', user) or any(item['request'].get('User') != user for item in plan['containers']):
        raise ValueError('Source service numeric UID/GID is required for private directory creation.')
    uid, gid = map(int, user.split(':'))
    for raw in plan['directories']:
        Path(raw).mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chown(raw, uid, gid)
    for document in plan['files']:
        private_write(document['path'], document['content'])
        os.chown(document['path'], uid, gid)
    for item in plan['containers']:
        for source in item['sourceMountReplacements'].values():
            if not Path(source).exists():
                raise ValueError('A required candidate bind source is absent; containers remain unstarted.')
    created = []
    for item in plan['containers']:
        value = docker_api('POST', '/containers/create?name=' + urllib.parse.quote(item['name']), item['request'])
        created.append({'name': item['name'], 'id': value['Id']})
    if start:
        for item in created:
            docker_api('POST', '/containers/' + item['id'] + '/start')
    return {'created': created, 'started': start, 'oldContainersPreserved': True}


def read_document(path):
    content = Path(path).read_bytes()
    return {'path': str(path), 'sha256': hashlib.sha256(content).hexdigest(), 'value': json.loads(content)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('plan', 'apply'))
    parser.add_argument('--plan-file', required=True)
    parser.add_argument('--project-root')
    parser.add_argument('--release')
    parser.add_argument('--runtime-binding')
    parser.add_argument('--platform-root')
    parser.add_argument('--start', action='store_true', help='Explicitly start newly created containers after prerequisite checks.')
    args = parser.parse_args()
    if args.mode == 'apply':
        path = Path(args.plan_file)
        if path.is_symlink() or stat.S_IMODE(path.stat().st_mode) & 0o077:
            raise ValueError('Apply requires a private regular plan file.')
        result = apply_plan(json.loads(path.read_text()), args.start)
    else:
        if not all((args.project_root, args.release, args.runtime_binding, args.platform_root)) or args.start:
            parser.error('plan requires project-root, release, runtime-binding and platform-root; --start is apply-only')
        project = Path(args.project_root).resolve(strict=True)
        binding = json.loads(Path(args.runtime_binding).read_text())
        identities = run(['docker', 'ps', '-a', '--quiet', '--filter', 'label=com.docker.compose.project=forge-' + project.name]).decode().split()
        containers = [inspect(identity) for identity in identities]
        acceptance = next((c for c in containers if c['Config'].get('Labels', {}).get('com.docker.compose.service') == 'protected-acceptance' and c['State'].get('Running')), None)
        documents = {'businessBaseReady': (project / 'workspace/.git').exists() and (project / 'ops/runtime-contract.json').is_file()
                     and any(c['State'].get('Running') and c['Config'].get('Labels', {}).get('com.docker.compose.service') in ('forge-admin', 'forge-app', 'forge-ui') for c in containers)}
        if acceptance:
            documents['acceptanceService'] = read_document(mount_sources(acceptance)['/etc/forge-acceptance/service.json'])
        verifier = next((c for c in containers if c['Config'].get('Labels', {}).get('com.docker.compose.service') == 'verification-runner' and c['State'].get('Running')), None)
        if verifier:
            documents['verificationContract'] = read_document(env_dict(verifier)['VERIFICATION_CONTRACT'])
        result = build_plan(str(project), args.release, binding, args.platform_root, containers, documents)
        private_write(args.plan_file, result)
        result = {'planFile': args.plan_file, 'channel': result['channel'], 'containers': [c['name'] for c in result['containers']],
                  'blockers': result['blockers'], 'nativeHostPreparationRequired': result['nativeHostSpec'] is not None,
                  'started': False}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'errorType': type(error).__name__, 'message': str(error)}, ensure_ascii=False))
        raise SystemExit(1)
