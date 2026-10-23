"""Run with: python -m unittest discover -s python/tests  (from the interveil/ directory)"""

import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from interveil.client import MAX_SCANNED_STRINGS, _check_blocked  # noqa: E402

CASES = json.loads((ROOT / "test-fixtures" / "blocklist-cases.json").read_text(encoding="utf-8"))


class DefaultRulesTest(unittest.TestCase):
    def test_blocks_shared_cases(self):
        for cmd in CASES["block"]:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(_check_blocked(cmd))

    def test_allows_shared_cases(self):
        for cmd in CASES["allow"]:
            with self.subTest(cmd=cmd):
                self.assertIsNone(_check_blocked(cmd))


class DeepScanTest(unittest.TestCase):
    def test_no_depth_limit(self):
        deep = {"cmd": "rm -rf /"}
        for _ in range(50):
            deep = {"next": deep}
        self.assertEqual(_check_blocked(deep), "rm-recursive")

    def test_dict_keys_are_scanned(self):
        self.assertIsNotNone(_check_blocked({"drop table users": 1}))

    def test_circular_references(self):
        a = {"cmd": "ls"}
        a["self"] = a
        self.assertIsNone(_check_blocked(a))

    def test_oversized_values_are_blocked(self):
        self.assertIsNotNone(_check_blocked(["ok"] * (MAX_SCANNED_STRINGS + 1)))

    def test_extra_patterns(self):
        self.assertEqual(_check_blocked("use dangerous_tool", ["DANGEROUS_TOOL"]), "dangerous_tool")


if __name__ == "__main__":
    unittest.main()
