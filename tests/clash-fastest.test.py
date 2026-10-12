import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('fastest', Path(__file__).resolve().parents[1] / 'scripts/clash-fastest.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class ClashFastestTests(unittest.TestCase):
    def test_credentials_keep_lexical_values(self):
        value = mod.parse_config('proxies:\n- name: demo\n  type: vless\n  password: 000123\n  reality-opts:\n    short-id: 01234567\n')
        self.assertEqual(value['proxies'][0]['password'], '000123')
        self.assertEqual(value['proxies'][0]['reality-opts']['short-id'], '01234567')

    def test_all_subscriptions_and_same_named_nodes(self):
        index = 'items:\n- {uid: a, name: first, type: remote, file: a.yaml}\n- {uid: b, name: second, type: remote, file: b.yaml}\n'
        files = {'a.yaml': 'proxies: [{name: Japan, type: ss, server: a}]',
                 'b.yaml': 'proxies: [{name: Japan, type: ss, server: b}]'}
        nodes, summary, excluded = mod.inventory(index, files)
        self.assertEqual(len(nodes), 2)
        self.assertNotEqual(nodes[0]['key'], nodes[1]['key'])
        self.assertEqual(len(summary), 2)
        self.assertEqual(excluded, [])
        selected, _, _ = mod.inventory(index, files, 'second')
        self.assertEqual(selected[0]['config']['server'], 'b')

    def test_missing_subscription_never_becomes_all_passed(self):
        index = 'items: [{uid: a, name: first, type: remote, file: missing.yaml}]'
        with self.assertRaisesRegex(RuntimeError, 'Missing cached subscription'):
            mod.inventory(index, {})

    def test_switch_preserves_other_consumers(self):
        live = {'proxies': [{'name': 'old', 'type': 'ss'}],
                'proxy-groups': [{'name': 'FORGE_CODEX_MODEL', 'type': 'fallback', 'proxies': ['old'], 'interval': 10},
                                 {'name': 'other', 'type': 'select', 'proxies': ['old']}],
                'rules': ['DOMAIN,chatgpt.com,FORGE_CODEX_MODEL', 'MATCH,other'],
                'dns': {'enable': True}, 'listeners': [{'port': 17897, 'users': [{'username': 'u', 'password': 'secret'}]}]}
        node = {'key': 'new', 'config': {'name': 'new', 'type': 'ss'}}
        result = mod.selected_config(live, node, 'FORGE_CODEX_MODEL')
        for key in ('rules', 'dns', 'listeners'):
            self.assertEqual(result[key], live[key])
        self.assertEqual(result['proxy-groups'][1], live['proxy-groups'][1])
        self.assertEqual(result['proxy-groups'][0]['proxies'], ['new', 'old'])
        self.assertEqual(live['proxy-groups'][0]['proxies'], ['old'])
        self.assertEqual(mod.selected_config(result, node, 'FORGE_CODEX_MODEL'), result)


if __name__ == '__main__':
    unittest.main()
