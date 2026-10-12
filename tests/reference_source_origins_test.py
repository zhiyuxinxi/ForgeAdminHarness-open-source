import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/verify-reference-source-origins.py'


class ReferenceOriginsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='forge-origin-test-')
        self.root = Path(self.temporary.name).resolve()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.addCleanup(self.temporary.cleanup)
        self.procode = self.root / 'procode'
        self.aiko = self.root / 'aiko'
        self.source = self.procode / 'skills/example/SKILL.md'
        self.source.parent.mkdir(parents=True)
        self.source.write_bytes(b'original skill\n')
        self.aiko.mkdir()
        (self.aiko / 'README.md').write_bytes(b'archive reference\n')
        (self.procode / 'LICENSE').write_bytes(b'fixture license evidence only\n')
        (self.aiko / 'package.json').write_text('{"name":"fixture","version":"1.0.0","license":"MIT"}', encoding='utf-8')
        def entry(path, data):
            return {'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'decision': 'reject'}
        self.manifest = {'schemaVersion': 1, 'evidenceType': 'forge-reference-clean-room-source-audit',
            'procode': {'domainSkills': [entry('skills/example/SKILL.md', self.source.read_bytes())], 'genericSkills': [], 'domainTree': {'fileCount': 1, 'byteCount': self.source.stat().st_size}},
            'aiko': {'files': [entry('README.md', b'archive reference\n')]}}
        self.manifest_path = self.root / 'manifest.json'
        self.output = self.root / 'capture.json'

    def run_check(self, output=None):
        self.manifest_path.write_text(json.dumps(self.manifest), encoding='utf-8')
        return subprocess.run([sys.executable, '-O', str(SCRIPT), '--manifest', str(self.manifest_path),
            '--procode-root', str(self.procode), '--aiko-root', str(self.aiko), '--output', str(output or self.output)], capture_output=True, text=True, timeout=15)

    def test_actual_bytes_and_license_metadata_do_not_grant_copy_rights(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.output.read_bytes())
        self.assertEqual(report['counts'], {'matched': 2, 'changed': 0, 'missing': 0})
        self.assertTrue(report['domainInventoryShapeMatches'])
        self.assertEqual(report['licenseFiles'][0]['sha256'], hashlib.sha256((self.procode / 'LICENSE').read_bytes()).hexdigest())
        self.assertEqual(report['selectedFiles'][1]['packageMetadata'][0]['declaredLicense'], 'MIT')
        self.assertTrue(all(item['copyApproval'] == 'not-granted-by-this-audit' for item in report['selectedFiles']))
        self.assertEqual(report['formalCapabilityStatus'], 'partial')

    def test_changed_or_missing_source_cannot_pass_using_a_well_formed_old_hash(self):
        for missing in [False, True]:
            with self.subTest(missing=missing):
                if missing:
                    self.source.unlink()
                else:
                    self.source.write_bytes(b'altered skill!\n')
                output = self.root / ('missing.json' if missing else 'changed.json')
                result = self.run_check(output)
                self.assertEqual(result.returncode, 2, result.stderr)
                report = json.loads(output.read_bytes())
                self.assertFalse(report['sourceBytesVerified'])
                self.assertEqual(report['counts']['missing' if missing else 'changed'], 1)

    def test_traversal_drive_paths_and_excluded_secret_are_rejected_before_capture(self):
        for value in ['../outside.md', 'C:outside.md', 'skills\\example\\SKILL.md', '.cursor/mcp.json', '.CURSOR/MCP.JSON']:
            with self.subTest(path=value):
                self.manifest['procode']['domainSkills'][0]['path'] = value
                result = self.run_check()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.output.exists())

    def test_prior_capture_and_reference_roots_remain_read_only(self):
        self.output.write_bytes(b'prior evidence')
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.output.read_bytes(), b'prior evidence')
        original = self.source.read_bytes()
        result = self.run_check(self.procode / 'capture.json')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.procode / 'capture.json').exists())
        self.assertEqual(self.source.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
