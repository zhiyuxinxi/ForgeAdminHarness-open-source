import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/prepare-host-pnpm-10.34.5.py'
SPEC = importlib.util.spec_from_file_location('prepare_fixed_host_pnpm', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FixedPnpmPreparationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='forge-pnpm-prepare-test-')
        self.base = Path(self.temporary.name)
        self.candidate = self.base / 'candidate'
        self.cache = self.base / 'readonly-npm-cache'
        self.cache.mkdir()
        (self.cache / 'sentinel').write_text('existing npm cache')
        (self.cache / '_cacache').mkdir()
        (self.cache / '_cacache/index').write_text('existing public package index')
        self.npm_cli = self.base / 'npm-cli.js'
        self.npm_cli.write_text('// test npm boundary')
        self.node = Path(shutil.which('node')).resolve()
        self.archive = b'fixed official archive fixture'
        self.dist = {'tarball': MODULE.TARBALL, 'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(self.archive).digest()).decode()}
        self.calls = []
        self.miss = None

    def tearDown(self):
        for directory, _, files in os.walk(self.base):
            Path(directory).chmod(0o700)
            for name in files:
                file = Path(directory) / name
                if not file.is_symlink():
                    file.chmod(0o600)
        self.temporary.cleanup()

    def invoke(self, argv, env, cwd):
        self.calls.append(argv)
        if str(self.npm_cli) not in argv:
            return MODULE.run(argv, env, cwd)
        self.assertIn('--offline', argv)
        self.assertIn('--ignore-scripts', argv)
        self.assertIn('--registry=' + MODULE.REGISTRY, argv)
        self.assertNotIn('NPM_TOKEN', env)
        action = next(item for item in ('view', 'pack', 'install') if item in argv)
        cache = Path(next(item.split('=', 1)[1] for item in argv if item.startswith('--cache=')))
        self.assertNotEqual(cache, self.cache, 'npm must never receive the source cache, including as root')
        if action in ('view', 'pack'):
            (cache / '_cacache/index').write_text('npm is allowed to rewrite only its private copy')
        if self.miss == action:
            raise MODULE.PreparationError('PNPM_OFFLINE_CACHE_MISS', 'fixed fixture cache miss')
        if action == 'view':
            return json.dumps(self.dist)
        if action == 'pack':
            destination = Path(next(item.split('=', 1)[1] for item in argv if item.startswith('--pack-destination=')))
            (destination / 'pnpm-10.34.5.tgz').write_bytes(self.archive)
            return json.dumps([{'filename': 'pnpm-10.34.5.tgz'}])
        self.assertIn('--bin-links=false', argv)
        prefix = Path(next(item.split('=', 1)[1] for item in argv if item.startswith('--prefix=')))
        self.assertNotIn('--cache=' + str(self.cache), argv, 'install uses its own writable scratch cache')
        package = prefix / 'lib/node_modules/pnpm'
        (package / 'bin').mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({'name': 'pnpm', 'version': '10.34.5', 'bin': {'pnpm': 'bin/pnpm.cjs'}}))
        (package / 'bin/pnpm.cjs').write_text('console.log("10.34.5");\n')
        (package / 'bin/pnpm.cjs').chmod(0o755)
        return '{}'

    def prepare(self, **options):
        return MODULE.prepare(self.candidate, self.cache, self.node, self.npm_cli, invoke=self.invoke, **options)

    def test_offline_prepares_fixed_readonly_tree_and_preserves_current_and_cache(self):
        current = self.candidate / 'toolchains/pnpm-current'
        current.parent.mkdir(parents=True)
        current.write_text('existing pnpm 11 binding')
        result = self.prepare()
        target = Path(result['root'])
        receipt = json.loads(Path(result['receipt']).read_text())
        self.assertEqual(target, self.candidate / 'toolchains/versions/pnpm-10.34.5')
        self.assertEqual(receipt['version'], '10.34.5')
        self.assertEqual(receipt['source']['sha256'], hashlib.sha256(self.archive).hexdigest())
        self.assertEqual(receipt['files'], MODULE.tree_inventory(target, readonly=True)[0])
        self.assertEqual(receipt['treeSha256'], MODULE.tree_inventory(target, readonly=True)[1])
        if os.name != 'nt':
            self.assertTrue(next(item for item in receipt['files'] if item['path'] == receipt['entrypoint'])['executable'])
        self.assertEqual(current.read_text(), 'existing pnpm 11 binding')
        self.assertEqual(sorted(p.name for p in self.cache.iterdir()), ['_cacache', 'sentinel'])
        self.assertEqual((self.cache / 'sentinel').read_text(), 'existing npm cache')
        self.assertEqual((self.cache / '_cacache/index').read_text(), 'existing public package index')
        count = len(self.calls)
        repeated = self.prepare()
        self.assertTrue(repeated['idempotent'])
        self.assertEqual(len(self.calls), count + 1, 'reuse only probes the preserved tool; no acquisition or reinstall')

    def test_offline_cache_miss_does_not_download_or_publish(self):
        self.miss = 'view'
        def unexpected(*_args):
            self.fail('offline preparation must not fetch')
        with self.assertRaises(MODULE.PreparationError) as error:
            self.prepare(fetch=unexpected)
        self.assertEqual(error.exception.code, 'PNPM_OFFLINE_CACHE_MISS')
        self.assertFalse((self.candidate / 'toolchains/versions/pnpm-10.34.5').exists())

    def test_explicit_fallback_fetches_only_fixed_metadata_and_tarball_then_installs_offline(self):
        self.miss = 'view'
        fetched = []
        def fetch(url, maximum):
            fetched.append(url)
            return json.dumps({'name': 'pnpm', 'version': '10.34.5', 'dist': self.dist}).encode() if url == MODULE.METADATA else self.archive
        self.prepare(allow_download=True, fetch=fetch)
        self.assertEqual(fetched, [MODULE.METADATA, MODULE.TARBALL])
        self.assertTrue(all('--offline' in command for command in self.calls if str(self.npm_cli) in command))

    def test_corrupt_archive_is_rejected_before_install(self):
        self.dist['integrity'] = 'sha512-' + base64.b64encode(hashlib.sha512(b'other archive').digest()).decode()
        with self.assertRaisesRegex(MODULE.PreparationError, 'integrity mismatch'):
            self.prepare()
        self.assertFalse(any('install' in command for command in self.calls))

    def test_explicit_files_install_offline_without_cache_or_metadata_commands(self):
        archive = self.base / 'pnpm-10.34.5.tgz'
        metadata = self.base / 'dist.json'
        archive.write_bytes(self.archive)
        metadata.write_text(json.dumps(self.dist))
        before = (archive.read_bytes(), metadata.read_bytes())
        result = MODULE.prepare(self.candidate, None, self.node, self.npm_cli, invoke=self.invoke,
                                fetch=lambda *_: self.fail('fixed inputs must not fetch'),
                                package_tarball=archive, dist_json=metadata)
        self.assertEqual(result['status'], 'ready')
        self.assertFalse(any('view' in command or 'pack' in command for command in self.calls))
        self.assertEqual((archive.read_bytes(), metadata.read_bytes()), before)
        self.assertTrue(any('install' in command and '--offline' in command for command in self.calls))

    def test_fixed_files_require_both_and_reject_tampered_archive_before_install(self):
        archive = self.base / 'pnpm-10.34.5.tgz'
        metadata = self.base / 'dist.json'
        archive.write_bytes(b'tampered')
        metadata.write_text(json.dumps(self.dist))
        with self.assertRaisesRegex(MODULE.PreparationError, 'Both fixed'):
            MODULE.prepare(self.candidate, None, self.node, self.npm_cli, package_tarball=archive)
        with self.assertRaisesRegex(MODULE.PreparationError, 'integrity mismatch'):
            MODULE.prepare(self.candidate, None, self.node, self.npm_cli, invoke=self.invoke,
                           package_tarball=archive, dist_json=metadata)
        self.assertEqual(self.calls, [])

    def test_existing_tree_tamper_is_rejected_not_overwritten(self):
        result = self.prepare()
        entry = Path(result['root']) / 'lib/node_modules/pnpm/bin/pnpm.cjs'
        entry.chmod(0o755)
        entry.write_text('modified tool bytes')
        entry.chmod(0o555)
        with self.assertRaisesRegex(MODULE.PreparationError, 'differs from its receipt'):
            self.prepare()
        self.assertEqual(entry.read_text(), 'modified tool bytes')

    def test_only_fixed_official_dist_and_safe_package_paths_are_accepted(self):
        with self.assertRaises(MODULE.PreparationError):
            MODULE.fixed_dist({**self.dist, 'tarball': 'https://example.com/pnpm.tgz'})
        for value in ('../pnpm.cjs', '/pnpm.cjs', 'bin\\pnpm.cjs'):
            with self.assertRaises(MODULE.PreparationError):
                MODULE.safe_relative(value)
        root = self.base / 'hardlinks'
        root.mkdir()
        (root / 'a').write_text('bytes')
        os.link(root / 'a', root / 'b')
        with self.assertRaisesRegex(MODULE.PreparationError, 'single-link'):
            MODULE.tree_inventory(root)


if __name__ == '__main__':
    unittest.main()
