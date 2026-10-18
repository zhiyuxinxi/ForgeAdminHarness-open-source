import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/部署-阶段20-独审事实反馈.py'
SPEC = importlib.util.spec_from_file_location('stage20_semantic_fact_feedback_deploy', SCRIPT)
DEPLOY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOY)


def manifest():
    containers = {role: {'id': str(index) * 64, 'imageId': 'sha256:' + str(index) * 64, 'name': 'original-' + role}
                  for index, role in enumerate(('acceptance', 'gateway', 'manager', 'broker', 'harness'), 1)}
    containers['acceptance'].update(targetImageId='sha256:' + '6' * 64, runtimeSha256='7' * 64)
    containers['harness']['port'] = 20050
    return {'schemaVersion': 1, 'operation': DEPLOY.OPERATION, 'projectSlug': 'forge-base', 'taskId': DEPLOY.TASK_ID,
            'containers': {'acceptance': containers.pop('acceptance')}, 'maintenance': containers,
            'helper': {'path': '/opt/forge-delivery-platform/scripts/lib/container-image-cutover.sh', 'sha256': '8' * 64},
            'files': {key: {'path': path.as_posix(), 'sha256': 'a' * 64, 'uid': 1000, 'gid': 983, 'mode': 0o600}
                      for key, path in DEPLOY.FILE_PATHS.items()},
            'sessionIds': ['session-f1184c70-6762-2e96-1a6f-90513bc971dd'],
            'hostUpgrade': {
                'unit': DEPLOY.FactFeedbackHostUpgrade.UNIT, 'oldVersion': '2026.09.18.3', 'newVersion': '2026.09.18.4',
                'oldPid': 12345, 'node': '/opt/node/bin/node', 'nodeMajor': 22, 'profileCatalogVersion': '2026.09.03.22',
                'oldBundleManifestSha256': 'b' * 64, 'newBundleManifestSha256': 'c' * 64,
                'oldTreeSha256': 'd' * 64, 'newTreeSha256': 'e' * 64,
                'stagedBundlePath': '/srv/forge-delivery/verification/fact-feedback/host-2026.09.18.4',
                'globalCurrent': 'versions/unchanged', 'globalActiveSha256': 'f' * 64,
                'otherHostPids': {'forge-host-verification@other.service': 22222},
                'changedModules': {name: {'oldSha256': '1' * 64, 'newSha256': '2' * 64}
                                   for name in DEPLOY.FactFeedbackHostUpgrade.MODULES},
                'files': {key: {'path': path, 'sha256': 'a' * 64, 'uid': 0, 'gid': 0, 'mode': 0o640}
                          for key, path in DEPLOY.FactFeedbackHostUpgrade.FILES.items()},
                'preservedToolchains': {'node': '/opt/node/bin/node', 'forgeGovernance': '/preserved/bin/forge-governance'}}}


