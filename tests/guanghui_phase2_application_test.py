import importlib.util
import pathlib
import subprocess
import unittest
from unittest.mock import patch

PATH = pathlib.Path(__file__).resolve().parents[1] / 'scripts/guanghui_phase2_application_remote.py'
SPEC = importlib.util.spec_from_file_location('guanghui_application_remote', PATH)
REMOTE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REMOTE)


class GuanghuiApplicationTest(unittest.TestCase):
    def test_migration_validation_alone_is_not_startup_success(self):
        item = {'Id': 'test-container', 'Image': 'sha256:abc',
                'State': {'Status': 'running', 'StartedAt': '2026-09-15T10:48:00Z'}, 'RestartCount': 0}
        logs = subprocess.CompletedProcess([], 0, b'Successfully validated 42 migrations\n', b'')
        with patch.object(REMOTE.subprocess, 'run', return_value=logs):
            self.assertFalse(REMOTE.readiness(item, True)['ready'])
        logs.stdout += b'Started ForgeAdminApplication\n'
        with patch.object(REMOTE.subprocess, 'run', return_value=logs):
            self.assertTrue(REMOTE.readiness(item, True)['ready'])
        logs.stderr = b'APPLICATION FAILED TO START\n'
        with patch.object(REMOTE.subprocess, 'run', return_value=logs):
            self.assertFalse(REMOTE.readiness(item, True)['ready'])

    def test_verbose_startup_keeps_early_migration_validation(self):
        item = {'Id': 'retained-test', 'Image': 'sha256:abc', 'RestartCount': 0,
                'State': {'Status': 'running', 'StartedAt': '2026-09-15T10:48:00Z'}}
        lines = [b'Successfully validated 133 migrations'] + [b'framework initialization'] * 2300 + [b'Started ForgeAdminApplication']

        def log_consumer(argv, **_kwargs):
            selected = lines[-int(argv[3]):] if '--tail' in argv else lines
            self.assertIn('--since', argv)
            self.assertIn(item['State']['StartedAt'], argv)
            return subprocess.CompletedProcess(argv, 0, b'\n'.join(selected), b'')

        with patch.object(REMOTE.subprocess, 'run', side_effect=log_consumer):
            result = REMOTE.readiness(item, True)
            self.assertTrue(result['migrationValidated'])
            self.assertTrue(result['applicationStarted'])
            self.assertTrue(result['ready'])

    def test_image_pinning_preserves_existing_environment_bytes(self):
        original = b'# configured once\nMYSQL_DATABASE=forge_guanghui_phase2\nPRIVATE_VALUE=do-not-print\n'
        manifest = {'environmentSha256': REMOTE.sha(original),
                    'images': {role: {'id': 'sha256:' + role} for role in ('admin', 'flow', 'ui')}}
        pinned = REMOTE.pinned_environment(manifest, original)
        self.assertTrue(pinned.startswith(original))
        self.assertIn(b'FORGE_ADMIN_IMAGE=sha256:admin\n', pinned)
        with self.assertRaisesRegex(RuntimeError, 'Original environment differs'):
            REMOTE.pinned_environment(manifest, pinned)

    def test_existing_image_fields_are_replaced_without_changing_other_bytes(self):
        original = b'# existing project\r\nFORGE_ADMIN_IMAGE=original-admin\r\nPRIVATE_VALUE=preserve\r\nFORGE_FLOW_IMAGE=\r\nFORGE_UI_IMAGE=original-ui\r\n'
        manifest = {'environmentSha256': REMOTE.sha(original),
                    'images': {role: {'id': 'sha256:' + role} for role in ('admin', 'flow', 'ui')}}
        expected = original.replace(b'FORGE_ADMIN_IMAGE=original-admin', b'FORGE_ADMIN_IMAGE=sha256:admin')
        expected = expected.replace(b'FORGE_FLOW_IMAGE=', b'FORGE_FLOW_IMAGE=sha256:flow')
        expected = expected.replace(b'FORGE_UI_IMAGE=original-ui', b'FORGE_UI_IMAGE=sha256:ui')
        self.assertEqual(REMOTE.pinned_environment(manifest, original), expected)

    def test_test_container_cannot_point_to_main_database(self):
        import json
        item = {'Name': '/' + REMOTE.TEST_NAME, 'Image': 'sha256:admin',
                'Config': {'Labels': {'com.forge-delivery.project': 'demoteam-phase2',
                                      'com.forge-delivery.role': 'test-database-migration'},
                           'Env': ['MYSQL_DB=forge_guanghui_phase2', 'REDIS_DATABASE=12']}}
        with patch.object(REMOTE, 'run', return_value=json.dumps([item]).encode()):
            with self.assertRaisesRegex(RuntimeError, 'Test isolation differs'):
                REMOTE.test_container({'images': {'admin': {'id': 'sha256:admin'}}})


if __name__ == '__main__':
    unittest.main()
