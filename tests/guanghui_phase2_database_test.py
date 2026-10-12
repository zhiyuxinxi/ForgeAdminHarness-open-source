import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/guanghui_phase2_database.py"
SPEC = importlib.util.spec_from_file_location("guanghui_phase2_database", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DatabaseInitializationTests(unittest.TestCase):
    def setUp(self):
        self.operator = MODULE.DatabaseOperator.__new__(MODULE.DatabaseOperator)
        self.schema = MODULE.SCHEMAS[0]
        self.empty = {"schema": self.schema, "characterSet": "utf8mb4",
                      "collation": "utf8mb4_0900_ai_ci", "tables": 0,
                      "views": 0, "routines": 0, "triggers": 0, "events": 0}
        self.populated = {**self.empty, "tables": 220}
        self.records = {}
        self.imports = []
        self.files = {name: name.encode() for name in MODULE.SOURCE_HASHES}

        def read_record(schema, kind):
            value = self.records.get((schema, kind))
            return (value, json.loads(value)) if value is not None else None

        def write_record(schema, kind, record):
            self.assertNotIn((schema, kind), self.records)
            raw = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode()
            self.records[(schema, kind)] = raw
            return raw

        self.operator.files = self.files
        self.operator._read_record = read_record
        self.operator._write_record = write_record
        self.operator._claim_initialization = Mock()
        self.operator._inspect_schema = Mock(side_effect=[self.empty, self.populated])
        self.operator._mysql = lambda schema, sql: self.imports.append((schema, sql))
        self.hash_patch = patch.object(MODULE, "SOURCE_HASHES", {
            name: hashlib.sha256(data).hexdigest() for name, data in self.files.items()
        })
        self.hash_patch.start()
        self.addCleanup(self.hash_patch.stop)

    def initialize(self, expected=None):
        return self.operator.initialize(self.schema, "a" * 40, expected)

    def test_source_file_set_and_each_digest_are_required_before_ssh(self):
        seeds = {name: b"-- reviewed fixture\n" for name in MODULE.SOURCE_HASHES if name != MODULE.FULL_SQL_PATH}
        fixture = {MODULE.FULL_SQL_PATH: b"reviewed full source", **seeds}
        hashes = {name: hashlib.sha256(data).hexdigest() for name, data in fixture.items()}
        with patch.object(MODULE, "SOURCE_HASHES", hashes):
            self.assertEqual(MODULE.validate_sources(fixture[MODULE.FULL_SQL_PATH], seeds), fixture)
            with self.assertRaisesRegex(RuntimeError, "source bytes differ"):
                MODULE.validate_sources(b"changed SQL", seeds)
            with self.assertRaisesRegex(RuntimeError, "seed file set differs"):
                MODULE.validate_sources(fixture[MODULE.FULL_SQL_PATH], {**seeds, "extra.sql": b""})

    def test_empty_import_uses_fixed_order_and_writes_independent_receipt(self):
        result = self.initialize()
        self.assertEqual(self.imports, [(self.schema, self.files[name]) for name in MODULE.SOURCE_HASHES])
        self.assertEqual(result["receipt"]["objectCounts"]["tables"], 220)
        self.assertEqual(result["receipt"]["sourceCommit"], MODULE.SOURCE_COMMIT)
        self.assertEqual(result["receiptSha256"], hashlib.sha256(self.records[(self.schema, "completed")]).hexdigest())
        self.assertIn((self.schema, "started"), self.records)

    def test_nonempty_or_cross_schema_target_never_imports(self):
        self.operator._inspect_schema = Mock(return_value=self.populated)
        with self.assertRaisesRegex(RuntimeError, "empty database"):
            self.initialize()
        with self.assertRaisesRegex(RuntimeError, "outside the two"):
            self.operator.initialize("mysql", "a" * 40, None)
        self.assertEqual(self.imports, [])
        self.assertEqual(self.records, {})

    def test_partial_failure_keeps_started_marker_and_refuses_replay(self):
        self.operator._mysql = Mock(side_effect=RuntimeError("MySQL operation failed; code=1064"))
        with self.assertRaisesRegex(RuntimeError, "code=1064"):
            self.initialize()
        self.assertIn((self.schema, "started"), self.records)
        self.assertNotIn((self.schema, "completed"), self.records)
        with self.assertRaisesRegex(RuntimeError, "Earlier initialization started"):
            self.initialize()
        self.assertEqual(self.operator._mysql.call_count, 1)

    def test_completed_import_requires_exact_receipt_to_resume_without_sql(self):
        first = self.initialize()
        self.operator._inspect_schema = Mock(return_value={**self.populated, "tables": 230})
        for expected in (None, "b" * 64):
            with self.assertRaisesRegex(RuntimeError, "receipt SHA-256"):
                self.initialize(expected)
        resumed = self.initialize(first["receiptSha256"])
        self.assertEqual(resumed["status"], "verified")
        self.assertEqual(resumed["currentState"]["tables"], 230)
        self.assertEqual(len(self.imports), len(MODULE.SOURCE_HASHES))

    def test_matching_digest_cannot_relabel_another_database_receipt(self):
        first = self.initialize()
        original = dict(first["receipt"], schema=MODULE.SCHEMAS[1])
        raw = json.dumps(original).encode()
        self.records[(self.schema, "completed")] = raw
        with self.assertRaisesRegex(RuntimeError, "receipt identity differs"):
            self.operator.verify(self.schema, hashlib.sha256(raw).hexdigest())

    def test_emptied_schema_cannot_reuse_a_success_receipt(self):
        first = self.initialize()
        self.operator._inspect_schema = Mock(return_value=self.empty)
        with self.assertRaisesRegex(RuntimeError, "became empty"):
            self.operator.verify(self.schema, first["receiptSha256"])

    def test_continuation_preflight_requires_exact_test_receipt_and_empty_main(self):
        first = self.initialize()
        self.operator._mysql = Mock(return_value=b"root@localhost\t8.0.42\n")
        main_empty = {**self.empty, "schema": MODULE.SCHEMAS[1]}
        self.operator._inspect_schema = Mock(side_effect=lambda schema:
            {**self.populated, "tables": 244} if schema == self.schema else main_empty)
        self.operator._lstat = Mock(return_value=None)
        with self.assertRaisesRegex(RuntimeError, "both databases to be empty"):
            self.operator.preflight()
        with self.assertRaisesRegex(RuntimeError, "receipt SHA-256 differs"):
            self.operator.preflight("f" * 64)
        result = self.operator.preflight(first["receiptSha256"])
        self.assertEqual(result["status"], "test-initialized-main-empty-verified")
        self.assertEqual([state["tables"] for state in result["schemas"]], [244, 0])
        self.assertEqual(result["completedTestReceiptSha256"], first["receiptSha256"])
        self.assertEqual(len(self.imports), len(MODULE.SOURCE_HASHES))

    def test_continuation_preflight_rejects_any_main_initialization_state(self):
        first = self.initialize()
        self.operator._mysql = Mock(return_value=b"root@localhost\t8.0.42\n")
        main_empty = {**self.empty, "schema": MODULE.SCHEMAS[1]}
        self.operator._inspect_schema = Mock(side_effect=lambda schema:
            self.populated if schema == self.schema else main_empty)
        self.operator._lstat = Mock(return_value=None)
        for kind in ("started", "completed"):
            with self.subTest(kind=kind):
                self.records[(MODULE.SCHEMAS[1], kind)] = b"{}"
                with self.assertRaisesRegex(RuntimeError, "Previous database initialization state"):
                    self.operator.preflight(first["receiptSha256"])
                del self.records[(MODULE.SCHEMAS[1], kind)]
        self.operator._lstat.return_value = object()
        with self.assertRaisesRegex(RuntimeError, "Previous database initialization state"):
            self.operator.preflight(first["receiptSha256"])
        self.operator._lstat.return_value = None
        main_empty["tables"] = 1
        with self.assertRaisesRegex(RuntimeError, "both databases to be empty"):
            self.operator.preflight(first["receiptSha256"])

    def test_mysql_uses_socket_env_and_returns_only_numeric_error_details(self):
        self.operator.mysql_password = "fixture-credential-never-in-argv"
        self.operator.client = Mock()
        channel = Mock()
        channel.recv_exit_status.return_value = 1
        stdin, stdout, stderr = Mock(), Mock(), Mock()
        stdin.channel = stdout.channel = channel
        stdout.read.side_effect = [b"ERROR 1064 (42000) at line 8: INSERT private-fixture-value", b""]
        self.operator.client.exec_command.return_value = stdin, stdout, stderr
        with self.assertRaisesRegex(RuntimeError, "code=1064 line=8") as caught:
            MODULE.DatabaseOperator._mysql(self.operator, self.schema, b"fixed source fixture")
        command = self.operator.client.exec_command.call_args.args[0]
        self.assertIn("/usr/local/mysql/bin/mysql --no-defaults", command)
        self.assertIn("--socket=/tmp/mysql3306.sock", command)
        self.assertIn("--database=" + self.schema, command)
        self.assertIn("export MYSQL_PWD=", command)
        self.assertNotIn(self.operator.mysql_password, command)
        self.assertEqual(stdin.write.call_args_list[0].args[0],
                         self.operator.mysql_password.encode() + b"\n")
        self.assertNotIn("private-fixture-value", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
