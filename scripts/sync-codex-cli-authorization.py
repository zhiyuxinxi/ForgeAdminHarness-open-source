#!/usr/bin/env python3
"""Distribute CLI-managed ChatGPT access tokens; never copy a refresh token."""
import argparse
import base64
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import tempfile
import time
import uuid
from urllib.parse import urlsplit

CONFIG = Path('/etc/forge-delivery/codex-cli.json')
STATE_DIR = Path('/run/forge-codex-cli-authorization')
WORKER = Path(__file__).resolve().parent / 'lib/sync-codex-credentials.mjs'
REF = 'FORGE_CODEX_CLI_ACCESS_TOKEN'
AUTH_CLAIM = 'https://api.openai.com/auth'
SLUG = re.compile(r'[a-z0-9][a-z0-9-]{1,47}\Z')


class SyncError(Exception):
    """Only fixed, non-secret error codes may leave the process."""


def reject(code):
    raise SyncError(code)


def checked_path(path, directory=False, owner=None, private=False):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        reject('unsafe-path')
    info = path.lstat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        reject('unsafe-path')
    if not directory and info.st_nlink != 1:
        reject('unsafe-file')
    if owner is not None and (info.st_uid, info.st_gid) != owner:
        reject('unexpected-owner')
    if private and stat.S_IMODE(info.st_mode) & 0o077:
        reject('unsafe-permissions')
    return path


def read_config(config_path=None):
    configuration = checked_path(CONFIG if config_path is None else config_path, owner=(0, 0), private=True)
    if config_path is not None and stat.S_IMODE(configuration.lstat().st_mode) != 0o600:
        reject('unsafe-permissions')
    value = json.loads(configuration.read_text('utf8'))
    required = {'schemaVersion', 'deliveryRoot', 'helperImage', 'allowedOwners', 'privateProxyUrl'}
    if not required.issubset(value) or set(value) - required - {'newTaskspacesOnly'}:
        reject('invalid-config')
    if type(value.get('newTaskspacesOnly', False)) is not bool:
        reject('invalid-config')
    if value['schemaVersion'] != 1 or not re.fullmatch(r'sha256:[a-f0-9]{64}', value['helperImage']):
        reject('invalid-config')
    checked_path(value['deliveryRoot'], directory=True)
    owners = value['allowedOwners']
    if not isinstance(owners, list) or not owners or any(
        set(item) != {'uid', 'gid'} or any(type(item[k]) is not int or item[k] <= 0 for k in ('uid', 'gid'))
        for item in owners
    ):
        reject('invalid-config')
    proxy = value['privateProxyUrl']
    if not isinstance(proxy, str) or re.search(r'[\s\x00-\x1f\x7f\'"`$\\#]', proxy):
        reject('invalid-proxy')
    parsed = urlsplit(proxy)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or not parsed.port or parsed.fragment:
        reject('invalid-proxy')
    return value


def read_env(path):
    checked_path(path)
    result = {}
    for line in Path(path).read_text('utf8').splitlines():
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or key in result:
            reject('invalid-environment')
        result[key] = value
    if result.get(REF):
        reject('environment-shadows-reference')
    return result


def owner_of(env, allowed):
    try:
        owner = (int(env['HOST_UID']), int(env['HOST_GID']))
    except (KeyError, ValueError):
        reject('invalid-owner')
    if owner not in allowed:
        reject('unexpected-owner')
    return owner


def home_owner(path, expected_uid, allowed):
    info = checked_path(path, directory=True).stat()
    owner = (info.st_uid, info.st_gid)
    if owner[0] != expected_uid or owner not in allowed:
        reject('unexpected-owner')
    return owner


