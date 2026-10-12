#!/usr/bin/env python3
"""Sequential, source-preserving upgrade of a reviewed workpod inventory."""
import argparse
import base64
import concurrent.futures
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import time
import types

ROOT = Path('/srv/forge-delivery/projects')
IMAGE = 'sha256:81679f5ec3608128a4c1b184c1de513d5246bc35de95643335436858aa1f1f67'
OPERATION = 'unified-workpods-20260919-r2'
HELPER = {'path': '/opt/forge-delivery-platform/scripts/lib/container-image-cutover.sh',
          'sha256': 'e500b71748d05a5aa6365642e15572516c533c3a34437a5b1c4071c85591dd22'}
GATEWAY_FENCE = Path('/srv/forge-delivery/conversation-control-plane/maintenance/gateway-fence.json')
PROJECTS = {'forge-base', 'forge-replica-acceptance', 'forge-a9-runtime-20260913',
            'forge-a9-clean-20260914', 'demoteam-phase2', 'safety-project-management'}
CANARY_PROOF = 'f86e31dcaa9d57f6caf43e9ff18dda34e1156d0bcd8c4d51c879b10e86b8c973'
SOURCES = {
    'common': ('部署-阶段20-合同续接修复.py', '892e1c244beda9d66a7c737d387eb9071e96b03eab2d59d77748148589572b20'),
    'archive': ('upgrade-taskspace-conversation-archive.py', '696fa7b8ab1508f108299ccb3ef6b8bb8bda0c47b41c040ecdf2cfb8d1661cd4')}
MODULES = {}
SOURCE_BYTES = {}
for key, (filename, digest) in SOURCES.items():
    data = globals().get('_SOURCES', {}).get(key)
    if data is None:
        data = Path(__file__).with_name(filename).read_bytes().replace(b'\r\n', b'\n')
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError('Reviewed helper changed: ' + key)
    module = types.ModuleType('reviewed_' + key)
    module.__file__ = filename
    exec(compile(data, filename, 'exec'), module.__dict__)
    MODULES[key], SOURCE_BYTES[key] = module, data
common, archive = MODULES['common'], MODULES['archive']
archive.TARGET_IMAGE = IMAGE
require, regular, sha = common.require, common.regular, common.sha
SESSIONS_JS = common.SESSIONS_JS.replace('Math.min(5000,Number(process.argv[1]))',
    'Math.min(12000,Number(process.argv[1]))').replace(
    'process.stdout.write(JSON.stringify(a));', 'process.stdout.write(JSON.stringify(a),()=>process.exit(0));')


def task_root(task):
    require(task['project'] in PROJECTS and re.fullmatch(r'(c-[a-f0-9]{24}|legacy-history-20260827)', task['taskId']),
            'Unexpected workpod scope')
    return ROOT / task['project'] / 'taskspaces' / task['taskId']


