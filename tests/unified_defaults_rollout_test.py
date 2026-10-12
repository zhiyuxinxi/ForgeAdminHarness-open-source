import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('defaults_rollout', ROOT / 'scripts/upgrade-unified-workpod-defaults.py')
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


def manifest():
    return json.loads((ROOT / 'docs/validation-evidence/2026-09-20-unified-defaults-manifest.json').read_text())


class DefaultsRolloutTests(unittest.TestCase):
    def test_scope_refuses_business_files_unverified_bundles_and_busy_turns(self):
        m = manifest(); MOD.validate_manifest(m)
        cases = []
        v = copy.deepcopy(m); v['sources'][0]['path'] = 'workspace/business.java'; cases.append(v)
        v = copy.deepcopy(m); v['environments'][0]['binding']['path'] = '/outside'; cases.append(v)
        v = copy.deepcopy(m); v['skill']['version'] = 'unverified'; cases.append(v)
        v = copy.deepcopy(m); v['skill']['roots'][0]['root'] = '/outside'; cases.append(v)
        v = copy.deepcopy(m); v['workpods'][0]['sessions'][0]['running'] = True; cases.append(v)
        for value in cases:
            with self.assertRaises(RuntimeError): MOD.validate_manifest(value)

    def test_only_supported_markers_change_and_all_other_bytes_are_preserved(self):
        raw = b'HARNESS_IMAGE=verified\r\nACCESS_MODE=conversation\r\nPROJECT_VERIFICATION_MODE=host-toolchain\r\n' + MOD.FLAGS[0].encode() + b'=false\r\n'
        changed = MOD.capability_bytes(raw)
        self.assertTrue(changed.startswith(raw.replace(b'=false', b'=true')))
        self.assertEqual(changed.count(b'\r\n'), 7)
        for flag in MOD.FLAGS: self.assertEqual(changed.count(flag.encode() + b'=true'), 1)
        self.assertEqual(MOD.capability_bytes(changed), changed)

    def test_ambiguous_or_invalid_markers_refuse_instead_of_silently_enabling(self):
        key = MOD.FLAGS[0].encode()
        for raw in (key + b'=true\n' + key + b'=false\n', key + b'=unknown\n'):
            with self.assertRaises(RuntimeError): MOD.capability_bytes(raw)

    def test_config_drift_prevents_writing_or_backing_up_unreviewed_content(self):
        m = manifest(); d = MOD.Deployment(m, json.dumps(m).encode())
        d.check_binding = Mock(side_effect=RuntimeError('drift'))
        with patch.object(MOD.common, 'atomic_replace') as atomic:
            with self.assertRaisesRegex(RuntimeError, 'drift'): d.apply_environment(m['environments'][0], 0)
            atomic.assert_not_called()

    def test_atomic_failure_retains_original_configuration_and_before_image(self):
        m = manifest(); d = MOD.Deployment(m, json.dumps(m).encode())
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); path = root / 'task.env'; raw = b'HARNESS_IMAGE=verified\n'
            path.write_bytes(raw); d.backup = root / 'backup'; d.backup.mkdir()
            f = {'binding': MOD.w.binding(path)}
            with patch.object(MOD.common, 'atomic_replace', side_effect=RuntimeError('atomic drift')):
                with self.assertRaisesRegex(RuntimeError, 'atomic drift'): d.apply_environment(f, 0)
            self.assertEqual(path.read_bytes(), raw)
            self.assertEqual((d.backup / 'env-0.before').read_bytes(), raw)


if __name__ == '__main__': unittest.main()
