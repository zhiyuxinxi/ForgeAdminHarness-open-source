import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/prepare-harness-runtime-services.py'
spec = importlib.util.spec_from_file_location('runtime_services', SCRIPT)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)

PROJECT = Path('/srv/forge-delivery/projects/fixture')
RELEASE = 'release-01'
ROOT = PROJECT / 'runtime-versions/stable' / RELEASE
ACCEPTANCE = PROJECT / 'acceptance/runtime-versions/stable' / RELEASE
VERIFY = PROJECT / 'verification/runtime-versions/stable' / RELEASE


def binding():
    return {'channel': 'stable', 'versionId': 'a' * 64, 'harnessImage': 'sha256:' + 'b' * 64,
            'skillBundleRoot': str(ROOT / 'skills'), 'managerSocket': str(ROOT / 'manager/manager.sock'),
            'environment': {key: 'direct' if key == 'FORGE_DEVELOPMENT_MODE' else 'false' for key in runtime.ENV_KEYS}}


def container(role):
    mounts = [(str(PROJECT / 'workspace'), str(PROJECT / 'workspace'), True),
              (str(PROJECT / 'taskspaces'), str(PROJECT / 'taskspaces'), True)]
    env = ['SECRET_VALUE=must-not-appear-in-summary', 'FORGE_DEVELOPMENT_MODE=controlled']
    if role == 'protected-acceptance':
        mounts += [(str(PROJECT / 'acceptance/state'), '/var/lib/forge-acceptance', True),
                   (str(PROJECT / 'acceptance/service.json'), '/etc/forge-acceptance/service.json', False),
                   ('/srv/control/ipc', '/run/forge-conversation-manager', False)]
    if role == 'conversation-manager':
        mounts += [(str(PROJECT), str(PROJECT), True),
                   (str(PROJECT / 'acceptance/empty-mask'), str(PROJECT / 'acceptance'), False),
                   (str(PROJECT / 'verification/empty-mask'), str(PROJECT / 'verification'), False),
                   ('/srv/control/ipc', '/run/forge-manager', True),
                   ('/srv/skills', '/srv/skills', False), ('/opt/forge-delivery-platform', '/opt/forge-delivery-platform', False)]
        env += ['CONVERSATION_PHASE_CATALOG_FILE=/srv/skills/current/skills/forge-task-router/references/phase-profiles.json']
    if role == 'taskspace-broker':
        mounts += [('/srv/skills/current/catalog.json', '/etc/forge-phase-catalog/phase-profiles.json', False),
                   (str(PROJECT / 'verification/host-contract.json'), '/etc/forge-verification/inventory-contract.json', False)]
    if role in ('taskspace-broker', 'release-runner'):
        mounts += [(str(PROJECT / 'ops/release-ipc'), '/run/forge-release', role == 'release-runner')]
    if role in ('taskspace-broker', 'verification-runner'):
        mounts += [(str(PROJECT / 'verification/ipc'), '/run/forge-verify', role == 'verification-runner')]
    if role in ('conversation-manager', 'verification-runner'):
        mounts += [(str(PROJECT / 'verification/source-ipc'), '/run/forge-verify-source', role == 'verification-runner')]
    for suffix in ('control', 'issuer', 'resolver', 'scope'):
        mounts += [(str(PROJECT / ('acceptance/ipc-' + suffix)), '/run/forge-acceptance-' + suffix, role == 'protected-acceptance')]
    identity = hashlib.sha256(role.encode()).hexdigest()
    return {'Id': identity, 'Image': 'sha256:' + 'c' * 64, 'State': {'Running': True},
            'Config': {'Image': 'sha256:' + 'c' * 64, 'Hostname': identity[:12], 'User': '1000:983',
                       'Env': env, 'Entrypoint': ['node'], 'Cmd': [role + '.mjs'],
                       'Healthcheck': {'Test': ['CMD', 'node', '--version']},
                       'Labels': {'com.docker.compose.project': 'forge-fixture', 'com.docker.compose.service': role}},
            'HostConfig': {'Binds': [src + ':' + dst + (':rw' if rw else ':ro') for src, dst, rw in mounts],
                           'NetworkMode': 'forge-fixture_taskspaces', 'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
                           'SecurityOpt': ['no-new-privileges:true'], 'MaskedPaths': ['/proc/kcore'],
                           'PidsLimit': 256, 'Memory': 123456, 'GroupAdd': ['983'], 'Tmpfs': {'/tmp': 'rw,noexec'},
                           'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '20m'}}, 'AutoRemove': False,
                           'PortBindings': {}, 'ContainerIDFile': ''},
            'Mounts': [{'Source': src, 'Destination': dst, 'RW': rw, 'Type': 'bind'} for src, dst, rw in mounts],
            'NetworkSettings': {'Networks': {'forge-fixture_taskspaces': {'Aliases': [role, identity[:12]],
                                  'IPAddress': '172.30.0.9', 'Gateway': '172.30.0.1', 'EndpointID': 'old-endpoint',
                                  'MacAddress': '00:00:00:00:00:01', 'DriverOpts': {'fixture': 'preserved'}}}}}


def documents():
    return {'businessBaseReady': True,
            'acceptanceService': {'path': str(PROJECT / 'acceptance/service.json'), 'sha256': 'd' * 64,
                                  'value': {'schemaVersion': 1, 'stateRoot': '/var/lib/forge-acceptance', 'projectPrivatePolicy': ['keep']}},
            'verificationContract': {'path': str(PROJECT / 'verification/contract.json'), 'sha256': 'e' * 64,
                                     'value': {'schemaVersion': 1, 'stateRoot': str(PROJECT / 'verification/state'),
                                               'profiles': ['project-private-profile'], 'limits': {'maxFiles': 123}}}}


