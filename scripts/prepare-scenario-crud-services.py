#!/usr/bin/env python3
"""Start AI A's loopback-only, empty test services using already verified tools.

Business schema, users, migrations and test assertions are not created here.
Live database files intentionally do not enter the artifact lifecycle cache.
"""
import json
from pathlib import Path
import os
import pwd
import socket
import subprocess
import time

ROOT = Path('/var/tmp/forge-ai-a-crud-acceptance-20260929')
TASK = 'c-eb66d41f0a81df221bf197fa'
TOOLS = Path('/usr/local/lib/forge-scenario-testtools/acceptance-20260929')
MYSQL = TOOLS / 'mysql-bdf3fd53f552/mysqld'
REDIS = TOOLS / 'redis-8231d3786e10/redis-server'
PORTS = {'mysql': 13307, 'redis': 16379}


def wait_ready(proc, port, kind):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f'{kind} exited with {proc.returncode}; retained logs under {ROOT}')
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=1) as client:
                if kind == 'mysql':
                    packet = client.recv(256)
                    assert len(packet) > 5 and packet[4] == 10
                else:
                    client.sendall(b'*1\r\n$4\r\nPING\r\n')
                    assert client.recv(128) == b'+PONG\r\n'
                return
        except OSError:
            time.sleep(.1)
    raise RuntimeError(f'{kind} startup timeout; retained logs under {ROOT}')


def main():
    owner = subprocess.check_output(['systemctl', 'show', 'forge-host-verification@forge-base.service',
                                     '--property=User', '--value'], text=True).strip()
    account = pwd.getpwnam(owner)
    assert account.pw_uid != 0 and ROOT.resolve() == ROOT
    state = ROOT / 'runtime.json'
    if state.exists():
        observed = json.loads(state.read_text())
        assert observed['taskId'] == TASK and observed['status'] == 'ready'
        for kind, pid in observed['pids'].items():
            process_root = Path(f'/proc/{pid}')
            assert (process_root / 'cwd').resolve().is_relative_to(ROOT)
            assert (process_root / 'exe').resolve().is_relative_to(TOOLS)
            identity_fields = dict(line.split(':', 1) for line in (process_root / 'status').read_text().splitlines() if ':' in line)
            assert identity_fields['Groups'].split() == [], 'Owned service requires supplementary-group repair'
            assert set(identity_fields['Uid'].split()) == {str(account.pw_uid)}
            with socket.create_connection(('127.0.0.1', PORTS[kind]), timeout=2):
                pass
        print(json.dumps({'status': 'reused-owned-runtime', **observed}))
        return
    assert not ROOT.exists(), 'Unexpected pre-existing runtime directory; do not overwrite'
    for port in PORTS.values():
        with socket.socket() as guard:
            guard.bind(('127.0.0.1', port))
    ROOT.mkdir(mode=0o700)
    os.chown(ROOT, account.pw_uid, account.pw_gid)
    for name in ('mysql-data', 'mysql-tmp', 'redis-data'):
        p = ROOT / name
        p.mkdir(mode=0o700)
        os.chown(p, account.pw_uid, account.pw_gid)
    init_sql = ROOT / 'create-empty-test-database.sql'
    init_sql.write_text('CREATE DATABASE IF NOT EXISTS supplier_archive_test CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;\n')
    init_sql.chmod(0o600)
    os.chown(init_sql, account.pw_uid, account.pw_gid)
    mysql_args = [str(MYSQL), '--datadir=' + str(ROOT / 'mysql-data'),
                  '--socket=' + str(ROOT / 'mysql.sock'), '--port=' + str(PORTS['mysql']),
                  '--pid-file=' + str(ROOT / 'mysql.pid'), '--log-error=' + str(ROOT / 'mysql.err'),
                  '--tmpdir=' + str(ROOT / 'mysql-tmp'), '--skip-log-bin',
                  '--innodb-buffer-pool-size=64M', '--max-connections=30', '--performance-schema=OFF']
    identity = {'user': account.pw_uid, 'group': account.pw_gid, 'extra_groups': [], 'cwd': str(ROOT)}
    subprocess.run([mysql_args[0], '--initialize-insecure', *mysql_args[1:]],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=90, **identity)
    processes = {}
    observed = {'taskId': TASK, 'owner': owner, 'root': str(ROOT), 'ports': PORTS,
                'database': 'supplier_archive_test', 'pids': {}, 'createdAt': time.time(),
                'status': 'starting', 'businessSchemaCreated': False, 'businessTestsExecuted': False}
    try:
        commands = {'mysql': mysql_args + ['--init-file=' + str(init_sql)],
                    'redis': [str(REDIS), '--port', str(PORTS['redis']), '--dir', str(ROOT / 'redis-data'),
                              '--logfile', str(ROOT / 'redis.log'), '--pidfile', str(ROOT / 'redis.pid')]}
        for kind, args in commands.items():
            with (ROOT / (kind + '-process.log')).open('ab') as log:
                process = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT,
                                           start_new_session=True, **identity)
            processes[kind] = process
            observed['pids'][kind] = process.pid
            state.write_text(json.dumps(observed, indent=2) + '\n')
            state.chmod(0o600)
            wait_ready(process, PORTS[kind], kind)
        observed['status'] = 'ready'
        state.write_text(json.dumps(observed, indent=2) + '\n')
        print(json.dumps(observed))
    except Exception:
        for process in processes.values():
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        observed['status'] = 'failed-stopped'
        state.write_text(json.dumps(observed, indent=2) + '\n')
        raise


if __name__ == '__main__':
    main()
