import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/部署-阶段20-独审变更依据.py'
SPEC = importlib.util.spec_from_file_location('stage20_change_basis_host_deploy', SCRIPT)
DEPLOY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOY)


def manifest():
    files = {key: {'path': path, 'sha256': 'a' * 64, 'uid': 0, 'gid': 0, 'mode': 0o640}
             for key, path in DEPLOY.ChangeBasisHostUpgrade.FILES.items()}
    return {'schemaVersion': 1, 'projectSlug': 'forge-base', 'taskId': DEPLOY.TASK_ID,
            'broker': {'id': DEPLOY.BROKER_ID, 'imageId': DEPLOY.BROKER_IMAGE, 'name': 'original-broker'},
            'operation': DEPLOY.OPERATION, 'hostUpgrade': {
                'unit': DEPLOY.ChangeBasisHostUpgrade.UNIT, 'oldVersion': '2026.09.18.4',
                'newVersion': '2026.09.18.5', 'oldPid': 12345, 'node': '/opt/node/bin/node', 'nodeMajor': 22,
                'profileCatalogVersion': '2026.09.03.22', 'oldBundleManifestSha256': 'b' * 64,
                'newBundleManifestSha256': 'c' * 64, 'oldTreeSha256': 'd' * 64, 'newTreeSha256': 'e' * 64,
                'stagedBundlePath': '/srv/forge-delivery/verification/semantic-change-basis/host-2026.09.18.5',
                'globalCurrent': 'versions/unchanged', 'globalActiveSha256': 'f' * 64,
                'otherHostPids': {'forge-host-verification@other.service': 22222},
                'changedModules': {name: {'oldSha256': '1' * 64, 'newSha256': '2' * 64}
                                   for name in DEPLOY.ChangeBasisHostUpgrade.MODULES},
                'files': files, 'preservedToolchains': {
                    'node': '/opt/node/bin/node',
                    'forgeGovernance': '/srv/forge-delivery/host-runner/versions/2026.09.17.1/bin/forge-governance'}}}


