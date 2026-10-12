#!/usr/bin/env python3
"""Set the Docker host's inotify instance capacity without restarting services."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

MINIMUM = 1024
PROC = Path('/proc/sys/fs/inotify/max_user_instances')
CONFIG = Path('/etc/sysctl.d/90-forge-delivery-inotify.conf')
KEY = 'fs.inotify.max_user_instances'


def content(value):
    return f'# Managed by Forge delivery host setup.\n{KEY} = {value}\n'.encode()


def inspect_state(proc_path=PROC, config_path=CONFIG):
    runtime_text = proc_path.read_text().strip()
    if not re.fullmatch(r'[1-9][0-9]*', runtime_text):
        raise RuntimeError('Invalid live inotify instance limit')
    raw = None
    persistent = 0
    if config_path.is_symlink():
        raise RuntimeError('Refusing a symlink at the managed sysctl path')
    if config_path.exists():
        if not config_path.is_file():
            raise RuntimeError('Managed sysctl path is not a regular file')
        raw = config_path.read_bytes()
        match = re.fullmatch(rb'# Managed by Forge delivery host setup\.\nfs\.inotify\.max_user_instances = ([1-9][0-9]*)\n', raw)
        if not match:
            raise RuntimeError('Existing sysctl file is not owned by this setup tool')
        persistent = int(match[1])
    runtime = int(runtime_text)
    target = max(runtime, persistent, MINIMUM)
    return dict(runtime=runtime, persistent=persistent, target=target,
                configPresent=raw is not None, ready=runtime >= MINIMUM and persistent >= MINIMUM)


def apply(backup_dir, proc_path=PROC, config_path=CONFIG, run=subprocess.run):
    before = inspect_state(proc_path, config_path)
    desired = content(before['target'])
    old = config_path.read_bytes() if before['configPresent'] else None
    if before['runtime'] == before['target'] and old == desired:
        return dict(status='unchanged', before=before, after=before)
    if backup_dir.is_symlink() or backup_dir.resolve() != backup_dir:
        raise RuntimeError('Backup directory must be a canonical path without symlinks')
    backup_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (backup_dir / '主机监视实例修复前像.json').open('x', encoding='utf-8') as stream:
        json.dump(dict(before=before, configBase64=base64.b64encode(old).decode() if old is not None else None), stream)
        stream.write('\n')
    if old != desired:
        if config_path.parent.resolve() != config_path.parent:
            raise RuntimeError('Managed sysctl parent must be a canonical directory')
        fd, temporary = tempfile.mkstemp(prefix='.forge-inotify-', dir=config_path.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(desired)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o644)
            os.replace(temporary, config_path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    if before['runtime'] != before['target']:
        run(['sysctl', '-w', f"{KEY}={before['target']}"], check=True, capture_output=True, timeout=10)
    after = inspect_state(proc_path, config_path)
    if after['runtime'] < before['target'] or after['persistent'] < before['target']:
        raise RuntimeError('The requested inotify capacity did not become effective')
    result = dict(status='configured', before=before, after=after)
    with (backup_dir / '主机监视实例修复结果.json').open('x', encoding='utf-8') as stream:
        json.dump(result, stream)
        stream.write('\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('preflight', 'apply', 'verify'))
    parser.add_argument('--backup-dir', type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Host inotify configuration requires root')
    if args.action == 'apply':
        if args.backup_dir is None or not args.backup_dir.is_absolute():
            raise RuntimeError('An absolute backup directory is required')
        result = apply(args.backup_dir)
    else:
        result = inspect_state()
        if args.action == 'verify' and not result['ready']:
            raise RuntimeError('Host inotify capacity is not persistent and effective')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