class FactFeedbackDeploymentTests(unittest.TestCase):
    def deployment(self, value=None):
        value = value or manifest()
        return DEPLOY.Deployment(value, (json.dumps(value) + '\n').encode())

    def test_manifest_rejects_any_extra_upgrade_target_or_host_payload(self):
        cases = []
        value = manifest(); value['containers']['broker'] = value['maintenance'].pop('broker'); cases.append(value)
        value = manifest(); value['maintenance']['harness']['targetImageId'] = 'sha256:' + '9' * 64; cases.append(value)
        value = manifest(); value['hostUpgrade']['newVersion'] = '2026.09.18.5'; cases.append(value)
        value = manifest(); value['hostUpgrade']['changedModules']['lib/verify-policy.mjs'] = {'oldSha256': '1' * 64, 'newSha256': '2' * 64}; cases.append(value)
        value = manifest(); value['taskId'] = 'another-task'; cases.append(value)
        value = manifest(); value['files']['taskEnv']['path'] = '/other/task.env'; cases.append(value)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                self.deployment(value)

    def test_only_acceptance_image_changes_and_task_env_remains_byte_identical(self):
        value = manifest()
        for newline in (b'\n', b'\r\n'):
            original = newline.join([b'# exact original', b'PROTECTED_ACCEPTANCE_IMAGE=old',
                                      b'CONVERSATION_MANAGER_IMAGE=keep-manager', b'TASKSPACE_BROKER_IMAGE=keep-broker',
                                      b'HARNESS_IMAGE=keep-harness', b'OTHER= keep spaces ']) + newline
            expected = original.replace(b'PROTECTED_ACCEPTANCE_IMAGE=old',
                                        b'PROTECTED_ACCEPTANCE_IMAGE=' + value['containers']['acceptance']['targetImageId'].encode())
            self.assertEqual(DEPLOY.changed_bytes('projectEnv', original, value), expected)
            task = b'HARNESS_IMAGE=keep\r\nFORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED=true\r\nOTHER=exact'
            self.assertEqual(DEPLOY.changed_bytes('taskEnv', task, value), task)
        with self.assertRaises(RuntimeError):
            DEPLOY.changed_bytes('projectEnv', b'PROTECTED_ACCEPTANCE_IMAGE=one\nPROTECTED_ACCEPTANCE_IMAGE=two\n', value)

    def test_host_revision_preserves_toolchains_and_other_bundle_payload(self):
        host = self.deployment().host
        original = ('{\r\n "runnerRevision":"forge-host-runner-2026.09.18.3",\r\n "toolchains":'
                    + json.dumps(host.m['preservedToolchains']) + ',"limits":{"maxConcurrent":2}\r\n}\r\n').encode()
        self.assertEqual(host._replacement('hostContract', original),
                         original.replace(b'forge-host-runner-2026.09.18.3', b'forge-host-runner-2026.09.18.4'))
        changed = json.loads(original); changed['toolchains']['node'] = '/wrong/node'
        with self.assertRaisesRegex(RuntimeError, '工具链与冻结前像不一致'):
            host._replacement('hostContract', json.dumps(changed).encode())
        files = [{'path': name, 'sha256': '1' * 64, 'bytes': 30} for name in sorted(host.MODULES)]
        files.append({'path': 'lib/verify-policy.mjs', 'sha256': '9' * 64, 'bytes': 40})
        old = {'bundleVersion': host.m['oldVersion'], 'treeSha256': 'd' * 64, 'files': files, 'schemaVersion': 1}
        new = copy.deepcopy(old); new['bundleVersion'] = host.m['newVersion']; new['treeSha256'] = 'e' * 64
        for item in new['files']:
            if item['path'] in host.MODULES:
                item['sha256'] = '2' * 64
        host._bundle = Mock(side_effect=lambda _, old=False: copy.deepcopy(old_bundle if old else new))
        old_bundle = old
        self.assertEqual(host._bundles('/fixture/staged'), new)
        new['files'][-1]['sha256'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, '夹带其它文件变化'):
            host._bundles('/fixture/staged')

    def fake_deployment(self, folder):
        instance = self.deployment()
        instance.backup = Path(folder) / 'backup'
        instance.records = instance.backup / 'container-cutover'
        instance.success = instance.backup / '独审事实反馈升级成功.json'
        instance.broker_state = Path(folder) / 'broker-state'
        instance.broker_state.mkdir()
        instance.preflight = Mock(return_value={'status': 'passed'})
        original = {'projectEnv': b'PROTECTED_ACCEPTANCE_IMAGE=old\nHARNESS_IMAGE=unchanged\n',
                    'taskEnv': b'HARNESS_IMAGE=untouched\r\nOTHER=keep exact\r\n',
                    'gatewayFence': b'{"state":"committed","epoch":"original-gateway"}\n',
                    'harnessFence': b'{"state":"committed","epoch":"original-harness"}\n'}
        paths = {}
        for key, raw in original.items():
            paths[key] = Path(folder) / key
            paths[key].write_bytes(raw)
        def file(key, expected=None):
            raw = paths[key].read_bytes()
            self.assertEqual(raw, original[key] if expected is None else expected)
            return raw
        instance.file = file
        state = {item['id']: 'running' for item in [*instance.m['containers'].values(), *instance.m['maintenance'].values()]}
        events, candidate = [], '9' * 64
        def inspect(identity):
            return {'Id': identity, 'Image': 'sha256:' + identity, 'State': {'Status': state[identity], 'Pid': 1234}}
        instance.inspect = inspect
        def container(item, running=True):
            self.assertEqual(state[item['id']], 'running' if running else 'exited')
            return inspect(item['id'])
        instance.container = container
        instance.wait = lambda fn, _: self.assertTrue(fn())
        instance.fence = lambda *args: True
        instance.close_idle_harness_connections = lambda: events.append(('drain',))
        instance.ready = lambda ids, maintenance: events.append(('ready', maintenance)) or True
        instance.jobs_idle = lambda: events.append(('idle',))
        def prepare(role):
            self.assertEqual(role, 'acceptance')
            events.append(('prepare', role))
            record = {'candidate': {'id': candidate}, 'original': {'fullId': instance.m['containers'][role]['id']}}
            instance.record(role).write_text(json.dumps(record), encoding='utf8')
        instance.prepare = prepare
        def run(argv, timeout=30):
            self.assertEqual(argv[0], 'docker')
            if argv[1] == 'exec':
                self.assertEqual(argv[2], instance.m['containers']['acceptance']['id'])
                return b'{"connected":0}'
            self.assertIn(argv[1], ('stop', 'start'))
            identity = argv[-1]
            self.assertIn(identity, [instance.m['maintenance'][role]['id'] for role in ('manager', 'broker')])
            state[identity] = 'exited' if argv[1] == 'stop' else 'running'
            events.append((argv[1], identity))
            return b''
        instance.run = run
        def install():
            for role in ('manager', 'broker'):
                self.assertEqual(state[instance.m['maintenance'][role]['id']], 'exited')
            events.append(('host-install',))
            return {'ok': True, 'mainPid': 54321}
        instance.host.install = Mock(side_effect=install)
        instance.host.verify = Mock(return_value={'ok': True, 'mainPid': 54321})
        def activate(role):
            self.assertEqual(role, 'acceptance')
            self.assertIn(('host-install',), events)
            for preserved in ('manager', 'broker'):
                self.assertEqual(state[instance.m['maintenance'][preserved]['id']], 'exited')
            events.append(('activate', role))
            state[instance.m['containers'][role]['id']] = 'exited'
            state[candidate] = 'running'
            return candidate
        instance.activate = Mock(side_effect=activate)
        instance.helper = lambda function, record: events.append((function, Path(record).name))
        def verify(ids):
            self.assertEqual(ids, instance.ids(candidate))
            self.assertEqual(paths['taskEnv'].read_bytes(), original['taskEnv'])
            self.assertEqual(paths['projectEnv'].read_bytes(), DEPLOY.changed_bytes('projectEnv', original['projectEnv'], instance.m))
            for key in ('gatewayFence', 'harnessFence'):
                self.assertEqual(paths[key].read_bytes(), original[key])
            self.assertFalse((instance.broker_state / 'maintenance.json').exists())
            self.assertFalse((instance.broker_state / 'release.lock').exists())
            for role in ('manager', 'broker', 'harness', 'gateway'):
                self.assertEqual(state[instance.m['maintenance'][role]['id']], 'running')
            events.append(('verified',))
            return instance.host.verify()
        instance._verify = verify
        return instance, paths, original, events, state

    def test_only_acceptance_and_host_switch_and_successful_repeat_only_verifies(self):
        with tempfile.TemporaryDirectory() as folder:
            instance, paths, original, events, _ = self.fake_deployment(folder)
            with patch.object(DEPLOY, 'FILE_PATHS', paths), patch.object(DEPLOY.os, 'chown', create=True), \
                    patch.object(DEPLOY.BASE, 'stable_contract_sha256', side_effect=lambda value, _: value['Id']):
                result = instance.deploy()
                self.assertEqual(result['replacedContainers'], ['acceptance'])
                self.assertTrue(result['taskEnvUnchanged'])
                self.assertFalse(result['automaticRollback'])
                for key, data in original.items():
                    self.assertEqual((instance.backup / (key + '.前像')).read_bytes(), data)
                self.assertEqual((instance.backup / '冻结清单.json').read_bytes(), instance.data)
                self.assertEqual([event for event in events if event[0] in ('prepare', 'activate', 'forge_cutover_promote')],
                                 [('prepare', 'acceptance'), ('activate', 'acceptance'), ('forge_cutover_promote', 'acceptance.json')])
                self.assertEqual([event for event in events if event[0] in ('stop', 'start')],
                                 [('stop', '3' * 64), ('stop', '4' * 64), ('start', '3' * 64), ('start', '4' * 64)])
                instance.host.install.reset_mock()
                instance.run = Mock(side_effect=AssertionError('重复操作不得切换'))
                self.assertEqual(instance.deploy(), result)
                instance.run.assert_not_called()
                instance.host.install.assert_not_called()

    def test_failed_host_upgrade_keeps_preimages_and_stopped_sources_without_rollback(self):
        with tempfile.TemporaryDirectory() as folder:
            instance, paths, original, events, state = self.fake_deployment(folder)
            instance.host.install.side_effect = RuntimeError('固定 Host 安装失败，私有诊断已保存')
            with patch.object(DEPLOY, 'FILE_PATHS', paths), patch.object(DEPLOY.os, 'chown', create=True):
                with self.assertRaisesRegex(RuntimeError, 'Host 安装失败'):
                    instance.deploy()
                instance.activate.assert_not_called()
                self.assertFalse(any(event[0] == 'start' for event in events))
                self.assertTrue((instance.broker_state / 'maintenance.json').exists())
                for key, raw in original.items():
                    self.assertEqual((instance.backup / (key + '.前像')).read_bytes(), raw)
                failure = json.loads((instance.backup / '独审事实反馈升级失败.json').read_text(encoding='utf8'))
                self.assertEqual(failure['stage'], '仅升级 forge-base Host 两模块')
                self.assertFalse(failure['automaticRollback'])
                self.assertEqual(failure['originalSources']['broker']['status'], 'exited')
                instance.preflight = DEPLOY.Deployment.preflight.__get__(instance)
                with self.assertRaisesRegex(RuntimeError, '拒绝盲重放'):
                    instance.deploy()
                self.assertEqual(state['3' * 64], 'exited')

    def test_timeout_diagnostics_keep_private_output_without_echoing_arguments(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = self.deployment()
            instance.diagnostics = Path(folder)
            raw = b'private-fixture-value' + b'x' * 70000
            failure = subprocess.TimeoutExpired(['not-run', 'private-argument'], 1, output=raw, stderr=b'private-error')
            with patch.object(DEPLOY.BASE.subprocess, 'run', side_effect=failure):
                with self.assertRaises(RuntimeError) as caught:
                    instance.run(['not-run', 'private-argument'], timeout=1)
            message = str(caught.exception)
            self.assertNotIn('private-argument', message)
            self.assertNotIn('private-fixture-value', message)
            self.assertNotIn('private-error', message)
            evidence = json.loads(message.split('诊断=', 1)[1])
            self.assertEqual(evidence['stdout']['bytes'], len(raw))
            self.assertEqual(evidence['stdout']['sha256'], DEPLOY.sha(raw))
            self.assertTrue(evidence['stdout']['truncated'])
            self.assertEqual(Path(evidence['stdout']['path']).read_bytes(), raw[:32768] + raw[-32768:])
            if os.name != 'nt':
                self.assertEqual(Path(evidence['stdout']['path']).stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
