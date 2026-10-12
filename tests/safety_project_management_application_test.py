import importlib.util
import copy
import json
import pathlib
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

PATH = pathlib.Path(__file__).resolve().parents[1] / 'scripts/safety_project_management_application_remote.py'
SPEC = importlib.util.spec_from_file_location('safety_application_remote', PATH)
REMOTE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REMOTE)
OPERATOR_PATH = PATH.with_name('deploy-safety-project-management-application.py')
OPERATOR_SPEC = importlib.util.spec_from_file_location('safety_application_operator', OPERATOR_PATH)
OPERATOR = importlib.util.module_from_spec(OPERATOR_SPEC)
sys.path.insert(0, str(PATH.parent))
try:
    OPERATOR_SPEC.loader.exec_module(OPERATOR)
finally:
    sys.path.pop(0)


class SafetyApplicationTest(unittest.TestCase):
    def test_ready_application_with_restart_is_rejected_before_success(self):
        application = {'ready': True, 'state': 'running', 'restartCount': 1, 'failureObserved': False}
        for action, result in (
            ('test-status', application),
            ('verify', {'status': 'verified', 'applications': {'forge-admin': application}}),
        ):
            with self.subTest(action=action):
                remote = Mock()
                remote.run.return_value = result
                with self.assertRaisesRegex(RuntimeError, 'Application startup failed'):
                    OPERATOR.wait_ready(remote, {}, action, 10)
                remote.run.assert_called_once()

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

    def test_startup_log_overflow_never_counts_as_ready(self):
        item = {'Id': 'bounded-test', 'State': {'StartedAt': '2026-09-17T00:00:00Z'}}
        logs = subprocess.CompletedProcess([], 0, b'x' * (4 * 1024 * 1024 + 1), b'')
        with patch.object(REMOTE.subprocess, 'run', return_value=logs):
            with self.assertRaisesRegex(RuntimeError, 'evidence bound'):
                REMOTE.readiness(item, True)

    def test_image_pinning_preserves_existing_environment_bytes(self):
        original = b'# configured once\nMYSQL_DATABASE=forge_safety_project_management\nPRIVATE_VALUE=do-not-print\n'
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

    def test_duplicate_image_assignment_refuses_environment_rewrite(self):
        original = b'FORGE_ADMIN_IMAGE=old\nFORGE_ADMIN_IMAGE=conflict\n'
        manifest = {'environmentSha256': REMOTE.sha(original),
                    'images': {role: {'id': 'sha256:' + role} for role in ('admin', 'flow', 'ui')}}
        with self.assertRaisesRegex(RuntimeError, 'Duplicate application image assignment'):
            REMOTE.pinned_environment(manifest, original)

    def test_test_container_cannot_point_to_main_database(self):
        import json
        item = {'Name': '/' + REMOTE.TEST_NAME, 'Image': 'sha256:admin',
                'Config': {'Labels': {'com.forge-delivery.project': 'safety-project-management',
                                      'com.forge-delivery.role': 'test-database-migration'},
                           'Env': ['MYSQL_DB=forge_safety_project_management', 'REDIS_DATABASE=11']}}
        with patch.object(REMOTE, 'run', return_value=json.dumps([item]).encode()):
            with self.assertRaisesRegex(RuntimeError, 'Test isolation differs'):
                REMOTE.test_container({'images': {'admin': {'id': 'sha256:admin'}}})

    def test_reused_build_requires_original_identity_and_same_source_subtrees(self):
        evidence = PATH.parents[1] / 'docs/validation-evidence/2026-09-15-demoteam-phase2-application-build.json'
        build = json.loads(evidence.read_bytes())
        manifest = {
            'schemaVersion': 1, 'project': 'safety-project-management',
            'sourceCommit': 'b' * 40, 'sourceTree': 'c' * 40,
            'buildSourceCommit': OPERATOR.BUILD_SOURCE_COMMIT, 'buildSourceTree': OPERATOR.BUILD_SOURCE_TREE,
            'buildSourceTrees': OPERATOR.BUILD_SOURCE_TREES.copy(), 'reusedFrom': 'demoteam-phase2',
            'buildInputSha256': build['inputLockSha256'],
            'sourceFiles': {'.dockerignore': OPERATOR.DOCKERIGNORE_SHA256, **OPERATOR.SOURCE_HASHES},
            'images': {entry['variable'].removeprefix('FORGE_').removesuffix('_IMAGE').lower():
                       {'reference': entry['reference'], 'id': entry['id']} for entry in build['images']},
            'controls': [{'service': service} for service in (
                'conversation-manager', 'verification-runner', 'taskspace-broker', 'release-runner', 'protected-acceptance')],
            'networks': {name: 'fixture' for name in ('application', 'taskspaces', 'git-remote')},
        }
        OPERATOR.validate_manifest(manifest, build)
        self.assertNotEqual(manifest['sourceCommit'], build['sourceCommit'])
        self.assertEqual(OPERATOR.BUILD_SOURCE_TREES, REMOTE.BUILD_SOURCE_TREES)
        for field, value, message in (
            ('project', 'demoteam-phase2', 'manifest scope differs'),
            ('sourceCommit', '', 'manifest scope differs'),
            ('buildSourceTrees', {**manifest['buildSourceTrees'], 'forge-server': 'd' * 40}, 'source binding differs'),
            ('controls', [], 'control scope differs'),
            ('networks', {}, 'network scope differs'),
        ):
            with self.subTest(field=field):
                changed = copy.deepcopy(manifest)
                changed[field] = value
                with self.assertRaisesRegex(RuntimeError, message):
                    OPERATOR.validate_manifest(changed, build)
        changed = copy.deepcopy(manifest)
        changed['images']['admin']['id'] = 'sha256:' + 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'not bound to the successful build'):
            OPERATOR.validate_manifest(changed, build)
        with self.assertRaisesRegex(RuntimeError, 'build identity differs'):
            OPERATOR.validate_manifest(manifest, {**build, 'sourceCommit': manifest['sourceCommit']})


if __name__ == '__main__':
    unittest.main()
