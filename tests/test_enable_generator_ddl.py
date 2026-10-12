import copy
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('generator_ddl_enable', ROOT / 'scripts/enable-generator-ddl.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GeneratorDdlEnableTests(unittest.TestCase):
    def test_release_fence_preserves_foreign_operation_and_releases_only_own(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            ops = root / 'ops'; ops.mkdir()
            (ops / 'project.env').write_text('NON_SECRET=test\n')
            broker = root / 'taskspaces/.broker'; broker.mkdir(parents=True)
            operation = 'generator-ddl-' + 'a' * 24
            with patch.object(module.os, 'chown', create=True), patch.object(module.os, 'fchown', create=True), patch.object(module.os, 'fchmod', create=True):
                module.release_fence(ops, 'fence-acquire', operation)
                before = (broker / 'release.lock/owner.json').read_bytes()
                with self.assertRaisesRegex(module.Refused, 'PROJECT_RELEASE_ACTIVE'):
                    module.release_fence(ops, 'fence-acquire', 'generator-ddl-' + 'b' * 24)
                with self.assertRaisesRegex(module.Refused, 'RELEASE_FENCE_OWNER_MISMATCH'):
                    module.release_fence(ops, 'fence-release', 'generator-ddl-' + 'b' * 24)
                self.assertEqual((broker / 'release.lock/owner.json').read_bytes(), before)
                module.release_fence(ops, 'fence-release', operation)
                self.assertFalse((broker / 'release.lock').exists())
                (broker / 'maintenance.json').write_text('{}')
                with self.assertRaisesRegex(module.Refused, 'PROJECT_MAINTENANCE_ACTIVE'):
                    module.release_fence(ops, 'fence-acquire', operation)

    def test_mapping_merge_preserves_other_services_and_is_idempotent(self):
        source = ('services:\n  forge-flow:\n    image: keep-flow\n  forge-admin:\n'
                  '    image: keep-admin\n    env_file:\n      - ${SHARED_SERVICES_ENV_FILE}\n'
                  '    environment:\n      MYSQL_DB: keep-schema\n      SPRING_PROFILES_ACTIVE: prod,custom\n'
                  '      SPRING_CONFIG_ADDITIONAL_LOCATION: optional:file:/custom.yml\n'
                  '    volumes:\n      - ../workspace/source.yml:/app/application-prod.yml:ro\n'
                  '  forge-app:\n    image: keep-app\nnetworks:\n  application: {}\n')
        environment = {'SPRING_PROFILES_ACTIVE': 'prod,custom',
                       'SPRING_CONFIG_ADDITIONAL_LOCATION': 'optional:file:/custom.yml'}
        result, wanted = module.patch_compose(source, environment)
        self.assertIn('prod,custom,generator-ddl', result)
        self.assertIn('optional:file:/custom.yml,' + module.LOCATION, result)
        self.assertTrue(result.startswith(source.split('  forge-admin:')[0]))
        self.assertEqual(result.split('  forge-app:')[1], source.split('  forge-app:')[1])
        self.assertIn('      MYSQL_DB: keep-schema\n', result)
        self.assertEqual(module.patch_compose(result, wanted, True)[0], result)
        self.assertEqual(result.count('./generator-ddl.env'), 1)

    def test_list_environment_preserves_entries_and_adds_missing_blocks(self):
        source = 'services:\n  forge-admin:\n    environment:\n      - KEEP=value\n      - SPRING_PROFILES_ACTIVE=custom\n  forge-app:\n    image: untouched\n'
        result, wanted = module.patch_compose(source, {'SPRING_PROFILES_ACTIVE': 'custom'})
        self.assertIn('      - KEEP=value\n', result)
        self.assertIn('      - SPRING_PROFILES_ACTIVE=custom,generator-ddl\n', result)
        self.assertEqual(module.patch_compose(result, wanted, True)[0], result)
        with self.assertRaisesRegex(module.Refused, 'INLINE_SECTION'):
            module.patch_compose('services:\n  forge-admin:\n    environment: {A: b}\n', {})

    def test_exact_schema_create_grants_allow_incomplete_resume_but_reject_other_rights(self):
        usage = "GRANT USAGE ON *.* TO `forge_base_ddl`@`192.0.2.12`"
        create = r"GRANT CREATE ON `forge\_forge\_base`.* TO `forge_base_ddl`@`192.0.2.12`"
        self.assertEqual(module.inspect_grants(usage + '\n' + create, 'forge_forge_base'), {'CREATE'})
        self.assertEqual(module.inspect_grants(usage, 'forge_forge_base', complete=False), set())
        for wrong in (create.replace('CREATE', 'CREATE, DROP'), create.replace(r'\_', '_'),
                      create + ' WITH GRANT OPTION', 'GRANT `writer`@`%` TO `forge_base_ddl`@`192.0.2.12`'):
            with self.assertRaises(module.Refused):
                module.inspect_grants(wrong, 'forge_forge_base')

    def test_projection_accepts_only_admin_configuration_changes(self):
        old = {'services': {'forge-admin': {'image': 'fixed', 'environment': {'OLD': 'preserved'}, 'volumes': []},
                            'forge-flow': {'image': 'unchanged'}}}
        new = copy.deepcopy(old)
        credentials = {'user': 'forge_base_ddl', 'password': 'test-only-not-a-credential'}
        wanted = {'SPRING_PROFILES_ACTIVE': 'prod,generator-ddl', 'SPRING_CONFIG_ADDITIONAL_LOCATION': module.LOCATION}
        new['services']['forge-admin']['environment'].update(wanted)
        new['services']['forge-admin']['environment'].update(GENERATOR_DDL_DB_USER=credentials['user'], GENERATOR_DDL_DB_PASSWORD=credentials['password'])
        config = Path('/srv/forge-delivery/projects/forge-base/ops/generator-ddl.yml')
        new['services']['forge-admin']['volumes'] = [{'type': 'bind', 'source': str(config), 'target': '/run/forge/generator-ddl.yml', 'read_only': True}]
        module.verify_projection(old, new, credentials, wanted, config)
        bad = copy.deepcopy(new); bad['services']['forge-flow']['image'] = 'changed'
        with self.assertRaisesRegex(module.Refused, 'NON_ADMIN'):
            module.verify_projection(old, bad, credentials, wanted, config)
        bad = copy.deepcopy(new); bad['services']['forge-admin']['environment']['OLD'] = 'changed'
        with self.assertRaisesRegex(module.Refused, 'ENVIRONMENT_MERGE'):
            module.verify_projection(old, bad, credentials, wanted, config)

    def test_plan_cannot_redirect_to_other_projects_or_databases(self):
        plan = json.loads((ROOT / 'docs/long-tasks/backend-audit-remediation-20261009/generator-ddl-activation-plan.json').read_text(encoding='utf-8'))
        module.validate_plan(plan)
        for field, value in [('schema', 'other_database'), ('dedicatedUser', 'root'), ('composeFile', '/tmp/compose.yaml')]:
            bad = copy.deepcopy(plan); bad['targets'][0][field] = value
            with self.assertRaises(module.Refused):
                module.validate_plan(bad)


if __name__ == '__main__':
    unittest.main()
