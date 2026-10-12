import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('status_rollout', ROOT / 'scripts/deploy-project-release-status.py')
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


def manifest():
    return json.loads((ROOT / 'docs/validation-evidence/2026-09-20-project-release-status-manifest.json').read_text())


class ReleaseStatusRolloutTests(unittest.TestCase):
    def test_frozen_linux_manifest_is_valid_on_windows(self):
        MOD.validate_manifest(manifest())

    def test_rollout_rejects_business_roles_other_projects_duplicates_and_unverified_images(self):
        for change in ('role', 'project', 'duplicate', 'image', 'default', 'path'):
            m = manifest()
            if change == 'role': m['services'][0]['role'] = 'harness'
            if change == 'project': m['services'][0]['project'] = 'other'
            if change == 'duplicate': m['services'].append(m['services'][0])
            if change == 'image': m['targetImageId'] = 'sha256:' + '0' * 64
            if change == 'default': m['files'][0]['replacements']['FORGE_ADMIN_IMAGE'] = MOD.IMAGE
            if change == 'path': m['files'][0]['binding']['path'] = '/outside'
            with self.subTest(change=change), self.assertRaises(RuntimeError): MOD.validate_manifest(m)

    def test_busy_release_prevents_any_cutover(self):
        m = manifest(); d = MOD.Deployment(m, json.dumps(m).encode()); c = m['services'][0]
        d.container = Mock(); d.role_ready = Mock(side_effect=RuntimeError('busy')); d.helper = Mock()
        with self.assertRaisesRegex(RuntimeError, 'busy'): d.upgrade_service(c, 0)
        d.helper.assert_not_called()

    def test_failed_candidate_is_retained_without_promotion(self):
        m = manifest(); d = MOD.Deployment(m, json.dumps(m).encode()); c = m['services'][0]
        with tempfile.TemporaryDirectory() as temp:
            d.backup = Path(temp); d.records = d.backup / 'records'; d.records.mkdir()
            d.container = Mock(); d.role_ready = Mock(); d.service_template = Mock(return_value=None)
            d.wait = Mock(side_effect=RuntimeError('candidate unavailable'))
            def helper(function, *args):
                if function == 'forge_cutover_contract_sha_for_id': return c['runtimeSha256'].encode()
                if function == 'forge_cutover_prepare': MOD.common.write_new(d.record('service-0'), {'candidate': {'id': 'b' * 64}})
                return b''
            d.helper = Mock(side_effect=helper)
            with self.assertRaisesRegex(RuntimeError, 'candidate unavailable'): d.upgrade_service(c, 0)
            self.assertNotIn('forge_cutover_promote', [call.args[0] for call in d.helper.call_args_list])
            self.assertTrue(d.record('service-0').exists())

    def test_status_validation_requires_actual_project_and_fresh_availability(self):
        m = manifest(); d = MOD.Deployment(m, json.dumps(m).encode()); c = m['services'][0]
        d.run = Mock(return_value=json.dumps({'projectSlug': c['project'], 'availability': 'ready'}).encode())
        d.status_ready(c, c['id'])
        for value in ({'projectSlug': 'other', 'availability': 'ready'}, {'projectSlug': c['project'], 'availability': 'unknown'}):
            d.run.return_value = json.dumps(value).encode()
            with self.assertRaises(RuntimeError): d.status_ready(c, c['id'])

    def test_image_default_edit_preserves_other_bytes(self):
        original = b'HARNESS_IMAGE=old\r\nFORGE_ADMIN_IMAGE=business\r\nFEATURE=false\r\n'
        self.assertEqual(MOD.common.image_env_bytes(original, {'HARNESS_IMAGE': MOD.IMAGE}),
                         original.replace(b'HARNESS_IMAGE=old', b'HARNESS_IMAGE=' + MOD.IMAGE.encode()))


if __name__ == '__main__': unittest.main()
