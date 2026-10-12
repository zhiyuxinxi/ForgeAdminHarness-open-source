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

OPERATION = 'unified-defaults-20260920'
VERSION = '2026.09.16.1'
FLAGS = ('FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED', 'FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED',
         'FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED', 'FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED')
SOURCE_PATHS = {'scripts/taskspacectl.sh', 'templates/taskspace/compose.legacy-v1.yaml'}
SKILL_ROOTS = {'/srv/forge-delivery/skill-bundles',
    '/srv/forge-delivery/projects/forge-a9-clean-20260914/skill-bundles',
    '/srv/forge-delivery/projects/forge-a9-runtime-20260913/skill-bundles'}


def validate_manifest(m):
    require(m.get('schemaVersion') == 'unified-defaults/v1' and m.get('operation') == OPERATION
            and m.get('image') == w.IMAGE, 'Unexpected defaults or image')
    require(m['artifact'] == '/srv/forge-delivery/canary/unified-defaults-20260920-f7c45d8c0d38', 'Unexpected source artifact')
    require({x['path'] for x in m['sources']} == SOURCE_PATHS and len(m['sources']) == 2, 'Only two workpod creation files allowed')
    for s in m['sources']:
        require(s['binding']['path'] == '/opt/forge-delivery-platform/' + s['path'], 'Source target escaped scope')
    require(m['skill']['version'] == VERSION and m['skill']['treeSha256'] == '00c18762fd22cf2bb83d6ef99f07e5742244cb6072b3f7cfd04af85ce8b0a1ca'
            and m['skill']['source'] == '/srv/forge-delivery/projects/forge-base/skill-bundles/versions/' + VERSION
            and {s['root'] for s in m['skill']['roots']} == SKILL_ROOTS, 'Unreviewed Skill artifact or target')
    require(m['skill']['installer']['path'] == '/opt/forge-delivery-platform/scripts/forge-skill-bundle.mjs', 'Unexpected installer')
    require(len({f['key'] for f in m['environments']}) == len(m['environments']), 'Duplicate environment')
    for f in m['environments']:
        parts = f['key'].split('/')
        require(parts[0] in w.PROJECTS, 'Environment outside projects')
        if len(parts) == 1:
            expected = (w.ROOT / parts[0] / 'ops/project.env').as_posix()
        else:
            require(len(parts) == 2, 'Environment outside workpod')
            expected = (w.task_root({'project': parts[0], 'taskId': parts[1]}) / 'task.env').as_posix()
        require(f['binding']['path'] == expected, 'Environment escaped scope')
    require(m['gatewayFence']['path'] == w.GATEWAY_FENCE.as_posix(), 'Wrong ingress fence')
    for t in m['workpods']:
        require(t['fence']['path'] == (w.task_root(t) / 'maintenance/proxy-fence.json').as_posix()
                and t['container']['imageId'] == w.IMAGE and all(s['running'] is False for s in t['sessions']), 'Unverified or busy workpod')


def capability_bytes(raw):
    result = raw
    newline = b'\r\n' if b'\r\n' in raw else b'\n'
    for key in FLAGS:
        pattern = re.compile(rb'(?m)^' + key.encode() + rb'=([^\r\n]*)(?=\r?$)')
        matches = list(pattern.finditer(result))
        require(len(matches) <= 1, 'Duplicate capability marker')
        if matches:
            require(matches[0].group(1) in (b'true', b'false'), 'Invalid capability marker')
            result = pattern.sub(key.encode() + b'=true', result)
        else:
            if result and not result.endswith(b'\n'): result += newline
            result += key.encode() + b'=true' + newline
    return result


