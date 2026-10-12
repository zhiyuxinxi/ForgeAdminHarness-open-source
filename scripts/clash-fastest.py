#!/usr/bin/env python3
"""Measure Clash subscription nodes on the server and select a usable low-latency exit."""
import argparse
import concurrent.futures
import copy
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.error
import urllib.request

MODEL_URL = 'https://chatgpt.com/backend-api/codex/responses'
CONFIG = '/home/forge/.config/forge-codex-proxy/config.yaml'
DATA = '/home/forge/.local/share/forge-codex-proxy'
SERVICE = 'forge-codex-proxy.service'
NOTICE_PREFIXES = ('剩余流量', '距离下次', '套餐到期', '订阅到期', '官网', '官方网站', '最新官网')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def parse_config(raw):
    # PyYAML is already installed on the server. Preserve lexical credentials:
    # unquoted REALITY short IDs otherwise change type/value across YAML runtimes.
    import yaml
    value = yaml.safe_load(raw)
    lexical = yaml.load(raw, Loader=yaml.BaseLoader)
    string_keys = {'short-id', 'password', 'uuid', 'private-key', 'public-key', 'token'}

    def preserve(parsed, source):
        if isinstance(parsed, dict) and isinstance(source, dict):
            for key in parsed:
                if key in string_keys and isinstance(source.get(key), str):
                    parsed[key] = source[key]
                else:
                    preserve(parsed[key], source.get(key))
        elif isinstance(parsed, list) and isinstance(source, list):
            for item, original in zip(parsed, source):
                preserve(item, original)
    preserve(value, lexical)
    require(isinstance(value, dict), 'Configuration must be a mapping')
    return value


def inventory(index_raw, files, subscription=None):
    index = parse_config(index_raw)
    nodes, summary, rejected = [], [], []
    for item in index.get('items', []):
        if item.get('type') not in ('local', 'remote'):
            continue
        uid, label = str(item['uid']), str(item.get('name', item['uid']))
        if subscription and subscription not in (uid, label):
            continue
        filename = item.get('file', '')
        require(filename in files, 'Missing cached subscription file: ' + uid)
        config = parse_config(files[filename])
        # Do not silently call the inline list "all nodes" if external providers exist.
        require(not config.get('proxy-providers'), 'Unexpanded proxy provider in ' + label)
        count, notices = 0, 0
        for number, original in enumerate(config.get('proxies', [])):
            node = copy.deepcopy(original)
            name = str(node.get('name', ''))
            if name.startswith(NOTICE_PREFIXES):
                notices += 1
                continue
            if not name or node.get('type') in ('direct', 'reject', 'dns'):
                rejected.append({'subscription': label, 'name': name, 'reason': 'not-proxy-node'})
                continue
            # Chained or file-based nodes require their source context; never test
            # a silently altered direct route or import unresolved local paths.
            if node.get('dialer-proxy') or any(k in node for k in ('private-key-file', 'certificate', 'certificate-path', 'private-key-path')):
                rejected.append({'subscription': label, 'name': name, 'reason': 'requires-source-context'})
                continue
            key = 'clash-fastest-' + digest((uid + ':' + str(number) + ':' + name).encode())[:16]
            node['name'] = key
            nodes.append({'key': key, 'subscription': label, 'subscriptionId': uid,
                          'name': name, 'config': node})
            count += 1
        summary.append({'id': uid, 'name': label, 'records': len(config.get('proxies', [])),
                        'testedNodes': count, 'noticeRecords': notices})
    require(summary, 'No matching subscriptions')
    require(nodes, 'No testable proxy nodes')
    return nodes, summary, rejected


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def write_private(path, raw):
    fd, pending = tempfile.mkstemp(prefix='.clash-fastest-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, path)
    finally:
        if os.path.exists(pending):
            os.unlink(pending)


def encoded(config):
    return (json.dumps(config, ensure_ascii=False, indent=2) + '\n').encode()


def command(argv, timeout=12):
    proc = subprocess.run(argv, capture_output=True, timeout=timeout)
    require(proc.returncode == 0, Path(argv[0]).name + ' failed; diagnostic SHA256=' + digest(proc.stdout + proc.stderr))
    return proc.stdout


class Controller:
    def __init__(self, port, secret, timeout=8):
        self.url = 'http://127.0.0.1:' + str(port)
        self.secret, self.timeout = secret, timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, path, data=None):
        req = urllib.request.Request(self.url + path, data=None if data is None else encoded(data),
                                     headers={'Authorization': 'Bearer ' + self.secret, 'Content-Type': 'application/json'},
                                     method='GET' if data is None else 'PUT')
        with self.opener.open(req, timeout=self.timeout) as response:
            raw = response.read()
            return json.loads(raw) if raw else {'status': response.status}

    def ready(self):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                return self.call('/version')
            except OSError:
                time.sleep(.15)
        raise RuntimeError('Local controller did not become ready')


