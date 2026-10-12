#!/usr/bin/env python3
"""Prepare only AI A's authenticated, IP-restricted temporary model route.

Uses the installed proxy binary and an anonymous in-memory configuration.
No source, business tests, shared proxy, or TaskSpace configuration is changed.
"""
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
import time
from urllib.parse import urlsplit, unquote

TASK = 'c-eb66d41f0a81df221bf197fa'
CONTAINER = 'forge-forge-base-task-' + TASK + '-harness-1'
ROOT = Path('/var/tmp/forge-ai-a-model-route-20260929')
TASKROOT = Path('/srv/forge-delivery/projects/forge-base/taskspaces') / TASK
PORT = 17899
HOST = '172.18.0.1'
BINARY = '/usr/bin/verge-mihomo'


def main():
    assert not ROOT.exists(), 'Existing owned route requires inspection, not duplicate preparation'
    task = json.loads((TASKROOT / 'metadata.json').read_bytes())
    assert task['taskId'] == TASK and task['actorId'] == 'liuhc' and task['status'] == 'active'
    container = json.loads(subprocess.check_output(['docker', 'inspect', CONTAINER]))[0]
    ip = container['NetworkSettings']['Networks']['forge-forge-base_application']['IPAddress']
    values = dict(line.split('=', 1) for line in (TASKROOT / 'task.env').read_text().splitlines() if '=' in line)
    old = urlsplit(values['TASKSPACE_HTTPS_PROXY'])
    assert old.scheme == 'http' and old.hostname == HOST and old.port == 17897
    assert old.username and old.password
    with socket.socket() as guard:
        guard.bind((HOST, PORT))
    account = pwd.getpwnam('forge')
    ROOT.mkdir(mode=0o700)
    os.chown(ROOT, account.pw_uid, account.pw_gid)
    config = {'port': PORT, 'allow-lan': True, 'bind-address': HOST,
              'lan-allowed-ips': [ip + '/32'], 'ipv6': False, 'mode': 'rule',
              'log-level': 'warning', 'dns': {'enable': False},
              'authentication': [unquote(old.username) + ':' + unquote(old.password)],
              'proxies': [{'name': 'owned-existing-upstream', 'type': 'http',
                           'server': '127.0.0.1', 'port': 7897}],
              'rules': ['DOMAIN,chatgpt.com,owned-existing-upstream', 'MATCH,REJECT']}
    fd = os.memfd_create('forge-ai-a-model-route', flags=0)
    os.fchown(fd, account.pw_uid, account.pw_gid)
    os.fchmod(fd, 0o600)
    os.write(fd, json.dumps(config).encode())
    identity = {'user': account.pw_uid, 'group': account.pw_gid, 'extra_groups': [],
                'cwd': str(ROOT), 'pass_fds': (fd,)}
    args = [BINARY, '-d', str(ROOT), '-f', f'/proc/self/fd/{fd}']
    state = {'taskId': TASK, 'status': 'preparing', 'port': PORT, 'allowedIp': ip,
             'upstream': '127.0.0.1:7897', 'binary': BINARY, 'createdAt': time.time(),
             'sharedProxyChanged': False, 'taskEnvironmentChanged': False,
             'configurationPersistence': 'anonymous-memory-only', 'previousPort': old.port}
    logpath = ROOT / 'process.log'
    logpath.touch(mode=0o600)
    os.chown(logpath, account.pw_uid, account.pw_gid)
    process = None
    try:
        with logpath.open('ab') as log:
            check = subprocess.run(args + ['-t'], stdout=log, stderr=subprocess.STDOUT,
                                   stdin=subprocess.DEVNULL, timeout=20, **identity)
            if check.returncode:
                raise RuntimeError('Isolated proxy configuration rejected; protected process.log retained')
            process = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT,
                                       stdin=subprocess.DEVNULL, start_new_session=True, **identity)
        state['pid'] = process.pid
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError('Isolated proxy exited; protected process.log retained')
            try:
                with socket.create_connection((HOST, PORT), timeout=.5):
                    break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('Isolated proxy listen timeout')
        state['status'] = 'listening-not-activated'
    except Exception:
        state['status'] = 'failed-stopped'
        if process is not None and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        raise
    finally:
        os.close(fd)
        file = ROOT / 'runtime.json'
        file.write_text(json.dumps(state, indent=2) + '\n')
        file.chmod(0o600)
    print(json.dumps(state))


if __name__ == '__main__':
    main()
