"""Linux real-mlock fixtures; never open the production metadata files."""

import importlib.util
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/containerd-metadata-residency.py'
spec = importlib.util.spec_from_file_location('metadata_residency', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def locked_kib(pid='self'):
    for line in Path('/proc', str(pid), 'status').read_text().splitlines():
        if line.startswith('VmLck:'):
            return int(line.split()[1])
    raise AssertionError('VmLck unavailable')


@unittest.skipUnless(sys.platform == 'linux', 'real mlock requires Linux')
class MetadataResidencyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='forge-metadata-residency-fixture-')
        self.root = Path(self.temp.name)
        self.paths = (self.root / 'meta.db', self.root / 'metadata.db')
        for path in self.paths:
            path.write_bytes(b'x' * 65536)
        self.before = locked_kib()
        self.residency = module.Residency(self.paths, max_bytes=512 * 1024)

    def tearDown(self):
        self.residency.close()
        self.assertEqual(locked_kib(), self.before)
        self.temp.cleanup()

    def test_initial_read_only_lock_and_release(self):
        before = [path.read_bytes() for path in self.paths]
        self.assertTrue(self.residency.refresh())
        self.assertEqual(self.residency.locked_bytes, 128 * 1024)
        self.assertEqual(locked_kib() - self.before, 128)
        self.assertFalse(self.residency.refresh())
        self.assertEqual([path.read_bytes() for path in self.paths], before)

    def test_growth_replaces_mapping_and_locks_new_pages(self):
        self.residency.refresh()
        old = self.residency.mappings[self.paths[0]]
        with self.paths[0].open('ab') as stream:
            stream.write(b'g' * 65536)
        self.assertTrue(self.residency.refresh())
        self.assertIsNone(old.address)
        self.assertEqual(self.residency.locked_bytes, 192 * 1024)
        self.assertEqual(locked_kib() - self.before, 192)

    def test_inode_replacement_locks_new_file_before_releasing_old(self):
        self.residency.refresh()
        old = self.residency.mappings[self.paths[1]]
        replacement = self.root / 'replacement.db'
        replacement.write_bytes(b'n' * 65536)
        os.replace(replacement, self.paths[1])
        self.assertTrue(self.residency.refresh())
        self.assertNotEqual(old.identity[1], self.residency.mappings[self.paths[1]].identity[1])
        self.assertIsNone(old.address)
        self.assertEqual(locked_kib() - self.before, 128)

    def test_limit_failure_preserves_existing_mapping_until_explicit_release(self):
        self.residency.refresh()
        old = self.residency.mappings.copy()
        with self.paths[0].open('r+b') as stream:
            stream.truncate(512 * 1024)
        with self.assertRaisesRegex(ValueError, 'TOTAL_SIZE_LIMIT'):
            self.residency.refresh()
        self.assertEqual(self.residency.mappings, old)
        self.assertEqual(locked_kib() - self.before, 128)
        with self.paths[0].open('r+b') as stream:
            stream.truncate(512 * 1024 + 4096)
        with self.assertRaisesRegex(ValueError, 'FILE_TYPE_OR_SIZE_LIMIT'):
            self.residency.refresh()

    def test_sigterm_reports_release_and_exits_successfully(self):
        code = ('import importlib.util;'
                's=importlib.util.spec_from_file_location("fixture",'+repr(str(SCRIPT))+');'
                'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);'
                'm.run(paths='+repr(tuple(str(path) for path in self.paths))+',interval=30)')
        process = subprocess.Popen([sys.executable, '-u', '-c', code],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(8), 'fixture lock readiness timed out')
                first = json.loads(process.stdout.readline())
            self.assertEqual(first['status'], 'locked')
            self.assertEqual(locked_kib(process.pid), 128)
            process.send_signal(signal.SIGTERM)
            output, error = process.communicate(timeout=8)
            self.assertEqual(process.returncode, 0, error)
            self.assertEqual(json.loads(output.splitlines()[-1]), {'status': 'released', 'lockedBytes': 0})
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()


if __name__ == '__main__':
    unittest.main()
