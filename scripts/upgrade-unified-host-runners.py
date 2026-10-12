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

OPERATION = 'development-flow-host-20260920'
VERSION = '2026.09.20.2'
REVISION = 'forge-host-runner-' + VERSION
INSTALL = Path('/srv/forge-delivery/host-runner')
TARGET = INSTALL / 'versions' / VERSION
PROJECTS = {'forge-base', 'forge-replica-acceptance', 'forge-a9-clean-20260914', 'forge-a9-runtime-20260913'}
SECURITY = ('User', 'Group', 'MemoryMax', 'MemoryHigh', 'MemorySwapMax', 'NoNewPrivileges', 'PrivateTmp', 'ProtectSystem', 'ProtectHome')


def validate_manifest(m):
    require(m.get('schemaVersion') == 'unified-host/v1' and m.get('operation') == OPERATION, 'Unexpected Host operation')
    b = m['bundle']
    require(b['version'] == VERSION and b['treeSha256'] == '6a5891213829b1b87542fc0b2de7e1c5221125b696a0149ae85c22084d9a9b0c'
            and b['stage'] == '/srv/forge-delivery/canary/development-flow-host-20260920-6a5891213829', 'Unreviewed Host artifact')
    require(m['node'] == '/srv/forge-delivery/canary/forge-skills-20260903/toolchains/versions/node-v22.23.2-linux-x64/bin/node', 'Unreviewed Node')
    require(len(m['projects']) == 4 and {p['project'] for p in m['projects']} == PROJECTS, 'Exactly four active Host projects required')
    for p in m['projects']:
        unit = 'forge-host-verification@' + p['project'] + '.service'
        require(p['unit'] == unit and p['systemd']['MainPID'].isdigit() and p['systemd']['MainPID'] != '0', 'Wrong active unit')
        require(p['override'] == {'path': '/etc/systemd/system/' + unit + '.d/zzz-development-flow-host-20260920.conf', 'exists': False}, 'Override outside scope')
        require({f['path'] for f in p['files']} == {(w.ROOT / p['project'] / 'verification' / n).as_posix()
            for n in ('host-contract.json', 'contract.json', 'host-runner.env')}, 'Configuration escaped Host scope')
        require(p['catalog'] in ('2026.09.03.5', '2026.09.03.22'), 'Unvalidated catalog')
    require(m['previous']['active']['path'] == (INSTALL / 'active.json').as_posix()
            and m['previous']['current'] == '/srv/forge-delivery/host-runner/versions/2026.09.20.1'
            and m['previous']['fragment']['path'] == '/etc/systemd/system/forge-host-verification@.service', 'Unexpected previous Host state')
    require(m['inactiveHosts'] == {'demoteam-phase2': '0', 'safety-project-management': '0'}, 'Inactive Host mode must remain unchanged')
    seen = set()
    for t in m['workpods']:
        require(t['project'] in PROJECTS and t['container']['id'] not in seen
                and t['fence']['path'] == (w.task_root(t) / 'maintenance/proxy-fence.json').as_posix()
                and all(s['running'] is False for s in t['sessions']), 'Unexpected or busy workpod')
        seen.add(t['container']['id'])


def contract_bytes(raw, project):
    old = json.loads(raw)
    require(old['runnerRevision'] == project['runnerRevision'] and old['toolchains']['forgeGovernance'] == project['governance'], 'Host field binding changed')
    new = json.loads(raw)
    new['runnerRevision'] = REVISION
    new['toolchains']['forgeGovernance'] = (TARGET / 'bin/forge-governance').as_posix()
    result = raw
    for before, after in ((old['runnerRevision'], REVISION), (project['governance'], new['toolchains']['forgeGovernance'])):
        a, b = json.dumps(before).encode(), json.dumps(after).encode()
        require(result.count(a) == 1, 'Host field replacement must be unique')
        result = result.replace(a, b)
    require(json.loads(result) == new, 'Unexpected Host policy mutation')
    return result


def override_bytes(node):
    return ('[Service]\nExecStart=\nExecStart=' + node + ' ' + (TARGET / 'lib/host-verification-runner.mjs').as_posix() + '\n').encode()


