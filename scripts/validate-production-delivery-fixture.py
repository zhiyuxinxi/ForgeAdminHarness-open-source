#!/usr/bin/env python3
"""Opt-in Linux/Docker platform fixture: initial install, historical restore, real upgrade.

No business project or human acceptance record is created. All images must already
exist locally and be supplied by immutable digest. Artifacts are retained.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request

from production_delivery_deploy import sha256, write_json
from production_delivery_worker import IMAGE


def run(args):
    return subprocess.run(list(map(str, args)), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, help='A new absolute directory; existing directories are rejected.')
    parser.add_argument('--mysql-image', required=True)
    parser.add_argument('--redis-image', required=True)
    parser.add_argument('--web-image', required=True, help='A fixed official nginx image with nginx on PATH.')
    parser.add_argument('--bind-host', default='127.0.0.1')
    parser.add_argument('--public-host')
    parser.add_argument('--initial-port', type=int, default=18980)
    parser.add_argument('--upgrade-port', type=int, default=18981)
    parser.add_argument('--resume', action='store_true', help='Continue only this existing platform fixture using fresh job identities.')
    parser.add_argument('--run-id', default='')
    args = parser.parse_args()
    if os.name != 'posix':
        raise SystemExit('This opt-in fixture requires Linux and a local Docker daemon.')
    root = Path(args.root)
    if not root.is_absolute() or (root.exists() and not args.resume) or any(p.is_symlink() for p in root.parents):
        raise SystemExit('--root must be a new absolute directory without symlink ancestors.')
    if args.run_id and not re.fullmatch(r'[a-z0-9-]{1,24}', args.run_id):
        raise SystemExit('Invalid fixture run identity.')
    first_id = 'initial' + ('-' + args.run_id if args.run_id else '')
    second_id = 'upgrade' + ('-' + args.run_id if args.run_id else '')
    if args.resume:
        original = json.loads((root / 'initial-validate-request.json').read_text())
        if not args.run_id or original.get('project') != 'platform-fixture' or original['source']['projectRoot'] != str(root / 'source'):
            raise SystemExit('Existing fixture identity mismatch; no files were changed.')
        if any((root / 'archive' / job).exists() for job in (first_id, second_id)):
            raise SystemExit('Retry requires fresh job ids; historical results cannot be overwritten.')
    if not all(IMAGE.fullmatch(value) for value in (args.mysql_image, args.redis_image, args.web_image)):
        raise SystemExit('All fixture images must be pinned by SHA256; floating tags are rejected.')
    inspected = [json.loads(run(['docker', 'image', 'inspect', value]))[0] for value in (args.mysql_image, args.redis_image, args.web_image)]
    if len({value['Architecture'] for value in inspected}) != 1 or any(value['Os'] != 'linux' for value in inspected):
        raise SystemExit('Fixture images must have the same Linux architecture.')
    root.mkdir(parents=True, mode=0o700, exist_ok=args.resume)
    workspace = root / 'source' / 'workspace'
    workspace.mkdir(parents=True, exist_ok=args.resume)
    for name in ('db', 'docs', 'web'):
        (workspace / name).mkdir(exist_ok=args.resume)
    (workspace / 'docs' / 'operation.md').write_text('# Platform fixture only\n\nThe web page displays the fixture version. This is not a business operation guide or production acceptance.\n')
    (workspace / 'db' / 'initial.sql').write_text('CREATE TABLE fixture_items (id INT PRIMARY KEY, label VARCHAR(64) NOT NULL);\nINSERT INTO fixture_items VALUES (1,\'historical-row\');\n')
    (workspace / 'web' / 'index.html').write_text('platform-fixture-v1\n')
    (workspace / 'web' / 'default.conf').write_text('server { listen 8080; location / { root /usr/share/nginx/html; } location = /health { return 200 "ok"; } }\n')
    run(['git', '-C', workspace, 'init'])
    run(['git', '-C', workspace, 'config', 'user.name', 'Platform Fixture'])
    run(['git', '-C', workspace, 'config', 'user.email', 'platform-fixture@invalid.local'])
    run(['git', '-C', workspace, 'add', '.'])
    run(['git', '-C', workspace, 'commit', '--allow-empty', '-m', 'Platform fixture initial version'])
    initial_commit = run(['git', '-C', workspace, 'rev-parse', 'HEAD']).decode().strip()
    recipe = {'schemaVersion': 1, 'mysql': {'image': inspected[0]['Id'], 'database': 'fixture'}, 'validationProxyImage': inspected[2]['Id'],
              'redis': {'image': inspected[1]['Id']}, 'database': {'initialSql': ['db/initial.sql'], 'migrations': []},
              'materials': {'operationGuide': 'docs/operation.md', 'resources': [{'name': 'nginx.conf', 'path': 'web/default.conf'}, {'name': 'index.html', 'path': 'web/index.html'}]},
              'application': {'services': [{'name': 'web', 'imageService': 'fixture-web',
                  'command': ['/bin/sh', '-c', "test -f /fixture-files/historical.txt || printf '%s' retained-file > /fixture-files/historical.txt; test -f /fixture-secrets/key.txt || printf '%s' fixture-only-private-key-v1 > /fixture-secrets/key.txt; exec nginx -g 'daemon off;'"],
                  'mounts': [
                  {'resource': 'nginx.conf', 'path': '/etc/nginx/conf.d/default.conf'},
                  {'resource': 'index.html', 'path': '/usr/share/nginx/html/index.html'},
                  {'resource': 'files', 'path': '/fixture-files'}, {'resource': 'secrets', 'path': '/fixture-secrets'}]}],
                  'entry': {'service': 'web', 'containerPort': 8080, 'path': '/'}, 'health': {'path': '/health', 'timeoutSeconds': 120}}}

    def request(job_id, commit, mode, port, base=None):
        result = {'schemaVersion': 1, 'action': 'validate', 'jobId': job_id, 'project': 'platform-fixture', 'releaseId': 'release-' + job_id,
                  'mode': mode, 'architecture': inspected[0]['Architecture'], 'jobRoot': str(root / 'archive' / job_id),
                  'archiveRoot': str(root / 'archive'), 'backupRoot': str(root / 'permanent-backup'), 'environmentRoot': str(root / 'environments'),
                  'bindHost': args.bind_host, 'publicHost': args.public_host or args.bind_host, 'port': port,
                  'source': {'projectRoot': str(root / 'source'), 'commit': commit, 'images': [{'service': 'fixture-web', 'id': inspected[2]['Id']}], 'services': ['fixture-web']},
                  'recipe': recipe}
        if base:
            result['base'] = base
        return result

    def worker(value):
        file = root / (value['jobId'] + '-' + value['action'] + '-request.json')
        write_json(file, value)
        command = [sys.executable, Path(__file__).with_name('production_delivery_worker.py'), '--request', file]
        result = subprocess.run(list(map(str, command)), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        (root / (value['jobId'] + '-' + value['action'] + '-worker.log')).write_bytes(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError('Platform fixture worker failed; retained evidence: ' + str(root))
        return json.loads(result.stdout)

    first_request = request(first_id, initial_commit, 'initial', args.initial_port)
    if args.resume:
        original_package = root / 'archive' / 'initial'
        first_request['reuseImageArchive'] = {'jobRoot': str(original_package), 'manifestSha256': sha256(original_package / 'package' / 'manifest.json')}
    first = worker(first_request)
    if first['status'] != 'success':
        raise RuntimeError('Initial fixture installation did not succeed.')
    (workspace / 'db' / 'V2.sql').write_text('ALTER TABLE fixture_items ADD COLUMN upgraded INT NOT NULL DEFAULT 0;\nUPDATE fixture_items SET upgraded=1 WHERE id=1;\n')
    (workspace / 'db' / 'initial.sql').write_text('CREATE TABLE fixture_items (id INT PRIMARY KEY, label VARCHAR(64) NOT NULL, upgraded INT NOT NULL DEFAULT 0);\nINSERT INTO fixture_items VALUES (1,\'historical-row\',1);\n')
    (workspace / 'web' / 'index.html').write_text('platform-fixture-v2\n')
    run(['git', '-C', workspace, 'add', '.'])
    run(['git', '-C', workspace, 'commit', '-m', 'Platform fixture forward migration'])
    target_commit = run(['git', '-C', workspace, 'rev-parse', 'HEAD']).decode().strip()
    recipe['database']['migrations'] = [{'id': 'V2', 'path': 'db/V2.sql'}]
    recipe['application']['services'][0]['command'][2] = recipe['application']['services'][0]['command'][2].replace('private-key-v1', 'private-key-v2')
    second_request = request(second_id, target_commit, 'upgrade', args.upgrade_port,
                             {'jobRoot': first_request['jobRoot'], 'manifestSha256': first['manifestSha256']})
    second_request['reuseImageArchive'] = {'jobRoot': first_request['jobRoot'], 'manifestSha256': first['manifestSha256']}
    second = worker(second_request)
    values = dict(line.split('=', 1) for line in (root / 'environments' / second_id / 'runtime.env').read_text().splitlines())
    query = run(['docker', 'exec', '--env', 'MYSQL_PWD=' + values['MYSQL_ROOT_PASSWORD'], second['environment']['id'] + '-mysql',
                 'mysql', '-uroot', '--batch', '--skip-column-names', 'fixture', '-e', 'SELECT CONCAT(label,\':\',upgraded) FROM fixture_items WHERE id=1']).decode().strip()
    if query != 'historical-row:1':
        raise RuntimeError('Historical row was not preserved and upgraded by the actual SQL package.')
    upgraded_runtime = root / 'environments' / second_id
    if (upgraded_runtime / 'files' / 'historical.txt').read_text() != 'retained-file' or (upgraded_runtime / 'secrets' / 'key.txt').read_text() != 'fixture-only-private-key-v1':
        raise RuntimeError('Historical files or private encryption material were not preserved by restore and upgrade.')
    host = '127.0.0.1' if args.bind_host == '0.0.0.0' else args.bind_host
    with urllib.request.urlopen(f'http://{host}:{args.upgrade_port}/', timeout=10) as response:
        if response.read().strip() != b'platform-fixture-v2':
            raise RuntimeError('The target offline application resources are not actually running.')
    stage_names = [item['stage'] for item in json.loads((root / 'archive' / second_id / 'progress.json').read_text())['stages']]
    if 'historical-application-healthy' not in stage_names:
        raise RuntimeError('Old-system health was not recorded before the real upgrade.')
    receipt = {'status': 'passed', 'scope': 'platform-fixture-only', 'humanAcceptance': False, 'formalProductionDelivery': False,
               'initial': first, 'upgrade': second, 'databaseProof': query, 'materialsRetained': True,
               'note': 'Both isolated environments remain running for inspection. Use their private stop requests to stop them; no cleanup or archive deletion is performed.'}
    receipt_path = root / ('fixture-result' + ('-' + args.run_id if args.run_id else '') + '.json')
    write_json(receipt_path, receipt)
    for value in (first_request, second_request):
        stop = dict(value, action='stop', stopAttemptId='fixture-stop-' + value['jobId'])
        write_json(root / (value['jobId'] + '-stop-request.json'), stop)
    print(json.dumps({'status': 'passed', 'receipt': str(receipt_path), 'initialUrl': first['environment']['url'],
                      'upgradeUrl': second['environment']['url'], 'scope': 'platform-fixture-only', 'humanAcceptance': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
