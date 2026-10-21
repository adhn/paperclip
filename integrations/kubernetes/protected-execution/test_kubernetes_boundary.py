import copy
import time
import unittest
from authority import Held, digest, sign
from kubernetes_boundary import WorkloadGuard, KubernetesRuntime, PREFIX, FINALIZER, verify_observation
from test_authority import policy


def fixture():
    p = policy()
    p["pool"] = "synthetic-pool"
    p["templates"]["synthetic"]["image"] = "example.invalid/synthetic@sha256:" + "a" * 64
    owner = {key: "exact-" + key for key in "company agent nativeId environment lease attempt".split()}
    owner.update(p["families"][0], nativeKind="run")
    argv = ["-c", "print('synthetic')"]
    c = {"version": 1, "instance": p["instance"], "policy": digest(p), "epoch": "epoch-1", "generation": 1,
         "owner": owner, "invocation": "exact-invocation", "commandHash": digest(argv), "journalHash": "b" * 64,
         "storage": "exact-storage", "template": "synthetic", "argv": argv}
    g = WorkloadGuard("pc-execution", "system:serviceaccount:pc-control:supervisor", p,
        {"synthetic": "example.invalid/synthetic@sha256:" + "a" * 64},
        {"exact-storage": {"name": "attempt-state", "uid": "storage-uid", "owner": digest(owner)}})
    return p, c, g


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.policy, self.contract, self.guard = fixture()
        self.pod = self.guard.manifest(self.contract)

    def review(self, pod=None):
        return {"namespace": self.guard.namespace, "resource": {"group": "", "version": "v1", "resource": "pods"},
            "operation": "CREATE", "userInfo": {"username": self.guard.supervisor_user}, "object": pod or self.pod}

    def test_approved_template_passes(self):
        self.guard.validate(self.review())

    def test_known_api_defaults_pass(self):
        self.pod["spec"].update(serviceAccount="paperclip-provider", priority=0,
            tolerations=[{"key": "node.kubernetes.io/" + c, "operator": "Exists", "effect": "NoExecute", "tolerationSeconds": 300}
                         for c in ("not-ready", "unreachable")])
        self.pod["spec"]["containers"][0].update(terminationMessagePath="/dev/termination-log", terminationMessagePolicy="File")
        self.guard.validate(self.review())

    def test_forbidden_spec_mutations(self):
        mutations = [
            lambda s: s.update(hostNetwork=True), lambda s: s.update(hostPID=True), lambda s: s.update(hostIPC=True),
            lambda s: s.update(nodeName="target-node"), lambda s: s.update(shareProcessNamespace=True),
            lambda s: s.update(runtimeClassName="escape"), lambda s: s.update(automountServiceAccountToken=True),
            lambda s: s.update(serviceAccountName="supervisor"), lambda s: s.update(initContainers=[s["containers"][0]]),
            lambda s: s.update(ephemeralContainers=[s["containers"][0]]),
            lambda s: s["containers"].append(copy.deepcopy(s["containers"][0])),
            lambda s: s["containers"][0].update(image="unapproved:latest"),
            lambda s: s["containers"][0].update(command=["/bin/sh"]),
            lambda s: s["containers"][0].update(env=[{"name": "TOKEN", "valueFrom": {"secretKeyRef": {"name": "canonical", "key": "auth"}}}]),
            lambda s: s["containers"][0]["securityContext"].update(privileged=True),
            lambda s: s["containers"][0]["securityContext"].update(runAsUser=0),
            lambda s: s["containers"][0]["securityContext"].update(allowPrivilegeEscalation=True),
            lambda s: s["containers"][0]["securityContext"].update(capabilities={"add": ["SYS_ADMIN"]}),
            lambda s: s["containers"][0].update(lifecycle={"postStart": {"exec": {"command": ["/bin/sh"]}}}),
            lambda s: s["volumes"].append({"name": "host", "hostPath": {"path": "/"}}),
            lambda s: s["volumes"][0].update(persistentVolumeClaim={"claimName": "canonical-auth"}),
            lambda s: s["containers"][0]["volumeMounts"][0].update(subPath="../canonical"),
            lambda s: s["containers"][0]["resources"]["limits"].update(memory="64Gi"),
            lambda s: s.update(imagePullSecrets=[{"name": "controller"}]),
            lambda s: s.update(restartPolicy="Always"), lambda s: s.update(activeDeadlineSeconds=86400),
        ]
        for index, mutate in enumerate(mutations):
            pod = copy.deepcopy(self.pod)
            mutate(pod["spec"])
            with self.subTest(index=index), self.assertRaises(Held):
                self.guard.validate(self.review(pod))

    def test_wrong_writer_namespace_and_subresource(self):
        for patch in ({"userInfo": {"username": "provider"}}, {"namespace": "default"},
                      {"subResource": "ephemeralcontainers"}, {"operation": "UPDATE"}):
            with self.subTest(patch=patch), self.assertRaises(Held):
                self.guard.validate({**self.review(), **patch})

    def test_storage_and_owner_remap_denied(self):
        for field in ("owner", "storage", "policy", "invocation", "template", "command"):
            pod = copy.deepcopy(self.pod)
            pod["metadata"]["annotations"][PREFIX + field] = "wrong"
            with self.subTest(field=field), self.assertRaises(Held):
                self.guard.validate(self.review(pod))

    def test_extra_annotation_and_owner_reference_denied(self):
        for mutate in (lambda m: m["annotations"].update({"evil.io/inject": "true"}),
                       lambda m: m.update(ownerReferences=[{"uid": "other"}]), lambda m: m.update(finalizers=[])):
            pod = copy.deepcopy(self.pod)
            mutate(pod["metadata"])
            with self.assertRaises(Held):
                self.guard.validate(self.review(pod))

    def test_exact_delete_requires_uid_version_and_grace(self):
        self.pod["metadata"].update(uid="uid", resourceVersion="123")
        request = {**self.review(), "operation": "DELETE", "oldObject": self.pod,
                   "options": {"preconditions": {"uid": "uid", "resourceVersion": "123"}, "gracePeriodSeconds": 5}}
        self.guard.validate(request)
        for options in ({"gracePeriodSeconds": 0}, {"preconditions": {"uid": "wrong", "resourceVersion": "123"}, "gracePeriodSeconds": 5},
                        {"preconditions": {"uid": "uid"}, "gracePeriodSeconds": 5}):
            with self.subTest(options=options), self.assertRaises(Held):
                self.guard.validate({**request, "options": options})


