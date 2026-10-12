#!/usr/bin/env python3
"""Keep only the two containerd Bolt metadata files resident, without writing them."""

import ctypes
import json
import os
from pathlib import Path
import signal
import stat
import sys
import threading


TARGETS = (
    Path('/var/lib/containerd/io.containerd.metadata.v1.bolt/meta.db'),
    Path('/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/metadata.db'),
)
MAX_BYTES = 512 * 1024 * 1024
INTERVAL_SECONDS = 30


class LockedMapping:
    def __init__(self, path, expected):
        self.address = None
        self.length = expected[2]
        self.identity = expected
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int,
                                   ctypes.c_int, ctypes.c_int, ctypes.c_long]
        self.libc.mmap.restype = ctypes.c_void_p
        for name in ('mlock', 'munlock', 'munmap'):
            method = getattr(self.libc, name)
            method.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
            method.restype = ctypes.c_int
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            current = os.fstat(fd)
            if (current.st_dev, current.st_ino, current.st_size) != expected:
                raise RuntimeError('METADATA_CHANGED_BEFORE_MAPPING')
            address = self.libc.mmap(None, self.length, 1, 1, fd, 0)  # PROT_READ, MAP_SHARED
            if address == ctypes.c_void_p(-1).value:
                raise OSError(ctypes.get_errno(), 'metadata mmap failed')
            self.address = address
            if self.libc.mlock(address, self.length) != 0:
                error = ctypes.get_errno()
                self.close()
                raise OSError(error, 'metadata mlock failed')
            current = os.fstat(fd)
            named = Path(path).stat(follow_symlinks=False)
            if ((named.st_dev, named.st_ino) != expected[:2]
                    or current.st_size < self.length):
                raise RuntimeError('METADATA_REPLACED_OR_SHRUNK_DURING_LOCK')
        except BaseException:
            self.close()
            raise
        finally:
            os.close(fd)

    def close(self):
        if self.address is None:
            return
        address, self.address = self.address, None
        unlock = self.libc.munlock(address, self.length)
        unlock_error = ctypes.get_errno() if unlock else 0
        unmap = self.libc.munmap(address, self.length)
        unmap_error = ctypes.get_errno() if unmap else 0
        if unlock or unmap:
            raise OSError(unmap_error or unlock_error, 'metadata unlock/unmap failed')


class Residency:
    # Alternate paths/limits are an import-only fixture seam, never CLI or env options.
    def __init__(self, paths=TARGETS, max_bytes=MAX_BYTES):
        self.paths = tuple(Path(path) for path in paths)
        if len(self.paths) != 2 or len(set(self.paths)) != 2:
            raise ValueError('EXACTLY_TWO_DISTINCT_METADATA_FILES_REQUIRED')
        self.max_bytes = max_bytes
        self.mappings = {}

    def refresh(self):
        identities = {}
        for path in self.paths:
            current = path.stat(follow_symlinks=False)
            if not stat.S_ISREG(current.st_mode) or not 0 < current.st_size <= self.max_bytes:
                raise ValueError('METADATA_FILE_TYPE_OR_SIZE_LIMIT')
            identities[path] = (current.st_dev, current.st_ino, current.st_size)
        if sum(identity[2] for identity in identities.values()) > self.max_bytes:
            raise ValueError('METADATA_TOTAL_SIZE_LIMIT')
        replacements = {}
        try:
            for path, identity in identities.items():
                old = self.mappings.get(path)
                if old is None or old.identity != identity:
                    replacements[path] = LockedMapping(path, identity)
        except BaseException:
            for replacement in replacements.values():
                replacement.close()
            raise
        # Every changed file is locked successfully before any old mapping is released.
        old_mappings = [self.mappings[path] for path in replacements if path in self.mappings]
        self.mappings.update(replacements)
        errors = []
        for old in old_mappings:
            try:
                old.close()
            except OSError as error:
                errors.append(error)
        if errors:
            raise errors[0]
        return bool(replacements)

    @property
    def locked_bytes(self):
        return sum(mapping.length for mapping in self.mappings.values())

    def close(self):
        errors = []
        for mapping in self.mappings.values():
            try:
                mapping.close()
            except OSError as error:
                errors.append(error)
        self.mappings.clear()
        if errors:
            raise errors[0]


def report(status, **fields):
    print(json.dumps({'status': status, **fields}, separators=(',', ':')), flush=True)


def run(paths=TARGETS, interval=INTERVAL_SECONDS):
    stop = threading.Event()
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, lambda _number, _frame: stop.set())
    residency = Residency(paths)
    try:
        while not stop.is_set():
            if residency.refresh():
                report('locked', lockedBytes=residency.locked_bytes,
                       files=[{'path': str(path), 'device': mapping.identity[0],
                               'inode': mapping.identity[1], 'bytes': mapping.length}
                              for path, mapping in residency.mappings.items()])
            stop.wait(interval)
    finally:
        residency.close()
        report('released', lockedBytes=0)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 1:
            raise ValueError('PRODUCTION_PATHS_AND_LIMITS_ARE_FIXED')
        run()
    except Exception as error:
        report('failed', errorType=type(error).__name__, error=str(error))
        sys.exit(1)