def binding(path):
    path = Path(path)
    if not path.exists():
        require(not path.is_symlink(), 'Dangling configuration link')
        return {'path': str(path), 'exists': False}
    raw = regular(path); info = path.stat()
    return {'path': str(path), 'exists': True, 'sha256': sha(raw),
            'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}


def run(argv, timeout=30):
    p = subprocess.run(argv, capture_output=True, timeout=timeout)
    require(p.returncode == 0, 'Command failed: ' + argv[0] + ' exit=' + str(p.returncode)
            + ' stderrSha256=' + sha(p.stderr))
    return p.stdout


def source_state(root):
    """Bind HEAD, tracked changes and untracked source without rehashing clean clones."""
    workspace = root / 'workspace'
    require(workspace.is_dir() and workspace.resolve() == workspace, 'Unexpected source directory')
    git = ['git', '--no-optional-locks', '-c', 'safe.directory=' + str(workspace), '-C', str(workspace)]
    head = run([*git, 'rev-parse', 'HEAD']).decode().strip()
    status = run([*git, 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
    changes = run([*git, 'diff', '--no-ext-diff', '--binary', 'HEAD', '--'])
    names = sorted(set(run([*git, 'ls-files', '-z', '--others', '--exclude-standard']).split(b'\0')) - {b''})
    fingerprint = hashlib.sha256(head.encode() + b'\0' + changes)
    for name in names:
        relative = Path(os.fsdecode(name))
        require(not relative.is_absolute() and '..' not in relative.parts, 'Unsafe source path')
        path = workspace / relative
        fingerprint.update(name + b'\0')
        if path.is_symlink():
            fingerprint.update(b'link\0' + os.fsencode(os.readlink(path)))
        elif not path.exists():
            fingerprint.update(b'deleted')
        else:
            info = path.stat()
            require(stat.S_ISREG(info.st_mode), 'Non-file source entry')
            fingerprint.update(str(stat.S_IMODE(info.st_mode)).encode() + b'\0')
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    fingerprint.update(block)
        fingerprint.update(b'\0')
    return {'head': head, 'statusSha256': sha(status), 'contentSha256': fingerprint.hexdigest(), 'untrackedFileCount': len(names)}


def validate_manifest(m):
    require(m.get('schemaVersion') == 'unified-workpods/v1' and m.get('operation') == OPERATION
            and m.get('targetImageId') == IMAGE and m.get('canaryProofSha256') == CANARY_PROOF
            and m.get('helper') == HELPER, 'Unreviewed image, proof or operation')
    seen = set()
    for task in m['tasks']:
        root = task_root(task); key = (task['project'], task['taskId'])
        require(key not in seen, 'Duplicate workpod'); seen.add(key)
        require(task['env']['path'] == str(root / 'task.env')
                and task['fence']['path'] == str(root / 'maintenance/proxy-fence.json')
                and task['metadata']['path'] == str(root / 'metadata.json'), 'Configuration path escaped workpod')
        require(task['state'] in ('running', 'absent'), 'Unsupported original lifecycle state')
        if task['state'] == 'running':
            require(re.fullmatch('[a-f0-9]{64}', task['container']['id']) is not None
                    and task['container']['name'] == 'forge-' + task['project'] + '-task-' + task['taskId'] + '-harness-1'
                    and all(s['running'] is False for s in task['sessions']), 'Busy or invalid workpod')
    require(len(seen) > 0 and {p['project'] for p in m['projects']} == {x[0] for x in seen}, 'Project inventory mismatch')
    for project in m['projects']:
        require(project['env']['path'] == str(ROOT / project['project'] / 'ops/project.env'), 'Unexpected default configuration')


def ensure_broker_state(project):
    require(project in PROJECTS, 'Unexpected project')
    parent = ROOT / project / 'taskspaces'
    state = parent / '.broker'
    require(parent.is_dir() and parent.resolve() == parent and state.resolve() == state,
            'Unsafe Broker state path')
    if not state.exists():
        owner = parent.stat()
        state.mkdir(mode=0o700)
        os.chown(state, owner.st_uid, owner.st_gid)
    require(state.is_dir(), 'Broker state is not a directory')
    return state


class Deployment(common.Deployment):
    def __init__(self, manifest, data):
        validate_manifest(manifest)
        self.m, self.data, self.digest = manifest, data, sha(data)
        self.backup = Path('/srv/forge-delivery/platform-backups') / ('pre-' + OPERATION)
        self.records = self.backup / 'container-cutover'
        self.diagnostics = Path('/var/tmp')
        self.stage = 'preflight'

    def check_binding(self, expected):
        require(binding(expected['path']) == expected, 'Configuration changed: ' + expected['path'])

    def task_sessions(self, identity):
        rows = json.loads(self.run(['docker', 'exec', identity, 'node', '-e', SESSIONS_JS, '12000'], 15))
        require(all(x['running'] is False for x in rows), 'Active model turn: do not stop this workpod')
        return sorted(rows, key=lambda x: x['sessionId'])

    def unchanged_services(self):
        for spec in self.m['unchangedContainers']:
            self.container(spec)

    def project_idle(self, project):
        root = ROOT / project
        for suffix, host in [('verification/ipc/runner.sock', True), ('ops/release-ipc/runner.sock', False)]:
            v = json.loads(self.run(['curl', '-fsS', '--max-time', '5', '--unix-socket', str(root / suffix), 'http://localhost/healthz'], 7))
            require(v.get('ok') is True and (v.get('activeJobs') == 0 and not v.get('safetyHold')
                    if host else v.get('active') is False), 'Verification/release still active: ' + project)

    def preflight(self):
        if (self.backup / 'success.json').exists():
            return self.verify()
        require(not self.backup.exists(), 'Partial upgrade retained; inspect before resuming')
        require(sha(regular(HELPER['path'])) == HELPER['sha256'], 'Cutover helper drift')
        image = json.loads(self.run(['docker', 'image', 'inspect', IMAGE]))[0]
        require(image['Id'] == IMAGE and image['Config']['Labels'].get('com.forge-delivery.unified.version') == '2026.09.19.1', 'Candidate identity mismatch')
        self.check_binding(self.m['gatewayFence']); self.container(self.m['gateway'])
        require(json.loads(regular(GATEWAY_FENCE))['state'] == 'committed', 'Gateway already in maintenance')
        for p in self.m['projects']:
            self.check_binding(p['env']); self.project_idle(p['project'])
            state = ROOT / p['project'] / 'taskspaces/.broker'
            require(not (state / 'maintenance.json').exists() and not (state / 'release.lock').exists(), 'Project maintenance/release already active')
        for task in self.m['tasks']:
            for key in ('env', 'metadata', 'fence'):
                self.check_binding(task[key])
            require(source_state(task_root(task)) == task['source'], 'Workpod source changed')
            if task['state'] == 'running':
                c = task['container']; self.container(c)
                require(self.helper('forge_cutover_contract_sha_for_id', c['id']).decode().strip() == c['runtimeSha256'], 'Runtime configuration changed')
                require(self.task_sessions(c['id']) == task['sessions'], 'Session state changed')
            else:
                require(not self.run(['docker', 'ps', '-aq', '--filter', 'name=^/forge-' + task['project'] + '-task-' + task['taskId'] + '-harness-1$']).strip(), 'Stopped workpod became active')
        self.unchanged_services()
        return {'status': 'ready', 'workpods': len(self.m['tasks']), 'manifestSha256': self.digest}

    def create_fence(self, task):
        path = Path(task['fence']['path'])
        if task['fence']['exists']:
            raw = regular(path)
            require(json.loads(raw)['state'] == 'committed', 'Task maintenance already active')
            return raw
        require(path.parent.resolve() == path.parent.absolute(), 'Unsafe maintenance directory')
        path.parent.mkdir(mode=0o750, exist_ok=True)
        os.chown(path.parent, task['env']['uid'], task['env']['gid'])
        common.write_new(path, {'schemaVersion': 1, 'state': 'committed', 'epoch': OPERATION + '-initial'})
        os.chmod(path, 0o640); os.chown(path, task['env']['uid'], task['env']['gid'])
        return regular(path)

    def runtime_template(self, task, key):
        c = self.inspect(task['container']['id'])
        target = json.loads(self.run(['docker', 'image', 'inspect', IMAGE]))[0]['Config']
        source_labels = json.loads(self.run(['docker', 'image', 'inspect', c['Image']]))[0]['Config'].get('Labels') or {}
        env = {v.split('=', 1)[0] for v in c['Config']['Env']}
        missing = 'HARNESS_MAINTENANCE_FENCE_FILE' not in env
        if not missing and all(v.split('=', 1)[0] in env for v in target['Env']):
            return None
        request = archive.runtime_template_request(c, source_labels, target.get('Labels') or {},
                    task_root(task) / 'maintenance' if missing else None, target['Env'])
        request_path = self.backup / (key + '.template-request.json')
        common.write_new(request_path, request)
        version = json.loads(self.run(['curl', '-fsS', '--unix-socket', '/var/run/docker.sock', 'http://localhost/version']))['ApiVersion']
        require(re.fullmatch(r'1\.[0-9]+', version) is not None, 'Invalid Docker API version')
        value = json.loads(self.run(['curl', '-fsS', '--unix-socket', '/var/run/docker.sock', '-H', 'content-type: application/json',
            '--data-binary', '@' + str(request_path), 'http://localhost/v' + version + '/containers/create?name=forge-template-' + OPERATION + '-' + key]))
        identity = value['Id']; archive.verify_runtime_template(c, self.inspect(identity), request)
        common.write_new(self.backup / (key + '.template.json'), {'id': identity, 'neverStarted': True})
        return identity

    def verify_task(self, task, result):
        require(source_state(task_root(task)) == task['source'], 'Source changed during upgrade')
        self.check_binding(task['metadata'])
        expected = common.image_env_bytes(regular(self.backup / (result['key'] + '.env.before')), {'HARNESS_IMAGE': IMAGE})
        require(regular(task['env']['path']) == expected, 'Workpod image default not saved')
        if task['state'] == 'absent':
            require(not self.run(['docker', 'ps', '-aq', '--filter', 'name=^/forge-' + task['project'] + '-task-' + task['taskId'] + '-harness-1$']).strip(), 'Inactive workpod was started')
            return
        c = task['container']; identity = result['containerId']
        self.container({**c, 'imageId': IMAGE}, identity)
        require(self.task_sessions(identity) == task['sessions'], 'Original sessions not preserved')
        if identity != c['id']:
            self.container(c, running=False, name=False)
            record = json.loads(regular(self.record(result['key'])))
            require(record['promoted'] is True and record['candidate']['id'] == identity, 'Cutover identity mismatch')
        self.wait(lambda: self.fence(identity, False, False), 'Workpod public ingress restored')

    def upgrade_one(self, task, index):
        key = 'pod-' + str(index); self.stage = task['project'] + '/' + task['taskId']
        for field in ('env', 'metadata', 'fence'):
            self.check_binding(task[field])
        require(source_state(task_root(task)) == task['source'], 'Source changed before this workpod upgrade')
        raw = regular(task['env']['path'])
        (self.backup / (key + '.env.before')).write_bytes(raw)
        fence_before = self.create_fence(task)
        (self.backup / (key + '.fence.before')).write_bytes(fence_before)
        result = {'key': key, 'project': task['project'], 'taskId': task['taskId'], 'state': task['state']}
        if task['state'] == 'running':
            c = task['container']; identity = c['id']
            require(self.task_sessions(identity) == task['sessions'], 'Session became active or changed')
            if c['imageId'] != IMAGE:
                fence = (json.dumps({'schemaVersion': 1, 'state': 'maintenance', 'epoch': OPERATION}) + '\n').encode()
                common.atomic_replace(task['fence']['path'], fence_before, fence)
                # Gateway authorization is already closed. Close idle public sockets,
                # then recheck model state before the synchronous exact-ID cutover.
                pid = self.inspect(identity)['State']['Pid']
                self.run(['nsenter', '--target', str(pid), '--net', '--', 'ss', '--kill', '--tcp', '--numeric',
                          'state', 'established', '( sport = :' + str(task['port']) + ' )'])
                require(self.task_sessions(identity) == task['sessions'], 'Model turn changed while draining')
                template = self.runtime_template(task, key)
                args = [key, identity, IMAGE] + (['', template] if template else [])
                self.helper('forge_cutover_prepare', *args)
                self.helper('forge_cutover_activate', str(self.record(key)))
                identity = json.loads(regular(self.record(key)))['candidate']['id']
                self.wait(lambda: self.task_sessions(identity) == task['sessions'], 'Original session API ready')
                self.wait(lambda: self.fence(identity, False, True), 'Candidate maintenance ingress')
                require(source_state(task_root(task)) == task['source'], 'Source changed during cutover')
                self.helper('forge_cutover_promote', str(self.record(key)))
                common.atomic_replace(task['fence']['path'], fence, fence_before)
            result['containerId'] = identity
        common.atomic_replace(task['env']['path'], raw, common.image_env_bytes(raw, {'HARNESS_IMAGE': IMAGE}))
        self.verify_task(task, result)
        common.write_new(self.backup / (key + '.verified.json'), result)
        print(json.dumps({'verified': index + 1, 'total': len(self.m['tasks']), **result}), flush=True)
        return result

    def verify(self):
        result = json.loads(regular(self.backup / 'success.json'))
        require(result['manifestSha256'] == self.digest, 'Success manifest mismatch')
        for task, row in zip(self.m['tasks'], result['tasks'], strict=True):
            self.verify_task(task, row)
        for project in self.m['projects']:
            before = regular(self.backup / (project['project'] + '.env.before'))
            require(regular(project['env']['path']) == common.image_env_bytes(before, {'HARNESS_IMAGE': IMAGE}), 'New workpod default mismatch')
            self.project_idle(project['project'])
        self.check_binding(self.m['gatewayFence']); self.unchanged_services()
        return {**result, 'verification': 'passed'}

    def deploy(self):
        import fcntl
        if (self.backup / 'success.json').exists():
            return self.verify()
        self.preflight()
        # Reuse the existing lifecycle lock; do not create another lock protocol.
        with open('/srv/forge-delivery/registry/taskspaces.lock', 'a') as registry:
            fcntl.flock(registry, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.backup.mkdir(mode=0o700); self.records.mkdir(mode=0o700)
            (self.backup / 'manifest.json').write_bytes(self.data)
            before = regular(GATEWAY_FENCE); (self.backup / 'gateway-fence.before').write_bytes(before)
            fence = (json.dumps({'schemaVersion': 1, 'state': 'maintenance', 'epoch': OPERATION}) + '\n').encode()
            locks = []
            try:
                for p in self.m['projects']:
                    state = ensure_broker_state(p['project']); lock = state / 'release.lock'
                    lock.mkdir(mode=0o700); os.chown(lock, 1000, 983); locks.append(state)
                    for file in (lock / 'owner.json', state / 'maintenance.json'):
                        common.write_new(file, {'schemaVersion': 1, 'operationId': OPERATION, 'instanceId': OPERATION,
                            'taskId': 'platform-maintenance', 'actorId': 'platform-operator',
                            'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
                        os.chmod(file, 0o600); os.chown(file, 1000, 983)
                    self.project_idle(p['project'])
                common.atomic_replace(GATEWAY_FENCE, before, fence)
                gateway = self.m['gateway']['id']; pid = self.inspect(gateway)['State']['Pid']
                self.run(['nsenter', '--target', str(pid), '--net', '--', 'ss', '--kill', '--tcp', '--numeric',
                          'state', 'established', '( sport = :3080 )'])
                self.wait(lambda: self.fence(gateway, True, True), 'Gateway authorization drain')
                results = [self.upgrade_one(task, index) for index, task in enumerate(self.m['tasks'])]
                self.unchanged_services()
                for p in self.m['projects']:
                    raw = regular(p['env']['path']); self.check_binding(p['env'])
                    (self.backup / (p['project'] + '.env.before')).write_bytes(raw)
                    common.atomic_replace(p['env']['path'], raw, common.image_env_bytes(raw, {'HARNESS_IMAGE': IMAGE}))
                for state in locks:
                    for file in (state / 'maintenance.json', state / 'release.lock/owner.json'):
                        require(json.loads(regular(file))['operationId'] == OPERATION, 'Maintenance ownership changed')
                        file.unlink()
                    (state / 'release.lock').rmdir()
                common.atomic_replace(GATEWAY_FENCE, fence, before)
                result = {'status': 'success', 'manifestSha256': self.digest, 'tasks': results,
                          'originalContainersRetained': True, 'businessModified': False, 'automaticRollback': False}
                common.write_new(self.backup / 'success.json', result)
                return self.verify()
            except Exception as error:
                common.write_new(self.backup / 'failure.json', {'stage': self.stage, 'error': str(error),
                    'automaticRollback': False, 'completedWorkpodsRetained': True})
                raise


def main():
    sys.stdout.reconfigure(encoding='utf8'); os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['preflight', 'deploy', 'verify'])
    parser.add_argument('--manifest'); parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--bridge'); parser.add_argument('--remote', action='store_true'); parser.add_argument('--manifest-b64')
    args = parser.parse_args()
    data = globals().get('_MANIFEST_BYTES') if args.remote else regular(args.manifest)
    require(isinstance(data, bytes), 'Frozen manifest bytes are required')
    require(sha(data) == args.manifest_sha256, 'Manifest digest mismatch')
    if args.remote:
        require(os.geteuid() == 0, 'Reviewed root execution required')
        print(json.dumps(getattr(Deployment(json.loads(data), data), args.action)())); return 0
    bridge_path = Path(args.bridge); require(sha(regular(bridge_path)) == common.BRIDGE_SHA, 'SSH bridge changed')
    spec = importlib.util.spec_from_file_location('rollout_bridge', bridge_path)
    bridge = importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
    client = bridge.paramiko.SSHClient(); client.load_host_keys(str(bridge.KNOWN_HOSTS))
    client.set_missing_host_key_policy(bridge.paramiko.RejectPolicy()); secret = bridge.load_secret()
    try:
        client.connect(bridge.HOST, username=bridge.USER, key_filename=str(bridge.SSH_KEY), timeout=15,
                       banner_timeout=15, auth_timeout=15, allow_agent=False, look_for_keys=False)
        argv = [args.action, '--remote', '--manifest-sha256', args.manifest_sha256]
        stdin, stdout, _ = client.exec_command(shlex.join(['/usr/bin/sudo', '-S', '-p', '', '--', 'python3', '-', *argv]), timeout=2400, get_pty=False)
        sources = {key: base64.b64encode(value).decode() for key, value in SOURCE_BYTES.items()}
        prefix = 'import base64\n_SOURCES={k:base64.b64decode(v) for k,v in ' + repr(sources) + '.items()}\n'
        prefix += '_MANIFEST_BYTES=base64.b64decode(' + repr(base64.b64encode(data).decode()) + ')\n'
        stdin.write(secret + '\n' + prefix + regular(__file__).decode('utf8')); stdin.flush(); stdin.channel.shutdown_write()
        out, err = bridge.read_bounded_channel(stdout.channel, timeout_seconds=2400)
        code = stdout.channel.recv_exit_status()
    finally:
        client.close()
    require(secret.encode() not in out + err, 'Credential material refused')
    sys.stdout.write(out.decode('utf8', 'replace')); sys.stderr.write(err.decode('utf8', 'replace'))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
