import copy
import json
from pathlib import Path
import tempfile
import unittest
from authority import Held, digest
from cri_stop_witness import ExactCRIStopWitness, verify_cri_stop, FINALIZER


class CRIStopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.temp.name) / "witness.sqlite")
        self.key, self.config, self.namespace = b"k" * 32, "a" * 64, "fixture-only"
        self.physical = {"pool": "fixture", "uid": "original-pod", "container": "containerd://" + "b" * 64, "node": "fixture-node", "storage": "state-original"}
        self.sandbox, self.runtime = "c" * 64, "runtime-original"
        self.missing, self.fail, self.extra, self.changed_during_rpc = False, False, False, False
        self.rpc_calls = []
        self.pod = {"metadata": {"uid": "original-pod", "resourceVersion": "42", "finalizers": [FINALIZER], "deletionTimestamp": "fixture-timestamp"},
            "spec": {"nodeName": "fixture-node"}, "status": {"containerStatuses": [{"containerID": self.physical["container"]}]}}
        self.witness = self.new()
        self.witness.pin(self.physical, self.sandbox)

    def new(self):
        return ExactCRIStopWitness(self.path, self.key, self.config, self.namespace, self.node, lambda: self.runtime, lambda physical: self.pod)

    def node(self, *args):
        if args[:2] == ("crictl", "inspectp"):
            if self.missing:
                raise Held("sandbox_missing")
            return json.dumps({"status": {"id": self.sandbox, "metadata": {"uid": "original-pod", "namespace": self.namespace}}})
        if args[:2] == ("crictl", "ps"):
            containers = [{"id": "b" * 64}]
            if self.extra:
                containers.append({"id": "d" * 64})
            return json.dumps({"containers": containers})
        if args[:2] == ("crictl", "stopp"):
            self.rpc_calls.append(args[2])
            if self.fail:
                raise Held("rpc_timeout")
            if self.changed_during_rpc:
                self.runtime = "runtime-restarted"
            return self.sandbox
        raise AssertionError("unexpected host operation:" + str(args))

    def tearDown(self):
        self.witness.close()
        self.temp.cleanup()

    def test_success_is_distinct_authenticated_exact_rpc_evidence(self):
        reply = self.witness.stop(self.physical, "fresh-challenge")
        evidence = verify_cri_stop(self.key, reply, "fresh-challenge", self.physical, self.config)
        self.assertTrue(evidence["stopped"])
        self.assertFalse(evidence["stableRetirement"])
        self.assertEqual(evidence["evidence"]["receipt"]["type"], "exact-cri-stop-success-v1")
        self.assertNotIn("cgroupEmpty", evidence["evidence"])
        self.assertEqual(self.rpc_calls, [self.sandbox])

    def test_durable_lost_ack_retrieval_survives_missing_runtime_metadata(self):
        first = self.witness.stop(self.physical, "first")
        self.witness.close()
        self.witness = self.new()
        self.missing = True
        second = self.witness.stop(self.physical, "second")
        self.assertEqual(first["body"]["receipt"], second["body"]["receipt"])
        self.assertEqual(self.rpc_calls, [self.sandbox])
        self.assertTrue(verify_cri_stop(self.key, second, "second", self.physical, self.config)["stopped"])

    def test_missing_sandbox_cannot_mint_receipt(self):
        self.missing = True
        with self.assertRaises(Held):
            self.witness.stop(self.physical, "challenge")
        self.assertEqual(self.rpc_calls, [])

    def test_rpc_timeout_then_metadata_loss_stays_uncertain(self):
        self.fail = True
        with self.assertRaises(Held):
            self.witness.stop(self.physical, "challenge")
        self.fail, self.missing = False, True
        with self.assertRaises(Held):
            self.witness.stop(self.physical, "challenge-2")
        self.assertEqual(len(self.rpc_calls), 1)

    def test_runtime_restart_before_or_during_stop_holds(self):
        self.runtime = "runtime-restarted"
        with self.assertRaises(Held):
            self.witness.stop(self.physical, "before")
        self.assertEqual(self.rpc_calls, [])
        self.runtime, self.changed_during_rpc = "runtime-original", True
        with self.assertRaises(Held):
            self.witness.stop(self.physical, "during")
        self.assertIsNone(self.witness.db.execute("SELECT receipt FROM pins").fetchone()[0])

    def test_undeleted_or_wrong_pod_and_container_holds(self):
        for change in (lambda p: p["metadata"].pop("deletionTimestamp"), lambda p: p["metadata"].update(uid="sibling"),
                       lambda p: p["status"]["containerStatuses"][0].update(containerID="sibling-container"),
                       lambda p: p["metadata"].update(finalizers=[])):
            old = copy.deepcopy(self.pod)
            change(self.pod)
            with self.assertRaises(Held):
                self.witness.stop(self.physical, "challenge")
            self.pod = old
        self.assertEqual(self.rpc_calls, [])

    def test_additional_container_refuses_exact_rpc_receipt(self):
        self.extra = True
        with self.assertRaises(Held):
            self.witness.stop(self.physical, "challenge")
        self.assertEqual(self.rpc_calls, [])

    def test_sibling_owner_cannot_select_original_sandbox(self):
        sibling = {**self.physical, "uid": "sibling"}
        with self.assertRaises(Held):
            self.witness.stop(sibling, "challenge")
        with self.assertRaises(Held):
            self.witness.pin(sibling, self.sandbox)
        self.assertEqual(self.rpc_calls, [])

    def test_forgery_replay_and_cross_binding_rejected(self):
        reply = self.witness.stop(self.physical, "challenge")
        for key, challenge, physical, config in ((b"x" * 32, "challenge", self.physical, self.config),
            (self.key, "old-challenge", self.physical, self.config), (self.key, "challenge", {**self.physical, "uid": "sibling"}, self.config),
            (self.key, "challenge", self.physical, "d" * 64)):
            with self.assertRaises(Held):
                verify_cri_stop(key, reply, challenge, physical, config)
        with self.assertRaises(Held):
            verify_cri_stop(self.key, reply, "challenge", self.physical, self.config, now=reply["body"]["observedAt"] + 11000)


if __name__ == "__main__":
    unittest.main()
