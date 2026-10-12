#!/usr/bin/env python3
"""Prepare a private candidate for the existing model proxy; never restart it."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path


GROUP = 'FORGE_CODEX_MODEL'
NODES = ('🇯🇵 日本直连Pro', '🇯🇵 日本直连HY2-01')
TARGET = 'https://chatgpt.com/backend-api/codex/responses'


def fallback_group():
    return {'name': GROUP, 'type': 'fallback', 'proxies': list(NODES),
            'url': TARGET, 'expected-status': '405', 'interval': 10,
            'timeout': 5000, 'lazy': False, 'max-failed-times': 1}


def candidate(raw):
    original = json.loads(raw)
    value = copy.deepcopy(original)
    names = [node['name'] for node in value.get('proxies', [])]
    if any(names.count(name) != 1 for name in NODES):
        raise ValueError('The two reviewed model proxy nodes must exist exactly once.')
    rules = value['rules']
    matches = [i for i, rule in enumerate(rules) if rule.startswith('DOMAIN,chatgpt.com,')]
    if len(matches) > 1:
        raise ValueError('Ambiguous model-domain route; retain the original configuration.')
    route = 'DOMAIN,chatgpt.com,' + GROUP
    for rule in rules:
        if GROUP in rule.split(',') and rule != route:
            raise ValueError('The model group is referenced outside the reviewed domain.')
    groups = value.setdefault('proxy-groups', [])
    existing = [group for group in groups if group.get('name') == GROUP]
    desired_group = fallback_group()
    previous_group = {**desired_group, 'interval': 60}
    if len(existing) > 1 or (existing and existing[0] not in (desired_group, previous_group)):
        raise ValueError('An unrelated proxy group already uses the model group name.')
    if not existing:
        groups.append(desired_group)
    elif existing[0] == previous_group:
        existing[0]['interval'] = desired_group['interval']
    if matches:
        rules[matches[0]] = route
    else:
        rules.insert(0, route)
    if value == original:
        return raw
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        parser.error('Output must be a separate reviewed candidate, not the live input.')
    raw = args.input.read_bytes()
    result = candidate(raw)
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(result)
    print(json.dumps({'changed': result != raw,
                      'sourceSha256': hashlib.sha256(raw).hexdigest(),
                      'candidateSha256': hashlib.sha256(result).hexdigest(),
                      'serviceChanged': False}))


if __name__ == '__main__':
    main()