def measure(args, nodes, live):
    with tempfile.TemporaryDirectory(prefix='clash-fastest-') as directory:
        work = Path(directory)
        # Reuse original databases via symlinks; no Geo database download/copy.
        for name in ('geoip.dat', 'geosite.dat', 'Country.mmdb'):
            source = Path(args.data) / name
            if source.exists():
                (work / name).symlink_to(source)
        port = free_port()
        assigned = {port}
        inbound = {}
        for node in nodes:
            node_port = free_port()
            while node_port in assigned:
                node_port = free_port()
            assigned.add(node_port)
            inbound[node['key']] = node_port
        secret = secrets.token_urlsafe(32)
        probe = {'mode': 'rule', 'log-level': 'silent', 'allow-lan': False,
                 'external-controller': '127.0.0.1:' + str(port), 'secret': secret,
                 'profile': {'store-selected': False}, 'geo-auto-update': False,
                 'proxies': [n['config'] for n in nodes], 'rules': ['MATCH,DIRECT'],
                 'listeners': [{'name': n['key'], 'type': 'mixed', 'listen': '127.0.0.1',
                                'port': inbound[n['key']], 'proxy': n['key']} for n in nodes]}
        probe.update({k: copy.deepcopy(live[k]) for k in
                      ('ipv6', 'global-client-fingerprint', 'unified-delay', 'tcp-concurrent', 'dns', 'hosts') if k in live})
        if probe.get('dns', {}).get('enable'):
            probe['dns'].update({'listen': '127.0.0.1:' + str(free_port()), 'respect-rules': False})
        config = work / 'config.json'
        write_private(config, encoded(probe))
        command([args.binary, '-t', '-d', str(work), '-f', str(config)])
        proc = subprocess.Popen([args.binary, '-d', str(work), '-f', str(config)],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            api = Controller(port, secret, args.timeout_ms / 1000 + 2)
            api.ready()
            def sample(node):
                values = []
                statuses = []
                for _ in range(args.samples):
                    try:
                        # Native URLTest uses HEAD. Use the same GET as the real
                        # proxy verification, including HTTP status and full time.
                        request = subprocess.run(['curl', '--silent', '--noproxy', '', '--proxy',
                            'http://127.0.0.1:' + str(inbound[node['key']]), '--max-time', str(args.timeout_ms / 1000),
                            '--output', '/dev/null', '--write-out', '%{http_code} %{time_total}', args.url],
                            capture_output=True, timeout=args.timeout_ms / 1000 + 1)
                        status, duration = request.stdout.decode().split()
                        statuses.append(status)
                        values.append(round(float(duration) * 1000, 3) if request.returncode == 0 and status in args.expected.split('/') else None)
                    except (OSError, ValueError, subprocess.TimeoutExpired):
                        statuses.append('error')
                        values.append(None)
                return {k: node[k] for k in ('key', 'name', 'subscription', 'subscriptionId')} | {
                    'samplesMs': values, 'httpStatuses': statuses,
                    'medianMs': statistics.median(values) if all(v is not None for v in values) else None}

            results = []
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
                futures = [pool.submit(sample, node) for node in nodes]
                for future in concurrent.futures.as_completed(futures):
                    results.append(future.result())
                    if len(results) % 12 == 0:
                        emit({'progress': len(results), 'total': len(nodes)})
            return sorted(results, key=lambda r: (r['medianMs'] is None, r['medianMs'] or 0, r['key']))
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=4)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=4)


def selected_config(live, node, group_name):
    result = copy.deepcopy(live)
    matches = [g for g in result.get('proxy-groups', []) if g.get('name') == group_name]
    require(len(matches) == 1, 'Target group missing or ambiguous')
    group = matches[0]
    require(group.get('type') in ('select', 'fallback'), 'Target group must be select or fallback')
    require(not group.get('use') and isinstance(group.get('proxies'), list), 'Target group must have explicit node members')
    if group_name == 'FORGE_CODEX_MODEL':
        require([r for r in result.get('rules', []) if group_name in r.split(',')] ==
                ['DOMAIN,chatgpt.com,FORGE_CODEX_MODEL'], 'Model group is used beyond the reviewed domain')
    existing = [p for p in result.get('proxies', []) if p.get('name') == node['key']]
    require(not existing or existing == [node['config']], 'Managed node changed since last selection')
    if not existing:
        result.setdefault('proxies', []).append(node['config'])
    group['proxies'] = [node['key']] + [name for name in group['proxies'] if name != node['key']]
    return result