class WitnessTests(unittest.TestCase):
    def setUp(self):
        self.key = b"w" * 32
        self.physical = {"pool": "pool", "uid": "pod", "container": "containerd://exact", "node": "node", "storage": "state"}
        self.body = {"challenge": "fresh", "physical": self.physical, "configuration": "config", "observedAt": int(time.time() * 1000),
                     "runtime": {"node": "node", "incarnation": "boot-runtime"},
                     "sandbox": {"uid": "sandbox", "state": "SANDBOX_NOTREADY", "podUid": "pod"},
                     "containers": [{"id": "containerd://exact", "state": "CONTAINER_EXITED"}], "cgroupEmpty": True}

    def verify(self):
        return verify_observation(self.key, {"body": self.body, "mac": sign(self.key, "whole-pod-observation-v1", self.body)},
                                  "fresh", self.physical, "config")

    def test_exact_independent_observation(self):
        self.assertTrue(self.verify()["stopped"])

    def test_replay_wrong_physical_and_stale_observations(self):
        for field, value in (("challenge", "old"), ("configuration", "old"), ("physical", {**self.physical, "uid": "sibling"}), ("observedAt", int(time.time() * 1000) - 60000)):
            original = self.body
            self.body = {**original, field: value}
            with self.subTest(field=field), self.assertRaises(Held):
                self.verify()
            self.body = original

    def test_no_sandbox_or_container_or_cgroup_is_not_stop(self):
        for mutate in (lambda b: b["sandbox"].update(state="SANDBOX_READY"),
                       lambda b: b["containers"][0].update(state="CONTAINER_RUNNING"), lambda b: b.update(cgroupEmpty=False)):
            original = self.body
            self.body = copy.deepcopy(original)
            mutate(self.body)
            self.assertFalse(self.verify()["stopped"])
            self.body = original

    def test_unknown_missing_sibling_containers_hold(self):
        for containers in ([], self.body["containers"] * 2, [{"id": "sibling", "state": "CONTAINER_EXITED"}]):
            self.body["containers"] = containers
            with self.assertRaises(Held):
                self.verify()

    def test_provider_cannot_forge_witness(self):
        with self.assertRaises(Held):
            verify_observation(self.key, {"body": self.body, "mac": sign(b"p" * 32, "whole-pod-observation-v1", self.body)},
                               "fresh", self.physical, "config")

