import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('shared_rollout', ROOT / 'scripts/upgrade-unified-shared-consumers.py')
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


def manifest():
    m = json.loads((ROOT / 'docs/validation-evidence/2026-09-20-development-flow-shared-manifest.json').read_text())
    return m


class SharedRolloutTests(unittest.TestCase):
    def test_frozen_manifest_accepts_only_verified_image_and_idle_workpods(self):
        MOD.validate_manifest(manifest())
        self.assertEqual(MOD.archive.TARGET_IMAGE, MOD.IMAGE)
        value = manifest(); value['workpods'][0]['container']['imageId'] = 'sha256:' + 'a' * 64
        MOD.validate_manifest(value)
        self.assertNotIn('harness-upload', MOD.ROLES)
        cases = []
        for key in ('targetImageId', 'canaryProofSha256'):
            value = manifest(); value[key] = 'unverified'; cases.append(value)
        value = manifest(); value['services'].append(copy.deepcopy(value['services'][0])); cases.append(value)
        value = manifest(); value['services'][0]['role'] = 'forge-admin'; cases.append(value)
        value = manifest(); value['services'][0]['project'] = 'other-project'; cases.append(value)
        value = manifest(); value['workpods'][0]['sessions'] = [{'running': True}]; cases.append(value)
        value = manifest(); value['workpods'][0]['fence']['path'] = '/outside'; cases.append(value)
        for value in cases:
            with self.subTest(value=value.get('targetImageId')), self.assertRaises(RuntimeError):
                MOD.validate_manifest(value)

    def test_image_defaults_cannot_change_permissions_or_business_images(self):
        for key in ('FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED', 'FORGE_ADMIN_IMAGE'):
            value = manifest(); value['files'][0]['replacements'][key] = MOD.IMAGE
            with self.assertRaises(RuntimeError): MOD.validate_manifest(value)
        value = manifest(); value['files'][0]['binding']['path'] = '/outside'
        with self.assertRaises(RuntimeError): MOD.validate_manifest(value)
        raw = b'HARNESS_IMAGE=old\r\nFORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED=false\r\nFORGE_ADMIN_IMAGE=business\r\n'
        self.assertEqual(MOD.common.image_env_bytes(raw, {'HARNESS_IMAGE': MOD.IMAGE}),
            raw.replace(b'HARNESS_IMAGE=old', b'HARNESS_IMAGE=' + MOD.IMAGE.encode()))

    def test_already_current_service_is_verified_without_container_mutation(self):
        m = manifest(); d = MOD.Deployment(m, json.dumps(m).encode())
        c = copy.deepcopy(m['services'][0]); c['imageId'] = MOD.IMAGE
        with tempfile.TemporaryDirectory() as temp:
            d.backup = Path(temp); d.container = Mock(); d.role_ready = Mock()
            d.helper = Mock(return_value=c['runtimeSha256'].encode()); d.service_template = Mock()
            result = d.upgrade_service(c, 0)
            self.assertEqual(result['id'], c['id'])
            self.assertEqual([x.args[0] for x in d.helper.call_args_list], ['forge_cutover_contract_sha_for_id'])
            d.service_template.assert_not_called()

    def test_busy_service_never_prepares_or_stops_container(self):
        m = manifest(); d = MOD.Deployment(m, json.dumps(m).encode()); c = m['services'][0]
        d.container = Mock(); d.role_ready = Mock(side_effect=RuntimeError('busy')); d.helper = Mock()
        with self.assertRaisesRegex(RuntimeError, 'busy'): d.upgrade_service(c, 0)
        d.helper.assert_not_called()

    def test_failed_candidate_is_retained_and_not_promoted_or_marked_verified(self):
        m = manifest(); d = MOD.Deployment(m, json.dumps(m).encode())
        c = next(x for x in m['services'] if x['imageId'] != MOD.IMAGE)
        with tempfile.TemporaryDirectory() as temp:
            d.backup = Path(temp); d.records = d.backup / 'records'; d.records.mkdir()
            d.container = Mock(); d.role_ready = Mock(); d.service_template = Mock(return_value=None)
            d.wait = Mock(side_effect=RuntimeError('candidate failed health'))
            def helper(function, *args):
                if function == 'forge_cutover_contract_sha_for_id': return c['runtimeSha256'].encode()
                if function == 'forge_cutover_prepare':
                    MOD.common.write_new(d.record('service-0'), {'candidate': {'id': 'b' * 64}})
                return b''
            d.helper = Mock(side_effect=helper)
            with self.assertRaisesRegex(RuntimeError, 'candidate failed health'): d.upgrade_service(c, 0)
            self.assertNotIn('forge_cutover_promote', [x.args[0] for x in d.helper.call_args_list])
            self.assertFalse((d.backup / 'service-0.verified.json').exists())
            self.assertTrue(d.record('service-0').exists())

    def test_candidate_health_precedes_promotion_and_original_is_retained(self):
        m = manifest(); d = MOD.Deployment(m, json.dumps(m).encode())
        c = next(x for x in m['services'] if x['imageId'] != MOD.IMAGE)
        events = []
        with tempfile.TemporaryDirectory() as temp, patch.object(MOD.common, 'stable_contract_sha256', return_value='bound'):
            d.backup = Path(temp); d.records = d.backup / 'records'; d.records.mkdir()
            d.container = Mock(return_value={'ok': True}); d.inspect = Mock(return_value={}); d.service_template = Mock(return_value=None)
            d.role_ready = Mock(side_effect=lambda *a, **k: events.append('ready') or True)
            d.wait = lambda callback, _: callback()
            def helper(function, *args):
                events.append(function)
                if function == 'forge_cutover_contract_sha_for_id': return c['runtimeSha256'].encode()
                if function == 'forge_cutover_prepare':
                    MOD.common.write_new(d.record('service-0'), {'candidate': {'id': 'b' * 64}})
                return b''
            d.helper = Mock(side_effect=helper)
            result = d.upgrade_service(c, 0)
            self.assertLess(events.index('forge_cutover_activate'), len(events) - 1 - events[::-1].index('ready'))
            self.assertLess(len(events) - 1 - events[::-1].index('ready'), events.index('forge_cutover_promote'))
            self.assertEqual(result['id'], 'b' * 64)
            self.assertTrue(any(call.kwargs.get('running') is False for call in d.container.call_args_list))


if __name__ == '__main__': unittest.main()
