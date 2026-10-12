#!/usr/bin/env python3
"""Stage pinned Redis binaries for isolated Host tests; no daemon or business data."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path('/usr/local/lib/forge-scenario-testtools/acceptance-20260929')
IMAGE = 'sha256:8231d3786e10c470840c27963f3d19672dc7ef3e5d5adc512c01d44faada5672'
RESOURCE = ROOT / 'redis-8231d3786e10'
NODE = '/srv/forge-delivery/canary/forge-skills-20260903/toolchains/versions/node-v22.23.2-linux-x64/bin/node'
CONTAINER = 'forge-ai-a-redis-extract-20260929'


def run(argv):
    return subprocess.check_output(argv, text=True, stderr=subprocess.STDOUT, timeout=90).strip()


def main():
    assert ROOT.resolve() == ROOT and ROOT.is_dir()
    executor = ROOT / 'control/expensive-artifact-lifecycle.mjs'
    assert executor.is_file() and not executor.is_symlink()
    lifecycle = [NODE, str(executor)]
    common = ['--project-root', str(ROOT), '--state-root', str(ROOT / 'control/lifecycle-state')]
    receipt_file = ROOT / 'control/redis-lease.json'
    if receipt_file.exists():
        lease = json.loads(receipt_file.read_text())['lease']['leaseId']
        run(lifecycle + ['resume', *common, '--lease-id', lease])
    else:
        begin = run(lifecycle + ['begin', *common, '--resource', str(RESOURCE),
                                '--kind', 'other-expensive-input', '--fingerprint', IMAGE[7:],
                                '--reason', 'Pinned Redis binary for AI A isolated scenario Host tests'])
        receipt_file.write_text(begin + '\n')
        receipt_file.chmod(0o600)
        lease = json.loads(begin)['lease']['leaseId']
    manifest = RESOURCE / 'manifest.json'
    if manifest.exists():
        value = json.loads(manifest.read_text())
        assert value['imageId'] == IMAGE and value['toolPolicyVersion'] == 1
        for item in value['files']:
            p = RESOURCE / item['path']
            assert p.is_file() and not p.is_symlink()
            assert hashlib.sha256(p.read_bytes()).hexdigest() == item['sha256']
        print(json.dumps({'status': 'already-prepared', 'manifest': str(manifest), 'leaseId': lease}))
        return
    observed = json.loads(run(['docker', 'image', 'inspect', IMAGE]))[0]
    assert observed['Id'] == IMAGE and observed['Architecture'] == 'amd64'
    created = run(['docker', 'create', '--name', CONTAINER,
                   '--label', 'forge.acceptance.owner=ai-a-scenarios-20260929',
                   '--network', 'none', '--entrypoint', '/bin/true', IMAGE])
    sources = ['/usr/local/bin/redis-server', '/lib/ld-musl-x86_64.so.1',
               '/usr/lib/libssl.so.3', '/usr/lib/libcrypto.so.3']
    try:
        for source in sources:
            target = RESOURCE / source.lstrip('/')
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                run(['docker', 'cp', '-L', created + ':' + source, str(target)])
        wrapper = RESOURCE / 'redis-server'
        wrapper.write_text('#!/bin/sh\nset -eu\nroot="' + str(RESOURCE) + '"\n'
                           'exec "$root/lib/ld-musl-x86_64.so.1" '
                           '--library-path "$root/lib:$root/usr/lib" '
                           '"$root/usr/local/bin/redis-server" "$@" '
                           '--bind 127.0.0.1 --protected-mode yes '
                           '--save "" --appendonly no --daemonize no\n')
        wrapper.chmod(0o755)
        version = run([str(wrapper), '--version'])
        files = []
        for p in sorted(RESOURCE.rglob('*')):
            if p.is_file() and not p.is_symlink() and p.name != '.artifact-lifecycle-owner.json':
                raw = p.read_bytes()
                files.append({'path': str(p.relative_to(RESOURCE)), 'bytes': len(raw),
                              'sha256': hashlib.sha256(raw).hexdigest()})
        manifest.write_text(json.dumps({'imageId': IMAGE, 'version': version, 'files': files,
                                        'toolPolicyVersion': 1,
                                        'scope': 'binary preparation only; no daemon or business test'}, indent=2) + '\n')
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
