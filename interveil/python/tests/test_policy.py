"""Python SDK policy enforcement against a real Interveil server (requires `pnpm build`)."""

import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from interveil import PolicyViolationError, trace  # noqa: E402

CLI = ROOT / "dist" / "cli.js"
POLICY = """
version: "1.0"
agents:
  - id: billing-agent
    rules:
      - id: large-refunds
        action: block
        message: Refunds over $100 need a human
        condition:
          tool: refund
          args.0.amount: { greaterThan: 100 }
"""


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Billing:
    def __init__(self):
        self.refunded = []

    def refund(self, order):
        self.refunded.append(order["amount"])
        return "ok"


@unittest.skipUnless(CLI.exists(), "run `pnpm build` first")
class ServerPolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        policy = pathlib.Path(cls.tmp.name) / "policy.yaml"
        policy.write_text(POLICY, encoding="utf-8")
        cls.port = free_port()
        cls.server = subprocess.Popen(
            ["node", str(CLI), "serve", "--port", str(cls.port), "--db", "memory", "--policy-file", str(policy)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=0.1).close()
                break
            except OSError:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait()
        cls.tmp.cleanup()

    def test_blocks_a_call_the_policy_forbids_and_allows_the_rest(self):
        billing = Billing()
        agent = trace(billing, port=self.port, agent_id="billing-agent", enforce_policy=True)
        self.assertEqual(agent.refund({"amount": 20}), "ok")
        with self.assertRaises(PolicyViolationError) as ctx:
            agent.refund({"amount": 900})
        self.assertEqual(ctx.exception.rule_id, "large-refunds")
        self.assertEqual(billing.refunded, [20])


class FailClosedTest(unittest.TestCase):
    def test_refuses_calls_when_the_server_cannot_answer(self):
        billing = Billing()
        agent = trace(billing, port=free_port(), agent_id="billing-agent", enforce_policy=True)
        with self.assertRaises(PolicyViolationError) as ctx:
            agent.refund({"amount": 1})
        self.assertEqual(ctx.exception.rule_id, "policy-unavailable")
        self.assertEqual(billing.refunded, [])


if __name__ == "__main__":
    unittest.main()
