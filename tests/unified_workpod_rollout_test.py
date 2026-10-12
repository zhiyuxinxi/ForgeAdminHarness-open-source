import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('workpod_rollout', ROOT / 'scripts/upgrade-unified-workpods.py')
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


def manifest(state='absent'):
    root = MOD.ROOT / 'forge-base/taskspaces/c-' / 'unused'
    task = {'project': 'forge-base', 'taskId': 'c-' + 'a' * 24, 'state': state, 'source': {'head': 'saved'}}
    root = MOD.task_root(task)
    for name, suffix in [('env', 'task.env'), ('metadata', 'metadata.json'), ('fence', 'maintenance/proxy-fence.json')]:
        task[name] = {'path': str(root / suffix), 'exists': True}
    if state == 'running':
        task.update({'container': {'id': 'a' * 64, 'name': 'forge-forge-base-task-' + task['taskId'] + '-harness-1', 'imageId': 'old'},
                     'sessions': [{'sessionId': 'saved', 'running': False}], 'port': 20038})
    return {'schemaVersion': 'unified-workpods/v1', 'operation': MOD.OPERATION, 'targetImageId': MOD.IMAGE,
            'canaryProofSha256': MOD.CANARY_PROOF, 'helper': MOD.HELPER, 'tasks': [task],
            'projects': [{'project': 'forge-base', 'env': {'path': str(MOD.ROOT / 'forge-base/ops/project.env')}}]}


class RolloutTests(unittest.TestCase):
    def test_unused_project_state_is_created_once_with_parent_ownership(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(MOD, 'ROOT', Path(temp).resolve()), \
                patch.object(MOD.os, 'chown', create=True) as chown:
            parent = MOD.ROOT / 'demoteam-phase2/taskspaces'; parent.mkdir(parents=True)
            state = MOD.ensure_broker_state('demoteam-phase2')
            self.assertTrue(state.is_dir())
            chown.assert_called_once_with(state, parent.stat().st_uid, parent.stat().st_gid)
            (state / 'audit.jsonl').write_text('preserve history')
            MOD.ensure_broker_state('demoteam-phase2')
            self.assertEqual((state / 'audit.jsonl').read_text(), 'preserve history')
            self.assertEqual(chown.call_count, 1)

    def test_refuses_unverified_image_escape_duplicate_and_busy_turn(self):
        MOD.validate_manifest(manifest())
        cases = []
        for key in ('targetImageId', 'canaryProofSha256'):
            value = manifest(); value[key] = 'wrong'; cases.append(value)
        value = manifest(); value['tasks'][0]['env']['path'] = '/outside'; cases.append(value)
        value = manifest(); value['tasks'].append(copy.deepcopy(value['tasks'][0])); cases.append(value)
        value = manifest('running'); value['tasks'][0]['sessions'][0]['running'] = True; cases.append(value)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                MOD.validate_manifest(value)

    def test_source_fingerprint_detects_uncommitted_edits_untracked_and_deletion(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); workspace = root / 'workspace'; workspace.mkdir()
            def git(*args):
                subprocess.run(['git', '-C', str(workspace), *args], check=True, capture_output=True)
            git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test')
            (workspace / 'tracked.txt').write_text('before'); git('add', '.'); git('commit', '-m', 'fixture')
            baseline = MOD.source_state(root)
            (workspace / 'tracked.txt').write_text('draft')
            edited = MOD.source_state(root)
            self.assertEqual(baseline['head'], edited['head'])
            self.assertNotEqual(baseline['contentSha256'], edited['contentSha256'])
            (workspace / 'untracked.txt').write_text('must retain')
            added = MOD.source_state(root); self.assertEqual(added['untrackedFileCount'], 1)
            self.assertNotEqual(added['contentSha256'], edited['contentSha256'])
            (workspace / 'tracked.txt').unlink()
            self.assertNotEqual(MOD.source_state(root)['contentSha256'], added['contentSha256'])

    def test_stopped_workpod_updates_only_image_without_starting_any_container(self):
        m = manifest(); d = MOD.Deployment(m, json.dumps(m).encode()); task = m['tasks'][0]
        with tempfile.TemporaryDirectory() as temp, patch.object(MOD, 'regular', return_value=b'HARNESS_IMAGE=old\nOTHER=keep\n'), \
                patch.object(MOD, 'source_state', return_value=task['source']), patch.object(MOD.common, 'atomic_replace') as replace:
            d.backup = Path(temp); d.check_binding = Mock(); d.create_fence = Mock(return_value=b'committed')
            d.helper = Mock(side_effect=AssertionError('No container operation allowed'))
            d.inspect = Mock(side_effect=AssertionError('No running container expected'))
            d.verify_task = Mock()
            result = d.upgrade_one(task, 0)
            self.assertNotIn('containerId', result); self.assertEqual(result['state'], 'absent')
            self.assertEqual(replace.call_args.args[2], b'HARNESS_IMAGE=' + MOD.IMAGE.encode() + b'\nOTHER=keep\n')
            d.verify_task.assert_called_once_with(task, result); d.helper.assert_not_called()

    def test_new_model_turn_refuses_cutover_before_sockets_or_image_change(self):
        m = manifest('running'); d = MOD.Deployment(m, json.dumps(m).encode()); task = m['tasks'][0]
        with tempfile.TemporaryDirectory() as temp, patch.object(MOD, 'regular', return_value=b'HARNESS_IMAGE=old\n'), \
                patch.object(MOD, 'source_state', return_value=task['source']), patch.object(MOD.common, 'atomic_replace') as replace:
            d.backup = Path(temp); d.check_binding = Mock(); d.create_fence = Mock(return_value=b'committed')
            d.task_sessions = Mock(side_effect=RuntimeError('Active model turn'))
            d.run = Mock(); d.helper = Mock()
            with self.assertRaisesRegex(RuntimeError, 'Active model turn'):
                d.upgrade_one(task, 0)
            replace.assert_not_called(); d.run.assert_not_called(); d.helper.assert_not_called()

    def test_image_replacement_preserves_capability_flags_and_does_not_upgrade_other_roles(self):
        raw = b'HARNESS_IMAGE=old\r\nRELEASE_RUNNER_IMAGE=keep\r\nFORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED=false\r\n'
        changed = MOD.common.image_env_bytes(raw, {'HARNESS_IMAGE': MOD.IMAGE})
        self.assertEqual(changed, raw.replace(b'HARNESS_IMAGE=old', b'HARNESS_IMAGE=' + MOD.IMAGE.encode()))


if __name__ == '__main__':
    unittest.main()
