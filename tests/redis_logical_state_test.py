import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "redis-logical-state.py"
SPEC = importlib.util.spec_from_file_location("redis_logical_state", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class FakeRedisConnection:
    stores = {}
    flushes = 0

    def __init__(self, database):
        self.database = database
        self.stores.setdefault(database, {})

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def command(self, command, *parts):
        command = str(command).upper()
        store = self.stores[self.database]
        if command == "DBSIZE":
            return len(store)
        if command == "SCAN":
            return [b"0", list(store)]
        if command == "DUMP":
            return store[parts[0]][0]
        if command == "PTTL":
            return store[parts[0]][1]
        if command == "FLUSHDB":
            type(self).flushes += 1
            store.clear()
            return b"OK"
        if command == "RESTORE":
            key, ttl, payload, replace = parts
            if replace != "REPLACE":
                raise AssertionError("restore must replace exact target keys")
            store[key] = (payload, -1 if int(ttl) == 0 else int(ttl))
            return b"OK"
        raise AssertionError(f"unexpected command: {command}")


class RedisLogicalStateTests(unittest.TestCase):
    def setUp(self):
        FakeRedisConnection.stores = {
            2: {b"binary\x00key": (b"redis-dump-payload", 45000)},
            14: {b"stale": (b"old", -1)},
        }
        FakeRedisConnection.flushes = 0

    def test_backup_and_exact_database_restore(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(
            MODULE, "RedisConnection", FakeRedisConnection
        ):
            backup_path = Path(temporary) / "redis.jsonl"
            summary = MODULE.backup(14, backup_path)
            self.assertEqual(summary["keys"], 1)
            if os.name != "nt":
                self.assertEqual(backup_path.stat().st_mode & 0o777, 0o600)

            FakeRedisConnection.stores[14] = {b"corrupt": (b"wrong", -1)}
            restored = MODULE.restore(14, backup_path, 14)
            self.assertEqual(restored, {"database": 14, "keys": 1})
            self.assertEqual(
                FakeRedisConnection.stores[14][b"stale"][0],
                b"old",
            )
            self.assertNotIn(b"corrupt", FakeRedisConnection.stores[14])

    def test_identity_mismatch_never_flushes_target(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(
            MODULE, "RedisConnection", FakeRedisConnection
        ):
            backup_path = Path(temporary) / "wrong.jsonl"
            backup_path.write_text(
                json.dumps({"schemaVersion": 1, "database": 2}) + "\n",
                encoding="utf-8",
            )
            with self.assertRaises(MODULE.RedisProtocolError):
                MODULE.restore(14, backup_path, 14)
            self.assertEqual(FakeRedisConnection.flushes, 0)
            self.assertIn(b"stale", FakeRedisConnection.stores[14])

    def test_malformed_record_never_flushes_target(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(
            MODULE, "RedisConnection", FakeRedisConnection
        ):
            backup_path = Path(temporary) / "malformed.jsonl"
            backup_path.write_text(
                json.dumps({"schemaVersion": 1, "database": 14})
                + "\n"
                + json.dumps({"key": "***", "payload": "AA==", "pttl": -1})
                + "\n",
                encoding="utf-8",
            )
            with self.assertRaises(Exception):
                MODULE.restore(14, backup_path, 14)
            self.assertEqual(FakeRedisConnection.flushes, 0)
            self.assertIn(b"stale", FakeRedisConnection.stores[14])

    def test_database_range_and_command_encoding(self):
        self.assertEqual(MODULE.validate_database(0), 0)
        self.assertEqual(MODULE.validate_database(15), 15)
        with self.assertRaises(MODULE.RedisProtocolError):
            MODULE.validate_database(16)
        self.assertEqual(
            MODULE.encode_command("SELECT", 2),
            b"*2\r\n$6\r\nSELECT\r\n$1\r\n2\r\n",
        )


if __name__ == "__main__":
    unittest.main()