def apply_selection(args, raw, live, node):
    config = Path(args.config)
    info = config.lstat()
    require(config.is_file() and not config.is_symlink() and info.st_nlink == 1
            and info.st_uid == os.getuid() and info.st_mode & 0o777 == 0o600,
            'Run as the owner of the private proxy configuration')
    require(live.get('mode') == 'rule', 'Proxy must be in rule mode')
    require(not any(live.get(k) for k in ('external-controller', 'external-controller-unix', 'external-controller-tls', 'secret')),
            'Existing controller configuration requires explicit integration')
    pid = int(command(['systemctl', 'show', args.service, '-p', 'MainPID', '--value']).strip())
    require(pid > 0, 'Proxy service is stopped')
    argv = Path('/proc/' + str(pid) + '/cmdline').read_bytes().split(b'\0')
    require(b'-f' in argv and argv[argv.index(b'-f') + 1] == os.fsencode(args.config)
            and b'-d' in argv and argv[argv.index(b'-d') + 1] == os.fsencode(args.data), 'Service uses a different configuration')
    environment = Path('/proc/' + str(pid) + '/environ').read_bytes().split(b'\0')
    require(not any(v.split(b'=', 1)[0] in (b'CLASH_CONFIG_STRING', b'CLASH_CONFIG_FILE', b'CLASH_HOME_DIR') and v.partition(b'=')[2]
                    for v in environment), 'Service has an environment configuration override')
    ports = {live.get('mixed-port'), live.get('port'), live.get('socks-port')}
    ports.update(v.get('port') for v in live.get('listeners', []))
    filters = ' or '.join('sport = :' + str(int(p)) for p in ports if p)
    require(filters, 'Cannot determine proxy client listeners')
    # HUP reloads the whole configuration. Do not interrupt an active conversation.
    require(not command(['ss', '-Htn', 'state', 'established', '( ' + filters + ' )']).strip(),
            'Proxy has active requests; ranking is saved, selection has not changed')
    require(config.read_bytes() == raw, 'Live configuration changed during measurement')
    result = selected_config(live, node, args.group)
    final = encoded(result)
    port, secret = free_port(), secrets.token_urlsafe(32)
    temporary = {**result, 'external-controller': '127.0.0.1:' + str(port), 'secret': secret}
    backup = config.parent / ('clash-fastest-backup-' + time.strftime('%Y%m%dT%H%M%S') + '-' + secrets.token_hex(3) + '.json')
    changed = False
    try:
        with tempfile.TemporaryDirectory(prefix='clash-fastest-check-', dir=config.parent) as directory:
            candidate = Path(directory) / 'config.json'
            write_private(candidate, encoded(temporary))
            command([args.binary, '-t', '-d', args.data, '-f', str(candidate)])
        write_private(backup, raw)
        write_private(config, encoded(temporary))
        changed = True
        os.kill(pid, signal.SIGHUP)
        api = Controller(port, secret)
        api.ready()
        # /version only proves the controller is reachable. Complete the native
        # reload before selecting from groups that SIGHUP may still be replacing.
        api.call('/configs?force=true', {'payload': encoded(temporary).decode()})
        route = '/proxies/' + urllib.parse.quote(args.group, safe='')
        api.call(route, {'name': node['key']})
        initial_selected = api.call(route).get('now')
        require(initial_selected == node['key'], 'Runtime selection did not match; actual=' + str(initial_selected))
        # Remove temporary pin by reloading the final config (fallback priority
        # persists as the first member; select uses the existing selection store).
        if next(g for g in result['proxy-groups'] if g['name'] == args.group)['type'] == 'select':
            require(result.get('profile', {}).get('store-selected') is True, 'Selection persistence is disabled')
            time.sleep(.3)
        # SIGHUP is asynchronous; a controller being reachable can still mean
        # the old configuration. The native reload response is the completion.
        api.call('/configs?force=true', {'payload': encoded(temporary).decode()})
        selected_after_reload = api.call(route).get('now')
        require(selected_after_reload == node['key'], 'Selection did not survive configuration reload; actual=' + str(selected_after_reload))
        write_private(config, final)
        os.kill(pid, signal.SIGHUP)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=.2):
                    time.sleep(.1)
            except OSError:
                break
        else:
            raise RuntimeError('Temporary controller did not close')
        require(config.read_bytes() == final, 'Final configuration changed unexpectedly')
        require(int(command(['systemctl', 'show', args.service, '-p', 'MainPID', '--value']).strip()) == pid,
                'Proxy service identity changed')
        # Real consumer request follows the production rules and listener.
        require(live.get('mixed-port'), 'No loopback mixed-port for consumer verification')
        http = command(['curl', '--silent', '--noproxy', '', '--proxy', 'http://127.0.0.1:' + str(live['mixed-port']),
                        '--max-time', str(args.timeout_ms / 1000 + 2), '--output', '/dev/null',
                        '--write-out', '%{http_code}', args.url], timeout=args.timeout_ms / 1000 + 4).decode()
        require(http in args.expected.split('/'), 'Production request returned HTTP ' + http)
        return {'changed': final != raw, 'runtimeSelected': node['name'], 'group': args.group,
                'consumerStatus': http, 'pid': pid, 'beforeSha256': digest(raw), 'afterSha256': digest(final),
                'backup': str(backup), 'controllerClosed': True, 'selectionSurvivedReload': True}
    except BaseException:
        if changed:
            write_private(config, raw)
            os.kill(pid, signal.SIGHUP)
        raise


