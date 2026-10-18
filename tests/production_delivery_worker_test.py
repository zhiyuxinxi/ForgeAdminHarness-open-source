"""Platform-only fixtures. No business project, Docker daemon or production connection is used."""
import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from production_delivery_deploy import LABEL, DeliveryError, Executor, extract_archive, sha256, write_json
from production_delivery_worker import Worker, validate_recipe, validate_application_sql


DIGEST = 'sha256:' + 'a' * 64


def recipe():
    return {'schemaVersion': 1, 'mysql': {'image': DIGEST}, 'redis': {'image': DIGEST}, 'validationProxyImage': DIGEST,
            'database': {'initialSql': ['db/initial.sql'], 'migrations': []},
            'materials': {'operationGuide': 'docs/operation.md'},
            'application': {'services': [{'name': 'app', 'imageService': 'app',
                                         'environment': {'DATABASE_PASSWORD': '${MYSQL_PASSWORD}'}}],
                            'entry': {'service': 'app', 'containerPort': 8080, 'path': '/'},
                            'health': {'path': '/health', 'timeoutSeconds': 1}}}


class WorkerFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.request = {'schemaVersion': 1, 'action': 'validate', 'project': 'fixture', 'releaseId': 'release-1',
                        'jobId': 'job-1', 'mode': 'initial', 'architecture': 'amd64', 'base': None,
                        'jobRoot': str(self.root / 'archive' / 'fixture' / 'job-1'),
                        'archiveRoot': str(self.root / 'archive'), 'backupRoot': str(self.root / 'backup'),
                        'environmentRoot': str(self.root / 'environments'), 'bindHost': '127.0.0.1', 'port': 18080,
                        'source': {'projectRoot': str(self.root / 'source'), 'commit': 'b' * 40,
                                   'images': [{'service': 'app', 'id': DIGEST}]}, 'recipe': recipe()}
        (self.root / 'source' / 'workspace' / '.git').mkdir(parents=True)

    def tearDown(self):
        self.temporary.cleanup()

    def test_missing_project_material_is_a_real_failure(self):
        worker = Worker(self.request, command=lambda args, **kwargs: b'')
        with self.assertRaisesRegex(DeliveryError, 'absent from the selected commit'):
            worker.build_package()
        self.assertFalse((worker.job / 'bundle.tar').exists())
        self.assertFalse(worker.runtime.exists())

    def test_recipe_requires_real_guide_and_rejects_literal_secrets(self):
        value = recipe()
        del value['materials']['operationGuide']
        with self.assertRaises(DeliveryError) as error:
            validate_recipe(value)
        self.assertEqual(error.exception.code, 'OPERATION_GUIDE_MISSING')
        value = recipe()
        value['application']['services'][0]['environment']['DATABASE_PASSWORD'] = 'real-password'
        with self.assertRaises(DeliveryError) as error:
            validate_recipe(value)
        self.assertEqual(error.exception.code, 'SECRET_IN_RECIPE')

    def test_storage_overlap_and_cross_archive_identity_rejected(self):
        request = copy.deepcopy(self.request)
        request['environmentRoot'] = request['archiveRoot']
        with self.assertRaises(DeliveryError):
            Worker(request)
        request = copy.deepcopy(self.request)
        request['jobRoot'] = str(self.root / 'outside' / 'job-1')
        with self.assertRaises(DeliveryError):
            Worker(request)

    def fake_source(self, architecture='amd64', material_commit=None):
        calls = []
        files = {'db/initial.sql': b'CREATE TABLE fixture (id INT);\n', 'docs/operation.md': b'Fixture operator instructions.\n'}

        def command(args, output=None):
            args = list(map(str, args))
            calls.append(args)
            if 'ls-tree' in args:
                name = args[-1]
                return b'100644 blob ' + b'c' * 40 + b'\t' + name.encode() + b'\0' if name in files else b''
            if 'show' in args:
                self.assertTrue(args[-1].startswith((material_commit or 'b' * 40) + ':'))
                return files[args[-1].split(':', 1)[1]]
            if args[:3] == ['docker', 'image', 'inspect']:
                return json.dumps([{'Id': DIGEST, 'Architecture': architecture, 'Os': 'linux'}]).encode()
            if args[:3] == ['docker', 'image', 'save']:
                output.write(b'platform-fixture-image-archive')
            return b''
        return command, calls

    def test_fixed_commit_materials_and_frozen_executor_are_packaged(self):
        command, calls = self.fake_source()
        worker = Worker(self.request, command=command)
        worker.build_package()
        self.assertEqual((worker.package / 'deploy.py').read_bytes(), (Path(__file__).resolve().parents[1] / 'scripts' / 'production_delivery_deploy.py').read_bytes())
        self.assertTrue((worker.job / 'bundle.tar').is_file())
        self.assertTrue(all('b' * 40 in ' '.join(args) for args in calls if 'show' in args or 'ls-tree' in args))
        self.assertNotIn('MYSQL_ROOT_PASSWORD=', (worker.package / 'env.example').read_text())
        self.assertEqual(worker.manifest['database']['execute'], ['sql/initial/0000.sql'])

    def test_architecture_mismatch_does_not_save_or_start_images(self):
        command, calls = self.fake_source('arm64')
        worker = Worker(self.request, command=command)
        with self.assertRaises(DeliveryError) as error:
            worker.build_package()
        self.assertEqual(error.exception.code, 'TARGET_ARCHITECTURE_UNAVAILABLE')
        self.assertFalse(any(args[:3] == ['docker', 'image', 'save'] for args in calls))
        self.assertFalse(worker.runtime.exists())

    def test_later_fixed_material_commit_is_separate_from_the_application_version(self):
        material_root = self.root / 'materials'
        (material_root / 'workspace' / '.git').mkdir(parents=True)
        self.request['source']['materials'] = {'projectRoot': str(material_root), 'commit': 'd' * 40}
        command, calls = self.fake_source(material_commit='d' * 40)
        worker = Worker(self.request, command=command)
        worker.build_package()
        self.assertEqual(worker.manifest['applicationCommit'], 'b' * 40)
        self.assertEqual(worker.manifest['materialCommit'], 'd' * 40)
        self.assertTrue(any('--is-ancestor' in args and args[-2:] == ['b' * 40, 'd' * 40] for args in calls))
        self.assertTrue(all(str(material_root / 'workspace') in args for args in calls if 'show' in args or 'ls-tree' in args))

    def test_provisioning_sql_is_not_silently_rewritten_or_executed(self):
        file = self.root / 'bad-initial.sql'
        file.write_text('-- Project SQL\nCREATE DATABASE other_customer;\nUSE other_customer;')
        original = file.read_bytes()
        with self.assertRaises(DeliveryError) as error:
            validate_application_sql(file)
        self.assertEqual(error.exception.code, 'DATABASE_PROVISIONING_SQL_FORBIDDEN')
        self.assertEqual(file.read_bytes(), original)

    def test_worker_rejects_changed_executor_before_launching_it(self):
        command, calls = self.fake_source()
        worker = Worker(self.request, command=command)
        worker.build_package()
        (worker.package / 'deploy.py').write_text('raise SystemExit(0)')
        with self.assertRaises(DeliveryError) as error:
            worker.execute(worker.package, 'initial')
        self.assertEqual(error.exception.code, 'PACKAGE_DIGEST_MISMATCH')
        self.assertFalse(any('deploy.py' in str(item) for args in calls for item in args))

    def test_upgrade_cannot_guess_a_missing_historical_baseline(self):
        self.request['mode'] = 'upgrade'
        command, _ = self.fake_source()
        worker = Worker(self.request, command=command)
        with self.assertRaises(DeliveryError) as error:
            worker.build_package()
        self.assertEqual(error.exception.code, 'HISTORICAL_BASELINE_REQUIRED')

    def test_new_job_environment_is_unique_and_historical_first(self):
        worker = Worker(self.request)
        other = copy.deepcopy(self.request)
        other['jobId'] = 'job-2'
        other['jobRoot'] = str(self.root / 'archive' / 'fixture' / 'job-2')
        self.assertNotEqual(worker.environment_id, Worker(other).environment_id)
        worker.recipe = recipe()
        worker.manifest = {'project': 'fixture'}
        worker.package.mkdir()
        write_json(worker.package / 'manifest.json', worker.manifest)
        (worker.package / 'sql').mkdir()
        (worker.package / 'sql' / 'execute.sql').write_text('-- fixture')
        (worker.package / 'DEPLOYMENT.md').write_text('fixture')
        (worker.package / 'OPERATION.md').write_text('fixture')
        (worker.job / 'bundle.tar').write_bytes(b'fixture archive')
        worker.operation_path = 'OPERATION.md'
        worker.base_package = self.root / 'historical-package'
        worker.base_baseline = self.root / 'historical-baseline'
        calls = []

        def execute(package, action, baseline=None):
            calls.append((package, action, baseline))
            if action == 'snapshot':
                baseline.mkdir()
                for name in ('database.sql', 'redis.rdb', 'files.tar', 'secrets.tar'):
                    (baseline / name).write_bytes(b'fixture')

        with patch.object(worker, 'build_package'), patch.object(worker, 'execute', side_effect=execute):
            result = worker.validate()
        self.assertEqual([(p, a) for p, a, _ in calls], [(worker.base_package, 'restore'), (worker.package, 'upgrade'), (worker.package, 'snapshot')])
        self.assertEqual(result['status'], 'success')
        self.assertEqual(worker.progress['status'], 'awaiting-acceptance')
        self.assertEqual({item['name'] for item in result['baseline']['files']}, {'database.sql', 'redis.rdb', 'files.tar', 'secrets.tar'})
        self.assertTrue((worker.backup / 'bundle.tar').exists())
        self.assertNotIn('private-baseline', {item['relativePath'] for item in result['artifacts']})

    def test_stop_attempt_results_are_bound_and_do_not_rewrite_validation(self):
        request = dict(self.request, action='stop', stopAttemptId='stop-attempt-1')
        worker = Worker(request)
        write_json(worker.job / 'result.json', {'status': 'success', 'manifestSha256': 'f' * 64})
        original = (worker.job / 'result.json').read_bytes()
        worker.record_stop({'status': 'failed', 'error': {'code': 'FIXTURE_STOP_FAILURE'}})
        first_bytes = (worker.job / 'stop-worker-result-stop-attempt-1.json').read_bytes()
        request['stopAttemptId'] = 'stop-attempt-2'
        worker.record_stop({'status': 'success', 'environment': {'status': 'stopped'}})
        self.assertEqual(json.loads((worker.job / 'stop-result.json').read_text())['stopAttemptId'], 'stop-attempt-2')
        self.assertEqual((worker.job / 'stop-worker-result-stop-attempt-1.json').read_bytes(), first_bytes)
        self.assertEqual((worker.job / 'result.json').read_bytes(), original)

    def test_stop_with_missing_local_state_only_releases_after_all_exact_label_queries_are_empty(self):
        for existing in ('neither', 'package', 'runtime'):
            with self.subTest(existing=existing):
                request = dict(self.request, action='stop', stopAttemptId='stop-empty', jobId='job-' + existing,
                               jobRoot=str(self.root / 'archive' / 'fixture' / ('job-' + existing)))
                calls = []
                worker = Worker(request, command=lambda args: calls.append(args) or b'')
                if existing == 'package':
                    worker.package.mkdir()
                    (worker.package / 'retained.txt').write_bytes(b'archive material')
                if existing == 'runtime':
                    worker.runtime.mkdir(parents=True)
                write_json(worker.job / 'result.json', {'status': 'failed', 'error': 'fixture startup failure'})
                original = (worker.job / 'result.json').read_bytes()
                with patch.object(worker, 'execute') as execute:
                    result = worker.record_stop(worker.stop())
                    execute.assert_not_called()
                self.assertEqual(result['status'], 'success')
                self.assertEqual(result['environment']['status'], 'stopped')
                self.assertEqual(result['resourceCheck']['counts'], {'container': 0, 'network': 0, 'volume': 0})
                self.assertEqual([args[:3] for args in calls], [['docker', kind, 'ls'] for kind in ('container', 'network', 'volume')])
                for args in calls:
                    self.assertEqual(args[args.index('--filter') + 1], f'label={LABEL}={worker.environment_id}')
                self.assertIn('--all', calls[0], 'stopped containers must also prevent declaring the job empty')
                self.assertEqual((worker.job / 'result.json').read_bytes(), original)
                self.assertEqual(json.loads((worker.job / 'stop-result.json').read_text())['stopAttemptId'], 'stop-empty')
                if existing == 'package':
                    self.assertEqual((worker.package / 'retained.txt').read_bytes(), b'archive material')

    def test_stop_with_missing_local_state_preserves_any_residual_resource_and_refuses_release(self):
        for kind in ('container', 'network', 'volume'):
            with self.subTest(resource=kind):
                calls = []
                def query(args):
                    calls.append(args)
                    return b'fixture-retained-resource\n' if args[1] == kind else b''
                worker = Worker(dict(self.request, action='stop', stopAttemptId='stop-residual'), command=query)
                with patch.object(worker, 'execute') as execute, self.assertRaises(DeliveryError) as error:
                    worker.stop()
                self.assertEqual(error.exception.code, 'ENVIRONMENT_RESOURCES_REMAIN')
                execute.assert_not_called()
                self.assertEqual(len(calls), 3)
                self.assertTrue(all(args[:3] == ['docker', args[1], 'ls'] for args in calls))
                self.assertFalse((worker.job / 'stop-result.json').exists())

    def test_stop_with_missing_local_state_fails_closed_on_query_errors_or_invalid_output(self):
        cases = [DeliveryError('COMMAND_FAILED', 'fixture Docker failure'), OSError('fixture unavailable Docker'), b'\xff', None]
        for failure in cases:
            with self.subTest(failure=repr(failure)):
                def query(_args):
                    if isinstance(failure, Exception):
                        raise failure
                    return failure
                worker = Worker(dict(self.request, action='stop', stopAttemptId='stop-unknown'), command=query)
                with patch.object(worker, 'execute') as execute, self.assertRaises(DeliveryError) as error:
                    worker.stop()
                self.assertEqual(error.exception.code, 'ENVIRONMENT_STATE_UNKNOWN')
                execute.assert_not_called()
                self.assertFalse((worker.job / 'stop-result.json').exists())

    def test_stop_with_complete_local_state_keeps_the_existing_frozen_executor_path(self):
        worker = Worker(dict(self.request, action='stop', stopAttemptId='stop-existing'),
                        command=lambda _args: self.fail('No new Docker query is required for the existing executor path.'))
        worker.package.mkdir()
        worker.runtime.mkdir(parents=True)
        with patch.object(worker, 'execute') as execute:
            result = worker.stop()
        execute.assert_called_once_with(worker.package, 'stop')
        self.assertEqual(result['environment']['status'], 'stopped')


class ExecutorFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.package = self.root / 'package'
        self.package.mkdir()
        self.sql = self.package / 'initial.sql'
        self.sql.write_text('CREATE TABLE fixture (id INT);')
        self.manifest = {'schemaVersion': 1, 'architecture': 'amd64', 'recipe': recipe(),
                         'images': [{'service': service, 'id': DIGEST} for service in ('app', '_mysql', '_redis', '_validation-proxy')],
                         'baseManifestSha256': 'c' * 64, 'database': {'execute': ['initial.sql'], 'migrations': []},
                         'files': [{'path': 'initial.sql', 'sha256': sha256(self.sql)}]}
        write_json(self.package / 'manifest.json', self.manifest)
        self.calls = []

        def command(args, **kwargs):
            self.calls.append(args)
            if len(args) > 2 and args[2] == 'inspect':
                return subprocess.CompletedProcess(args, 1, b'', b'not found')
            if 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE()' in args:
                return subprocess.CompletedProcess(args, 0, b'0\n', b'')
            return subprocess.CompletedProcess(args, 0, b'1\n', b'')
        self.command = command

    def tearDown(self):
        self.temporary.cleanup()

    def executor(self, profile='isolated', config=None):
        return Executor(self.package, self.root / 'runtime', 'pd-fixture-123', '127.0.0.1', 18080,
                        command=self.command, profile=profile, config=config)

    def test_modified_material_fails_before_docker(self):
        self.sql.write_text('ALTER TABLE someone_elses_table DROP COLUMN id;')
        with self.assertRaises(DeliveryError) as error:
            self.executor()
        self.assertEqual(error.exception.code, 'PACKAGE_DIGEST_MISMATCH')
        self.assertFalse(self.calls)

    def test_archive_traversal_and_links_are_rejected(self):
        archive = self.root / 'bad.tar'
        with tarfile.open(archive, 'w') as output:
            info = tarfile.TarInfo('../outside')
            info.size = 1
            output.addfile(info, io.BytesIO(b'x'))
        with self.assertRaises(DeliveryError):
            extract_archive(archive, self.root / 'restored')
        self.assertFalse((self.root / 'outside').exists())

    def test_isolated_environment_has_own_mysql_redis_network_volumes_and_private_files(self):
        executor = self.executor()
        executor.create_infrastructure()
        commands = [' '.join(args) for args in self.calls]
        self.assertTrue(any('network create --internal' in args for args in commands))
        self.assertEqual(sum('volume create' in args for args in commands), 2)
        self.assertTrue(any('--name pd-fixture-123-mysql' in args for args in commands))
        self.assertTrue(any('--name pd-fixture-123-redis' in args for args in commands))
        self.assertTrue((executor.runtime / 'secrets').is_dir())
        self.assertNotIn(executor.secrets()['MYSQL_PASSWORD'], (self.package / 'manifest.json').read_text())

    def test_external_install_never_provisions_database_or_redis(self):
        config = self.root / 'external.env'
        config.write_text('MYSQL_HOST=database.internal\nMYSQL_PORT=3306\nMYSQL_DATABASE=existing\nMYSQL_USER=app\nMYSQL_PASSWORD=private-value\nREDIS_HOST=cache.internal\nREDIS_PORT=6379\nREDIS_PASSWORD=private-redis\n')
        executor = self.executor('external', config)
        executor.create_infrastructure()
        commands = [' '.join(args) for args in self.calls]
        self.assertFalse(any('volume create' in args or 'redis-server' in args or '--name pd-fixture-123-mysql' in args for args in commands))
        self.assertTrue(any('--host database.internal' in args and '--user app' in args for args in commands))
        self.assertFalse(any('CREATE DATABASE' in args for args in commands))

    def test_only_isolated_entry_proxy_gets_published_ports_and_external_network(self):
        executor = self.executor()
        executor.create_infrastructure()
        executor.start_applications()
        executor.start_entry_proxy()
        application = next(args for args in self.calls if args[:2] == ['docker', 'run'] and '--name' in args and args[args.index('--name') + 1] == 'pd-fixture-123-app')
        self.assertNotIn('--publish', application)
        self.assertEqual(application[application.index('--network') + 1], 'pd-fixture-123')
        proxy = next(args for args in self.calls if args[:2] == ['docker', 'create'] and '--name' in args and args[args.index('--name') + 1] == 'pd-fixture-123-entry')
        self.assertEqual(proxy[proxy.index('--network') + 1], 'pd-fixture-123-entry')
        self.assertIn('127.0.0.1:18080:8080', proxy)
        self.assertIn(['docker', 'network', 'connect', 'pd-fixture-123', 'pd-fixture-123-entry'], self.calls)

    def test_sql_failure_records_partial_and_never_starts_application(self):
        executor = self.executor()

        def failed_sql(args, **kwargs):
            return subprocess.CompletedProcess(args, 1, b'', b'ERROR fixture second statement failed')

        executor.command = failed_sql
        with patch.object(executor, 'load_images'), patch.object(executor, 'create_infrastructure', side_effect=lambda *_: setattr(executor, 'state', {'environmentId': executor.environment_id})), patch.object(executor, 'start_applications') as start:
            with self.assertRaises(DeliveryError):
                executor.deploy('initial')
            start.assert_not_called()
        self.assertEqual(executor.attempt['databaseStatus'], 'partial')
        self.assertEqual(executor.attempt['applicationStatus'], 'not-run')
        self.assertEqual(executor.attempt['status'], 'failed')
        self.assertEqual(json.loads(executor.state_file.read_text())['databaseStatus'], 'partial')

    def test_upgrade_rejects_partial_or_wrong_database_baseline_before_stopping_apps(self):
        executor = self.executor()
        executor.state = {'databaseManifestSha256': 'd' * 64, 'applicationManifestSha256': 'c' * 64}
        with patch.object(executor, 'load_images'), patch.object(executor, 'stop_applications') as stop:
            with self.assertRaises(DeliveryError) as error:
                executor.deploy('upgrade')
            stop.assert_not_called()
        self.assertEqual(error.exception.code, 'BASELINE_MISMATCH')

    def test_application_failure_preserves_successful_database_and_old_app_state(self):
        executor = self.executor()
        executor.state = {'environmentId': executor.environment_id, 'databaseManifestSha256': 'c' * 64, 'applicationManifestSha256': 'c' * 64,
                          'databaseStatus': 'success', 'applicationStatus': 'success'}
        with patch.object(executor, 'load_images'), patch.object(executor, 'stop_applications'), patch.object(executor, 'execute_sql'), patch.object(executor, 'start_applications'), patch.object(executor, 'start_entry_proxy'), patch.object(executor, 'health', side_effect=DeliveryError('HEALTH', 'fixture failure')):
            with self.assertRaises(DeliveryError):
                executor.deploy('upgrade')
        saved = json.loads(executor.state_file.read_text())
        self.assertEqual(saved['databaseManifestSha256'], executor.manifest_hash)
        self.assertEqual(saved['applicationManifestSha256'], 'c' * 64)
        self.assertEqual(executor.attempt['databaseStatus'], 'success')
        self.assertEqual(executor.attempt['applicationStatus'], 'failed')

    def test_stop_checks_each_container_identity_and_never_removes_storage(self):
        executor = self.executor()
        executor.state = {'environmentId': executor.environment_id, 'applicationContainers': ['other-project-app']}

        def wrong_owner(args, **kwargs):
            self.calls.append(args)
            return subprocess.CompletedProcess(args, 0, json.dumps([{'Config': {'Labels': {'com.forge.production.environment': 'someone-else'}}}]).encode(), b'')

        executor.command = wrong_owner
        with self.assertRaises(DeliveryError) as error:
            executor.stop()
        self.assertEqual(error.exception.code, 'RESOURCE_OWNERSHIP_MISMATCH')
        self.assertFalse(any('stop' in args or 'rm' in args for args in self.calls))

    def test_resume_application_reuses_successful_sql_and_preserves_failed_attempt(self):
        executor = self.executor()
        executor.state = {'environmentId': executor.environment_id, 'databaseManifestSha256': executor.manifest_hash,
                          'applicationManifestSha256': 'c' * 64, 'databaseStatus': 'success', 'applicationStatus': 'failed'}
        original = executor.runtime / 'attempt-original-failure.json'
        write_json(original, {'status': 'failed', 'databaseStatus': 'success', 'applicationStatus': 'failed'})
        old_bytes = original.read_bytes()
        with patch.object(executor, 'load_images'), patch.object(executor, 'stop_applications'), patch.object(executor, 'execute_sql') as sql, patch.object(executor, 'start_applications'), patch.object(executor, 'start_entry_proxy'), patch.object(executor, 'health'):
            executor.deploy('resume-app')
            sql.assert_not_called()
        self.assertEqual(executor.attempt['status'], 'success')
        self.assertEqual(executor.state['applicationManifestSha256'], executor.manifest_hash)
        self.assertEqual(original.read_bytes(), old_bytes)

    def test_external_result_import_format_preserves_partial_without_credentials(self):
        self.manifest.update(project='fixture', releaseId='release-1', jobId='job-1')
        write_json(self.package / 'manifest.json', self.manifest)
        executor = Executor(self.package, self.root / 'runtime', 'pd-fixture-123', '127.0.0.1', 18080,
                            command=self.command, profile='external', target_id='customer-production-1')
        executor.attempt.update(action='upgrade', status='failed', databaseStatus='partial', applicationStatus='not-run', error={'code': 'SQL_EXECUTION_PARTIAL', 'message': 'safe'})
        executor.record_deployment_result()
        result = json.loads(next(executor.runtime.glob('deployment-result-*.json')).read_text())
        self.assertEqual(set(result), {'project', 'targetId', 'releaseId', 'jobId', 'manifestSha256', 'occurredAt', 'databaseStatus', 'applicationStatus', 'notes'})
        self.assertEqual(result['databaseStatus'], 'partial')
        self.assertEqual(result['applicationStatus'], 'not-run')
        self.assertNotIn('MYSQL', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