class JournalGrantTests(unittest.TestCase):
    def setUp(self):
        self.policy, self.contract, self.guard = fixture()
        self.guard.journal_key = b"g" * 32
        target = {"storage": self.contract["storage"], "pvcUid": "storage-uid", "pvcName": "attempt-state",
                  "image": self.guard.images["synthetic"], "template": "synthetic"}
        body = {"contract": copy.deepcopy(self.contract), "target": target, "expires": int(time.time()) + 30}
        self.contract["journalGrant"] = {"body": body, "mac": sign(self.guard.journal_key, "native-journal-grant-v1", body)}
        self.pod = self.guard.manifest(self.contract)

    def review(self):
        return {"namespace": self.guard.namespace, "resource": {"group": "", "version": "v1", "resource": "pods"},
            "operation": "CREATE", "userInfo": {"username": self.guard.supervisor_user}, "object": self.pod}

    def test_independent_committed_grant_passes(self):
        self.guard.validate(self.review())

    def test_supervisor_cannot_forge_native_grant(self):
        grant = self.contract["journalGrant"]
        grant["mac"] = sign(b"s" * 32, "native-journal-grant-v1", grant["body"])
        self.pod = self.guard.manifest(self.contract)
        with self.assertRaisesRegex(Held, "uncommitted"):
            self.guard.validate(self.review())

    def test_stale_grant_and_pvc_replacement_hold(self):
        for change in (lambda b: b.update(expires=1), lambda b: b["target"].update(pvcUid="replacement-uid")):
            grant = copy.deepcopy(self.contract["journalGrant"])
            change(grant["body"])
            grant["mac"] = sign(self.guard.journal_key, "native-journal-grant-v1", grant["body"])
            self.pod = self.guard.manifest({**self.contract, "journalGrant": grant})
            with self.assertRaises(Held):
                self.guard.validate(self.review())

    def test_changed_command_and_matching_annotation_cannot_escape_original_grant(self):
        contract = copy.deepcopy(self.contract)
        contract["argv"] = ["-c", "print('replayed or changed')"]
        contract["commandHash"] = digest(contract["argv"])
        self.pod = self.guard.manifest(contract)
        with self.assertRaisesRegex(Held, "binding"):
            self.guard.validate(self.review())

    def test_missing_native_grant_is_denied(self):
        del self.pod["metadata"]["annotations"][PREFIX + "grant"]
        with self.assertRaises(Held):
            self.guard.validate(self.review())

