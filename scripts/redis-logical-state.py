#!/usr/bin/env python3

"""Back up and restore one registered Redis logical database without server-wide RDB access."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import socket
import tempfile
from pathlib import Path
from typing import BinaryIO


class RedisProtocolError(RuntimeError):
    pass


def clean_env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None:
        raise RedisProtocolError(f"Required environment variable is missing: {name}")
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    return value


def encode_command(*parts: str | bytes | int) -> bytes:
    encoded = []
    for part in parts:
        value = part if isinstance(part, bytes) else str(part).encode("utf-8")
        encoded.append(b"$%d\r\n%s\r\n" % (len(value), value))
    return b"*%d\r\n%s" % (len(encoded), b"".join(encoded))


def read_line(stream: BinaryIO) -> bytes:
    value = stream.readline()
    if not value.endswith(b"\r\n"):
        raise RedisProtocolError("Redis returned a truncated response")
    return value[:-2]


def read_response(stream: BinaryIO):
    prefix = stream.read(1)
    if prefix == b"+":
        return read_line(stream)
    if prefix == b"-":
        raise RedisProtocolError(read_line(stream).decode("utf-8", "replace"))
    if prefix == b":":
        return int(read_line(stream))
    if prefix == b"$":
        length = int(read_line(stream))
        if length == -1:
            return None
        payload = stream.read(length)
        if len(payload) != length or stream.read(2) != b"\r\n":
            raise RedisProtocolError("Redis returned a truncated bulk response")
        return payload
    if prefix == b"*":
        length = int(read_line(stream))
        if length == -1:
            return None
        return [read_response(stream) for _ in range(length)]
    raise RedisProtocolError(f"Unsupported Redis response prefix: {prefix!r}")


class RedisConnection:
    def __init__(self, database: int):
        host = clean_env("REDIS_HOST")
        port = int(clean_env("REDIS_PORT", "6379"))
        password = clean_env("REDIS_PASSWORD", "")
        username = clean_env("REDIS_USER", "")
        self.sock = socket.create_connection((host, port), timeout=15)
        self.sock.settimeout(60)
        self.stream = self.sock.makefile("rb")
        if password:
            if username:
                self.command("AUTH", username, password)
            else:
                self.command("AUTH", password)
        self.command("SELECT", database)

    def command(self, *parts: str | bytes | int):
        self.sock.sendall(encode_command(*parts))
        return read_response(self.stream)

    def close(self) -> None:
        try:
            self.stream.close()
        finally:
            self.sock.close()

    def __enter__(self) -> "RedisConnection":
        return self

    def __exit__(self, *_args) -> None:
        self.close()


def validate_database(value: int) -> int:
    if value < 0 or value > 15:
        raise RedisProtocolError("Redis database must be between 0 and 15")
    return value


def key_count(database: int) -> int:
    with RedisConnection(database) as client:
        return int(client.command("DBSIZE"))


def backup(database: int, output: Path) -> dict[str, object]:
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    count = 0
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps({"schemaVersion": 1, "database": database}, separators=(",", ":")) + "\n")
            with RedisConnection(database) as client:
                cursor: bytes | int = 0
                while True:
                    response = client.command("SCAN", cursor, "COUNT", 500)
                    if not isinstance(response, list) or len(response) != 2:
                        raise RedisProtocolError("Redis SCAN returned an invalid response")
                    cursor, keys = response
                    for key in keys:
                        payload = client.command("DUMP", key)
                        if payload is None:
                            continue
                        pttl = int(client.command("PTTL", key))
                        handle.write(json.dumps({
                            "key": base64.b64encode(key).decode("ascii"),
                            "payload": base64.b64encode(payload).decode("ascii"),
                            "pttl": pttl,
                        }, separators=(",", ":")) + "\n")
                        count += 1
                    if cursor in {0, b"0"}:
                        break
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, output)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    return {"database": database, "keys": count, "sha256": digest, "bytes": output.stat().st_size}


def restore(database: int, source: Path, confirm_database: int) -> dict[str, int]:
    if database != confirm_database:
        raise RedisProtocolError("--confirm-database must exactly match --database")
    expected = 0
    with source.open("r", encoding="utf-8") as handle:
        header = json.loads(handle.readline())
        if header != {"schemaVersion": 1, "database": database}:
            raise RedisProtocolError("Redis backup identity does not match the target database")
        for line in handle:
            record = json.loads(line)
            if set(record) != {"key", "payload", "pttl"}:
                raise RedisProtocolError("Redis backup record has an invalid shape")
            base64.b64decode(record["key"], validate=True)
            base64.b64decode(record["payload"], validate=True)
            int(record["pttl"])
            expected += 1
    restored = 0
    with source.open("r", encoding="utf-8") as handle:
        header = json.loads(handle.readline())
        with RedisConnection(database) as client:
            if client.command("FLUSHDB") != b"OK":
                raise RedisProtocolError("Redis FLUSHDB did not return OK")
            for line in handle:
                record = json.loads(line)
                key = base64.b64decode(record["key"], validate=True)
                payload = base64.b64decode(record["payload"], validate=True)
                pttl = int(record["pttl"])
                ttl = 0 if pttl < 0 else max(1, pttl)
                if client.command("RESTORE", key, ttl, payload, "REPLACE") != b"OK":
                    raise RedisProtocolError("Redis RESTORE did not return OK")
                restored += 1
    if restored != expected:
        raise RedisProtocolError("Redis restore record count changed between validation and restore")
    return {"database": database, "keys": restored}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("size", "backup", "restore"))
    parser.add_argument("--database", type=int, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--confirm-database", type=int)
    args = parser.parse_args()
    database = validate_database(args.database)
    if args.action == "size":
        print(json.dumps({"database": database, "keys": key_count(database)}, separators=(",", ":")))
        return 0
    if args.action == "backup":
        if args.output is None:
            parser.error("backup requires --output")
        print(json.dumps(backup(database, args.output), separators=(",", ":")))
        return 0
    if args.input is None or args.confirm_database is None:
        parser.error("restore requires --input and --confirm-database")
    print(json.dumps(restore(database, args.input, args.confirm_database), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