class Deployment(w.Deployment):
    def __init__(self, manifest, data):
        validate_manifest(manifest)
        self.m, self.data, self.digest = manifest, data, sha(data)
        self.backup = Path('/srv/forge-delivery/platform-backups') / ('pre-' + OPERATION)
        self.diagnostics = Path('/var/tmp'); self.stage = 'preflight'

    def skill_command(self, action, *args):
        installer = self.m['skill']['installer']; self.check_binding(installer)
        value = json.loads(self.run([self.m['node'], installer['path'], action, *args, '--dsh-version', '0.1.1-rc.2'], 60))
        require(value.get('ok') is True, 'Skill action failed')
        return value

    def preserved(self):
        actual = [json.loads(x) for x in self.run(['docker', 'ps', '--no-trunc', '--format', '{{json .}}']).decode().splitlines()]
        require(sorted((x['ID'], x['Names']) for x in actual) == sorted((x['id'], x['name']) for x in self.m['containers']), 'Container identity changed')
        for p in self.m['hostUnits']:
            require(self.run(['systemctl', 'show', 'forge-host-verification@' + p['project'] + '.service', '--property', 'MainPID', '--value']).decode().strip() == p['pid'], 'Host process changed')
        for b in self.m['unchangedBindings']: self.check_binding(b)
        with w.concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            rows = list(pool.map(lambda t: self.task_sessions(t['container']['id']), self.m['workpods']))
        require(rows == [t['sessions'] for t in self.m['workpods']], 'Session changed or became active')
        for c in self.m['managers']:
            result = json.loads(self.run(['docker', 'exec', c['id'], 'node', '-e', common.UNIX_HTTP_JS, '5000', '/run/forge-manager/manager.sock'], 7))
            require(result['status'] == 200 and result['body'].get('ok') is True, 'Manager control preflight failed')

    def preflight(self):
        if (self.backup / 'success.json').exists(): return self.verify()
        require(not self.backup.exists(), 'Partial defaults upgrade retained; inspect before resume')
        for s in self.m['sources']:
            self.check_binding(s['binding'])
            require(sha(regular(Path(self.m['artifact']) / s['path'])) == s['sha256'], 'Candidate source changed')
        for f in self.m['environments']:
            self.check_binding(f['binding']); capability_bytes(regular(f['binding']['path']))
        self.check_binding(self.m['gatewayFence'])
        for t in self.m['workpods']: self.check_binding(t['fence'])
        for p in sorted(w.PROJECTS):
            self.project_idle(p)
            state = w.ROOT / p / 'taskspaces/.broker'
            require(not (state / 'maintenance.json').exists() and not (state / 'release.lock').exists(), 'Project already in maintenance')
        # Only the global old phase catalog differs. These projects have no phase state to invalidate.
        for p in ('demoteam-phase2', 'safety-project-management', 'forge-replica-acceptance'):
            require(not list((w.ROOT / p / 'taskspaces/.broker/delivery-phases').glob('*/phase-control/state.json')), 'New old-catalog phase requires preservation review')
        target = self.skill_command('validate', '--bundle', self.m['skill']['source'])
        require(target['treeSha256'] == self.m['skill']['treeSha256'], 'Skill payload changed')
        phase = 'current/skills/forge-task-router/references/phase-profiles.json'
        target_phase = sha(regular(Path(self.m['skill']['source']) / phase.removeprefix('current/')))
        for s in self.m['skill']['roots']:
            self.check_binding(s['active'])
            current = self.skill_command('doctor', '--install-root', s['root'])
            require(current['version'] == s['version'] and current['treeSha256'] == s['treeSha256'], 'Skill current changed')
            if s['root'] != '/srv/forge-delivery/skill-bundles':
                require(sha((Path(s['root']) / phase).read_bytes()) == target_phase, 'Existing phase definition must remain identical')
        self.preserved()
        return {'status': 'ready', 'environmentFiles': len(self.m['environments']), 'manifestSha256': self.digest}

    def apply_environment(self, f, index):
        self.check_binding(f['binding']); before = regular(f['binding']['path'])
        (self.backup / ('env-' + str(index) + '.before')).write_bytes(before)
        changed = capability_bytes(before)
        if before != changed: common.atomic_replace(f['binding']['path'], before, changed)
        require(regular(f['binding']['path']) == changed, 'Capability markers not saved')

    def verify(self):
        result = json.loads(regular(self.backup / 'success.json'))
        require(result['manifestSha256'] == self.digest, 'Defaults result mismatch')
        for s in self.m['sources']: require(sha(regular(s['binding']['path'])) == s['sha256'], 'Installed workpod source changed')
        for i, f in enumerate(self.m['environments']):
            require(regular(f['binding']['path']) == capability_bytes(regular(self.backup / ('env-' + str(i) + '.before'))), 'Environment changed outside verified capabilities')
        for s in self.m['skill']['roots']:
            value = self.skill_command('doctor', '--install-root', s['root'])
            require(value['version'] == VERSION and value['treeSha256'] == self.m['skill']['treeSha256'], 'Skill activation not current')
            require((Path(s['root']) / 'versions' / s['version'] / 'bundle.manifest.json').is_file(), 'Original Skill version not retained')
        for p in w.PROJECTS:
            state = w.ROOT / p / 'taskspaces/.broker'
            require(not (state / 'maintenance.json').exists() and not (state / 'release.lock').exists(), 'Maintenance not cleared')
        self.check_binding(self.m['gatewayFence'])
        for t in self.m['workpods']: self.check_binding(t['fence'])
        self.preserved()
        return {**result, 'verification': 'passed'}

    def deploy(self):
        import fcntl
        if (self.backup / 'success.json').exists(): return self.verify()
        self.preflight()
        with open('/srv/forge-delivery/registry/taskspaces.lock', 'a') as registry:
            fcntl.flock(registry, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.backup.mkdir(mode=0o700); (self.backup / 'manifest.json').write_bytes(self.data)
            fence = (json.dumps({'schemaVersion': 1, 'state': 'maintenance', 'epoch': OPERATION}) + '\n').encode()
            fences = [('gateway', self.m['gatewayFence'], self.m['gateway']['id'], 3080, True)] + [
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
                for key, binding, cid, port, gateway in fences:
                    self.check_binding(binding); before = regular(binding['path'])
                    (self.backup / (key + '.fence.before')).write_bytes(before)
                    common.atomic_replace(binding['path'], before, fence)
                    pid = self.inspect(cid)['State']['Pid']
                    self.run(['nsenter', '--target', str(pid), '--net', '--', 'ss', '--kill', '--tcp', '--numeric', 'state', 'established', '( sport = :' + str(port) + ' )'])
                    self.wait(lambda: self.fence(cid, gateway, True), 'Defaults ingress drained')
                self.preserved(); self.stage = 'creation-source'
                for i, s in enumerate(self.m['sources']):
                    self.check_binding(s['binding']); before = regular(s['binding']['path'])
                    (self.backup / ('source-' + str(i) + '.before')).write_bytes(before)
                    common.atomic_replace(s['binding']['path'], before, regular(Path(self.m['artifact']) / s['path']))
                self.stage = 'capability-defaults'
                for i, f in enumerate(self.m['environments']): self.apply_environment(f, i)
                self.stage = 'skill-defaults'
                for i, s in enumerate(self.m['skill']['roots']):
                    (self.backup / ('skill-' + str(i) + '.active.before')).write_bytes(regular(s['active']['path']))
                    self.skill_command('install', '--bundle', self.m['skill']['source'], '--install-root', s['root'])
                    self.skill_command('activate', '--install-root', s['root'], '--version', VERSION)
                self.preserved()
                for state in locks:
                    for file in (state / 'maintenance.json', state / 'release.lock/owner.json'):
                        require(json.loads(regular(file))['operationId'] == OPERATION, 'Maintenance ownership changed')
                        file.unlink()
                    (state / 'release.lock').rmdir()
                for key, binding, _, _, _ in reversed(fences):
                    common.atomic_replace(binding['path'], fence, regular(self.backup / (key + '.fence.before')))
                result = {'status': 'success', 'manifestSha256': self.digest, 'environmentFiles': len(self.m['environments']),
                    'skillVersion': VERSION, 'containersRestarted': False, 'hostRestarted': False, 'businessModified': False,
                    'oldSkillsRetained': True, 'automaticRollback': False}
                common.write_new(self.backup / 'success.json', result)
                return self.verify()
            except Exception as error:
                common.write_new(self.backup / 'failure.json', {'stage': self.stage, 'error': str(error), 'automaticRollback': False, 'blindReplayRefused': True})
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
        stdin, stdout, _ = client.exec_command(shlex.join(['/usr/bin/sudo', '-S', '-p', '', '--', 'python3', '-', *argv]), timeout=1200, get_pty=False)
        sources = {key: base64.b64encode(value).decode() for key, value in w.SOURCE_BYTES.items()}
        prefix = 'import base64\n_SOURCES={k:base64.b64decode(v) for k,v in ' + repr(sources) + '.items()}\n'
        prefix += '_WORKPOD_SOURCE=base64.b64decode(' + repr(base64.b64encode(WORKPOD_SOURCE).decode()) + ')\n'
        prefix += '_MANIFEST_BYTES=base64.b64decode(' + repr(base64.b64encode(data).decode()) + ')\n'
        stdin.write(secret + '\n' + prefix + regular(__file__).decode('utf8')); stdin.flush(); stdin.channel.shutdown_write()
        out, err = bridge.read_bounded_channel(stdout.channel, timeout_seconds=1200)
        code = stdout.channel.recv_exit_status()
    finally:
        client.close()
    require(secret.encode() not in out + err, 'Credential material refused')
    sys.stdout.write(out.decode('utf8', 'replace')); sys.stderr.write(err.decode('utf8', 'replace'))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
