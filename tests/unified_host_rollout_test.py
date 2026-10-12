import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('host_rollout', ROOT / 'scripts/upgrade-unified-host-runners.py')
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


def manifest():
    return json.loads((ROOT / 'docs/validation-evidence/2026-09-20-development-flow-host-manifest.json').read_text())


class HostRolloutTests(unittest.TestCase):
    def test_scope_refuses_other_hosts_and_busy_workpods(self):
        m = manifest(); MOD.validate_manifest(m)
        cases = []
        v = copy.deepcopy(m); v['projects'][0]['project'] = 'demoteam-phase2'; cases.append(v)
        v = copy.deepcopy(m); v['inactiveHosts']['demoteam-phase2'] = '1'; cases.append(v)
        v = copy.deepcopy(m); v['bundle']['stage'] = '/outside'; cases.append(v)
        v = copy.deepcopy(m); v['workpods'][0]['sessions'][0]['running'] = True; cases.append(v)
        v = copy.deepcopy(m); v['projects'][0]['override']['path'] = '/outside'; cases.append(v)
        for value in cases:
            with self.assertRaises(RuntimeError): MOD.validate_manifest(value)

    def test_contract_changes_only_revision_and_governance_path_preserving_bytes(self):
        p = manifest()['projects'][0]
        value = {'runnerRevision': p['runnerRevision'], 'toolchains': {'forgeGovernance': p['governance'], 'java': '/bin/java'},
                 'profiles': ['compile', 'startup'], 'processIsolation': {'driver': 'bubblewrap'}, 'limits': {'timeoutSeconds': 3600}}
        raw = (json.dumps(value, indent=2) + '\n').replace('\n', '\r\n').encode()
        changed = MOD.contract_bytes(raw, p)
        value['runnerRevision'] = MOD.REVISION
        value['toolchains']['forgeGovernance'] = (MOD.TARGET / 'bin/forge-governance').as_posix()
        self.assertEqual(json.loads(changed), value)
        self.assertEqual(changed.count(b'\r\n'), raw.count(b'\r\n'))
        with self.assertRaises(RuntimeError): MOD.contract_bytes(raw.replace(p['runnerRevision'].encode(), b'changed'), p)

    def test_busy_host_does_not_change_configuration_or_restart(self):
        m = manifest(); d = MOD.Deployment(m, json.dumps(m).encode())
        d.host_health = Mock(side_effect=RuntimeError('busy')); d.run = Mock()
        with patch.object(MOD.common, 'atomic_replace') as atomic:
            with self.assertRaisesRegex(RuntimeError, 'busy'): d.upgrade_host(m['projects'][0])
            atomic.assert_not_called(); d.run.assert_not_called()

    def test_failed_restart_retains_original_and_does_not_claim_verified(self):
        m = manifest(); p = m['projects'][0]; d = MOD.Deployment(m, json.dumps(m).encode())
        with tempfile.TemporaryDirectory() as temp, patch.object(MOD, 'TARGET', Path(temp) / 'versions' / MOD.VERSION):
            root = Path(temp); p['override']['path'] = str(root / 'service.d' / 'override.conf')
            config = root / p['project'] / 'verification'; config.mkdir(parents=True)
            raw = json.dumps({'runnerRevision': p['runnerRevision'], 'toolchains': {'forgeGovernance': p['governance']}}).encode()
            (config / 'host-contract.json').write_bytes(raw)
            d.backup = root / 'backup'; d.backup.mkdir()
            d.host_health = Mock(); d.project_idle = Mock(); d.check_binding = Mock()
            def run(argv, *args):
                if argv[:2] == ['systemctl', 'restart']: raise RuntimeError('restart failed')
            d.run = Mock(side_effect=run)
            with patch.object(MOD.w, 'ROOT', root):
                with self.assertRaisesRegex(RuntimeError, 'restart failed'): d.upgrade_host(p)
            self.assertEqual((d.backup / (p['project'] + '.host-contract.before')).read_bytes(), raw)
            self.assertFalse((d.backup / (p['project'] + '.verified.json')).exists())
            self.assertFalse(any('rollback' in call.args[0] for call in d.run.call_args_list))

    def test_systemd_override_cannot_change_isolation_or_environment(self):
        data = MOD.override_bytes(manifest()['node']).decode().splitlines()
        self.assertEqual(len(data), 3)
        self.assertEqual(data[:2], ['[Service]', 'ExecStart='])
        self.assertTrue(data[2].endswith('/versions/' + MOD.VERSION + '/lib/host-verification-runner.mjs'))


if __name__ == '__main__': unittest.main()
