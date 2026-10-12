import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('buildkit_export', ROOT / 'scripts/export-host-buildkit-dependencies.py')
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)
IMAGE = 'forge-delivery/deepseek-harness:reviewed'
IMAGE_ID = 'sha256:' + 'a' * 64
BINDING = {'namespace': '', 'composeProjectName': 'forge-forge-base', 'composeSha256': 'b' * 64}


class BuildkitDependencyExportTests(unittest.TestCase):
    @unittest.skipIf(os.name == 'nt', 'requires Unix executable modes')
    def test_executable_mode_survives_archive_extraction_and_readonly_freeze(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'payload.tar'
            with tarfile.open(archive, 'w') as handle:
                for name, mode in [('m2/repository/a.jar', 0o644), ('pnpm/store/v10/files/bin-exec', 0o755)]:
                    member = tarfile.TarInfo(name)
                    member.mode, member.size = mode, 1
                    handle.addfile(member, io.BytesIO(b'x'))
            output = root / 'export'
            exporter.extract_archive(archive, output)
            try:
                exporter.freeze(output)
                self.assertEqual((output / 'pnpm/store/v10/files/bin-exec').stat().st_mode & 0o777, 0o555)
                self.assertEqual((output / 'm2/repository/a.jar').stat().st_mode & 0o777, 0o444)
            finally:
                self.writable_cleanup(output)

    def payload(self, root):
        (root / 'm2/repository/group').mkdir(parents=True)
        (root / 'pnpm/store/v3/files').mkdir(parents=True)
        (root / 'm2/repository/group/dependency.jar').write_bytes(b'jar')
        (root / 'pnpm/store/v3/files/content').write_bytes(b'package')

    def writable_cleanup(self, root):
        for directory, directories, files in os.walk(root):
            Path(directory).chmod(0o700)
            for name in files:
                (Path(directory) / name).chmod(0o600)

    def archive(self, archive_path, members=None):
        if members is None:
            members = [('m2/repository/dependency.jar', tarfile.REGTYPE, b'jar'),
                       ('pnpm/store/v3/files/content', tarfile.REGTYPE, b'package')]
        with tarfile.open(archive_path, 'w') as handle:
            for name, kind, data in members:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.size = len(data)
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    member.linkname = 'm2/repository/dependency.jar'
                handle.addfile(member, io.BytesIO(data))

    def test_fixed_buildkit_namespace_readonly_mounts_and_networkless_export(self):
        argv = exporter.build_argv(Path('/context'), Path('/output/payload.tar'), IMAGE, '', 'export-one')
        self.assertEqual(argv, ['docker', 'build', '--pull=false', '--network=none', '--progress=plain',
                               '--build-arg', 'BUILDKIT_CACHE_MOUNT_NS=',
                               '--build-arg', 'PARENT_IMAGE=' + IMAGE,
                               '--build-arg', 'EXPORT_RUN_ID=export-one',
                               '--output', 'type=tar,dest=' + str(Path('/output/payload.tar')), str(Path('/context'))])
        self.assertNotIn('--no-cache', argv)
        self.assertNotIn('--no-cache-filter', argv)
        dockerfile = exporter.dockerfile()
        self.assertIn('RUN --network=none', dockerfile)
        for target in ['/root/.m2', '/pnpm-store']:
            self.assertIn('type=cache,target=' + target + ',sharing=locked,readonly', dockerfile)
        self.assertNotIn('id=', dockerfile)  # Preserve the existing Dockerfiles' default target IDs.
        self.assertIn('ARG EXPORT_RUN_ID\n', dockerfile)
        self.assertIn('node /tmp/forge-export-cache.mjs "$EXPORT_RUN_ID"', dockerfile)
        self.assertIn('FROM scratch\nCOPY --from=dependency-export /export/ /', dockerfile)
        for namespace in ['forge-forge-base', 'other-project']:
            with self.subTest(namespace=namespace), self.assertRaisesRegex(RuntimeError, 'namespace'):
                exporter.build_argv(Path('/context'), Path('/output'), IMAGE, namespace, 'export-one')
        later = exporter.build_argv(Path('/context'), Path('/output/payload.tar'), IMAGE, '', 'export-two')
        self.assertIn('EXPORT_RUN_ID=export-two', later)
        self.assertNotEqual(argv, later)

    def test_tar_extraction_preserves_archive_and_exact_payload_without_replaying_partial(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'payload.tar'
            self.archive(archive)
            original = archive.read_bytes()
            output = root / 'export'
            self.assertEqual(exporter.extract_archive(archive, output), {'files': 2, 'bytes': 10})
            self.assertEqual(archive.read_bytes(), original)
            self.assertEqual((output / 'm2/repository/dependency.jar').read_bytes(), b'jar')
            self.assertEqual(len(exporter.inventory(output)), 2)
            with self.assertRaisesRegex(RuntimeError, 'destination must be new'):
                exporter.extract_archive(archive, output)

    def test_tar_rejects_escape_links_special_nodes_and_duplicate_paths(self):
        cases = [('/m2/repository/a', tarfile.REGTYPE), ('../outside', tarfile.REGTYPE),
                 ('m2/repository/../../outside', tarfile.REGTYPE), ('m2\\repository\\a', tarfile.REGTYPE),
                 ('C:/outside', tarfile.REGTYPE), ('m2/repository//a', tarfile.REGTYPE),
                 ('elsewhere/a', tarfile.REGTYPE), ('m2/repository/link', tarfile.SYMTYPE),
                 ('m2/repository/link', tarfile.LNKTYPE), ('m2/repository/fifo', tarfile.FIFOTYPE),
                 ('m2/repository/device', tarfile.CHRTYPE)]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index, (name, kind) in enumerate(cases):
                with self.subTest(name=name, kind=kind):
                    archive = root / f'reject-{index}.tar'
                    self.archive(archive, [(name, kind, b'')])
                    with self.assertRaises(RuntimeError):
                        exporter.extract_archive(archive, root / f'export-{index}')
                    self.assertTrue(archive.exists())
            archive = root / 'duplicate.tar'
            self.archive(archive, [('m2/repository/a', tarfile.REGTYPE, b'a'),
                                   ('./m2/repository/a', tarfile.REGTYPE, b'b')])
            with self.assertRaisesRegex(RuntimeError, 'duplicate'):
                exporter.extract_archive(archive, root / 'duplicate')
            self.assertEqual((root / 'duplicate/m2/repository/a').read_bytes(), b'a')

    def test_tar_enforces_archive_member_file_and_total_size_limits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'payload.tar'
            self.archive(archive)
            for index, (constant, limit) in enumerate([('MAX_ARCHIVE_BYTES', archive.stat().st_size - 1),
                                                      ('MAX_ARCHIVE_MEMBERS', 1), ('MAX_FILE_BYTES', 2),
                                                      ('MAX_PAYLOAD_BYTES', 5)]):
                with self.subTest(constant=constant), patch.object(exporter, constant, limit):
                    with self.assertRaisesRegex(RuntimeError, 'limit'):
                        exporter.extract_archive(archive, root / f'export-{index}')

    def test_actual_compose_namespace_and_project_identity_are_both_verified(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            (project / 'ops').mkdir()
            env = project / 'ops/project.env'
            compose = project / 'ops/compose.yaml'
            compose.write_bytes(b'name: ${COMPOSE_PROJECT_NAME}\nservices: {}\n')
            env.write_text('OTHER=value\nCOMPOSE_PROJECT_NAME=forge-forge-base\n', encoding='utf-8')
            self.assertEqual(exporter.read_source_binding(project), {'namespace': '', 'composeProjectName': 'forge-forge-base',
                                                                    'composeSha256': hashlib.sha256(compose.read_bytes()).hexdigest()})
            compose.write_bytes(b'build:\n  args:\n    BUILDKIT_CACHE_MOUNT_NS: forge-forge-base\n')
            with self.assertRaisesRegex(RuntimeError, 'Actual Compose'):
                exporter.read_source_binding(project)
            compose.write_bytes(b'name: ${COMPOSE_PROJECT_NAME}\nservices: {}\n')
            for value in ['COMPOSE_PROJECT_NAME=other\n', 'COMPOSE_PROJECT_NAME=$(command)\n',
                          'COMPOSE_PROJECT_NAME=forge-forge-base\nCOMPOSE_PROJECT_NAME=forge-forge-base\n']:
                env.write_text(value, encoding='utf-8')
                with self.assertRaisesRegex(RuntimeError, 'namespace'):
                    exporter.read_source_binding(project)

    def test_output_path_and_parent_image_inputs_cannot_expand_scope(self):
        for project, output in [(Path('/srv/forge-delivery/projects/other'), exporter.CANARY / 'export'),
                                (exporter.PROJECT, Path('/tmp/export')),
                                (exporter.PROJECT, exporter.CANARY / 'nested/export'),
                                (exporter.PROJECT, exporter.CANARY / '..')]:
            with self.subTest(output=output), self.assertRaises(RuntimeError):
                exporter.validate_paths(project, output)
        exporter.validate_image(IMAGE, IMAGE_ID)
        for reference, image_id in [('repo:tag\nRUN command', IMAGE_ID), (IMAGE_ID, IMAGE_ID),
                                    (IMAGE, 'latest'), ('$(command)', IMAGE_ID)]:
            with self.subTest(reference=reference), self.assertRaises(RuntimeError):
                exporter.validate_image(reference, image_id)
        with patch.object(exporter.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, IMAGE_ID + '\n', '')) as run:
            exporter.inspect_image(IMAGE, IMAGE_ID)
            self.assertEqual(run.call_args.args[0], ['docker', 'image', 'inspect', '--format', '{{.Id}}', IMAGE])
        with patch.object(exporter.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'sha256:' + 'b' * 64, '')):
            with self.assertRaisesRegex(RuntimeError, 'pinned'):
                exporter.inspect_image(IMAGE, IMAGE_ID)

    def test_export_inventory_has_exact_payload_hashes_and_rejects_extra_nodes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.payload(root)
            files = exporter.inventory(root)
            self.assertEqual([item['path'] for item in files], ['m2/repository/group/dependency.jar', 'pnpm/store/v3/files/content'])
            self.assertEqual(files[0], {'path': 'm2/repository/group/dependency.jar', 'bytes': 3,
                                        'sha256': hashlib.sha256(b'jar').hexdigest()})
            self.assertEqual(exporter.tree_hash(files), hashlib.sha256(json.dumps(files, separators=(',', ':')).encode()).hexdigest())
            extra = root / 'm2/extra'
            extra.mkdir()
            with self.assertRaisesRegex(RuntimeError, 'Directory escaped'):
                exporter.inventory(root)
            extra.rmdir()
            config = root / 'pnpm/store/.npmrc'
            config.write_text('not-exportable')
            with self.assertRaisesRegex(RuntimeError, 'Configuration'):
                exporter.inventory(root)

    def test_copy_script_keeps_dependencies_and_excludes_only_known_temporary_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            self.payload(source)
            (source / 'm2/repository/group/pending.jar.lastUpdated').write_text('pending')
            (source / 'm2/repository/group/pending.jar.part').write_text('pending')
            (source / 'pnpm/store/v3/projects').mkdir()
            (source / 'pnpm/store/v3/projects/index').write_text('workspace index')
            output = root / 'export'
            code = exporter.COPY_SCRIPT
            replacements = {'/root/.m2/repository': str(source / 'm2/repository'), '/pnpm-store': str(source / 'pnpm/store'),
                            '/export/m2/repository': str(output / 'm2/repository'),
                            '/export/pnpm/store': str(output / 'pnpm/store'), '/export': str(output)}
            for original, target in replacements.items():
                code = code.replace("'" + original + "'", json.dumps(target))
            subprocess.run(['node', '--input-type=module', '-', 'copy-fixture'], input=code, text=True, check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(len(exporter.inventory(output)), 2)
            self.assertTrue((source / 'm2/repository/group/pending.jar.part').exists())
            self.assertTrue((source / 'pnpm/store/v3/projects/index').exists())

    def test_failed_export_retains_logs_and_cannot_blindly_replay(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'operation'
            with patch.object(exporter, 'validate_paths'), patch.object(exporter, 'read_source_binding', return_value=BINDING), \
                 patch.object(exporter, 'inspect_image'), patch.object(exporter.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['docker', 'build'])) as run:
                with self.assertRaises(subprocess.CalledProcessError):
                    exporter.export_dependencies(exporter.PROJECT, output, IMAGE, IMAGE_ID)
                self.assertTrue((output / 'build.log').is_file())
                self.assertTrue((output / 'context/Dockerfile').is_file())
                with self.assertRaisesRegex(RuntimeError, 'no blind'):
                    exporter.export_dependencies(exporter.PROJECT, output, IMAGE, IMAGE_ID)
                self.assertEqual(run.call_count, 1)

    @unittest.skipIf(os.name == 'nt', 'Immutable directory mode verification requires POSIX.')
    def test_completed_export_is_frozen_and_idempotently_verified_without_rebuilding(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'operation'
            try:
                def build(*args, **kwargs):
                    self.archive(output / 'payload.tar')
                    return subprocess.CompletedProcess(args[0], 0)
                with patch.object(exporter, 'validate_paths'), patch.object(exporter, 'read_source_binding', return_value=BINDING), \
                     patch.object(exporter, 'inspect_image'), patch.object(exporter.subprocess, 'run', side_effect=build) as run:
                    first = exporter.export_dependencies(exporter.PROJECT, output, IMAGE, IMAGE_ID)
                    second = exporter.export_dependencies(exporter.PROJECT, output, IMAGE, IMAGE_ID)
                    self.assertFalse(first['reused'])
                    self.assertTrue(second['reused'])
                    self.assertEqual(first['exportInventorySha256'], second['exportInventorySha256'])
                    self.assertEqual(run.call_count, 1)
                    self.assertEqual(first['status'], 'exported-unverified')
                    self.assertEqual(first['exportInventorySha256'], hashlib.sha256((output / 'export/export-inventory.json').read_bytes()).hexdigest())
            finally:
                self.writable_cleanup(Path(temporary))


if __name__ == '__main__':
    unittest.main()
