"""Fixture retry scheduling only, with the unchanged real SQLite witness logic.

Node calls are synthetic unit responses; no actual CNI/runtime acceptance here.
No error/absence may create the successful StopPodSandbox receipt.
"""
import unittest
from unittest.mock import patch

from authority import Held
from cri_stop_witness import verify_cri_stop
import test_cri_stop_witness as witness_fixture
from test_kubernetes_disposable import FixtureNodeObserver


class FixtureExactStopRetryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = witness_fixture.CRIStopTests("test_success_is_distinct_authenticated_exact_rpc_evidence")
        self.fixture.setUp()
        self.observer = FixtureNodeObserver.__new__(FixtureNodeObserver)
        self.observer.binding = {self.fixture.physical["uid"]: {"sandbox": self.fixture.sandbox}}
        self.observer.stop_retry_evidence = []
        self.observer.cri = self.fixture.witness
        self.real_node = self.fixture.witness.node
        self.stops = []

    def tearDown(self):
        self.fixture.tearDown()

    def race(self, sandbox=None):
        sandbox = sandbox or self.fixture.sandbox
        # Match actual klog/Go escaped quotes in the hosted failure, not only an
        # unescaped synthetic message. Selector remains exact sandbox/ptp/eth0.
        return RuntimeError('StopPodSandbox from runtime service failed: rpc error: failed to destroy network for sandbox \\"' + sandbox +
            '\\": plugin type=\\"ptp\\" failed (delete): failed to delete \\"eth0\\": no such device')

    def install(self, responses):
        def node(*args):
            if args[:2] == ("crictl", "stopp"):
                self.stops.append(args[2])
                response = responses.pop(0)
                if callable(response): response = response()
                if isinstance(response, BaseException): raise response
            return self.real_node(*args)
        self.fixture.witness.node = node

    def receipt(self):
        return self.fixture.witness.db.execute("SELECT receipt FROM pins").fetchone()[0]

    def test_exact_cni_race_then_real_witness_success_may_return_receipt(self):
        self.install([self.race(), None])
        with patch("test_kubernetes_disposable.time.sleep") as backoff:
            reply = self.observer.stop_exact(self.fixture.physical)
        self.assertEqual(self.stops, [self.fixture.sandbox] * 2)
        self.assertIsNotNone(self.receipt())
        evidence = verify_cri_stop(self.fixture.key, reply, reply["body"]["challenge"], self.fixture.physical, self.fixture.config)
        self.assertTrue(evidence["stopped"]); self.assertFalse(evidence["stableRetirement"])
        report = self.observer.stop_retry_evidence[-1]
        self.assertEqual((report["attempts"], report["retries"], report["status"]), (2, 1, "actual-witness-receipt-returned"))
        self.assertIn("no such device", report["firstError"])
        backoff.assert_called_once_with(.2)

    def test_repeated_identical_cni_error_is_bounded_and_stays_held(self):
        self.install([self.race(), self.race(), self.race()])
        with patch("test_kubernetes_disposable.time.sleep") as backoff, self.assertRaises(RuntimeError):
            self.observer.stop_exact(self.fixture.physical)
        self.assertEqual(self.stops, [self.fixture.sandbox] * 3)
        self.assertIsNone(self.receipt())
        report = self.observer.stop_retry_evidence[-1]
        self.assertEqual((report["attempts"], report["retries"], report["status"]), (3, 2, "held"))
        self.assertEqual([call.args[0] for call in backoff.call_args_list], [.2, .4])

    def test_other_runtime_errors_or_wrong_sandbox_are_never_retried(self):
        errors = [RuntimeError("runtime transport refused"), self.race("d" * 64),
            RuntimeError(str(self.race()).replace("ptp", "bridge")), RuntimeError(str(self.race()).replace("eth0", "eth1"))]
        for error in errors:
            with self.subTest(error=type(error).__name__):
                self.install([error]); before = len(self.stops)
                with patch("test_kubernetes_disposable.time.sleep") as backoff, self.assertRaises(RuntimeError):
                    self.observer.stop_exact(self.fixture.physical)
                self.assertEqual(len(self.stops), before + 1); backoff.assert_not_called()
                self.assertIsNone(self.receipt())
                self.assertEqual(self.observer.stop_retry_evidence[-1]["status"], "held")

    def test_metadata_disappearance_after_error_cannot_be_success(self):
        def race_then_missing():
            self.fixture.missing = True
            return self.race()
        self.install([race_then_missing])
        with patch("test_kubernetes_disposable.time.sleep"), self.assertRaisesRegex(Held, "sandbox_missing"):
            self.observer.stop_exact(self.fixture.physical)
        self.assertEqual(self.stops, [self.fixture.sandbox])
        self.assertIsNone(self.receipt())
        self.assertEqual(self.observer.stop_retry_evidence[-1]["attempts"], 2)

    def test_runtime_change_after_error_cannot_be_success(self):
        def race_then_restart():
            self.fixture.runtime = "different-runtime-incarnation"
            return self.race()
        self.install([race_then_restart])
        with patch("test_kubernetes_disposable.time.sleep"), self.assertRaisesRegex(Held, "stop_witness_pin_changed"):
            self.observer.stop_exact(self.fixture.physical)
        self.assertEqual(self.stops, [self.fixture.sandbox]); self.assertIsNone(self.receipt())

    def test_metadata_error_is_not_a_retryable_runtime_error(self):
        self.fixture.missing = True
        self.install([])
        with patch("test_kubernetes_disposable.time.sleep") as backoff, self.assertRaises(Held):
            self.observer.stop_exact(self.fixture.physical)
        backoff.assert_not_called(); self.assertEqual(self.stops, []); self.assertIsNone(self.receipt())


if __name__ == "__main__": unittest.main()