class CurrentConsumptionTests(JournalGrantTests):
    def setUp(self):
        import tempfile
        from launch_consumption import FixtureCurrentAuthority
        super().setUp()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.context = {"cluster": "cluster-incarnation", "namespaceUid": "namespace-incarnation", "webhook": "independent-webhook"}
        self.consumer = FixtureCurrentAuthority(self.directory.name + "/current.sqlite", self.context)
        body = self.contract["journalGrant"]["body"]
        self.consumer.register(body["contract"], body["target"])
        self.guard.launch_consumer, self.guard.admission_identity = self.consumer, self.context
        self.pod["metadata"]["uid"] = "server-pod-uid"

    def review(self):
        return {**super().review(), "uid": "server-review-uid", "dryRun": False}

    def test_consumption_is_irreversible_even_exact_duplicate_review(self):
        self.guard.validate(self.review())
        with self.assertRaisesRegex(Held, "already_consumed"):
            self.guard.validate(self.review())
        self.assertEqual(len(self.consumer.history()), 1)

    def test_old_envelope_after_supervisor_rollback_and_object_loss_denied(self):
        self.guard.validate(self.review())
        old_guard = copy.copy(self.guard)  # fresh supervisor, captured old grant
        self.pod["metadata"]["uid"] = "replacement-server-pod-uid"
        with self.assertRaisesRegex(Held, "already_consumed"):
            old_guard.validate({**self.review(), "uid": "replacement-review"})
        self.assertEqual(len(self.consumer.history()), 1)

    def test_cancel_first_denies_consume(self):
        self.consumer.cancel(self.contract["invocation"])
        with self.assertRaisesRegex(Held, "not_current"):
            self.guard.validate(self.review())
        self.assertEqual(self.consumer.history(), [])

    def test_dry_run_missing_uid_and_invalid_spec_never_consume(self):
        for patch in ({"dryRun": True}, {"uid": ""}):
            with self.assertRaises(Held):
                self.guard.validate({**self.review(), **patch})
        self.pod["spec"]["hostPID"] = True
        with self.assertRaises(Held):
            self.guard.validate(self.review())
        self.assertEqual(self.consumer.history(), [])

    def test_post_allow_storage_failure_does_not_unconsume(self):
        self.guard.validate(self.review())
        self.pod["metadata"]["uid"] = "new-pod-uid"
        with self.assertRaisesRegex(Held, "already_consumed"):
            self.guard.validate({**self.review(), "uid": "new-review"})

    def test_authority_restart_retains_consumption(self):
        from launch_consumption import FixtureCurrentAuthority
        self.guard.validate(self.review())
        self.guard.launch_consumer = FixtureCurrentAuthority(self.directory.name + "/current.sqlite", self.context)
        with self.assertRaisesRegex(Held, "already_consumed"):
            self.guard.validate(self.review())

    def test_concurrent_reviews_allow_only_one(self):
        from concurrent.futures import ThreadPoolExecutor
        def create(index):
            request = copy.deepcopy(self.review())
            request["uid"] = "review-" + str(index)
            request["object"]["metadata"]["uid"] = "pod-" + str(index)
            try:
                self.guard.validate(request)
                return True
            except Held:
                return False
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(sum(pool.map(create, range(8))), 1)

    def test_current_service_partition_denies_without_cached_allow(self):
        class Partition:
            def consume(self, binding):
                raise TimeoutError("native partition")
        self.guard.launch_consumer = Partition()
        with self.assertRaises(TimeoutError):
            self.guard.validate(self.review())
        self.assertEqual(self.consumer.history(), [])

    def test_replayed_allow_response_for_other_object_is_denied(self):
        original = self.consumer.consume
        class CapturedResponse:
            saved = None
            def consume(self, binding):
                if self.saved is None:
                    self.saved = original(binding)
                return self.saved
        self.guard.launch_consumer = CapturedResponse()
        self.guard.validate(self.review())
        self.pod["metadata"]["uid"] = "different-object"
        with self.assertRaisesRegex(Held, "unconfirmed"):
            self.guard.validate({**self.review(), "uid": "different-review"})

    def test_api_assigned_pod_uid_is_required(self):
        del self.pod["metadata"]["uid"]
        with self.assertRaises(Held):
            self.guard.validate(self.review())
        self.assertEqual(self.consumer.history(), [])

    def test_actual_supervisor_ledger_rollback_old_signed_envelope_is_fenced(self):
        import sqlite3
        from pathlib import Path
        from authority import Authority, Ledger, request
        import tempfile, os
        supervisor_directory = tempfile.TemporaryDirectory(dir=os.environ.get("TEST_ROOT", Path(__file__).resolve().parent))
        self.addCleanup(supervisor_directory.cleanup)
        root = Path(supervisor_directory.name)
        Ledger.initialize(root, self.policy)
        db = sqlite3.connect(root / "ledger.sqlite")
        incarnation = db.execute("SELECT incarnation FROM meta").fetchone()[0]
        db.close()
        ledger = Ledger(root, self.policy, incarnation)
        self.addCleanup(ledger.db.close)
        outer = self
        class ProtectedRuntime:
            starts = 0
            objects = []
            def attest(self):
                return {"authority": outer.policy["runtimeAuthority"], "configuration": digest(outer.policy), "objects": self.objects}
            def launch(self, contract, template):
                pod = outer.guard.manifest(contract)
                pod["metadata"]["uid"] = "actual-api-uid-" + str(self.starts)
                review = {**outer.review(), "object": pod, "uid": "actual-review-" + str(self.starts)}
                outer.guard.validate(review)
                self.starts += 1
                self.objects = [pod["metadata"]["uid"]]
                return {"pool": outer.policy["pool"], "uid": pod["metadata"]["uid"], "container": "exact-container", "node": "exact-node", "storage": contract["storage"]}
        runtime = ProtectedRuntime()
        authority = Authority(ledger, self.policy, b"r" * 32, b"a" * 32, runtime)
        authority.call(request(b"r" * 32, "acknowledgeEpoch", {"expectedGeneration": 0, "epoch": "epoch-1"}))
        snapshot = sqlite3.connect(":memory:")
        self.addCleanup(snapshot.close)
        ledger.db.backup(snapshot)
        envelope = request(b"r" * 32, "authorizeInvocation", self.contract)
        envelope["body"]["highWater"] = ledger.watermark()
        envelope["mac"] = sign(b"r" * 32, "request", envelope["body"])
        authority.call(envelope)
        self.assertEqual(runtime.starts, 1)
        snapshot.backup(ledger.db)
        runtime.objects = []  # removed runtime object/name no longer protects us
        authority.call(envelope)  # exact captured old floor/signature, still valid
        self.assertEqual(runtime.starts, 1)
        self.assertEqual(len(self.consumer.history()), 1)
        self.assertEqual(ledger.db.execute("SELECT phase FROM commands").fetchone()[0], "uncertain")

    def test_malformed_native_allow_is_not_truthiness(self):
        class Malformed:
            def consume(self, binding):
                return {"consumed": 1, "bindingHash": digest(binding)}
        self.guard.launch_consumer = Malformed()
        with self.assertRaisesRegex(Held, "unconfirmed"):
            self.guard.validate(self.review())
