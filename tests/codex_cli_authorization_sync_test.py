"""Authorization boundary tests use synthetic tokens and no external process."""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('codex_sync', ROOT / 'scripts/sync-codex-cli-authorization.py')
SYNC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SYNC)


def token(exp=10000, account='fixture-account'):
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    return encode({'alg': 'RS256'}) + '.' + encode({'exp': exp, SYNC.AUTH_CLAIM: {'chatgpt_account_id': account}}) + '.fixture'


class CodexCliAuthorizationTests(unittest.TestCase):
    def auth(self, value=None):
        return {'requiresOpenaiAuth': True, 'authMethod': 'chatgpt', 'authToken': value or token()}

    def test_only_chatgpt_with_unexpired_account_token_is_accepted(self):
        self.assertEqual(SYNC.validate_auth(self.auth(), 100), (token(), 10000))
        for result in [self.auth(token(159)), self.auth(token(account='')), self.auth('not-a-token'),
                       {**self.auth(), 'authMethod': 'apikey'}, {**self.auth(), 'requiresOpenaiAuth': False}]:
            with self.subTest(result_type=result['authMethod']), self.assertRaises(SYNC.SyncError):
                SYNC.validate_auth(result, 100)

    def test_only_explicit_logged_out_response_clears_reference(self):
        self.assertEqual(SYNC.validate_auth({'requiresOpenaiAuth': True, 'authMethod': None, 'authToken': None}), (None, None))
        with self.assertRaises(SYNC.SyncError):
            SYNC.validate_auth({'requiresOpenaiAuth': True, 'authMethod': 'chatgpt', 'authToken': None})

    def fixture(self, folder):
        delivery = Path(folder).resolve()
        project = delivery / 'projects/forge-base'
        task = project / 'taskspaces/c-fixture'
        (delivery / 'registry').mkdir()
        (delivery / 'registry/projects.tsv').write_text('slug\tdisplay_name\nforge-base\tFixture\n', encoding='utf8')
        (project / 'ops').mkdir(parents=True)
        (task / 'dsh-home').mkdir(parents=True)
        owner = (task.stat().st_uid, task.stat().st_gid)
        (project / 'ops/project.env').write_text(f'HOST_UID={owner[0]}\nHOST_GID={owner[1]}\n', encoding='utf8')
        (task / 'metadata.json').write_text(json.dumps({'schemaVersion': 1, 'projectSlug': 'forge-base',
                                                      'taskId': 'c-fixture', 'status': 'stopped'}), encoding='utf8')
        env = {'HOST_UID': owner[0], 'HOST_GID': owner[1], 'PROJECT_SLUG': 'forge-base',
               'TASKSPACE_ID': 'c-fixture', 'TASKSPACE_ROOT': str(task), 'PROJECT_COMPOSE_NAME': 'forge-forge-base',
               'TASKSPACE_COMPOSE_PROJECT_NAME': 'forge-forge-base-task-c-fixture'}
        (task / 'task.env').write_text(''.join(f'{key}={value}\n' for key, value in env.items()), encoding='utf8')
        return {'deliveryRoot': str(delivery), 'allowedOwners': [{'uid': owner[0], 'gid': owner[1]}]}, project, task

    def test_discovery_includes_stopped_and_shared_homes_but_rejects_misbound_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            config, project, task = self.fixture(folder)
            (project / 'dsh-home').mkdir()
            (project / 'taskspaces/.c-fixture.creating.7').mkdir()
            projects, homes = SYNC.discover(config)
            self.assertEqual((len(projects), len(homes)), (1, 2))
            with self.assertRaises(SYNC.SyncError):
                SYNC.discover(config, str(project.parent / 'unregistered'))
            (task / 'metadata.json').write_text('{"schemaVersion":1,"projectSlug":"other","taskId":"c-fixture"}', encoding='utf8')
            with self.assertRaises(SYNC.SyncError):
                SYNC.discover(config)

    def test_static_reference_shadow_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'fixture.env'
            path.write_text(SYNC.REF + '=synthetic\n', encoding='utf8')
            with self.assertRaises(SYNC.SyncError):
                SYNC.read_env(path)

    def test_new_only_keeps_old_homes_out_but_refreshes_enrolled_new_tasks(self):
        with tempfile.TemporaryDirectory() as folder:
            config, project, task = self.fixture(folder)
            (project / 'dsh-home').mkdir()
            config['newTaskspacesOnly'] = True
            projects, homes = SYNC.discover(config)
            self.assertEqual((len(projects), len(homes)), (1, 0))
            with (task / 'task.env').open('a', encoding='utf8') as stream:
                stream.write('TASKSPACE_CODEX_CLI_MANAGED=true\n')
            _, homes = SYNC.discover(config)
            self.assertEqual([home['path'] for home in homes], [str(task / 'dsh-home')])

    def test_historical_home_group_must_be_explicitly_approved_with_same_uid(self):
        fake = SimpleNamespace(stat=lambda: SimpleNamespace(st_uid=1000, st_gid=1000))
        with patch.object(SYNC, 'checked_path', return_value=fake):
            self.assertEqual(SYNC.home_owner('/fixture', 1000, {(1000, 983), (1000, 1000)}), (1000, 1000))
            with self.assertRaises(SYNC.SyncError):
                SYNC.home_owner('/fixture', 1000, {(1000, 983)})
            with self.assertRaises(SYNC.SyncError):
                SYNC.home_owner('/fixture', 1001, {(1000, 1000)})

    def test_one_batch_per_owner_only_access_token_in_stdin(self):
        targets = [{'path': '/registered/home1', 'kind': 'home', 'owner': (1000, 983)},
                   {'path': '/registered/seed', 'kind': 'seed', 'owner': (1000, 983)}]
        response = subprocess.CompletedProcess([], 0, b'{"state":"synced","changed":2,"targets":2}')
        with patch.object(SYNC.subprocess, 'run', return_value=response) as run:
            self.assertEqual(SYNC.run_batch({'helperImage': 'sha256:' + 'a' * 64}, targets, token()), 2)
        self.assertEqual(run.call_count, 1)
        command = run.call_args.args[0]
        self.assertNotIn(token(), ' '.join(command))
        for arg in ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--log-driver=none']:
            self.assertIn(arg, command)
        self.assertIn('1000:983', command)
        body = json.loads(run.call_args.kwargs['input'])
        self.assertEqual(body['token'], token())
        self.assertFalse(body['configureProviders'])
        self.assertNotIn('refresh', body)

    def test_transient_cli_failure_does_not_prepare_or_change_credentials(self):
        with patch.object(SYNC, 'discover', return_value=([], [])), \
             patch.object(SYNC, 'read_cli_auth', side_effect=SYNC.SyncError('cli-rpc-timeout')), \
             patch.object(SYNC, 'prepare_seeds') as prepare, patch.object(SYNC, 'run_batch') as run:
            with self.assertRaises(SYNC.SyncError):
                SYNC.sync({})
        prepare.assert_not_called()
        run.assert_not_called()

    def test_unchanged_token_and_files_do_not_launch_worker(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(SYNC, 'STATE_DIR', Path(folder)), \
                 patch.object(SYNC, 'discover', return_value=([], [])), \
                 patch.object(SYNC, 'read_cli_auth', return_value=(token(), 10000)), \
                 patch.object(SYNC, 'prepare_seeds', return_value=[]), \
                 patch.object(SYNC, 'target_fingerprint', return_value='unchanged'), \
                 patch.object(SYNC, 'checked_path', side_effect=lambda path, **_: Path(path)), \
                 patch.object(SYNC, 'run_batch', return_value=0) as run, \
                 patch.object(SYNC, 'atomic_private', side_effect=lambda path, data, _: Path(path).write_bytes(data)):
                SYNC.sync({'helperImage': 'fixed'})
                SYNC.sync({'helperImage': 'fixed'})
                self.assertEqual(run.call_count, 1)
                SYNC.sync({'helperImage': 'fixed'}, configure_providers=True)
                self.assertEqual(run.call_count, 2)


class ScopedConfigTests(unittest.TestCase):
    def config(self, folder):
        path = Path(folder).resolve() / 'private-codex.json'
        document = {'schemaVersion': 1, 'deliveryRoot': str(Path(folder).resolve()),
                    'helperImage': 'sha256:' + 'a' * 64,
                    'allowedOwners': [{'uid': 1000, 'gid': 1000}],
                    'privateProxyUrl': 'http://127.0.0.1:8080'}
        path.write_text(json.dumps(document), encoding='utf8')
        return path, document

    def test_default_config_and_project_filter_remain_unchanged(self):
        args = SYNC.parse_args([])
        self.assertIsNone(args.config)
        self.assertIsNone(args.project_root)
        with tempfile.TemporaryDirectory() as folder:
            path, document = self.config(folder)
            with patch.object(SYNC, 'CONFIG', path), \
                 patch.object(SYNC, 'checked_path', side_effect=lambda value, **_: Path(value)) as checked:
                self.assertEqual(SYNC.read_config(), document)
            self.assertEqual(checked.call_args_list[0].args, (path,))
            self.assertEqual(checked.call_args_list[0].kwargs, {'owner': (0, 0), 'private': True})

    def test_custom_config_requires_project_and_discovery_stays_in_that_project(self):
        for argv in [['--config', '/private/config.json'],
                     ['--config', '/private/config.json', '--project-root', '']]:
            with self.subTest(argv=argv), patch('sys.stderr', new_callable=io.StringIO), \
                 self.assertRaises(SystemExit) as error:
                SYNC.parse_args(argv)
            self.assertEqual(error.exception.code, 2)
        with tempfile.TemporaryDirectory() as folder:
            config, project, task = CodexCliAuthorizationTests().fixture(folder)
            other = Path(folder).resolve() / 'projects/other-project'
            other.mkdir()
            with (Path(folder) / 'registry/projects.tsv').open('a', encoding='utf8') as registry:
                registry.write('other-project\tDo not inspect its homes\n')
            args = SYNC.parse_args(['--config', str(Path(folder) / 'private.json'),
                                    '--project-root', str(project), '--configure-providers'])
            self.assertTrue(args.configure_providers)
            projects, homes = SYNC.discover(config, args.project_root)
            self.assertEqual([item['path'] for item in projects], [str(project)])
            self.assertEqual([item['path'] for item in homes], [str(task / 'dsh-home')])

    def test_custom_config_keeps_file_and_schema_rejections(self):
        # Windows cannot exercise Unix owner/mode bits directly. Run the real
        # checked_path/read_config logic with synthetic stat metadata and real JSON.
        with tempfile.TemporaryDirectory() as folder:
            path, document = self.config(folder)
            private = SimpleNamespace(is_absolute=lambda: True, read_text=path.read_text)
            private.resolve = lambda: private
            metadata = {'st_mode': stat.S_IFREG | 0o600, 'st_uid': 0, 'st_gid': 0, 'st_nlink': 1}
            private.lstat = lambda: SimpleNamespace(**metadata)
            with patch.object(SYNC, 'Path', side_effect=lambda value: private if str(value) == str(path) else Path(value)):
                self.assertEqual(SYNC.read_config(str(path)), document)
                for changes, code in [({'st_uid': 1000}, 'unexpected-owner'),
                                      ({'st_gid': 1000}, 'unexpected-owner'),
                                      ({'st_mode': stat.S_IFREG | 0o644}, 'unsafe-permissions'),
                                      ({'st_mode': stat.S_IFREG | 0o400}, 'unsafe-permissions'),
                                      ({'st_mode': stat.S_IFLNK | 0o600}, 'unsafe-path'),
                                      ({'st_nlink': 2}, 'unsafe-file')]:
                    before = dict(metadata)
                    metadata.update(changes)
                    with self.subTest(changes=changes), self.assertRaisesRegex(SYNC.SyncError, '^' + code + '$'):
                        SYNC.read_config(str(path))
                    metadata.update(before)
                private.is_absolute = lambda: False
                with self.assertRaisesRegex(SYNC.SyncError, '^unsafe-path$'):
                    SYNC.read_config(str(path))
                private.is_absolute = lambda: True
                private.resolve = lambda: Path(folder)
                with self.assertRaisesRegex(SYNC.SyncError, '^unsafe-path$'):
                    SYNC.read_config(str(path))
                private.resolve = lambda: private
                path.write_text(json.dumps({**document, 'unexpected': True}), encoding='utf8')
                with self.assertRaisesRegex(SYNC.SyncError, '^invalid-config$'):
                    SYNC.read_config(str(path))


if __name__ == '__main__':
    unittest.main()