class Deployment(w.Deployment):
    def __init__(self, manifest, data):
        validate_manifest(manifest)
        self.m, self.data, self.digest = manifest, data, sha(data)
        self.backup = Path('/srv/forge-delivery/platform-backups') / ('pre-' + OPERATION)
        self.diagnostics = Path('/var/tmp')
        self.stage = 'preflight'

    def unit_properties(self, p):
        keys = ['MainPID', 'ExecStart', 'FragmentPath', 'DropInPaths', *SECURITY]
        value = self.run(['systemctl', 'show', p['unit'], '--property=' + ','.join(keys)]).decode()
        return dict(line.split('=', 1) for line in value.splitlines())

    def host_health(self, p, revision):
        value = json.loads(self.run(['curl', '-fsS', '--max-time', '5', '--unix-socket',
            str(w.ROOT / p['project'] / 'verification/ipc/runner.sock'), 'http://localhost/healthz'], 7))
        require(value.get('ok') is True and value.get('projectSlug') == p['project'] and value.get('runnerRevision') == revision
                and value.get('activeJobs') == 0 and value.get('acceptingJobs') is True and not value.get('safetyHold'), 'Host is busy or unhealthy: ' + p['project'])
        return value

    def bundle_command(self, action, *args):
        manager = Path(self.m['bundle']['stage']) / 'bin/forge-host-runner-bundle.mjs'
        require(sha(regular(manager)) == self.m['bundle']['managerSha256'], 'Candidate installer changed')
        value = json.loads(self.run([self.m['node'], str(manager), action, *args], 120))
        require(value.get('ok') is True, 'Host bundle action failed: ' + action)
        return value

    def preserved(self):
        actual = [json.loads(x) for x in self.run(['docker', 'ps', '--no-trunc', '--format', '{{json .}}']).decode().splitlines()]
        require(sorted((x['ID'], x['Names']) for x in actual) == sorted((x['id'], x['name']) for x in self.m['containers']), 'Running container identity changed')
        for p, pid in self.m['inactiveHosts'].items():
            require(self.run(['systemctl', 'show', 'forge-host-verification@' + p + '.service', '--property', 'MainPID', '--value']).decode().strip() == pid, 'Inactive Host started')
        self.check_binding(self.m['previous']['fragment'])
        for p in self.m['projects']:
            for f in [*p['dropins'], *[f for f in p['files'] if not f['path'].endswith('/host-contract.json')]]:
                self.check_binding(f)
        # Reuse the source proof; Host rollout never opens a business workspace.
        with w.concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            current = list(pool.map(lambda t: self.task_sessions(t['container']['id']), self.m['workpods']))
        require(current == [t['sessions'] for t in self.m['workpods']], 'Session changed or became active')

    def preflight(self):
        if (self.backup / 'success.json').exists(): return self.verify()
        require(not self.backup.exists(), 'Partial Host update retained; inspect before resume')
        b = self.m['bundle']; stage = Path(b['stage'])
        require(sha(regular(stage / 'runner.manifest.json')) == b['manifestSha256'], 'Host manifest changed')
        for cat in sorted({p['catalog'] for p in self.m['projects']}):
            result = self.bundle_command('validate', '--bundle', str(stage), '--profile-catalog-version', cat, '--node-major', '22')
            require(result['treeSha256'] == b['treeSha256'], 'Host payload changed')
        require(not (INSTALL / 'activation.pending.json').exists() and (INSTALL / 'current').resolve().as_posix() == self.m['previous']['current'], 'Host activation already changed')
        self.check_binding(self.m['previous']['active'])
        for p in self.m['projects']:
            require(self.unit_properties(p) == p['systemd'], 'Host unit changed before maintenance')
            self.check_binding(p['override'])
            for f in p['files']: self.check_binding(f)
            contract_bytes(regular(w.ROOT / p['project'] / 'verification/host-contract.json'), p)
            self.host_health(p, p['runnerRevision']); self.project_idle(p['project'])
            state = w.ROOT / p['project'] / 'taskspaces/.broker'
            require(not (state / 'maintenance.json').exists() and not (state / 'release.lock').exists(), 'Project already in maintenance')
        for t in self.m['workpods']:
            self.check_binding(t['fence'])
            require(json.loads(regular(t['fence']['path']))['state'] == 'committed', 'Workpod already in maintenance')
        self.preserved()
        return {'status': 'ready', 'projects': 4, 'workpods': len(self.m['workpods']), 'manifestSha256': self.digest}

    def verify_unit(self, p):
        value = self.unit_properties(p)
        require(value['MainPID'] not in ('0', p['systemd']['MainPID']), 'New Host process not running')
        command = regular('/proc/' + value['MainPID'] + '/cmdline').split(b'\0')
        require(command[:2] == [self.m['node'].encode(), str(TARGET / 'lib/host-verification-runner.mjs').encode()], 'Actual Host command differs')
        require(all(value[k] == p['systemd'][k] for k in SECURITY)
                and value['FragmentPath'] == p['systemd']['FragmentPath']
                and set(value['DropInPaths'].split()) == {*p['systemd']['DropInPaths'].split(), p['override']['path']}, 'Host isolation or drop-ins changed')
        self.host_health(p, REVISION)
        return value['MainPID']

    def upgrade_host(self, p):
        self.stage = p['project']
        self.host_health(p, p['runnerRevision']); self.project_idle(p['project'])
        file = w.ROOT / p['project'] / 'verification/host-contract.json'
        before = regular(file); changed = contract_bytes(before, p)
        (self.backup / (p['project'] + '.host-contract.before')).write_bytes(before)
        common.atomic_replace(file, before, changed)
        override = Path(p['override']['path']); self.check_binding(p['override'])
        require(override.parent.parent.resolve() == override.parent.parent, 'Unsafe systemd path')
        override.parent.mkdir(mode=0o755, exist_ok=True)
        require(override.parent.resolve() == override.parent, 'Unsafe systemd drop-in directory')
        with override.open('xb') as stream: stream.write(override_bytes(self.m['node']))
        os.chmod(override, 0o644)
        self.run(['systemctl', 'daemon-reload'])
        self.run(['systemctl', 'restart', p['unit']], 120)
        self.wait(lambda: self.verify_unit(p), 'New Host health')
        result = {'project': p['project'], 'pid': self.verify_unit(p), 'revision': REVISION}
        common.write_new(self.backup / (p['project'] + '.verified.json'), result)
        print(json.dumps(result), flush=True)
        return result

    def verify(self):
        result = json.loads(regular(self.backup / 'success.json'))
        require(result['manifestSha256'] == self.digest and len(result['projects']) == 4, 'Incomplete Host result')
        require((INSTALL / 'current').resolve() == TARGET, 'Future Host default not promoted')
        for p in self.m['projects']:
            self.verify_unit(p)
            raw = regular(self.backup / (p['project'] + '.host-contract.before'))
            require(regular(w.ROOT / p['project'] / 'verification/host-contract.json') == contract_bytes(raw, p), 'Host contract drift')
            require(regular(p['override']['path']) == override_bytes(self.m['node']), 'Host entrypoint drift')
            state = w.ROOT / p['project'] / 'taskspaces/.broker'
            require(not (state / 'maintenance.json').exists() and not (state / 'release.lock').exists(), 'Host maintenance not cleared')
        for t in self.m['workpods']: self.check_binding(t['fence'])
        for cat in ('2026.09.03.5', '2026.09.03.22'):
            self.bundle_command('doctor', '--install-root', str(INSTALL), '--profile-catalog-version', cat, '--node-major', '22')
        self.preserved()
        return {**result, 'verification': 'passed'}

    def deploy(self):
        import fcntl
        if (self.backup / 'success.json').exists(): return self.verify()
        self.preflight()
        with open('/srv/forge-delivery/registry/taskspaces.lock', 'a') as registry:
            fcntl.flock(registry, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.backup.mkdir(mode=0o700)
            (self.backup / 'manifest.json').write_bytes(self.data)
            (self.backup / 'active.before.json').write_bytes(regular(INSTALL / 'active.json'))
            fence = (json.dumps({'schemaVersion': 1, 'state': 'maintenance', 'epoch': OPERATION}) + '\n').encode()
            locks = []
            try:
                self.stage = 'maintenance'
                for p in self.m['projects']:
                    state = w.ensure_broker_state(p['project']); lock = state / 'release.lock'
                    lock.mkdir(mode=0o700); os.chown(lock, 1000, 983); locks.append(state)
                    for file in (lock / 'owner.json', state / 'maintenance.json'):
                        common.write_new(file, {'schemaVersion': 1, 'operationId': OPERATION, 'instanceId': OPERATION,
                            'taskId': 'platform-maintenance', 'actorId': 'platform-operator',
                            'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
                        os.chmod(file, 0o600); os.chown(file, 1000, 983)
                    self.project_idle(p['project'])
                self.preserved()
                for i, t in enumerate(self.m['workpods']):
                    self.check_binding(t['fence']); before = regular(t['fence']['path'])
                    (self.backup / ('pod-' + str(i) + '.fence.before')).write_bytes(before)
                    common.atomic_replace(t['fence']['path'], before, fence)
                    pid = self.inspect(t['container']['id'])['State']['Pid']
                    self.run(['nsenter', '--target', str(pid), '--net', '--', 'ss', '--kill', '--tcp', '--numeric',
                              'state', 'established', '( sport = :' + str(t['port']) + ' )'])
                    self.wait(lambda: self.fence(t['container']['id'], False, True), 'Host workpod ingress drained')
                self.preserved()
                self.stage = 'install'
                self.bundle_command('install', '--bundle', self.m['bundle']['stage'], '--install-root', str(INSTALL), '--node-major', '22')
                results = [self.upgrade_host(p) for p in self.m['projects']]
                self.stage = 'future-host-default'
                # The old manager declares catalog .6; validate both installed states structurally here.
                # All actual target catalogs are independently validated before and after activation.
                self.bundle_command('activate', '--install-root', str(INSTALL), '--version', VERSION, '--node-major', '22')
                self.preserved()
                for state in locks:
                    for file in (state / 'maintenance.json', state / 'release.lock/owner.json'):
                        require(json.loads(regular(file))['operationId'] == OPERATION, 'Maintenance ownership changed')
                        file.unlink()
                    (state / 'release.lock').rmdir()
                for i, t in reversed(list(enumerate(self.m['workpods']))):
                    common.atomic_replace(t['fence']['path'], fence, regular(self.backup / ('pod-' + str(i) + '.fence.before')))
                result = {'status': 'success', 'manifestSha256': self.digest, 'projects': results,
                    'bundleVersion': VERSION, 'treeSha256': self.m['bundle']['treeSha256'],
                    'containersRestarted': False, 'businessModified': False, 'oldBundlesRetained': True, 'automaticRollback': False}
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