class ChangeBasisHostDeploymentTests(unittest.TestCase):
    def deployment(self):
        value = manifest()
        deployment = DEPLOY.Deployment(value, (json.dumps(value) + '\n').encode())
        deployment.broker_ready = Mock(return_value=True)
        return deployment

    def mock_broker(self, deployment):
        events, state = [], {'status': 'running'}
        def run(argv, timeout=30):
            events.append(tuple(argv[:2]))
            self.assertEqual(argv[-1], DEPLOY.BROKER_ID)
            self.assertIn(argv[:2], [['docker', 'stop'], ['docker', 'start']])
            state['status'] = 'exited' if argv[1] == 'stop' else 'running'
            return b''
        def observed():
            return {'id': DEPLOY.BROKER_ID, 'imageId': DEPLOY.BROKER_IMAGE,
                    'status': state['status'], 'stateKnown': True}
        deployment.run = Mock(side_effect=run)
        deployment.broker_observation = observed
        def container(expected, running=True):
            self.assertEqual(expected['id'], DEPLOY.BROKER_ID)
            self.assertEqual(state['status'], 'running' if running else 'exited')
            return {'Id': expected['id'], 'Image': expected['imageId'], 'State': {'Status': state['status']}}
        deployment.container = container
        deployment.jobs_idle = lambda: events.append(('jobs-idle', state['status']))
        deployment.wait = lambda check, _: self.assertTrue(check())
        return events, state

    def test_fixed_scope_rejects_other_versions_modules_and_containers(self):
        cases = []
        value = manifest(); value['hostUpgrade']['newVersion'] = '2026.09.18.6'; cases.append(value)
        value = manifest(); value['hostUpgrade']['oldVersion'] = '2026.09.18.3'; cases.append(value)
        value = manifest(); del value['hostUpgrade']['changedModules']['lib/forge-independent-semantic-review.mjs']; cases.append(value)
        value = manifest(); value['hostUpgrade']['changedModules']['lib/verify-policy.mjs'] = {'oldSha256': '1' * 64, 'newSha256': '2' * 64}; cases.append(value)
        value = manifest(); value['containers'] = {}; cases.append(value)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                DEPLOY.Deployment(value, json.dumps(value).encode())

    def test_revision_replacement_preserves_full_toolchain_and_crlf_bytes(self):
        host = self.deployment().host
        original = ('{\r\n  "runnerRevision" : "forge-host-runner-2026.09.18.4",\r\n'
                    '  "toolchains":' + json.dumps(host.m['preservedToolchains']) + ',\r\n  "limits":{"maxConcurrent":2}\r\n}\r\n').encode()
        self.assertEqual(host._replacement('hostContract', original),
                         original.replace(b'forge-host-runner-2026.09.18.4', b'forge-host-runner-2026.09.18.5'))
        dropin = ('[Service]\r\nExecStart=\r\nExecStart=/opt/node/bin/node ' + host.old + '/lib/host-verification-runner.mjs\r\n').encode()
        self.assertEqual(host._replacement('dropin', dropin), dropin.replace(host.old.encode(), host.new.encode()))
        drifted = json.loads(original); drifted['toolchains']['java'] = '/different/java'
        with self.assertRaisesRegex(RuntimeError, '工具链与冻结前像不一致'):
            host._replacement('hostContract', json.dumps(drifted).encode())

        old = {'schemaVersion': 1, 'bundleVersion': host.m['oldVersion'], 'treeSha256': 'd' * 64,
               'files': [{'path': name, 'sha256': '1' * 64, 'bytes': 30} for name in sorted(host.MODULES)]
                        + [{'path': f'fixture/unchanged-{index}.mjs', 'sha256': '9' * 64, 'bytes': 40}
                           for index in range(26)]}
        new = copy.deepcopy(old)
        new.update(bundleVersion=host.m['newVersion'], treeSha256='e' * 64)
        for item in new['files']:
            if item['path'] in host.MODULES:
                item['sha256'] = '2' * 64
        host._bundle = Mock(side_effect=lambda directory, **kwargs: copy.deepcopy(old if kwargs.get('old') else new))
        self.assertEqual(host._bundles('/fixture/staged'), new)
        self.assertEqual(len(new['files']), 28)
        new['files'][-1]['sha256'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, '夹带其它文件变化'):
            host._bundles('/fixture/staged')

    def test_busy_preflight_cannot_create_backup_or_install(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(DEPLOY, 'BACKUP_ROOT', Path(directory)):
            deployment = self.deployment()
            deployment.host.preflight = Mock(side_effect=RuntimeError('Host 或 Release 忙碌'))
            deployment.host.install = Mock()
            with self.assertRaisesRegex(RuntimeError, '忙碌'):
                deployment.deploy()
            self.assertFalse(deployment.backup.exists())
            deployment.host.install.assert_not_called()

    def test_successful_repeat_only_verifies_without_install_or_commands(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(DEPLOY, 'BACKUP_ROOT', Path(directory)):
            deployment = self.deployment()
            deployment.host.preflight = Mock(return_value={'ok': True})
            deployment.host.install = Mock(return_value={'ok': True, 'mainPid': 54321})
            deployment.host.verify = Mock(return_value={'ok': True, 'mainPid': 54321})
            events, state = self.mock_broker(deployment)
            def install():
                events.append(('host-install', state['status']))
                self.assertEqual(state['status'], 'exited')
                return {'ok': True, 'mainPid': 54321}
            deployment.host.install.side_effect = install
            first = deployment.deploy()
            self.assertEqual(events, [('jobs-idle', 'running'), ('docker', 'stop'),
                                      ('jobs-idle', 'exited'), ('host-install', 'exited'), ('docker', 'start')])
            self.assertTrue(first['brokerTemporarilyStopped'])
            self.assertFalse(first['containersReplaced'])
            self.assertEqual(first['brokerRestored']['id'], DEPLOY.BROKER_ID)
            self.assertEqual(first['brokerRestored']['imageId'], DEPLOY.BROKER_IMAGE)
            self.assertEqual(first['brokerRestored']['status'], 'running')
            deployment.host.install.assert_called_once()
            deployment.host.install.reset_mock()
            deployment.run = Mock(side_effect=AssertionError('重复部署不得运行命令'))
            self.assertEqual(deployment.deploy(), first)
            self.assertEqual(deployment.preflight(), first)
            deployment.host.install.assert_not_called()
            deployment.run.assert_not_called()

    def test_failed_install_preserves_manifest_and_does_not_blind_replay(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(DEPLOY, 'BACKUP_ROOT', Path(directory)):
            deployment = self.deployment()
            deployment.host.preflight = Mock(return_value={'ok': True})
            deployment.host.install = Mock(side_effect=RuntimeError('已保存诊断，安装失败'))
            events, state = self.mock_broker(deployment)
            with self.assertRaisesRegex(RuntimeError, '安装失败'):
                deployment.deploy()
            self.assertEqual((deployment.backup / '部署冻结清单.json').read_bytes(), deployment.data)
            failure = json.loads((deployment.backup / '独审变更依据Host升级失败.json').read_text(encoding='utf8'))
            self.assertEqual(failure['error'], '已保存诊断，安装失败')
            self.assertTrue(failure['preimagesRetained'])
            self.assertEqual(failure['stage'], '仅升级 forge-base Host')
            self.assertTrue(failure['brokerStoppedConfirmed'])
            self.assertFalse(failure['brokerStartCommandSucceeded'])
            self.assertEqual(failure['brokerActualState']['status'], 'exited')
            self.assertNotIn(('docker', 'start'), events)
            with self.assertRaisesRegex(RuntimeError, '拒绝盲重放'):
                deployment.deploy()
            deployment.host.install.assert_called_once()

    def test_inflight_host_job_after_broker_stop_prevents_host_install(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(DEPLOY, 'BACKUP_ROOT', Path(directory)):
            deployment = self.deployment()
            deployment.host.preflight = Mock(return_value={'ok': True})
            deployment.host.install = Mock()
            events, state = self.mock_broker(deployment)
            deployment.jobs_idle = Mock(side_effect=[None, RuntimeError('Host/发布并非空闲')])
            with self.assertRaisesRegex(RuntimeError, '并非空闲'):
                deployment.deploy()
            deployment.host.install.assert_not_called()
            self.assertEqual(state['status'], 'exited')
            self.assertNotIn(('docker', 'start'), events)
            failure = json.loads((deployment.backup / '独审变更依据Host升级失败.json').read_text(encoding='utf8'))
            self.assertEqual(failure['stage'], '排空后再次确认 Host 与发布空闲')

    def test_busy_broker_prevents_stop_and_host_change(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(DEPLOY, 'BACKUP_ROOT', Path(directory)):
            deployment = self.deployment()
            deployment.broker_ready.side_effect = RuntimeError('原 Broker 忙碌')
            deployment.run = Mock()
            deployment.host.install = Mock()
            with self.assertRaisesRegex(RuntimeError, 'Broker 忙碌'):
                deployment.deploy()
            deployment.run.assert_not_called()
            deployment.host.install.assert_not_called()
            self.assertFalse(deployment.backup.exists())


if __name__ == '__main__':
    unittest.main()
