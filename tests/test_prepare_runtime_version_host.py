import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('prepare_host', Path(__file__).parents[1] / 'scripts/prepare-runtime-version-host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


def snapshot():
    root = '/srv/forge-delivery/projects/sample'
    return {
        'projectSlug': 'sample', 'projectRoot': root, 'unitName': 'forge-host-verification@sample.service',
        'unitText': '[Service]\nUser=forge\nGroup=forgeops\nNoNewPrivileges=true\nProtectSystem=strict\n'
                    'EnvironmentFile=' + root + '/verification/host-runner.env\n'
                    'ReadOnlyPaths=' + root + '/taskspaces\nBindReadOnlyPaths=/protected/seed:/shared/seed\n'
                    'ReadWritePaths=' + root + '/verification\nReadWritePaths=' + root + '/acceptance/ipc-issuer\n'
                    '[Service]\nProtectKernelLogs=no\nCapabilityBoundingSet=~CAP_SYSLOG\n',
        'properties': {'User': 'forge', 'Group': 'forgeops', 'MainPID': '123', 'NoNewPrivileges': 'yes',
                       'ProtectSystem': 'strict', 'EnvironmentFiles': root + '/verification/host-runner.env (ignore_errors=no)',
                       'ReadWritePaths': root + '/verification ' + root + '/acceptance/ipc-issuer'},
        'environmentPath': root + '/verification/host-runner.env',
        'environment': {'VERIFICATION_PROJECT_SLUG': 'sample', 'VERIFICATION_CONTRACT': root + '/verification/host-contract.json',
                        'PROTECTED_ACCEPTANCE_ISSUER_SOCKET': root + '/acceptance/ipc-issuer/issuer.sock',
                        'HOST_SEMANTIC_REVIEW_KEY_FILE': '/protected/model-key', 'FORGE_DEVELOPMENT_MODE': 'direct'},
        'contractPath': root + '/verification/host-contract.json',
        'contract': {'projectSlug': 'sample', 'executionMode': 'host-toolchain', 'taskspacesRoot': root + '/taskspaces',
                     'profileCatalogVersion': '2026.09.03.22', 'runnerRevision': 'old', 'stateRoot': root + '/verification/host-state',
                     'toolchains': {'forgeGovernance': '/old/bin/forge-governance', 'node': '/bin/node'},
                     'dependencySeed': {'root': '/protected/seed', 'manifestSha256': 'a' * 64},
                     'preparedDependencies': {'root': '/protected/prepared', 'manifestSha256': 'b' * 64},
                     'testDatabase': {'taskId': 'fixed-task', 'passwordFile': '/protected/test-db-password'},
                     'inputScopes': {'mustPreserve': True}, 'limits': {'maxConcurrent': 1}},
        'runningCommand': ['/tools/node-v22.23.2-linux-x64/bin/node', '/host/versions/2026.10.12.3217/lib/host-verification-runner.mjs'],
        'bundleManifest': {'bundleVersion': '2026.10.12.3217'}, 'bundleManifestSha256': 'c' * 64,
    }


class PrepareHostTests(unittest.TestCase):
    def bundle(self):
        return {'bundleVersion': '2026.10.16.200', 'compatibleProfileCatalogVersions': ['2026.09.03.22'],
                'compatibleNodeMajors': [22], 'treeSha256': 'd' * 64}

    def test_isolated_paths_and_preserved_project_policy(self):
        original = snapshot()
        before = copy.deepcopy(original)
        plan = host.prepare(original, 'stable', 'r1', 'a' * 40, self.bundle(), {'FORGE_DEVELOPMENT_MODE': 'direct'})
        self.assertEqual(original, before)
        root = original['projectRoot']
        self.assertEqual(plan['paths']['stateRoot'], root + '/verification/runtime-versions/stable/r1/host-state')
        self.assertEqual(plan['paths']['issuerSocket'], root + '/acceptance/runtime-versions/stable/r1/ipc-issuer/issuer.sock')
        for key in ['taskspacesRoot', 'dependencySeed', 'preparedDependencies', 'testDatabase', 'inputScopes', 'limits']:
            self.assertEqual(plan['contract'][key], before['contract'][key])
        self.assertEqual(plan['environment']['HOST_SEMANTIC_REVIEW_KEY_FILE'], '/protected/model-key')
        self.assertIn('CapabilityBoundingSet=~CAP_SYSLOG', plan['unitText'])
        self.assertIn('BindReadOnlyPaths=/protected/seed:/shared/seed', plan['unitText'])
        self.assertIn('ReadWritePaths=\nReadWritePaths=' + plan['paths']['hostRoot'], plan['unitText'])
        self.assertFalse(plan['installed'])
        self.assertFalse(plan['started'])

    def test_other_version_cannot_share_state_or_ipc(self):
        stable = host.prepare(snapshot(), 'stable', 'r1', 'a' * 40, self.bundle())
        enhanced = host.prepare(snapshot(), 'enhanced', 'r1', 'b' * 40, self.bundle())
        for key in ['stateRoot', 'runnerSocket', 'sourceSocket', 'issuerSocket', 'bundleRoot']:
            self.assertNotEqual(stable['paths'][key], enhanced['paths'][key])

    def test_long_version_paths_use_private_short_socket_mounts(self):
        plan = host.prepare(snapshot(), 'enhanced', '20261016-3525c758', 'a' * 40, self.bundle())
        for env_key, path_key in [('VERIFICATION_RUNNER_SOCKET', 'runnerSocket'),
                                  ('VERIFICATION_SOURCE_SOCKET', 'sourceSocket'),
                                  ('PROTECTED_ACCEPTANCE_ISSUER_SOCKET', 'issuerSocket')]:
            address = plan['environment'][env_key]
            self.assertLess(len(address.encode()), 108)
            source = str(host.PurePosixPath(plan['paths'][path_key]).parent)
            target = str(host.PurePosixPath(address).parent)
            self.assertIn(f'BindPaths={source}:{target}\n', plan['unitText'])

    def test_fixed_branch_node_and_scope_mismatch_fail_closed(self):
        invalid = snapshot()
        invalid['contract']['taskspacesRoot'] = '/other-project/taskspaces'
        with self.assertRaisesRegex(ValueError, 'taskspace scope'):
            host.prepare(invalid, 'stable', 'r1', 'a' * 40, self.bundle())
        invalid = self.bundle()
        invalid['compatibleNodeMajors'] = [24]
        with self.assertRaisesRegex(ValueError, 'Node compatibility'):
            host.prepare(snapshot(), 'stable', 'r1', 'a' * 40, invalid)
        with self.assertRaisesRegex(ValueError, 'Invalid channel'):
            host.prepare(snapshot(), 'main', 'r1', 'a' * 40, self.bundle())

    def test_secret_values_and_path_traversal_are_rejected(self):
        invalid = snapshot()
        invalid['environment']['API_KEY'] = 'not-a-file-reference'
        with self.assertRaisesRegex(ValueError, 'secret file references'):
            host.prepare(invalid, 'stable', 'r1', 'a' * 40, self.bundle())
        with self.assertRaisesRegex(ValueError, 'Invalid channel or release'):
            host.prepare(snapshot(), 'stable', '../escape', 'a' * 40, self.bundle())


if __name__ == '__main__':
    unittest.main()
