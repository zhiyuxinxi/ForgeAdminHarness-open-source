import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/部署-阶段20-历史回执复核.py'
SPEC = importlib.util.spec_from_file_location('stage20_receipt_revalidation_deploy', SCRIPT)
DEPLOY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOY)


class ReceiptRevalidationDeploymentTests(unittest.TestCase):
    def test_broker_cutover_records_its_stopped_state_before_host_or_images_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            deployment = object.__new__(DEPLOY.Deployment)
            deployment.backup = root / 'backup'
            deployment.records = deployment.backup / 'records'
            deployment.broker_state = root / 'broker-state'
            deployment.broker_state.mkdir()
            deployment.stage = 'fixture-preflight'
            deployment.data = b'{}'
            deployment.digest = 'a' * 64
            deployment.m = {'operation': 'lyl-revalidation-test',
                            'containers': {role: {'id': role} for role in ['acceptance', 'broker', 'harness']},
                            'maintenance': {role: {'id': role} for role in ['gateway', 'manager']}}
            paths = {key: root / (key + '.json') for key in DEPLOY.FILE_PATHS}
            for file in paths.values():
                file.write_bytes(b'{"state":"committed"}\n')
            states = {key: 'running' for key in ['acceptance', 'broker', 'harness', 'gateway', 'manager']}
            prepared = []
            deployment.preflight = lambda: None
            deployment.file = lambda key: paths[key].read_bytes()
            deployment.close_idle_harness_connections = lambda: None
            deployment.fence = lambda *_: True
            deployment.wait = lambda check, _: self.assertTrue(check())
            deployment.jobs_idle = lambda: None
            deployment.ready = lambda *_: True
            def stop(argv, _timeout=30):
                self.assertEqual(argv[:4], ['docker', 'stop', '--time', '30'])
                states[argv[4]] = 'exited'
                return b''
            deployment.run = stop
            def container(expected, running=True):
                self.assertEqual(states[expected['id']], 'running' if running else 'exited')
            deployment.container = container
            def prepare(role):
                prepared.append((role, states[role]))
                if role == 'broker':
                    self.assertEqual(states[role], 'exited', 'cutover helper requires prepare status to match activation status')
                    raise RuntimeError('dry-run-boundary-before-host-and-image-cutover')
            deployment.prepare = prepare
            with patch.object(DEPLOY, 'FILE_PATHS', paths), patch.object(DEPLOY.os, 'chown', create=True):
                with self.assertRaisesRegex(RuntimeError, 'dry-run-boundary-before-host-and-image-cutover'):
                    deployment.deploy()
            self.assertEqual(prepared, [('acceptance', 'running'), ('harness', 'running'), ('broker', 'exited')])

    def test_image_configuration_preserves_manager_and_existing_capability(self):
        manifest = {'containers': {role: {'targetImageId': 'sha256:' + digit * 64}
                                  for role, digit in [('acceptance', 'a'), ('broker', 'b'), ('harness', 'c')]}}
        original = (b'PROTECTED_ACCEPTANCE_IMAGE=old-a\r\nTASKSPACE_BROKER_IMAGE=old-b\r\n'
                    b'CONVERSATION_MANAGER_IMAGE=keep-manager\r\nHARNESS_IMAGE=keep-default\r\n')
        self.assertEqual(DEPLOY.changed_bytes('projectEnv', original, manifest),
                         original.replace(b'old-a', ('sha256:' + 'a' * 64).encode())
                         .replace(b'old-b', ('sha256:' + 'b' * 64).encode()))
        task = b'HARNESS_IMAGE=old-task\nFORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED=true\n'
        self.assertEqual(DEPLOY.changed_bytes('taskEnv', task, manifest),
                         task.replace(b'old-task', ('sha256:' + 'c' * 64).encode()))
        fence = b'{"schemaVersion":1,"state":"committed","epoch":"previous"}\n'
        self.assertEqual(DEPLOY.changed_bytes('harnessFence', fence, manifest), fence)

    def test_host_revision_change_preserves_original_toolchain_bytes(self):
        upgrade = object.__new__(DEPLOY.HostUpgrade)
        upgrade.old = '/srv/forge-delivery/host-runner/versions/2026.09.17.1'
        upgrade.new = '/srv/forge-delivery/host-runner/versions/2026.09.17.2'
        upgrade.m = {'oldVersion': '2026.09.17.1', 'newVersion': '2026.09.17.2'}
        contract = (b'{\r\n  "runnerRevision" : "forge-host-runner-2026.09.17.1",\r\n'
                    b'  "toolchains":{"forgeGovernance":"/srv/forge-delivery/host-runner/versions/2026.09.17.1/bin/forge-governance"}\r\n}\r\n')
        self.assertEqual(upgrade._replacement('hostContract', contract),
                         contract.replace(b'forge-host-runner-2026.09.17.1', b'forge-host-runner-2026.09.17.2'))
        dropin = ('[Service]\nExecStart=\nExecStart=/opt/node ' + upgrade.old + '/lib/host-verification-runner.mjs\n').encode()
        self.assertEqual(upgrade._replacement('dropin', dropin), dropin.replace(upgrade.old.encode(), upgrade.new.encode()))
        linux = '/srv/forge-delivery/verification/lyl-receipt-revalidation-20260917/host-2026.09.17.2'
        self.assertEqual(upgrade._posix(linux), linux)
        for invalid in ['C:\\srv\\host', '/srv/../etc']:
            with self.assertRaises(RuntimeError):
                upgrade._posix(invalid)

    def test_idle_connection_close_waits_for_fence_and_targets_only_lyl(self):
        with tempfile.TemporaryDirectory() as temporary:
            deployment = object.__new__(DEPLOY.Deployment)
            deployment.backup = Path(temporary)
            deployment.m = {'operation': 'lyl-revalidation-test', 'containers': {'harness': {'id': 'h' * 64}}}
            container = {'Config': {'Env': ['HARNESS_PORT=20050']}, 'State': {'Pid': 12345}}
            deployment.container = lambda _: container
            deployment.inspect = lambda _: container
            observations = iter([
                {'status': 200, 'body': {'state': 'committed'}},
                {'status': 503, 'body': {'state': 'maintenance', 'epoch': deployment.m['operation'],
                                      'drain': {'mode': 'connection-tracked', 'activeTcpConnections': 1}}},
            ])
            deployment.http = lambda *_: next(observations)
            def wait_until_fenced(check, _description):
                self.assertFalse(check())
                self.assertTrue(check())
            deployment.wait = wait_until_fenced
            events = []
            deployment.jobs_idle = lambda: events.append('jobs-idle')
            deployment.sessions = lambda identity: events.append(('sessions-idle', identity))
            def run(argv, timeout=30):
                events.append(argv)
                return b''
            deployment.run = run
            deployment.close_idle_harness_connections()
            self.assertEqual(events[:2], ['jobs-idle', ('sessions-idle', 'h' * 64)])
            self.assertEqual(events[2], ['nsenter', '--target', '12345', '--net', '--', '/usr/bin/ss',
                                        '--kill', '--tcp', '--numeric', '--no-header', 'state', 'established', '( sport = :20050 )'])
            self.assertEqual(json.loads((deployment.backup / 'lyl闲置连接关闭.json').read_text(encoding='utf-8'))['port'], 20050)

    def test_busy_jobs_prevent_connection_close(self):
        deployment = object.__new__(DEPLOY.Deployment)
        deployment.m = {'operation': 'lyl-revalidation-test', 'containers': {'harness': {'id': 'h' * 64}}}
        deployment.container = lambda _: {'Config': {'Env': ['HARNESS_PORT=20050']}, 'State': {'Pid': 12345}}
        deployment.http = lambda *_: {'status': 503, 'body': {'state': 'maintenance', 'epoch': deployment.m['operation'],
                                       'drain': {'mode': 'connection-tracked', 'activeTcpConnections': 1}}}
        deployment.wait = lambda check, _: self.assertTrue(check())
        def busy():
            raise RuntimeError('Host/发布并非空闲')
        deployment.jobs_idle = busy
        deployment.run = lambda *_: self.fail('must not close connections while work is active')
        with self.assertRaisesRegex(RuntimeError, '并非空闲'):
            deployment.close_idle_harness_connections()


if __name__ == '__main__':
    unittest.main()
