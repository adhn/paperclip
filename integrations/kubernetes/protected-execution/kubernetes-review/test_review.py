import base64
import copy
import hashlib
import json
import unittest
from render import render, CONTROL, EXECUTION


def fixture():
    policy = {"fixture": "no-real-account-or-image"}
    return {"mode": "review-only-held", "podSecurityVersion": "v1.35", "guardImage": "invalid.example/fixture@sha256:" + "a" * 64,
        "guardConfig": {"namespace": EXECUTION, "supervisor_user": f"system:serviceaccount:{CONTROL}:supervisor", "policy": policy,
            "storages": {"fixture": {"name": "attempt-fixture", "uid": "12345678-1234-1234-1234-123456789abc", "owner": "b" * 64}}},
        "guardCABundle": base64.b64encode(b"-----BEGIN CERTIFICATE-----\nfixture-only\n-----END CERTIFICATE-----\n").decode(),
        "attemptPVCName": "attempt-fixture", "attemptPVCUID": "12345678-1234-1234-1234-123456789abc", "storageClass": "fixture-retained", "storageBytes": 128 * 1024**2,
        "policyHash": hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()).hexdigest(), "sourceCommit": "c" * 40}


class ReviewTests(unittest.TestCase):
    def test_no_activation_or_network_allow(self):
        items = render(fixture())["items"]
        self.assertTrue(all(i["spec"]["replicas"] == 0 for i in items if i["kind"] == "Deployment"))
        self.assertFalse(any(i["kind"] in ("Pod", "PersistentVolumeClaim", "Secret", "ClusterRole", "ClusterRoleBinding") for i in items))
        policies = [i for i in items if i["kind"] == "NetworkPolicy"]
        self.assertEqual(len(policies), 2)
        self.assertTrue(all(i["spec"] == {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]} for i in policies))

    def test_least_privilege_excludes_runtime_and_state_authority(self):
        role = next(i for i in render(fixture())["items"] if i["kind"] == "Role")
        rules = role["rules"]
        self.assertEqual(rules[0], {"apiGroups": [""], "resources": ["pods"], "verbs": ["create", "get", "list", "delete"]})
        self.assertEqual(rules[1], {"apiGroups": [""], "resources": ["persistentvolumeclaims"], "resourceNames": ["attempt-fixture"], "verbs": ["get"]})

    def test_guard_is_nonroot_without_cluster_identity(self):
        items = render(fixture())["items"]
        deployment = next(i for i in items if i["kind"] == "Deployment")
        spec = deployment["spec"]["template"]["spec"]
        self.assertFalse(spec["automountServiceAccountToken"])
        self.assertEqual(spec["securityContext"]["runAsUser"], 2000)
        self.assertTrue(spec["containers"][0]["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual([v["name"] for v in spec["volumes"]], ["config", "tls"])
        config = next(i for i in items if i["kind"] == "ConfigMap")
        self.assertTrue(config["immutable"])

    def test_fail_closed_namespace_scope_and_subresource_coverage(self):
        obj = next(i for i in render(fixture())["items"] if i["kind"] == "ValidatingWebhookConfiguration")
        hook = obj["webhooks"][0]
        self.assertEqual(hook["failurePolicy"], "Fail")
        self.assertEqual(hook["namespaceSelector"], {"matchLabels": {"kubernetes.io/metadata.name": EXECUTION}})
        self.assertIn("pods/ephemeralcontainers", hook["rules"][0]["resources"])
        self.assertEqual(set(hook["rules"][0]["operations"]), {"CREATE", "UPDATE", "DELETE"})

    def test_reject_incomplete_or_unbound_inputs(self):
        for field, bad in (("mode", "activate"), ("guardImage", "mutable:latest"), ("policyHash", "0" * 64),
                           ("sourceCommit", "main"), ("attemptPVCUID", "unknown"), ("attemptPVCName", "../canonical"),
                           ("storageBytes", 3 * 1024**3), ("storageBytes", True), ("guardCABundle", ""),
                           ("storageClass", ""), ("podSecurityVersion", "latest")):
            with self.subTest(field=field, bad=bad):
                inputs = fixture()
                inputs[field] = bad
                with self.assertRaises(ValueError):
                    render(inputs)
        inputs = fixture()
        inputs["unexpected"] = True
        with self.assertRaises(ValueError):
            render(inputs)

    def test_storage_rebind_or_widening_refused(self):
        for change in (lambda x: x["guardConfig"]["storages"]["fixture"].update(uid="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
                       lambda x: x["guardConfig"]["storages"]["fixture"].update(name="canonical"),
                       lambda x: x["guardConfig"]["storages"].update(other=copy.deepcopy(x["guardConfig"]["storages"]["fixture"])),
                       lambda x: x["guardConfig"].update(supervisor_user="system:serviceaccount:default:default")):
            inputs = fixture()
            change(inputs)
            with self.assertRaises(ValueError):
                render(inputs)

    def test_deterministic_read_only_render(self):
        inputs = fixture()
        before = copy.deepcopy(inputs)
        self.assertEqual(render(inputs), render(inputs))
        self.assertEqual(inputs, before)


if __name__ == "__main__":
    unittest.main()
