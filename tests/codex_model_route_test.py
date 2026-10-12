import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('model_route', Path(__file__).resolve().parents[1] / 'scripts/configure-codex-model-route.py')
route = importlib.util.module_from_spec(spec)
spec.loader.exec_module(route)


class ModelRouteTest(unittest.TestCase):
    def setUp(self):
        self.config = {'mixed-port': 7897, 'listeners': [{'name': 'existing', 'users': [{'username': 'fixture', 'password': 'preserved'}]}],
                       'dns': {'enable': True, 'nameserver-policy': {'chatgpt.com': ['fixture-dns']}},
                       'proxies': [{'name': name, 'type': 'trojan', 'password': 'fixture-secret'} for name in route.NODES],
                       'proxy-groups': [{'name': 'existing', 'type': 'select', 'proxies': ['DIRECT']}],
                       'rules': ['DOMAIN,chatgpt.com,' + route.NODES[0], 'DOMAIN,example.com,existing', 'MATCH,DIRECT']}

    def test_only_model_domain_and_its_group_change(self):
        result = json.loads(route.candidate(json.dumps(self.config).encode()))
        expected = copy.deepcopy(self.config)
        expected['rules'][0] = 'DOMAIN,chatgpt.com,' + route.GROUP
        expected['proxy-groups'].append(route.fallback_group())
        self.assertEqual(result, expected)
        self.assertEqual(result['proxy-groups'][-1]['expected-status'], '405')
        self.assertEqual(result['proxy-groups'][-1]['interval'], 10)
        raw = json.dumps(result, indent=4).encode()
        self.assertEqual(route.candidate(raw), raw, 'An already aligned candidate preserves exact bytes.')

    def test_initial_configuration_adds_only_the_exact_domain(self):
        self.config['rules'].pop(0)
        result = json.loads(route.candidate(json.dumps(self.config).encode()))
        self.assertEqual(result['rules'][1:], self.config['rules'])
        self.assertEqual(result['rules'][0], 'DOMAIN,chatgpt.com,' + route.GROUP)

    def test_existing_reviewed_group_only_shortens_periodic_health_interval(self):
        config = json.loads(route.candidate(json.dumps(self.config).encode()))
        config['proxy-groups'][-1]['interval'] = 60
        expected = copy.deepcopy(config)
        expected['proxy-groups'][-1]['interval'] = 10
        raw = json.dumps(config, ensure_ascii=False, indent=2).encode()
        result = route.candidate(raw)
        self.assertEqual(json.loads(result), expected)
        self.assertEqual(route.candidate(result), result)
        for key, value in [('timeout', 9000), ('max-failed-times', 2), ('interval', 30), ('lazy', True)]:
            conflicting = copy.deepcopy(config)
            conflicting['proxy-groups'][-1][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                route.candidate(json.dumps(conflicting).encode())

    def test_missing_node_and_conflicting_group_are_not_overwritten(self):
        for change in ('missing', 'group', 'other-domain', 'duplicate-route'):
            config = copy.deepcopy(self.config)
            if change == 'missing':
                config['proxies'].pop()
            elif change == 'group':
                config['proxy-groups'].append({'name': route.GROUP, 'type': 'select'})
            elif change == 'other-domain':
                config['rules'].insert(0, 'DOMAIN,example.org,' + route.GROUP)
            else:
                config['rules'].insert(0, config['rules'][0])
            raw = json.dumps(config).encode()
            with self.subTest(change=change), self.assertRaises(ValueError):
                route.candidate(raw)


if __name__ == '__main__':
    unittest.main()