def server_run(args, payload=None):
    require(args.url.startswith('https://'), 'Use an HTTPS measurement target')
    require(1 <= args.samples <= 5 and 1 <= args.concurrency <= 12 and 500 <= args.timeout_ms <= 30000, 'Invalid measurement limits')
    require(args.rank >= 1 and args.top >= 1, 'rank/top must be positive')
    require(all(x.isdigit() and 100 <= int(x) <= 599 for x in args.expected.split('/')), 'Expected status must be a code or slash-separated codes')
    if payload is None:
        source = Path(args.profiles_home)
        payload = {'index': (source / 'profiles.yaml').read_text(encoding='utf-8-sig'),
                   'files': {p.name: p.read_text(encoding='utf-8-sig') for p in (source / 'profiles').glob('*.yaml')}}
    nodes, subscriptions, excluded = inventory(payload['index'], payload['files'], args.subscription)
    emit({'subscriptions': subscriptions, 'excluded': excluded, 'target': args.url, 'samplesPerNode': args.samples})
    raw = Path(args.config).read_bytes()
    live = parse_config(raw)
    source_hash = digest(encoded([n['config'] for n in nodes]))
    started = time.monotonic()
    if args.use_result:
        saved = json.loads(Path(args.use_result).read_bytes())
        require(saved.get('sourceSha256') == source_hash and saved.get('target') == args.url and saved.get('method') == 'GET'
                and saved.get('expected') == args.expected and saved.get('samples') == args.samples
                and 0 <= time.time() - saved.get('measuredAtEpoch', 0) <= 900,
                'Saved measurement is stale or belongs to different nodes/target/settings')
        results = saved['results']
    else:
        results = measure(args, nodes, live)
    ranked = [r for r in results if r['medianMs'] is not None]
    selected = ranked[args.rank - 1] if args.rank <= len(ranked) else None
    report = {'measuredAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'target': args.url,
              'measuredAtEpoch': saved['measuredAtEpoch'] if args.use_result else time.time(),
              'sourceSha256': source_hash, 'expected': args.expected, 'samples': args.samples, 'method': 'GET',
              'elapsedSeconds': round(time.monotonic() - started, 3), 'subscriptions': subscriptions,
              'tested': len(results), 'passed': len(ranked), 'excluded': excluded,
              'rank': args.rank, 'selected': selected, 'results': results, 'applied': False}
    destination = Path(args.result)
    destination.parent.mkdir(parents=True, exist_ok=True)
    write_private(destination, encoded(report))
    emit({'ranking': ranked[:args.top], 'selected': selected, 'report': str(destination), 'elapsedSeconds': report['elapsedSeconds']})
    require(selected, 'Not enough nodes passed every sample; failure report saved, live configuration is unchanged')
    if not args.check_only:
        # Omitted/unhandled nodes must not be disguised as an exhaustive win.
        require(not excluded, 'Some nodes require source context; report saved, use --check-only until resolved')
        require(args.group != 'FORGE_CODEX_MODEL' or urllib.parse.urlparse(args.url).hostname == 'chatgpt.com',
                'Model selection must be measured against chatgpt.com; other targets support --check-only')
        node = next(n for n in nodes if n['key'] == selected['key'])
        report['switch'] = apply_selection(args, raw, live, node)
        report['applied'] = True
        write_private(destination, encoded(report))
        emit({'applied': True, 'switch': report['switch']})
    return report


