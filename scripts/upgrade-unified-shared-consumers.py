#!/usr/bin/env python3
"""Upgrade only frozen shared Harness consumers; preserve workpods and all business state."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import sys
import time
import types

WORKPOD_SHA = '0b4417e82b6ff7ea4ddcb62ed1bc65c42a70de29983a3b5829a8c4f243eb168b'
WORKPOD_SOURCE = globals().get('_WORKPOD_SOURCE')
if WORKPOD_SOURCE is None:
    WORKPOD_SOURCE = Path(__file__).with_name('upgrade-unified-workpods.py').read_bytes().replace(b'\r\n', b'\n')
if hashlib.sha256(WORKPOD_SOURCE).hexdigest() != WORKPOD_SHA:
    raise RuntimeError('Reviewed workpod helper changed')
w = types.ModuleType('reviewed_workpod_helpers')
w.__file__ = str(Path(__file__).with_name('upgrade-unified-workpods.py'))
if '_SOURCES' in globals(): w._SOURCES = globals()['_SOURCES']
exec(compile(WORKPOD_SOURCE, w.__file__, 'exec'), w.__dict__)
common, archive = w.common, w.archive
require, regular, sha = w.require, w.regular, w.sha
IMAGE = 'sha256:fb76654bd987c1557de7c6f4fca632be8761a722d08ec30019dca507ed308413'
# The reused container-template helper must construct this exact candidate.
archive.TARGET_IMAGE = IMAGE
CANARY_PROOF = 'f5ef9b64903015b2bfde998cc8f2b0eec6f3fcdd31242c3ab341fa252c155054'
OPERATION = 'development-flow-shared-20260920'
ROLES = ('release-runner', 'verification-runner', 'protected-acceptance',
         'taskspace-broker', 'conversation-manager', 'conversation-gateway')
IMAGE_KEYS = {'HARNESS_IMAGE', 'CONVERSATION_MANAGER_IMAGE', 'RELEASE_RUNNER_IMAGE',
              'TASKSPACE_BROKER_IMAGE', 'PROTECTED_ACCEPTANCE_IMAGE', 'VERIFICATION_RUNNER_IMAGE'}


def validate_manifest(m):
    require(m.get('schemaVersion') == 'unified-shared/v1' and m.get('operation') == OPERATION
            and m.get('targetImageId') == IMAGE and m.get('helper') == w.HELPER
            and m.get('canaryProofSha256') == CANARY_PROOF, 'Unreviewed rollout or image')
    seen = set()
    for c in m['services']:
        require(c['role'] in ROLES and c['id'] not in seen and re.fullmatch('[a-f0-9]{64}', c['id']), 'Unexpected or duplicate service')
        seen.add(c['id'])
        if c['role'] != 'conversation-gateway':
            require(c['project'] in w.PROJECTS and c['name'].startswith('forge-' + c['project'] + '-'), 'Service outside project scope')
        else:
            require(c['project'] is None and c['name'] == m['gatewayName'], 'Gateway identity changed')
        if c['role'] == 'harness-upload':
            require(any(t['project'] == c['project'] and t['taskId'] == c['taskId'] for t in m['workpods']), 'Upload without active workpod')
    require(sum(c['role'] == 'conversation-gateway' for c in m['services']) == 1, 'One Gateway required')
    for t in m['workpods']:
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', t['container']['imageId'])
                and re.fullmatch('[a-f0-9]{64}', t['container']['id']) and t['container']['id'] not in seen
                and all(s['running'] is False for s in t['sessions']), 'Preserved workpod identity or idle state invalid')
        require(t['fence']['path'] == (w.task_root(t) / 'maintenance/proxy-fence.json').as_posix(), 'Workpod fence outside scope')
    require(len({f['key'] for f in m['files']}) == len(m['files']), 'Duplicate default file')
    for f in m['files']:
        key, p, replacements = f['key'], f['binding']['path'], f['replacements']
        if key in w.PROJECTS:
            require(p == (w.ROOT / key / 'ops/project.env').as_posix() and set(replacements) <= IMAGE_KEYS, 'Project default escaped scope')
        elif key == 'global-versions':
            require(p == '/opt/forge-delivery-platform/config/versions.env'
                    and set(replacements) == {'HARNESS_IMAGE', 'CONVERSATION_MANAGER_IMAGE', 'RELEASE_RUNNER_IMAGE'}, 'Global default escaped scope')
        else:
            require(key == 'control-plane' and p == '/srv/forge-delivery/conversation-control-plane/control-plane.env'
                    and set(replacements) == {'HARNESS_IMAGE', 'HARNESS_IMAGE_SOURCE'}, 'Control default escaped scope')
        require(set(replacements.values()) == {IMAGE}, 'Default is not verified immutable image')
    require(m['gatewayFence']['path'] == w.GATEWAY_FENCE.as_posix(), 'Unexpected Gateway fence')


class Deployment(w.Deployment):
    def __init__(self, manifest, data):
        validate_manifest(manifest)
        self.m, self.data, self.digest = manifest, data, sha(data)
        self.backup = Path('/srv/forge-delivery/platform-backups') / ('pre-' + OPERATION)
        self.records = self.backup / 'container-cutover'
        self.diagnostics = Path('/var/tmp')
        self.stage = 'preflight'

    def role_ready(self, c, identity, maintenance=False):
        role = c['role']
        if role == 'conversation-gateway':
            return self.fence(identity, True, maintenance)
        if role in ('harness-upload', 'taskspace-broker'):
            port = '3090' if role == 'harness-upload' else '3100'
            value = self.http(identity, 'http://127.0.0.1:' + port + '/healthz')
        else:
            socket = {'release-runner': '/run/forge-release/runner.sock',
                      'verification-runner': '/run/forge-verify/runner.sock',
                      'protected-acceptance': '/run/forge-acceptance-resolver/resolver.sock',
                      'conversation-manager': '/run/forge-manager/manager.sock'}[role]
            value = json.loads(self.run(['docker', 'exec', identity, 'node', '-e', common.UNIX_HTTP_JS, '5000', socket], 7))
        body = value['body']
        require(value['status'] == 200 and body.get('ok') is True, 'Service health failed: ' + role)
        if role in ('release-runner', 'taskspace-broker'):
            require(body.get('active') is False, 'Service became busy: ' + role)
        if role == 'verification-runner':
            require(body.get('activeJobs') == 0 and not body.get('safetyHold'), 'Verifier became busy')
        if role == 'protected-acceptance':
            require(body.get('capability') == 'resolver', 'Wrong acceptance capability')
        if role == 'conversation-manager':
            require(body.get('projectSlug') == c['project'], 'Wrong Manager project')
        return True

    def unchanged(self, sessions=True):
        for c in self.m['unchangedContainers']:
            self.container(c)
        for t in self.m['workpods']:
            self.container(t['container'])
            if sessions: require(self.task_sessions(t['container']['id']) == t['sessions'], 'Workpod session state changed')
        for unit in self.m['hostUnits']:
            require(self.run(['systemctl', 'show', 'forge-host-verification@' + unit['project'] + '.service',
                    '--property', 'MainPID', '--value']).decode().strip() == unit['pid'], 'Host process changed')
        for b in self.m['configurationBindings']: self.check_binding(b)

    def preflight(self):
        if (self.backup / 'success.json').exists(): return self.verify()
        require(not self.backup.exists(), 'Partial deployment retained; inspect without blind replay')
        require(sha(regular(w.HELPER['path'])) == w.HELPER['sha256'], 'Cutover helper drift')
        image = json.loads(self.run(['docker', 'image', 'inspect', IMAGE]))[0]
        require(image['Id'] == IMAGE and image['Config']['Labels'].get('com.forge-delivery.development-flow.version') == '2026.09.20.1', 'Candidate image drift')
        self.check_binding(self.m['gatewayFence'])
        require(json.loads(regular(w.GATEWAY_FENCE))['state'] == 'committed', 'Gateway already in maintenance')
        for t in self.m['workpods']:
            self.check_binding(t['fence'])
            require(json.loads(regular(t['fence']['path']))['state'] == 'committed', 'Workpod already in maintenance')
        for f in self.m['files']:
            self.check_binding(f['binding']); common.image_env_bytes(regular(f['binding']['path']), f['replacements'])
        for project in sorted(w.PROJECTS):
            self.project_idle(project)
            root = w.ROOT / project / 'taskspaces/.broker'
            require(not (root / 'maintenance.json').exists() and not (root / 'release.lock').exists(), 'Project already in maintenance')
        for c in self.m['services']:
            self.container(c)
            require(self.helper('forge_cutover_contract_sha_for_id', c['id']).decode().strip() == c['runtimeSha256'], 'Service runtime drift')
            self.role_ready(c, c['id'])
        self.unchanged()
        return {'status': 'ready', 'consumers': len(self.m['services']), 'workpodsUnchanged': len(self.m['workpods']), 'manifestSha256': self.digest}

    def service_template(self, c, key):
        original = self.inspect(c['id'])
        target = json.loads(self.run(['docker', 'image', 'inspect', IMAGE]))[0]['Config']
        env = {v.split('=', 1)[0] for v in original['Config']['Env']}
        if all(v.split('=', 1)[0] in env for v in target['Env']): return None
        old_labels = json.loads(self.run(['docker', 'image', 'inspect', c['imageId']]))[0]['Config'].get('Labels') or {}
        request = archive.runtime_template_request(original, old_labels, target.get('Labels') or {}, None, target['Env'])
        file = self.backup / (key + '.template-request.json'); common.write_new(file, request)
        version = json.loads(self.run(['curl', '-fsS', '--unix-socket', '/var/run/docker.sock', 'http://localhost/version']))['ApiVersion']
        require(re.fullmatch(r'1\.[0-9]+', version), 'Unexpected Docker API version')
        value = json.loads(self.run(['curl', '-fsS', '--unix-socket', '/var/run/docker.sock', '-H', 'content-type: application/json',
            '--data-binary', '@' + str(file), 'http://localhost/v' + version + '/containers/create?name=forge-template-' + OPERATION + '-' + key]))
        identity = value['Id']; archive.verify_runtime_template(original, self.inspect(identity), request)
        common.write_new(self.backup / (key + '.template.json'), {'id': identity, 'neverStarted': True})
        return identity

    def upgrade_service(self, c, index):
        key = 'service-' + str(index); self.stage = c['name']
        self.container(c); self.role_ready(c, c['id'], maintenance=c['role'] == 'conversation-gateway')
        require(self.helper('forge_cutover_contract_sha_for_id', c['id']).decode().strip() == c['runtimeSha256'], 'Runtime changed before cutover')
        identity = c['id']
        if c['imageId'] != IMAGE:
            template = self.service_template(c, key)
            self.helper('forge_cutover_prepare', key, c['id'], IMAGE, *(['', template] if template else []))
            self.helper('forge_cutover_activate', str(self.record(key)))
            record = json.loads(regular(self.record(key))); identity = record['candidate']['id']
            self.wait(lambda: bool(self.container({**c, 'imageId': IMAGE}, identity, name=False))
                and self.role_ready(c, identity, maintenance=c['role'] == 'conversation-gateway'), 'New ' + c['role'] + ' readiness')
            stable = {side: common.stable_contract_sha256(self.inspect(cid), record)
                      for side, cid in [('original', c['id']), ('candidate', identity)]}
            common.write_new(self.backup / (key + '.runtime.json'), stable)
            self.helper('forge_cutover_promote', str(self.record(key)))
            self.container(c, running=False, name=False)
        result = {'key': key, 'id': identity, 'originalId': c['id'], 'role': c['role'], 'name': c['name']}
        common.write_new(self.backup / (key + '.verified.json'), result)
        print(json.dumps({'verified': index + 1, 'total': len(self.m['services']), **result}), flush=True)
        return result

    def verify(self):
        result = json.loads(regular(self.backup / 'success.json'))
        require(result['manifestSha256'] == self.digest, 'Success manifest mismatch')
        require(len(result['services']) == len(self.m['services']), 'Incomplete consumer results')
        for c, row in zip(self.m['services'], result['services'], strict=True):
            require(row['originalId'] == c['id'], 'Service mapping mismatch')
            self.container({**c, 'imageId': IMAGE}, row['id']); self.role_ready(c, row['id'])
            if row['id'] != c['id']:
                self.container(c, running=False, name=False)
                record = json.loads(regular(self.record(row['key'])))
                require(record['promoted'] is True and record['candidate']['id'] == row['id']
                        and record['targetImageId'] == IMAGE, 'Cutover proof mismatch')
                stable = json.loads(regular(self.backup / (row['key'] + '.runtime.json')))
                for side, cid in [('original', c['id']), ('candidate', row['id'])]:
                    require(common.stable_contract_sha256(self.inspect(cid), record) == stable[side], 'Preserved service configuration changed')
        for f in self.m['files']:
            before = regular(self.backup / (f['key'] + '.env.before'))
            require(regular(f['binding']['path']) == common.image_env_bytes(before, f['replacements']), 'Image defaults mismatch')
        self.check_binding(self.m['gatewayFence'])
        for t in self.m['workpods']:
            self.check_binding(t['fence'])
            self.wait(lambda: self.fence(t['container']['id'], False, False), 'Existing workpod ingress restored')
        for p in w.PROJECTS:
            state = w.ROOT / p / 'taskspaces/.broker'
            require(not (state / 'maintenance.json').exists() and not (state / 'release.lock').exists(), 'Maintenance not cleared')
        self.unchanged()
        return {**result, 'verification': 'passed'}

    def deploy(self):
        import fcntl
        if (self.backup / 'success.json').exists(): return self.verify()
        self.preflight()
        with open('/srv/forge-delivery/registry/taskspaces.lock', 'a') as registry:
            fcntl.flock(registry, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.backup.mkdir(mode=0o700); self.records.mkdir(mode=0o700)
            (self.backup / 'manifest.json').write_bytes(self.data)
            fence = (json.dumps({'schemaVersion': 1, 'state': 'maintenance', 'epoch': OPERATION}) + '\n').encode()
            gateway = next(c for c in self.m['services'] if c['role'] == 'conversation-gateway')
            fences = [('gateway', self.m['gatewayFence'], gateway['id'], 3080, True)] + [
                ('pod-' + str(i), t['fence'], t['container']['id'], t['port'], False) for i, t in enumerate(self.m['workpods'])]
            locks = []
            try:
                self.stage = 'maintenance'
                for p in sorted(w.PROJECTS):
                    state = w.ensure_broker_state(p); lock = state / 'release.lock'
                    lock.mkdir(mode=0o700); os.chown(lock, 1000, 983); locks.append(state)
                    for file in (lock / 'owner.json', state / 'maintenance.json'):
                        common.write_new(file, {'schemaVersion': 1, 'operationId': OPERATION, 'instanceId': OPERATION,
                            'taskId': 'platform-maintenance', 'actorId': 'platform-operator',
                            'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
                        os.chmod(file, 0o600); os.chown(file, 1000, 983)
                    self.project_idle(p)
                self.unchanged()
                for key, binding, cid, port, is_gateway in fences:
                    self.check_binding(binding); before = regular(binding['path'])
                    (self.backup / (key + '.fence.before')).write_bytes(before)
                    common.atomic_replace(binding['path'], before, fence)
                    pid = self.inspect(cid)['State']['Pid']
                    self.run(['nsenter', '--target', str(pid), '--net', '--', 'ss', '--kill', '--tcp', '--numeric',
                              'state', 'established', '( sport = :' + str(port) + ' )'])
                    self.wait(lambda: self.fence(cid, is_gateway, True), 'Existing ingress drained')
                self.unchanged()
                results = [self.upgrade_service(c, i) for i, c in enumerate(self.m['services'])]
                self.stage = 'image-defaults'
                for f in self.m['files']:
                    self.check_binding(f['binding']); before = regular(f['binding']['path'])
                    (self.backup / (f['key'] + '.env.before')).write_bytes(before)
                    common.atomic_replace(f['binding']['path'], before, common.image_env_bytes(before, f['replacements']))
                self.unchanged()
                for state in locks:
                    for file in (state / 'maintenance.json', state / 'release.lock/owner.json'):
                        require(json.loads(regular(file))['operationId'] == OPERATION, 'Maintenance ownership changed')
                        file.unlink()
                    (state / 'release.lock').rmdir()
                for key, binding, _, _, _ in reversed(fences):
                    common.atomic_replace(binding['path'], fence, regular(self.backup / (key + '.fence.before')))
                result = {'status': 'success', 'manifestSha256': self.digest, 'services': results,
                          'businessModified': False, 'workpodsRestarted': False, 'hostModified': False,
                          'originalContainersRetained': True, 'automaticRollback': False}
                common.write_new(self.backup / 'success.json', result)
                return self.verify()
            except Exception as error:
                common.write_new(self.backup / 'failure.json', {'stage': self.stage, 'error': str(error),
                    'automaticRollback': False, 'blindReplayRefused': True})
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
        sources = {key: base64.b64encode(value).decode() for key, value in w.SOURCE_BYTES.items()}
        prefix = 'import base64\n_SOURCES={k:base64.b64decode(v) for k,v in ' + repr(sources) + '.items()}\n'
        prefix += '_WORKPOD_SOURCE=base64.b64decode(' + repr(base64.b64encode(WORKPOD_SOURCE).decode()) + ')\n'
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
