"""本地验证配置字节/限定范围/未知终态拒绝；不调用SSH或Docker。"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('stage20_deployment', ROOT / 'scripts/部署-阶段20-合同续接修复.py')
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)

def manifest():
    linux_paths = {
        'projectEnv': '/srv/forge-delivery/projects/forge-base/ops/project.env',
        'taskEnv': '/srv/forge-delivery/projects/forge-base/taskspaces/c-e7b9ab5b67f99bdd643b31b7/task.env',
        'gatewayFence': '/srv/forge-delivery/conversation-control-plane/maintenance/gateway-fence.json',
        'harnessFence': '/srv/forge-delivery/projects/forge-base/taskspaces/c-e7b9ab5b67f99bdd643b31b7/maintenance/proxy-fence.json'}
    roles = ('acceptance', 'manager', 'harness', 'gateway', 'broker')
    containers = {}
    for number, key in enumerate(roles, 1):
        item = {'id': str(number) * 64, 'name': key, 'imageId': 'sha256:' + 'a' * 64}
        if key in deployment.ROLES:
            item.update(targetImageId='sha256:' + str(number + 5) * 64, runtimeSha256='b' * 64)
        containers[key] = item
    return {'schemaVersion': 1, 'operation': 'stage20-contract-continuation-test', 'projectSlug': 'forge-base',
            'taskId': deployment.TASK_ID, 'containers': {k: containers[k] for k in deployment.ROLES},
            'maintenance': {k: containers[k] for k in ('gateway', 'broker')},
            'helper': {'path': '/opt/forge-delivery-platform/scripts/lib/container-image-cutover.sh', 'sha256': 'c' * 64},
            'files': {k: {'path': p, 'sha256': 'd' * 64, 'uid': 1000, 'gid': 983, 'mode': 384}
                      for k, p in linux_paths.items()},
            'sessionIds': ['session-f1184c70-6762-2e96-1a6f-90513bc971dd']}

class DeploymentBoundaryTests(unittest.TestCase):
    def test_only_allowed_env_keys_change_and_original_bytes_survive(self):
        m = manifest()
        for newline in (b'\n', b'\r\n'):
            with self.subTest(newline=newline):
                project = newline.join([b'# original comment', b'PROTECTED_ACCEPTANCE_IMAGE=old-a',
                    b'CONVERSATION_MANAGER_IMAGE=old-m', b'HARNESS_IMAGE=keep-h', b'TASKSPACE_BROKER_IMAGE=keep-b',
                    b'UNRELATED_VALUE=keep exact bytes']) + newline
                expected = project.replace(b'=old-a', b'=' + m['containers']['acceptance']['targetImageId'].encode()).replace(
                    b'=old-m', b'=' + m['containers']['manager']['targetImageId'].encode())
                self.assertEqual(deployment.changed_bytes('projectEnv', project, m), expected)
                task = b'# task' + newline + b'HARNESS_IMAGE=old-h' + newline + b'OTHER=unchanged'
                updated = deployment.changed_bytes('taskEnv', task, m)
                self.assertEqual(updated, task.replace(b'=old-h', b'=' + m['containers']['harness']['targetImageId'].encode())
                                 + newline + deployment.MARKER.encode() + b'=true' + newline)
                self.assertEqual(deployment.changed_bytes('taskEnv', updated, m), updated)

    def test_ambiguous_marker_and_duplicate_image_row_are_rejected(self):
        m = manifest(); marker = deployment.MARKER.encode()
        for tail in (marker + b'=maybe\n', marker + b'=true\n' + marker + b'=false\n'):
            with self.assertRaises(RuntimeError):
                deployment.changed_bytes('taskEnv', b'HARNESS_IMAGE=old\n' + tail, m)
        with self.assertRaises(RuntimeError):
            deployment.changed_bytes('taskEnv', b'HARNESS_IMAGE=one\nHARNESS_IMAGE=two\n', m)

    def test_broker_cannot_become_a_fourth_deployment_target(self):
        m = manifest(); deployment.validate_manifest(m)
        m['containers']['broker'] = copy.deepcopy(m['maintenance']['broker'])
        with self.assertRaises(RuntimeError): deployment.validate_manifest(m)

    def test_existing_unknown_terminal_state_never_replays(self):
        m = manifest(); instance = deployment.Deployment(m, json.dumps(m).encode())
        with tempfile.TemporaryDirectory() as directory:
            instance.backup = Path(directory)
            instance.run = lambda *args, **kwargs: self.fail('unexpected command during replay refusal')
            with self.assertRaisesRegex(RuntimeError, '禁止盲重放'): instance.preflight()

    def test_command_failure_and_timeout_keep_private_bounded_output_without_deployment_state(self):
        secret = b'private-environment-value'
        stderr = secret + b'x' * 70000 + b'failure-tail'
        stdout = b'partial-output-' + secret
        outcomes = (subprocess.CompletedProcess(['dummy'], 17, stdout, stderr),
                    subprocess.TimeoutExpired(['dummy', 'private-argument'], 1, stdout, stderr))
        for outcome in outcomes:
            with self.subTest(kind=type(outcome).__name__), tempfile.TemporaryDirectory() as directory:
                m = manifest(); instance = deployment.Deployment(m, json.dumps(m).encode())
                instance.backup = Path(directory) / 'not-started'
                instance.diagnostics = Path(directory)
                mock_args = {'side_effect': outcome} if isinstance(outcome, Exception) else {'return_value': outcome}
                with patch.object(deployment.subprocess, 'run', **mock_args):
                    with self.assertRaises(RuntimeError) as raised:
                        instance.run(['dummy'], timeout=1)
                message = str(raised.exception)
                self.assertNotIn(secret.decode(), message)
                self.assertNotIn('private-argument', message)
                evidence = json.loads(message.split('诊断=', 1)[1])
                self.assertFalse(instance.backup.exists())
                for name, raw in (('stderr', stderr), ('stdout', stdout)):
                    record = evidence[name]; path = Path(record['path'])
                    expected = raw if len(raw) <= 65536 else raw[:32768] + raw[-32768:]
                    self.assertEqual(path.read_bytes(), expected)
                    self.assertEqual(record['bytes'], len(raw))
                    self.assertEqual(record['sha256'], deployment.sha(raw))
                    self.assertEqual(record['savedBytes'], len(expected))
                    self.assertEqual(record['truncated'], len(raw) > 65536)
                    if os.name == 'posix':
                        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)

if __name__ == '__main__': unittest.main()