def discover(config, project_root=None):
    delivery = Path(config['deliveryRoot'])
    registry = checked_path(delivery / 'registry/projects.tsv')
    allowed = {(entry['uid'], entry['gid']) for entry in config['allowedOwners']}
    projects, targets, slugs = [], [], set()
    with registry.open(encoding='utf8', newline='') as stream:
        rows = list(csv.DictReader(stream, delimiter='\t'))
    for row in rows:
        slug = row.get('slug', '')
        if not SLUG.fullmatch(slug) or slug in slugs:
            reject('invalid-registry')
        slugs.add(slug)
        project = checked_path(delivery / 'projects' / slug, directory=True)
        if project_root is not None and str(project) != project_root:
            continue
        ops = checked_path(project / 'ops', directory=True)
        env = read_env(ops / 'project.env')
        owner = owner_of(env, allowed)
        projects.append({'path': str(project), 'owner': owner})
        legacy = project / 'dsh-home'
        if not config.get('newTaskspacesOnly', False) and (legacy.exists() or legacy.is_symlink()):
            actual_owner = home_owner(legacy, owner[0], allowed)
            targets.append({'path': str(legacy), 'kind': 'home', 'owner': actual_owner})
        spaces = project / 'taskspaces'
        if not spaces.exists():
            continue
        checked_path(spaces, directory=True)
        for task in sorted(spaces.iterdir()):
            if task.name.startswith('.'):
                continue  # Lifecycle's unpublished staging directories are not targets.
            if not SLUG.fullmatch(task.name):
                reject('invalid-task')
            checked_path(task, directory=True)
            metadata = json.loads(checked_path(task / 'metadata.json').read_text('utf8'))
            if metadata.get('schemaVersion') not in (1, 2) or metadata.get('projectSlug') != slug or metadata.get('taskId') != task.name:
                reject('task-identity-mismatch')
            task_env = read_env(task / 'task.env')
            if config.get('newTaskspacesOnly', False) and task_env.get('TASKSPACE_CODEX_CLI_MANAGED') != 'true':
                continue
            expected = {'PROJECT_SLUG': slug, 'TASKSPACE_ID': task.name, 'TASKSPACE_ROOT': str(task),
                        'PROJECT_COMPOSE_NAME': 'forge-' + slug,
                        'TASKSPACE_COMPOSE_PROJECT_NAME': 'forge-' + slug + '-task-' + task.name}
            if any(task_env.get(key) != value for key, value in expected.items()):
                reject('task-identity-mismatch')
            task_owner = owner_of(task_env, allowed)
            home = task / 'dsh-home'
            actual_owner = home_owner(home, task_owner[0], allowed)
            targets.append({'path': str(home), 'kind': 'home', 'owner': actual_owner})
    if not projects:
        reject('unregistered-project')
    return projects, targets


def validate_auth(result, now=None):
    now = time.time() if now is None else now
    if not isinstance(result, dict) or result.get('requiresOpenaiAuth') is not True:
        reject('cli-auth-unavailable')
    token, method = result.get('authToken'), result.get('authMethod')
    if token is None and method is None:
        return None, None
    if method != 'chatgpt' or not isinstance(token, str) or len(token) > 32768 or not re.fullmatch(r'[\w-]+\.[\w-]+\.[\w-]+', token, re.ASCII):
        reject('cli-chatgpt-auth-required')
    try:
        segment = token.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(segment + '=' * (-len(segment) % 4)))
        expires = claims['exp']
        account = claims[AUTH_CLAIM]['chatgpt_account_id']
        if type(expires) is not int or expires <= now + 60 or expires > 10**12 or not isinstance(account, str) or not account.strip():
            reject('cli-token-invalid')
    except (ValueError, KeyError, TypeError):
        reject('cli-token-invalid')
    return token, expires