class RuntimeServicesTest(unittest.TestCase):
    def test_candidates_preserve_security_business_mounts_and_isolate_private_state(self):
        parents = [container(role) for role in runtime.ROLES]
        before = copy.deepcopy(parents)
        plan = runtime.build_plan(str(PROJECT), RELEASE, binding(), str(ROOT / 'platform'), parents, documents())
        self.assertEqual(parents, before)
        self.assertFalse(plan['blockers'])
        self.assertIsNone(plan['nativeHostSpec'])
        for item, parent in zip(plan['containers'], parents):
            request = item['request']
            for key in ('ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'MaskedPaths', 'PidsLimit', 'Memory', 'GroupAdd', 'Tmpfs', 'LogConfig'):
                self.assertEqual(request['HostConfig'][key], parent['HostConfig'][key])
            self.assertEqual(request['User'], parent['Config']['User'])
            self.assertEqual(request['Healthcheck'], parent['Config']['Healthcheck'])
            self.assertIn(str(PROJECT / 'workspace') + ':' + str(PROJECT / 'workspace') + ':rw', request['HostConfig']['Binds'])
            self.assertEqual(request['Image'], binding()['harnessImage'])
            endpoint = request['NetworkingConfig']['EndpointsConfig']['forge-fixture_taskspaces']
            self.assertEqual(set(endpoint), {'Aliases', 'DriverOpts'})
            self.assertEqual(endpoint['Aliases'][0], item['role'] + '-stable')
            self.assertNotIn(parent['Config']['Hostname'], endpoint['Aliases'])
        by_role = {item['role']: item for item in plan['containers']}
        manager = by_role['conversation-manager']['request']
        self.assertIn(str(PROJECT / 'acceptance/empty-mask') + ':' + str(PROJECT / 'acceptance') + ':ro', manager['HostConfig']['Binds'])
        self.assertIn(str(ROOT / 'manager') + ':/run/forge-manager:rw', manager['HostConfig']['Binds'])
        self.assertIn(str(ACCEPTANCE / 'ipc-control') + ':/run/forge-acceptance-control:ro', manager['HostConfig']['Binds'])
        broker_env = dict(v.split('=', 1) for v in by_role['taskspace-broker']['request']['Env'])
        self.assertEqual(broker_env['TASKSPACE_BROKER_STATUS_SOCKET'], str(ROOT / 'broker/project-status.sock'))
        self.assertEqual(broker_env['FORGE_RUNTIME_VERSION_ID'], binding()['versionId'])
        self.assertEqual(plan['files'][0]['content']['projectPrivatePolicy'], ['keep'])
        self.assertEqual(plan['files'][1]['content']['profiles'], ['project-private-profile'])
        self.assertEqual(plan['files'][1]['content']['stateRoot'], str(VERIFY / 'state'))

    def test_native_host_is_an_explicit_external_prerequisite(self):
        parents = [container(role) for role in runtime.ROLES if role != 'verification-runner']
        stopped = copy.deepcopy(parents[0])
        stopped['State']['Running'] = False
        parents.append(stopped)
        plan = runtime.build_plan(str(PROJECT), RELEASE, binding(), str(ROOT / 'platform'), parents, documents())
        self.assertEqual(len(plan['containers']), 4)
        self.assertEqual(plan['nativeHostSpec']['runnerSocket'], str(VERIFY / 'ipc/runner.sock'))
        self.assertEqual(plan['nativeHostSpec']['issuerSocket'], str(ACCEPTANCE / 'ipc-issuer/issuer.sock'))
        self.assertEqual(plan['nativeHostSpec']['stateRoot'], str(VERIFY / 'host-state'))
        self.assertEqual(len(plan['files']), 1)

    def test_missing_baseline_stays_stopped_and_unsafe_masks_or_static_ip_are_rejected(self):
        plan = runtime.build_plan(str(PROJECT), RELEASE, binding(), str(ROOT / 'platform'), [], documents())
        self.assertTrue(plan['blockers'])
        self.assertEqual(plan['containers'], [])
        parents = [container(role) for role in runtime.ROLES]
        no_business = documents()
        no_business['businessBaseReady'] = False
        self.assertTrue(runtime.build_plan(str(PROJECT), RELEASE, binding(), str(ROOT / 'platform'), parents, no_business)['blockers'])
        unsafe = copy.deepcopy(parents)
        next(m for m in unsafe[-1]['Mounts'] if m['Destination'] == str(PROJECT / 'acceptance'))['RW'] = True
        with self.assertRaisesRegex(ValueError, 'private-state mask'):
            runtime.build_plan(str(PROJECT), RELEASE, binding(), str(ROOT / 'platform'), unsafe, documents())
        unsafe = copy.deepcopy(parents)
        unsafe[0]['NetworkSettings']['Networks']['forge-fixture_taskspaces']['IPAMConfig'] = {'IPv4Address': '172.30.0.9'}
        with self.assertRaisesRegex(ValueError, 'Static network'):
            runtime.build_plan(str(PROJECT), RELEASE, binding(), str(ROOT / 'platform'), unsafe, documents())


if __name__ == '__main__':
    unittest.main()
