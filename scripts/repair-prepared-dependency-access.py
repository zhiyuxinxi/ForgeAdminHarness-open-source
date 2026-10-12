#!/usr/bin/env python3
"""Repair only the published forge-base dependency parent; no service restart."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys

PROJECT = Path('/srv/forge-delivery/projects/forge-base')
PARENT = PROJECT / 'verification/prepared-dependencies'
ROOT = PARENT / '2026.09.21.2-direct-dependencies'
DIGEST = '8574bf78c0e0480110c8814903e040e6a836960ffc6ec36fe313ca07518ec454'
UNIT = 'forge-host-verification@forge-base.service'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def inspect():
    require(PARENT.resolve() == PARENT and ROOT.resolve() == ROOT, 'Unexpected symlink')
    parent, root = PARENT.lstat(), ROOT.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and parent.st_gid == 983
            and stat.S_IMODE(parent.st_mode) in (0o2700, 0o2755), 'Parent preimage differs')
    require(stat.S_ISDIR(root.st_mode) and root.st_uid == 0
            and stat.S_IMODE(root.st_mode) == 0o555, 'Protected artifact differs')
    require(hashlib.sha256((ROOT / 'manifest.json').read_bytes()).hexdigest() == DIGEST,
            'Manifest binding differs')
    contract = json.loads((PROJECT / 'verification/host-contract.json').read_bytes())
    require(contract['preparedDependencies'] == {'root': str(ROOT), 'manifestSha256': DIGEST},
            'Host dependency binding differs')
    properties = subprocess.check_output(['systemctl', 'show', UNIT, '--property=User',
                                         '--property=Group', '--property=MainPID'], text=True)
    service = dict(line.split('=', 1) for line in properties.splitlines())
    require(service['User'] == 'forge' and service['Group'] == 'forgeops'
            and int(service['MainPID']) > 0, 'Host identity differs')
    return {'path': str(PARENT), 'uid': parent.st_uid, 'gid': parent.st_gid,
            'mode': oct(stat.S_IMODE(parent.st_mode)), 'inode': parent.st_ino,
            'hostPid': service['MainPID'], 'manifestSha256': DIGEST}


def verify_consumer():
    # Use the service UID/GID at the final published path, not root or staging.
    probe = '''import hashlib,json,os,pathlib,subprocess,sys
root=pathlib.Path(sys.argv[1])
assert hashlib.sha256((root/'manifest.json').read_bytes()).hexdigest()==sys.argv[2]
assert not os.access(root.parent,os.W_OK) and not os.access(root,os.W_OK)
bins=sorted(root.glob('*/node_modules/.pnpm/@esbuild+linux-x64@*/node_modules/@esbuild/linux-x64/bin/esbuild'))
assert bins, 'Published esbuild executable missing'
versions=[subprocess.check_output([str(p),'--version'],text=True,timeout=5).strip() for p in bins]
print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'esbuildVersions':versions,'writable':False}))
'''
    result = subprocess.run(['setpriv', '--reuid=1000', '--regid=983', '--clear-groups',
                             'python3', '-c', probe, str(ROOT), DIGEST],
                            capture_output=True, text=True, timeout=30)
    require(result.returncode == 0, 'Published Host consumer failed: ' + result.stderr[-1200:])
    return json.loads(result.stdout)


def run(action):
    before = inspect()
    if action == 'preflight':
        return {'status': 'ready', 'preimage': before, 'mutated': False}
    if action == 'deploy':
        PARENT.chmod(0o2755)
    after = inspect()
    require(after['mode'] == '0o2755', 'Parent permission repair missing')
    require(after['inode'] == before['inode'] and after['hostPid'] == before['hostPid'],
            'Directory or Host process changed')
    return {'status': 'passed', 'before': before, 'after': after,
            'consumer': verify_consumer(), 'dependencyTreeCopies': 0,
            'serviceRestarts': 0, 'businessModified': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['preflight', 'deploy', 'verify'])
    parser.add_argument('--bridge')
    parser.add_argument('--bridge-sha256')
    parser.add_argument('--remote', action='store_true')
    args = parser.parse_args()
    if args.remote:
        require(os.geteuid() == 0, 'Reviewed root execution required')
        print(json.dumps(run(args.action)))
        return 0
    bridge_path = Path(args.bridge)
    require(hashlib.sha256(bridge_path.read_bytes()).hexdigest() == args.bridge_sha256,
            'Reviewed SSH bridge changed')
    spec = importlib.util.spec_from_file_location('repair_transport', bridge_path)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    client = bridge.paramiko.SSHClient()
    client.load_host_keys(str(bridge.KNOWN_HOSTS))
    client.set_missing_host_key_policy(bridge.paramiko.RejectPolicy())
    secret = bridge.load_secret()
    try:
        client.connect(bridge.HOST, username=bridge.USER, key_filename=str(bridge.SSH_KEY),
                       allow_agent=False, look_for_keys=False, timeout=15)
        stdin, stdout, _ = client.exec_command(shlex.join([
            'sudo', '-S', '-p', '', '--', 'python3', '-', args.action, '--remote']), timeout=50)
        stdin.write(secret + '\n' + Path(__file__).read_text(encoding='utf-8'))
        stdin.flush()
        stdin.channel.shutdown_write()
        out, err = bridge.read_bounded_channel(stdout.channel, timeout_seconds=50)
        code = stdout.channel.recv_exit_status()
        require(secret.encode() not in out + err, 'Credential material refused')
        sys.stdout.write(out.decode('utf-8', 'replace'))
        sys.stderr.write(err.decode('utf-8', 'replace'))
        return code
    finally:
        client.close()


if __name__ == '__main__':
    raise SystemExit(main())
