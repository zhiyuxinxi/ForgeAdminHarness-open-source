import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('host_inotify', ROOT / 'scripts/configure-host-inotify.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class HostInotifyTests(unittest.TestCase):
    def test_capacity_is_persistent_applied_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            proc, config, backup = root / 'runtime', root / 'sysctl.conf', root / 'backup'
            proc.write_text('128\n')
            calls = []

            def sysctl(argv, **kwargs):
                calls.append(argv)
                self.assertEqual(argv, ['sysctl', '-w', 'fs.inotify.max_user_instances=1024'])
                self.assertTrue(kwargs['check'])
                self.assertEqual(kwargs['timeout'], 10)
                proc.write_text('1024\n')

            result = mod.apply(backup, proc, config, sysctl)
            self.assertTrue(result['after']['ready'])
            self.assertEqual(config.read_bytes(), mod.content(1024))
            before_bytes = (backup / '主机监视实例修复前像.json').read_bytes()
            before = json.loads(before_bytes)
            self.assertEqual(before['before']['runtime'], 128)
            self.assertIsNone(before['configBase64'])
            self.assertEqual(mod.apply(backup, proc, config, sysctl)['status'], 'unchanged')
            self.assertEqual(len(calls), 1)
            self.assertEqual((backup / '主机监视实例修复前像.json').read_bytes(), before_bytes)

    def test_higher_live_capacity_is_never_lowered(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            proc, config = root / 'runtime', root / 'sysctl.conf'
            proc.write_text('4096\n')
            result = mod.apply(root / 'backup', proc, config, lambda *_a, **_k: self.fail('No live change needed'))
            self.assertEqual(result['after']['runtime'], 4096)
            self.assertEqual(config.read_bytes(), mod.content(4096))

    def test_foreign_configuration_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            proc, config, backup = root / 'runtime', root / 'sysctl.conf', root / 'backup'
            proc.write_text('128\n')
            foreign = b'fs.inotify.max_user_instances=4096\nnet.ipv4.ip_forward=0\n'
            config.write_bytes(foreign)
            with self.assertRaisesRegex(RuntimeError, 'not owned'):
                mod.apply(backup, proc, config)
            self.assertEqual(config.read_bytes(), foreign)
            self.assertFalse(backup.exists())

    def test_failed_sysctl_preserves_before_and_never_claims_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            proc, config, backup = root / 'runtime', root / 'sysctl.conf', root / 'backup'
            proc.write_text('128\n')

            def fail(argv, **kwargs):
                raise subprocess.CalledProcessError(1, argv)

            with self.assertRaises(subprocess.CalledProcessError):
                mod.apply(backup, proc, config, fail)
            self.assertEqual(proc.read_text(), '128\n')
            self.assertTrue((backup / '主机监视实例修复前像.json').is_file())
            self.assertFalse((backup / '主机监视实例修复结果.json').exists())

    def test_successful_command_without_effect_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            proc, config, backup = root / 'runtime', root / 'sysctl.conf', root / 'backup'
            proc.write_text('128\n')
            with self.assertRaisesRegex(RuntimeError, 'did not become effective'):
                mod.apply(backup, proc, config, lambda *_a, **_k: None)
            self.assertFalse((backup / '主机监视实例修复结果.json').exists())


if __name__ == '__main__':
    unittest.main()
