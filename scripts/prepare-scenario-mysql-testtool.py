#!/usr/bin/env python3
"""Prepare pinned, read-only MySQL binaries for isolated Host test processes.

Does not start a database, alter a Host service, or change business source.
The existing artifact lifecycle executor must already be staged in control/.
"""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path('/usr/local/lib/forge-scenario-testtools/acceptance-20260929')
IMAGE = 'sha256:bdf3fd53f552ba36b7e6bc84a865075a629f411cd9594ce8bfd015351f7ef0ab'
RESOURCE = ROOT / 'mysql-bdf3fd53f552'
NODE = '/srv/forge-delivery/canary/forge-skills-20260903/toolchains/versions/node-v22.23.2-linux-x64/bin/node'
CONTAINER = 'forge-ai-a-mysql-extract-20260929'
TOOL_POLICY_VERSION = 3


def run(argv):
    return subprocess.check_output(argv, text=True, stderr=subprocess.STDOUT, timeout=90).strip()


def write_wrapper():
    wrapper = RESOURCE / 'mysqld'
    wrapper.write_text('#!/bin/sh\nset -eu\nroot="' + str(RESOURCE) + '"\n'
                       'exec "$root/lib64/ld-linux-x86-64.so.2" '
                       '--library-path "$root/lib64:$root/usr/lib64/mysql/private" '
                       '"$root/usr/sbin/mysqld" --no-defaults --basedir="$root/usr" '
                       '--lc-messages-dir="$root/usr/share/mysql-8.0" '
                       '--plugin-dir="$root/usr/lib64/mysql/plugin" "$@" '
                       '--bind-address=127.0.0.1 --mysqlx=OFF --secure-file-priv=NULL\n')
    wrapper.chmod(0o755)
    return wrapper


def main():
    assert ROOT.resolve() == ROOT and ROOT.is_dir()
    executor = ROOT / 'control/expensive-artifact-lifecycle.mjs'
    assert executor.is_file() and not executor.is_symlink()
    lifecycle = [NODE, str(executor)]
    common = ['--project-root', str(ROOT), '--state-root', str(ROOT / 'control/lifecycle-state')]
    receipt_file = ROOT / 'control/mysql-lease.json'
    if receipt_file.exists():
        lease = json.loads(receipt_file.read_text())['lease']['leaseId']
        run(lifecycle + ['resume', *common, '--lease-id', lease])
    else:
        begin = run(lifecycle + ['begin', *common, '--resource', str(RESOURCE),
                                '--kind', 'other-expensive-input', '--fingerprint', IMAGE[7:],
                                '--reason', 'Pinned MySQL binaries for AI A isolated scenario Host tests'])
        receipt_file.write_text(begin + '\n')
        receipt_file.chmod(0o600)
        lease = json.loads(begin)['lease']['leaseId']
    manifest = RESOURCE / 'manifest.json'
    if manifest.exists():
        value = json.loads(manifest.read_text())
        assert value['imageId'] == IMAGE
        if value.get('toolPolicyVersion', 1) in (1, 2):
            old_wrapper = next(f for f in value['files'] if f['path'] == 'mysqld')
            assert hashlib.sha256((RESOURCE / 'mysqld').read_bytes()).hexdigest() == old_wrapper['sha256']
            before = ROOT / ('control/mysql-manifest-before-policy-' + str(TOOL_POLICY_VERSION) + '.json')
            if not before.exists():
                before.write_bytes(manifest.read_bytes())
            wrapper = write_wrapper()
            old_wrapper.update(bytes=wrapper.stat().st_size, sha256=hashlib.sha256(wrapper.read_bytes()).hexdigest())
            value['toolPolicyVersion'] = TOOL_POLICY_VERSION
            manifest.write_text(json.dumps(value, indent=2) + '\n')
            run(lifecycle + ['checkpoint', *common, '--lease-id', lease, '--state', 'staged'])
        assert value['toolPolicyVersion'] == TOOL_POLICY_VERSION
        print(json.dumps({'status': 'already-prepared', 'manifest': str(manifest), 'leaseId': lease}))
        return
    observed = json.loads(run(['docker', 'image', 'inspect', IMAGE]))[0]
    assert observed['Id'] == IMAGE and observed['Architecture'] == 'amd64'
    created = run(['docker', 'create', '--name', CONTAINER,
                   '--label', 'forge.acceptance.owner=ai-a-scenarios-20260929',
                   '--network', 'none', '--entrypoint', '/bin/true', IMAGE])
    sources = ['/usr/sbin/mysqld', '/usr/share/mysql-8.0', '/usr/lib64/mysql',
               '/lib64/ld-linux-x86-64.so.2', '/lib64/libssl.so.3', '/lib64/libcrypto.so.3',
               '/lib64/libaio.so.1', '/lib64/libstdc++.so.6', '/lib64/libm.so.6',
               '/lib64/libgcc_s.so.1', '/lib64/libc.so.6', '/lib64/libz.so.1']
    try:
        for source in sources:
            target = RESOURCE / source.lstrip('/')
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                run(['docker', 'cp', '-L', created + ':' + source, str(target)])
        wrapper = write_wrapper()
        version = run([str(wrapper), '--version'])
        files = []
        for p in sorted(RESOURCE.rglob('*')):
            if p.is_file() and not p.is_symlink() and p.name != '.artifact-lifecycle-owner.json':
                raw = p.read_bytes()
                files.append({'path': str(p.relative_to(RESOURCE)), 'bytes': len(raw),
                              'sha256': hashlib.sha256(raw).hexdigest()})
        value = {'imageId': IMAGE, 'version': version, 'files': files, 'toolPolicyVersion': TOOL_POLICY_VERSION,
                 'scope': 'binary preparation only; no database or business test executed'}
        manifest.write_text(json.dumps(value, indent=2) + '\n')
        run(lifecycle + ['checkpoint', *common, '--lease-id', lease, '--state', 'staged'])
        print(json.dumps({'status': 'staged', 'imageId': IMAGE, 'version': version,
                          'manifest': str(manifest), 'manifestSha256': hashlib.sha256(manifest.read_bytes()).hexdigest(),
                          'files': len(files), 'bytes': sum(f['bytes'] for f in files), 'leaseId': lease}))
    finally:
        state = json.loads(run(['docker', 'inspect', created]))[0]
        assert state['Id'] == created and state['Config']['Labels']['forge.acceptance.owner'] == 'ai-a-scenarios-20260929'
        assert state['State']['Running'] is False
        run(['docker', 'rm', created])


if __name__ == '__main__':
    main()