def read_cli_auth():
    # getAuthStatus(false) still lets AuthManager refresh a near-expiry token.
    # No second refresh owner, auth-file reader, thread or model request exists here.
    command = ['/usr/sbin/runuser', '--user', 'forge', '--', '/home/forge/.local/bin/codex', 'app-server']
    env = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env=env, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    pending, used, stage = b'', 0, 1
    deadline = time.monotonic() + 45
    def send(value):
        process.stdin.write((json.dumps(value) + '\n').encode())
        process.stdin.flush()
    try:
        send({'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'forge_cli_authorization_sync', 'version': '1.0.0'}}})
        while time.monotonic() < deadline:
            if not selector.select(max(0, deadline - time.monotonic())):
                break
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                reject('cli-rpc-closed')
            pending += chunk
            used += len(chunk)
            if used > 1024 * 1024:
                reject('cli-rpc-limit')
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                response = json.loads(line)
                if response.get('id') != stage:
                    continue
                if 'error' in response or 'result' not in response:
                    reject('cli-rpc-failed')
                if stage == 1:
                    send({'method': 'initialized'})
                    send({'id': 2, 'method': 'getAuthStatus', 'params': {'includeToken': True, 'refreshToken': False}})
                    stage = 2
                else:
                    return validate_auth(response['result'])
        reject('cli-rpc-timeout')
    finally:
        selector.close()
        process.stdin.close()
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        process.stdout.close()


def atomic_private(path, data, owner):
    path = Path(path)
    if path.exists() or path.is_symlink():
        checked_path(path, owner=owner, private=True)
        if path.read_bytes() == data:
            return False
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        os.fchown(fd, *owner)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


def prepare_seeds(projects, config):
    seeds = []
    for project in projects:
        owner = project['owner']
        ops = Path(project['path']) / 'ops'
        seed_dir = ops / 'codex-cli'
        if not seed_dir.exists() and not seed_dir.is_symlink():
            seed_dir.mkdir(mode=0o700)
            os.chown(seed_dir, *owner)
        checked_path(seed_dir, directory=True, owner=owner, private=True)
        # Proxy configuration, unlike the access token, is an intentional project
        # configuration artifact. It never appears in process arguments or logs.
        content = ('TASKSPACE_DEFAULT_HTTPS_PROXY=' + config['privateProxyUrl']
                   + '\nTASKSPACE_CODEX_CLI_ENABLED=true\n').encode()
        if config.get('newTaskspacesOnly', False):
            content += b'TASKSPACE_CODEX_NEW_ONLY=true\n'
        atomic_private(ops / 'codex-cli.env', content, owner)
        seeds.append({'path': str(seed_dir), 'kind': 'seed', 'owner': owner})
    return seeds


def target_fingerprint(targets):
    values = []
    for target in targets:
        root = checked_path(target['path'], directory=True, owner=target['owner'])
        filename = root / ('credentials.yaml' if target['kind'] == 'seed' else '.credentials.yaml')
        info = None
        if filename.exists() or filename.is_symlink():
            checked_path(filename, private=True)
            item = filename.stat()
            if item.st_uid != target['owner'][0]:
                reject('unexpected-owner')
            info = [item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns]
        values.append([str(root), target['kind'], target['owner'], info])
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def run_batch(config, targets, token, configure_providers=False):
    groups = {}
    for target in targets:
        groups.setdefault(target['owner'], []).append(target)
    changed = 0
    for owner, stores in groups.items():
        name = 'forge-codex-auth-sync-' + uuid.uuid4().hex
        command = ['docker', 'run', '--rm', '-i', '--name', name, '--log-driver=none', '--pull=never', '--network=none', '--read-only',
                   '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', f'{owner[0]}:{owner[1]}',
                   '--workdir', '/opt/forge-harness-runtime', '--entrypoint', 'node',
                   '--mount', f'type=bind,src={WORKER},dst=/sync-codex-credentials.mjs,readonly']
        for index, target in enumerate(stores):
            command += ['--mount', f'type=bind,src={target["path"]},dst=/targets/{index}']
        command += [config['helperImage'], '/sync-codex-credentials.mjs']
        request = {'action': 'set' if token is not None else 'unset',
                   'configureProviders': configure_providers,
                   'targets': [{'path': f'/targets/{i}', 'kind': target['kind']} for i, target in enumerate(stores)]}
        if token is not None:
            request['token'] = token
        try:
            result = subprocess.run(command, input=json.dumps(request).encode(), stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, timeout=90, check=False)
        except subprocess.TimeoutExpired:
            # Only the unique helper created by this invocation is addressed.
            subprocess.run(['docker', 'kill', name], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=10, check=False)
            reject('credential-batch-timeout')
        try:
            response = json.loads(result.stdout)
            if result.returncode and response.get('state') in {'codex-provider-conflict', 'seed-not-exclusive', 'environment-shadows-reference'}:
                reject(response['state'])
            if result.returncode or response.get('state') != 'synced' or response.get('targets') != len(stores) or type(response.get('changed')) is not int:
                reject('credential-batch-failed')
            changed += response['changed']
        except (ValueError, AttributeError):
            reject('credential-batch-failed')
    return changed


def sync(config, project_root=None, configure_providers=False):
    projects, homes = discover(config, project_root)
    token, expires = read_cli_auth()  # A transport/refresh failure never clears refs.
    if configure_providers and token is None:
        reject('cli-login-required')
    targets = homes + prepare_seeds(projects, config)
    identity = hashlib.sha256((project_root or 'all').encode()).hexdigest()[:16]
    state_file = STATE_DIR / (identity + '.json')
    current = {'tokenHash': hashlib.sha256((token or '').encode()).hexdigest(),
               'targetHash': target_fingerprint(targets), 'image': config['helperImage']}
    previous = None
    if state_file.exists():
        checked_path(state_file, owner=(0, 0), private=True)
        previous = json.loads(state_file.read_text('utf8'))
    changed = 0
    if current != previous or configure_providers:
        changed = run_batch(config, targets, token, configure_providers)
        current['targetHash'] = target_fingerprint(targets)
        atomic_private(state_file, (json.dumps(current) + '\n').encode(), (0, 0))
    return {'state': 'authorized' if token is not None else 'logged-out', 'changed': changed,
            'targets': len(targets), 'expiresAt': expires}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', help='Private root-owned configuration; requires --project-root')
    parser.add_argument('--project-root')
    parser.add_argument('--configure-providers', action='store_true')
    args = parser.parse_args(argv)
    if args.config is not None and not args.project_root:
        parser.error('--config requires an explicit --project-root')
    return args


def main():
    args = parse_args()
    if os.geteuid() != 0:
        reject('root-required')
    import fcntl
    if not STATE_DIR.exists():
        STATE_DIR.mkdir(mode=0o700)
    checked_path(STATE_DIR, directory=True, owner=(0, 0), private=True)
    fd = os.open(STATE_DIR / 'sync.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            reject('sync-already-running')
        print(json.dumps(sync(read_config(args.config), args.project_root, args.configure_providers)))
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except SyncError as error:
        print(json.dumps({'state': str(error)}))
        raise SystemExit(2)
    except Exception:
        print('{"state":"sync-failed"}')
        raise SystemExit(2)
