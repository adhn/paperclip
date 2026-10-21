"""Pure assembly contract tests; no Kubernetes/native acceptance claim."""
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from authority import Held, digest
from launch_native_fixture import NativeFixture, wait_for_native_ip
from test_kubernetes_boundary import fixture
from test_kubernetes_disposable import CONTROL, EXECUTION, provision


class FakeCluster:
    def __init__(self):
        self.objects = []

    def install(self, *objects):
        self.objects.extend(copy.deepcopy(objects))

    def kubectl(self, *args, **kwargs):
        if "namespace" in args:
            value = {"metadata": {"uid": "real-" + args[args.index("namespace") + 1]}}
        elif "pvc" in args:
            value = {"metadata": {"uid": "actual-api-pvc-uid"}}
        else:
            value = {}
        return subprocess.CompletedProcess(args, 0, json.dumps(value).encode(), b"")


class NativeAssemblyTests(unittest.TestCase):
    def test_native_backend_uses_observed_identities_and_has_no_sqlite_fallback(self):
        policy, contract, guard = fixture()
        guard.namespace = EXECUTION
        guard.journal_key = b"x" * 32
        cluster = FakeCluster()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", str(root / "client.key"),
                "-out", str(root / "client.crt"), "-subj", "/CN=fixture"], check=True, capture_output=True)
            observed = []
            native = {**contract, "owner": {**contract["owner"], "company": "native-db-company"}}
            def initialize(context, target, actual_policy):
                observed.append((context, target, actual_policy))
                return {"contract": native, "journalKeyHex": (b"y" * 32).hex(),
                    "native_consumer": {"endpoint": "https://192.0.2.1:8444/consume-pod-create", "ca": "/tls/native-ca.crt", "certificate": "/tls/native-client.crt", "key": "/tls/native-client.key"},
                    "tls_files": {"native-ca.crt": str(root / "client.crt"), "native-client.crt": str(root / "client.crt"), "native-client.key": str(root / "client.key")}}
            result = provision(cluster, guard, next(iter(guard.images.values())), root, contract, root / "client.crt", native_backend=initialize)
        self.assertEqual(result, native)
        context, target, actual_policy = observed[0]
        self.assertEqual(context["namespaceUid"], "real-" + EXECUTION)
        self.assertEqual(context["cluster"], "real-kube-system")
        self.assertEqual(target["pvcUid"], "actual-api-pvc-uid")
        self.assertEqual(actual_policy, policy)
        config_object = next(o for o in cluster.objects if o["kind"] == "ConfigMap" and o["metadata"]["name"] == "guard-config")
        config = json.loads(config_object["data"]["guard.json"])
        self.assertNotIn("disposable_current_authority", config)
        self.assertIn("native_consumer", config)
        self.assertEqual(config["storages"][contract["storage"]]["owner"], digest(native["owner"]))
        deployment = next(o for o in cluster.objects if o["kind"] == "Deployment")
        env = deployment["spec"]["template"]["spec"]["containers"][0]["env"]
        self.assertNotIn("PAPERCLIP_DISPOSABLE_CURRENT_AUTHORITY", [item["name"] for item in env])
        self.assertEqual(guard.journal_key, b"y" * 32)

    def test_missing_native_proof_cannot_install_guard_or_fall_back(self):
        _, contract, guard = fixture()
        guard.journal_key = b"x" * 32
        cluster = FakeCluster()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", str(root / "client.key"),
                "-out", str(root / "client.crt"), "-subj", "/CN=fixture"], check=True, capture_output=True)
            def unavailable(*_):
                raise Held("native_authority_unavailable")
            with self.assertRaisesRegex(Held, "native_authority_unavailable"):
                provision(cluster, guard, next(iter(guard.images.values())), root, contract, root / "client.crt", native_backend=unavailable)
        self.assertFalse(any(o["kind"] == "Deployment" for o in cluster.objects))
        self.assertFalse(any(o["kind"] == "ValidatingWebhookConfiguration" for o in cluster.objects))


class NativeNetworkReadinessTests(unittest.TestCase):
    def test_inspect_success_before_network_assignment_keeps_waiting(self):
        states = [{}, {"kind": {}}, {"kind": {"IPAddress": ""}}, {"kind": {"IPAddress": "172.18.0.3"}}]
        replies = [subprocess.CompletedProcess([], 0, json.dumps(state).encode(), b"") for state in states]
        with patch("launch_native_fixture.command", side_effect=replies) as inspect, patch("launch_native_fixture.time.sleep") as pause:
            self.assertEqual(wait_for_native_ip(), "172.18.0.3")
        self.assertEqual(inspect.call_count, 4)
        self.assertEqual(pause.call_count, 3)

    def test_unresolved_network_has_the_original_bounded_timeout(self):
        with patch("launch_native_fixture.command", return_value=subprocess.CompletedProcess([], 0, b'{}', b"")) as inspect, patch("launch_native_fixture.time.sleep"):
            with self.assertRaisesRegex(Held, "native_fixture_container_not_started"):
                wait_for_native_ip()
        self.assertEqual(inspect.call_count, 100)

    def test_existing_container_is_refused_before_process_or_directory_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "must-not-exist"
            with patch("launch_native_fixture.command", return_value=subprocess.CompletedProcess([], 0, b'{}', b"")), patch("launch_native_fixture.subprocess.Popen") as spawn:
                with self.assertRaisesRegex(Held, "native_fixture_refuses_existing_or_unverified_container"):
                    NativeFixture(target, "fixture-image")
            spawn.assert_not_called()
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