def remote_run(args):
    # One local invocation, measurement on the target server. No local proxy switch,
    # subscription refresh, core install, or secret-bearing command arguments.
    import paramiko
    source = Path(args.profiles_home)
    payload = {'script': Path(__file__).read_text(encoding='utf-8'),
               'index': (source / 'profiles.yaml').read_text(encoding='utf-8-sig'),
               'files': {p.name: p.read_text(encoding='utf-8-sig') for p in (source / 'profiles').glob('*.yaml')},
               'args': dict(vars(args))}
    payload['args']['server'] = None
    client = paramiko.SSHClient()
    client.load_host_keys(args.known_hosts)
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(args.server, username=args.user, key_filename=args.ssh_key,
                   allow_agent=False, look_for_keys=False, timeout=10)
    try:
        bootstrap = "import json,sys; p=json.load(sys.stdin); exec(compile(p['script'],'clash-fastest.py','exec'),{'__name__':'__main__','REMOTE_PAYLOAD':p})"
        import shlex
        stdin, stdout, stderr = client.exec_command(shlex.join(['python3', '-c', bootstrap]))
        stdin.write(json.dumps(payload))
        stdin.channel.shutdown_write()
        for line in stdout:
            print(line.rstrip(), flush=True)
        error = stderr.read()
        code = stdout.channel.recv_exit_status()
        require(not error, 'Remote error; SHA256=' + digest(error))
        return code
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    local_windows = os.name == 'nt'
    default_profiles = str(Path(os.environ.get('APPDATA', str(Path.home() / '.local/share'))) / 'io.github.clash-verge-rev.clash-verge-rev')
    parser.add_argument('--server', default='192.0.2.12' if local_windows else None)
    parser.add_argument('--user', default='forge')
    parser.add_argument('--ssh-key', default=str(Path.home() / '.ssh/id_ed25519_forge_delivery'))
    parser.add_argument('--known-hosts', default=str(Path.home() / '.ssh/known_hosts'))
    parser.add_argument('--profiles-home', default=default_profiles)
    parser.add_argument('--config', default=CONFIG)
    parser.add_argument('--data', default=DATA)
    parser.add_argument('--service', default=SERVICE)
    parser.add_argument('--binary', default='/usr/bin/verge-mihomo')
    parser.add_argument('--group', default='FORGE_CODEX_MODEL', help='Default affects chatgpt.com only')
    parser.add_argument('--url', default=MODEL_URL)
    parser.add_argument('--expected', default='405', help='Expected HTTP code, e.g. 204 or 200/204')
    parser.add_argument('--samples', type=int, default=2)
    parser.add_argument('--timeout-ms', type=int, default=5000)
    parser.add_argument('--concurrency', type=int, default=6)
    parser.add_argument('--subscription', help='Exact subscription name or UID')
    parser.add_argument('--rank', type=int, default=1, help='Select Nth usable node (1=fastest)')
    parser.add_argument('--top', type=int, default=10)
    parser.add_argument('--check-only', action='store_true', help='Measure/rank only; do not change the live proxy')
    parser.add_argument('--use-result', help='Reuse an unchanged report from the last 15 minutes; no repeat measurement')
    parser.add_argument('--result', default='/home/forge/.local/state/forge-clash-fastest/latest.json')
    payload = globals().get('REMOTE_PAYLOAD')
    args = argparse.Namespace(**payload['args']) if payload else parser.parse_args()
    try:
        if args.server:
            return remote_run(args)
        server_run(args, payload)
        return 0
    except Exception as error:
        # Exception bodies from YAML/HTTP/core may contain tokens; only our explicit
        # RuntimeError messages are public. Keep raw configs out of stdout/logs.
        emit({'ok': False, 'error': str(error) if isinstance(error, RuntimeError) else type(error).__name__,
              'httpStatus': error.code if isinstance(error, urllib.error.HTTPError) else None})
        return 1


if __name__ == '__main__':
    sys.exit(main())
