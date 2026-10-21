"""Actual kind fixture only; broad host Docker/admin/CRI authority NEVER ships.

Requires a specifically named disposable kind cluster and explicit kubeconfig.
Does not read the default kubeconfig, real credentials or homelab state. The
fixture observer's protected pin file is not a production node-attestation agent.
"""
import base64
import copy
import hashlib
import ssl
import socket
import urllib.request
import urllib.error
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid
from authority import Held, canonical, digest, sign
from cri_stop_witness import ExactCRIStopWitness
from kubernetes_boundary import KubernetesRuntime, WorkloadGuard, PREFIX, FINALIZER
from test_kubernetes_boundary import fixture

CLUSTER = "pc-protected-disposable"
CONTROL, EXECUTION = "pc-protected-control", "pc-protected-execution"
NODE = CLUSTER + "-control-plane"
PACKAGE = Path(__file__).resolve().parent


def command(argv, data=None, check=True):
    result = subprocess.run(argv, input=data, capture_output=True, timeout=60)
    if check and result.returncode:
        # Fixture errors contain no provider credentials; avoid kubeconfig/token.
        raise RuntimeError(result.stderr.decode()[-3000:])
    return result


class Cluster:
    def __init__(self, kubeconfig):
        self.kubeconfig = str(Path(kubeconfig).resolve())
        config = json.loads(command(["kubectl", "--kubeconfig", self.kubeconfig, "config", "view", "--raw", "-o", "json"]).stdout)
        if config["current-context"] != "kind-" + CLUSTER or len(config["clusters"]) != 1:
            raise Held("fixture_requires_explicit_kind_context")
        if not config["clusters"][0]["cluster"]["server"].startswith("https://127.0.0.1:"):
            raise Held("fixture_requires_loopback_api")
        labels = json.loads(command(["docker", "inspect", NODE, "--format", "{{json .Config.Labels}}" ]).stdout)
        if labels.get("io.x-k8s.kind.cluster") != CLUSTER:
            raise Held("not_disposable_kind_node")

    def kubectl(self, *args, data=None, user=None, check=True):
        argv = ["kubectl", "--kubeconfig", self.kubeconfig, "--request-timeout=45s"]
        if user:
            argv += ["--as", user]
        return command([*argv, *args], data=data, check=check)

    def install(self, *objects):
        return self.kubectl("apply", "-f", "-", data=canonical({"apiVersion": "v1", "kind": "List", "items": list(objects)}))


class NamespacedAPI:
    """Fixture transport impersonates the exact SA to exercise real RBAC.

    Production uses a bound, audience-limited token/CA and an explicit endpoint;
    admin impersonation and generic kubectl access belong ONLY to this harness.
    """
    def __init__(self, cluster):
        self.cluster = cluster
        self.user = "system:serviceaccount:" + CONTROL + ":supervisor"

    def get(self, kind, name=None):
        args = ["-n", EXECUTION, "get", kind]
        if name:
            args.append(name)
        return json.loads(self.cluster.kubectl(*args, "-o", "json", user=self.user).stdout)

    def get_storage(self, name):
        return self.get("pvc", name)

    def list_pods(self):
        return self.get("pods")["items"]

    def get_pod(self, name):
        return self.get("pod", name)

    def create_pod(self, manifest):
        manifest = copy.deepcopy(manifest)
        if hasattr(self, "supplied_uid"):
            manifest["metadata"]["uid"] = self.supplied_uid
        return json.loads(self.cluster.kubectl("create", "-f", "-", "-o", "json", data=canonical(manifest), user=self.user).stdout)

    def delete_pod(self, name, options):
        path = "/api/v1/namespaces/" + EXECUTION + "/pods/" + name
        return json.loads(self.cluster.kubectl("delete", "--raw", path, "-f", "-", data=canonical(options), user=self.user).stdout)


class FixtureNodeObserver:
    """Trusted test host, independent from supervisor/provider, durable UID pins.

    DO NOT deploy: this uses broad Docker/CRI authority. Production still needs a
    reviewed observation service or operator/node-evidence path with narrower
    authority. Missing sandbox/cgroup metadata is always uncertain.
    """
    def __init__(self, policy, key, pins, cluster):
        self.policy, self.key, self.pins, self.cluster = policy, key, Path(pins), cluster
        self.partitioned = False
        self.stop_retry_evidence = []
        self.binding = json.loads(self.pins.read_bytes()) if self.pins.exists() else {}
        self.cri = ExactCRIStopWitness(str(self.pins) + ".sqlite", key, digest(policy), EXECUTION,
            self.node, self.incarnation, self.retiring_pod)

    def retiring_pod(self, physical):
        pods = [p for p in NamespacedAPI(self.cluster).list_pods() if p["metadata"]["uid"] == physical["uid"]]
        if len(pods) != 1:
            raise Held("exact_pod_missing")
        return pods[0]

    def stop_exact(self, physical):
        # Fixture scheduling race only: kubelet and this observer can both issue
        # the idempotent exact StopPodSandbox after API deletion. ptp DEL can
        # report its already-removed eth0 while those calls overlap. No error is
        # success: every retry re-enters the unchanged witness transaction, which
        # revalidates the original Pod/runtime/sandbox/container and persists a
        # receipt only after an actual ZERO-exit StopPodSandbox RPC.
        physical = copy.deepcopy(physical)
        sandbox = self.binding[physical["uid"]]["sandbox"]
        entry = {"scope": "disposable fixture CNI race retry", "sandbox": sandbox,
            "attempts": 0, "retries": 0, "firstError": None, "status": "pending", "stableRetirement": False}
        self.stop_retry_evidence.append(entry)
        try:
            for attempt in range(3):
                entry["attempts"] += 1
                try:
                    reply = self.cri.stop(physical, str(uuid.uuid4()))
                except RuntimeError as error:
                    if entry["firstError"] is None: entry["firstError"] = str(error)[:3000]
                    # Only this exact observed CNI DEL error for the pinned
                    # sandbox is eligible. Timeout, absence, metadata/runtime
                    # change and every other error retain the original hold.
                    normalized = re.sub(r'\\+"', '"', str(error))
                    expected = ('failed to destroy network for sandbox "' + sandbox +
                        '": plugin type="ptp" failed (delete): failed to delete "eth0": no such device')
                    if expected not in normalized or attempt == 2:
                        raise
                    entry["retries"] += 1
                    time.sleep(.2 * (attempt + 1))
                    continue
                entry["status"] = "actual-witness-receipt-returned"
                return reply
        except BaseException as error:
            if entry["firstError"] is None: entry["firstError"] = str(error)[:3000]
            entry["status"] = "held"
            raise

    def node(self, *args):
        if self.partitioned:
            raise Held("synthetic_node_partition")
        return command(["docker", "exec", NODE, *args]).stdout.decode().strip()

    def incarnation(self):
        pid = self.node("pidof", "containerd").split()
        if len(pid) != 1:
            raise Held("runtime_incarnation_unknown")
        return digest([self.node("cat", "/proc/sys/kernel/random/boot_id"), self.node("cat", "/proc/" + pid[0] + "/stat").split()[21]])

    def attest(self, configuration):
        # Actual independent API guard/RBAC installation is checked by main's
        # negatives before any ACK. Not a production authenticated attestation.
        if configuration != digest(self.policy):
            raise Held("wrong_guard_configuration")
        return {"authority": self.policy["runtimeAuthority"], "configuration": configuration}

    def bind(self, physical):
        pods = json.loads(self.node("crictl", "pods", "-o", "json"))["items"]
        pods = [p for p in pods if p["metadata"]["uid"] == physical["uid"] and p["metadata"]["namespace"] == EXECUTION]
        if len(pods) != 1:
            raise Held("unknown_exact_sandbox")
        info = json.loads(self.node("crictl", "inspect", physical["container"].split("://")[1]))
        cg = info["info"]["runtimeSpec"]["linux"]["cgroupsPath"]
        # Fixed fixture QoS; never execute provider-supplied paths or shell text.
        parent = cg.split(":")[0]
        expected = "kubepods-burstable-pod" + physical["uid"].replace("-", "_") + ".slice"
        if parent not in (expected, "kubelet-" + expected):
            raise Held("unexpected_fixture_cgroup")
        paths = self.node("find", "/sys/fs/cgroup", "-type", "d", "-name", parent).splitlines()
        if len(paths) != 1:
            raise Held("unknown_exact_cgroup")
        entry = {"physical": physical, "runtime": self.incarnation(), "sandbox": pods[0]["id"],
                 "cgroup": paths[0] + "/cgroup.events"}
        if physical["uid"] in self.binding and self.binding[physical["uid"]] != entry:
            raise Held("witness_binding_conflict")
        self.binding[physical["uid"]] = entry
        fd = os.open(self.pins, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, canonical(self.binding))
            os.fsync(fd)
        finally:
            os.close(fd)
        self.cri.pin(physical, pods[0]["id"])

    def observe(self, physical, challenge):
        receipt = self.cri.db.execute("SELECT receipt FROM pins WHERE uid=?", (physical["uid"],)).fetchone()
        if receipt and receipt[0]:
            return self.cri.stop(physical, challenge)
        binding = self.binding[physical["uid"]]
        if binding["physical"] != physical or self.incarnation() != binding["runtime"]:
            raise Held("runtime_incarnation_changed")
        sandbox = json.loads(self.node("crictl", "inspectp", binding["sandbox"]))["status"]
        containers = json.loads(self.node("crictl", "ps", "-a", "--pod", binding["sandbox"], "-o", "json"))["containers"]
        cgroup = self.node("cat", binding["cgroup"])
        body = {"challenge": challenge, "physical": physical, "configuration": digest(self.policy), "observedAt": int(time.time() * 1000),
                "runtime": {"node": physical["node"], "incarnation": binding["runtime"]},
                "sandbox": {"uid": sandbox["id"], "state": sandbox["state"], "podUid": sandbox["metadata"]["uid"]},
                "containers": [{"id": "containerd://" + c["id"], "state": c["state"]} for c in containers],
                "cgroupEmpty": "populated 0" in cgroup.splitlines()}
        return {"body": body, "mac": sign(self.key, "whole-pod-observation-v1", body)}


def security(uid):
    return {"runAsNonRoot": True, "runAsUser": uid, "runAsGroup": uid, "fsGroup": uid,
            "seccompProfile": {"type": "RuntimeDefault"}}


def provision(cluster, guard, image, temp, contract=None, client_certificate=None, admission_path="/validate", native_backend=None, fixture_faults=False):
    (temp / "apiserver-client.crt").write_bytes(Path(client_certificate).read_bytes())
    for name in (CONTROL, EXECUTION):
        cluster.install({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": name, "labels": {
            "paperclip.fixture": "protected", "pod-security.kubernetes.io/enforce": "restricted"}}})
    cluster.install(
        {"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": {"name": "current-history", "namespace": CONTROL},
            "spec": {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": "64Mi"}}}},
        {"apiVersion": "v1", "kind": "ServiceAccount", "metadata": {"name": "supervisor", "namespace": CONTROL}, "automountServiceAccountToken": False},
        {"apiVersion": "v1", "kind": "ServiceAccount", "metadata": {"name": "paperclip-provider", "namespace": EXECUTION}, "automountServiceAccountToken": False},
        {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role", "metadata": {"name": "supervisor", "namespace": EXECUTION}, "rules": [
            {"apiGroups": [""], "resources": ["pods"], "verbs": ["create", "get", "list", "delete"]},
            {"apiGroups": [""], "resources": ["persistentvolumeclaims"], "resourceNames": ["attempt-state"], "verbs": ["get"]}]},
        {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding", "metadata": {"name": "supervisor", "namespace": EXECUTION},
            "subjects": [{"kind": "ServiceAccount", "name": "supervisor", "namespace": CONTROL}],
            "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "supervisor"}},
        {"apiVersion": "v1", "kind": "ResourceQuota", "metadata": {"name": "execution", "namespace": EXECUTION},
            "spec": {"hard": {"pods": "1", "persistentvolumeclaims": "1", "requests.storage": "128Mi", "requests.cpu": "500m", "requests.memory": "128Mi", "limits.cpu": "1", "limits.memory": "256Mi"}}},
        {"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": {"name": "attempt-state", "namespace": EXECUTION},
            "spec": {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": "128Mi"}}}},
        {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": {"name": "deny-all", "namespace": EXECUTION},
            "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]}})
    for storage in guard.storages.values():
        storage["uid"] = NamespacedAPI(cluster).get_storage(storage["name"])["metadata"]["uid"]
    (temp / "journal.key").write_bytes(guard.journal_key)
    # Fixture-only self-signed cert and source/config. Never use these keys live.
    command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", str(temp / "tls.key"),
             "-out", str(temp / "tls.crt"), "-subj", "/CN=guard." + CONTROL + ".svc",
             "-addext", "subjectAltName=DNS:guard." + CONTROL + ".svc"])
    config = {"namespace": guard.namespace, "supervisor_user": guard.supervisor_user, "policy": guard.policy,
              "images": guard.images, "storages": guard.storages}
    namespace_uid = json.loads(cluster.kubectl("get", "namespace", EXECUTION, "-o", "json").stdout)["metadata"]["uid"]
    cluster_uid = json.loads(cluster.kubectl("get", "namespace", "kube-system", "-o", "json").stdout)["metadata"]["uid"]
    target = {"storage": contract["storage"], "pvcUid": guard.storages[contract["storage"]]["uid"],
        "pvcName": "attempt-state", "image": image, "template": "synthetic"}
    config["apiserver_fingerprint"] = hashlib.sha256(ssl.PEM_cert_to_DER_cert((temp / "apiserver-client.crt").read_text())).hexdigest()
    config["admission_identity"] = {"cluster": cluster_uid, "namespaceUid": namespace_uid, "webhook": "guard.paperclip.fixture"}
    extra_tls = {}
    if native_backend is None:
        config["disposable_current_authority"] = {"contract": contract, "target": target}
    else:
        # Native integration is initialized only after the API has assigned the
        # real namespace/PVC UIDs. No SQLite fallback or pre-generated UID map.
        prepared = native_backend(config["admission_identity"], target, guard.policy)
        contract = prepared["contract"]
        guard.journal_key = bytes.fromhex(prepared["journalKeyHex"])
        guard.storages[target["storage"]]["owner"] = digest(contract["owner"])
        config["storages"] = guard.storages
        config["native_consumer"] = prepared["native_consumer"]
        extra_tls = prepared["tls_files"]
        if set(extra_tls) != {"native-ca.crt", "native-client.crt", "native-client.key"}:
            raise Held("exact_disposable_native_client_tls_required")
        (temp / "journal.key").write_bytes(guard.journal_key)
        for name, source in extra_tls.items():
            (temp / name).write_bytes(Path(source).read_bytes())
    cluster.install(
        {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "guard-tls", "namespace": CONTROL},
         "data": {n: base64.b64encode((temp / n).read_bytes()).decode() for n in ("tls.crt", "tls.key", "journal.key", "apiserver-client.crt", *extra_tls)}},
        {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "guard-source", "namespace": CONTROL},
         "data": {n: (PACKAGE / n).read_text() for n in ("authority.py", "kubernetes_boundary.py", "admission_webhook.py", "launch_consumption.py")}},
        {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "guard-config", "namespace": CONTROL}, "data": {"guard.json": canonical(config).decode()}},
        {"apiVersion": "v1", "kind": "Service", "metadata": {"name": "guard", "namespace": CONTROL},
         "spec": {"selector": {"app": "guard"}, "ports": [{"port": 443, "targetPort": 8443}]}},
        {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": "guard", "namespace": CONTROL},
         "spec": {"replicas": 1, "selector": {"matchLabels": {"app": "guard"}}, "template": {
            "metadata": {"labels": {"app": "guard"}, "annotations": {"fixture-revision": digest([config, (temp / "tls.crt").read_text(), (PACKAGE / "kubernetes_boundary.py").read_text(), (PACKAGE / "admission_webhook.py").read_text()])}}, "spec": {"automountServiceAccountToken": False, "terminationGracePeriodSeconds": 1, "securityContext": security(2000),
            "containers": [{"name": "guard", "image": image, "imagePullPolicy": "Never", "command": ["python3", "/app/admission_webhook.py"],
                "readinessProbe": {"tcpSocket": {"port": 8443}, "periodSeconds": 1},
                "env": [{"name": "PYTHONDONTWRITEBYTECODE", "value": "1"}] + ([{"name": "PAPERCLIP_DISPOSABLE_CURRENT_AUTHORITY", "value": "yes"}] if native_backend is None else ([{"name": "PAPERCLIP_DISPOSABLE_ADMISSION_FAULTS", "value": "yes"}] if admission_path != "/validate" or fixture_faults else [])),
                "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
                "resources": {"limits": {"cpu": "250m", "memory": "128Mi"}},
                "volumeMounts": [{"name": n, "mountPath": p, "readOnly": True} for n, p in (("source", "/app"), ("config", "/config"), ("tls", "/tls"))] + [{"name": "current", "mountPath": "/current"}]}],
            "volumes": [{"name": "source", "configMap": {"name": "guard-source"}}, {"name": "config", "configMap": {"name": "guard-config"}},
                        {"name": "tls", "secret": {"secretName": "guard-tls", "defaultMode": 0o440}}, {"name": "current", "persistentVolumeClaim": {"claimName": "current-history"}}]}}}})
    cluster.kubectl("-n", CONTROL, "rollout", "status", "deployment/guard", "--timeout=45s")
    cluster.install({"apiVersion": "admissionregistration.k8s.io/v1", "kind": "ValidatingWebhookConfiguration", "metadata": {"name": "pc-protected-fixture"},
        "webhooks": [{"name": "guard.paperclip.fixture", "admissionReviewVersions": ["v1"], "sideEffects": "NoneOnDryRun", "failurePolicy": "Fail", "timeoutSeconds": 5,
            "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": EXECUTION}},
            "clientConfig": {"service": {"namespace": CONTROL, "name": "guard", "path": admission_path}, "caBundle": base64.b64encode((temp / "tls.crt").read_bytes()).decode()},
            "rules": [{"apiGroups": [""], "apiVersions": ["v1"], "resources": ["pods", "pods/ephemeralcontainers"], "operations": ["CREATE", "UPDATE", "DELETE"], "scope": "Namespaced"}]}]})

    return contract


def main():
    cluster = Cluster(sys.argv[1])
    result = {"scope": "disposable kind, synthetic CLI only", "productionAcceptance": False, "checks": []}
    p, c, _ = fixture()
    p["runtimeAuthority"] = "fixture-kind-namespace"
    c["policy"] = digest(p)
    child_code = "import time; f=open('/attempt/ticks','ab',buffering=0)\nwhile True:\n f.write(b'tick\\n'); time.sleep(.1)"
    c["argv"] = ["-c", "import os,time,subprocess; assert os.getuid()==1000; assert not os.path.exists('/var/run/secrets/kubernetes.io/serviceaccount/token'); subprocess.Popen(['python3','-c'," + repr(child_code) + "],start_new_session=True); time.sleep(550)"]
    c["commandHash"] = digest(c["argv"])
    images = command(["docker", "exec", NODE, "ctr", "-n", "k8s.io", "images", "list"]).stdout.decode().splitlines()
    imported = [line.split()[2] for line in images if line.startswith("docker.io/library/python:3.11-slim-bookworm ")]
    assert len(imported) == 1
    image = "docker.io/library/python@" + imported[0]
    command(["docker", "exec", NODE, "ctr", "-n", "k8s.io", "images", "tag", "--force", "docker.io/library/python:3.11-slim-bookworm", image])
    p["templates"]["synthetic"]["image"] = image
    c["policy"] = digest(p)
    api = NamespacedAPI(cluster)
    guard = WorkloadGuard(EXECUTION, api.user, p, {"synthetic": image},
        {c["storage"]: {"name": "attempt-state", "uid": "pending", "owner": digest(c["owner"]) }}, journal_key=os.urandom(32))
    with tempfile.TemporaryDirectory(prefix="pc-kind-") as directory:
        temp = Path(directory)
        provision(cluster, guard, image, temp, copy.deepcopy(c), sys.argv[2])
        # A copied AdmissionReview has no authority without the configured
        # API-server client certificate. Port-forward is fixture operator access;
        # it grants no TLS client identity and is unavailable to provider Pods.
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        forward = subprocess.Popen(["kubectl", "--kubeconfig", cluster.kubeconfig, "-n", CONTROL, "port-forward", "--address", "127.0.0.1", "service/guard", str(port) + ":443"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(100):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=.1):
                        break
                except OSError:
                    time.sleep(.05)
            context = ssl.create_default_context(cafile=str(temp / "tls.crt"))
            context.check_hostname = False  # loopback fixture; explicit test CA
            try:
                urllib.request.urlopen(urllib.request.Request("https://127.0.0.1:" + str(port) + "/validate", data=canonical({"apiVersion": "admission.k8s.io/v1", "kind": "AdmissionReview", "request": {"uid": "copied-review"}})), context=context, timeout=3)
            except (urllib.error.URLError, ssl.SSLError, ConnectionError) as error:
                assert "CERTIFICATE" in str(error).upper() or "EOF" in str(error).upper() or "RESET" in str(error).upper(), str(error)
            else:
                raise AssertionError("copied unauthenticated review reached admission")
        finally:
            forward.terminate()
            forward.wait(timeout=5)
        result["checks"].append("webhook requires pinned API-server client TLS; copied unauthenticated review refused before consumption")
        pvc = api.get_storage("attempt-state")
        guard.storages[c["storage"]]["uid"] = pvc["metadata"]["uid"]
        # UID check is supervisor-side; immutable webhook PVC-name/owner map is
        # independently installed. Storage fencing/CAS integration remains open.
        denied = [("get", "secrets", "-n", EXECUTION), ("get", "nodes"), ("get", "pods", "-n", CONTROL),
                  ("create", "pods", "--subresource=exec", "-n", EXECUTION), ("patch", "pods", "-n", EXECUTION),
                  ("create", "persistentvolumeclaims", "-n", EXECUTION), ("create", "roles", "-n", EXECUTION)]
        for args in denied:
            response = cluster.kubectl("auth", "can-i", *args, user=api.user, check=False)
            assert response.stdout.strip() == b"no", (args, response.stdout)
        result["checks"].append("real RBAC refuses secrets/nodes/control Pods/exec/patch/PVC creation/RBAC writes")
        # API admission negatives use --dry-run=server to avoid creating any
        # forbidden object; a matching valid control proves webhook availability.
        def grant():
            core = {k: v for k, v in c.items() if k != "journalGrant"}
            body = {"contract": core, "target": {"storage": c["storage"], "pvcUid": guard.storages[c["storage"]]["uid"],
                "pvcName": "attempt-state", "image": image, "template": "synthetic"}, "expires": int(time.time()) + 55}
            c["journalGrant"] = {"body": body, "mac": sign(guard.journal_key, "native-journal-grant-v1", body)}
        grant()
        approved = guard.manifest(c)
        def dry(pod, allowed=False):
            response = cluster.kubectl("create", "--dry-run=server", "-f", "-", data=canonical(pod), user=api.user, check=False)
            assert (response.returncode == 0) == allowed, response.stderr.decode()
        dry(approved)
        mutations = [lambda x: x["spec"].update(hostNetwork=True),
            lambda x: x["spec"].update(automountServiceAccountToken=True),
            lambda x: x["spec"].update(serviceAccountName="default"),
            lambda x: x["spec"]["containers"][0].update(image="unapproved:latest"),
            lambda x: x["spec"]["containers"][0]["securityContext"].update(privileged=True),
            lambda x: x["spec"]["volumes"][0].update(persistentVolumeClaim={"claimName": "canonical"}),
            lambda x: x["spec"]["volumes"].append({"name": "host", "hostPath": {"path": "/"}}),
            lambda x: x["spec"]["containers"].append(copy.deepcopy(x["spec"]["containers"][0])),
            lambda x: x["metadata"]["annotations"].update({"injector.example/enable": "true"})]
        for mutate in mutations:
            bad = copy.deepcopy(approved)
            mutate(bad)
            dry(bad)
        result["checks"].append("real API rejects nine forbidden workload variants and valid dry-run without consumption")
        # FailurePolicy=Fail must actually reject when independent guard is down.
        cluster.kubectl("-n", CONTROL, "scale", "deployment/guard", "--replicas=0")
        cluster.kubectl("-n", CONTROL, "wait", "--for=delete", "pod", "-l", "app=guard", "--timeout=30s")
        dry(approved)
        cluster.kubectl("-n", CONTROL, "scale", "deployment/guard", "--replicas=1")
        cluster.kubectl("-n", CONTROL, "rollout", "status", "deployment/guard", "--timeout=45s")
        for _ in range(40):
            response = cluster.kubectl("create", "--dry-run=server", "-f", "-", data=canonical(approved), user=api.user, check=False)
            # A dry-run refusal proves the live authenticated guard replied.
            # TCP readiness alone cannot exclude stale Service endpoint routing.
            if b"protected workload contract refused" in response.stderr:
                break
            time.sleep(.5)
        assert response.returncode != 0 and b"protected workload contract refused" in response.stderr, response.stderr.decode()
        result["checks"].append("guard outage fails closed")
        api.supplied_uid = "00000000-0000-0000-0000-000000000001"
        key = os.urandom(32)
        witness = FixtureNodeObserver(p, key, temp / "pins.json", cluster)
        runtime = KubernetesRuntime(p, guard, api, witness, key)
        grant()
        physical = runtime.launch(c, p["templates"]["synthetic"])
        assert runtime.inspect(physical)["status"] == "running"
        def history():
            code = "import sqlite3,json; print(json.dumps([json.loads(r[0]) for r in sqlite3.connect('/current/launch.sqlite').execute('select binding from consumes')]))"
            return json.loads(cluster.kubectl("-n", CONTROL, "exec", "deployment/guard", "--", "python3", "-c", code).stdout)
        consumed = history()
        assert len(consumed) == 1 and consumed[0]["podUid"] == physical["uid"]
        assert consumed[0]["podUid"] != api.supplied_uid
        assert consumed[0]["reviewUid"] != consumed[0]["podUid"]
        result["createConsumption"] = consumed[0]
        result["kubernetesVersion"] = json.loads(cluster.kubectl("version", "-o", "json").stdout)["serverVersion"]["gitVersion"]
        assert result["kubernetesVersion"] == "v1.34.0"
        result["checks"].append("v1.34.0 validating CREATE sees server UID retained by persisted Pod; caller UID replaced; review UID distinct")
        root = "/var/local-path-provisioner/"
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            paths = witness.node("find", root, "-name", "ticks", "-type", "f").splitlines()
            if paths:
                break
            time.sleep(.1)
        assert len(paths) == 1, "synthetic descendant failed before cancellation"
        result["physical"] = physical
        result["checks"].append("actual non-root provider with descendant, exact Pod/container/PVC identity and independent runtime pin")
        witness.partitioned = True
        assert runtime.inspect(physical)["status"] == "uncertain"
        witness.partitioned = False
        witness = FixtureNodeObserver(p, key, temp / "pins.json", cluster)
        runtime.witness = witness
        assert runtime.inspect(physical)["status"] == "running"
        result["checks"].append("observer disconnect holds; independent observer restart retains exact binding")
        try:
            runtime.stop_and_inspect(physical)
        finally:
            # Retain retry diagnostics even if all attempts remain held. This
            # record is not a successful stop or production/runtime fence proof.
            result["fixtureStopRaceRetries"] = witness.stop_retry_evidence
            print(json.dumps({"scope": "fixture stop retry diagnostics", "productionAcceptance": False,
                "attempts": witness.stop_retry_evidence}), flush=True)
        deadline = time.monotonic() + 20
        observation = None
        while time.monotonic() < deadline:
            observation = runtime.inspect(physical)
            if observation["status"] == "confirmed_stopped":
                break
            time.sleep(.1)
        assert observation["status"] == "confirmed_stopped", observation
        result["stopEvidence"] = observation
        result["checks"].append("exact-UID graceful delete plus retained terminal Pod AND durable independent exact StopPodSandbox RPC receipt")
        # Retained fixture volume read is host/runtime inspection, no provider exec.
        root = "/var/local-path-provisioner/"
        paths = witness.node("find", root, "-name", "ticks", "-type", "f").splitlines()
        assert len(paths) == 1, paths
        before = witness.node("cat", paths[0])
        assert before
        time.sleep(.5)
        assert witness.node("cat", paths[0]) == before
        result["checks"].append("uncommitted descendant output retained byte-identically after whole-Pod stop")
        pod = runtime._pod(physical)
        denied_delete = cluster.kubectl("delete", "--raw", "/api/v1/namespaces/" + EXECUTION + "/pods/" + pod["metadata"]["name"], "-f", "-",
            data=canonical({"apiVersion": "v1", "kind": "DeleteOptions", "gracePeriodSeconds": 0}), user=api.user, check=False)
        assert denied_delete.returncode != 0
        # Admin removes webhook only for deliberate forced-loss injection/cleanup.
        # The supervisor cannot do this. Missing Pod MUST remain uncertain.
        webhook = json.loads(cluster.kubectl("get", "validatingwebhookconfiguration", "pc-protected-fixture", "-o", "json").stdout)
        cluster.kubectl("delete", "validatingwebhookconfiguration", "pc-protected-fixture")
        cluster.kubectl("-n", EXECUTION, "patch", "pod", pod["metadata"]["name"], "--type=merge", "-p", '{"metadata":{"finalizers":[]}}')
        assert runtime.inspect(physical)["status"] == "uncertain"
        result["checks"].append("supervisor force-delete refused; externally removed Pod is uncertain despite prior stop")
        cluster.kubectl("-n", EXECUTION, "wait", "--for=delete", "pod/" + pod["metadata"]["name"], "--timeout=20s")
        # Restore enforcing webhook; old captured authorization plus runtime-object
        # removal/new CREATE cannot consume again. No supervisor history is read.
        webhook["metadata"] = {"name": "pc-protected-fixture"}
        cluster.install(webhook)
        replay = guard.manifest(c)
        assert c["journalGrant"]["body"]["expires"] > time.time(), "captured replay must still be valid"
        for _ in range(2):
            response = cluster.kubectl("create", "-f", "-", data=canonical(replay), user=api.user, check=False)
            assert response.returncode != 0, "old valid envelope recreated removed Pod"
        assert history() == consumed
        code = "import sqlite3,json; print(json.dumps([{'binding':json.loads(r[0]),'outcome':r[1]} for r in sqlite3.connect('/current/launch.sqlite').execute('select binding,outcome from attempts')]))"
        attempts = json.loads(cluster.kubectl("-n", CONTROL, "exec", "deployment/guard", "--", "python3", "-c", code).stdout)
        assert len(attempts) == 3 and [x["outcome"] for x in attempts] == ["consumed", "denied_consumed", "denied_consumed"]
        assert len({x["binding"]["podUid"] for x in attempts}) == 3
        assert len({x["binding"]["reviewUid"] for x in attempts}) == 3
        result["createRetryAttempts"] = attempts
        assert api.list_pods() == []
        # Restart independently retained current authority and repeat; consumed
        # state is held on its own PVC, outside supervisor/runtime restoration.
        cluster.kubectl("-n", CONTROL, "rollout", "restart", "deployment/guard")
        cluster.kubectl("-n", CONTROL, "rollout", "status", "deployment/guard", "--timeout=45s")
        grant()  # fresh signature of same journal must not reopen consumed permit
        response = cluster.kubectl("create", "-f", "-", data=canonical(guard.manifest(c)), user=api.user, check=False)
        assert response.returncode != 0 and history() == consumed
        assert witness.node("cat", paths[0]) == before
        result["checks"].append("old valid envelope denied after runtime Pod removal; repeated CREATE/new UID and current-authority restart cannot consume again")
        result["gaps"] = ["fixture host observer has broad authority and is not deployable", "kind default CNI does not enforce NetworkPolicy; no network containment pass",
            "static attempt PVC map is not complete durable storage fencing", "native DB journal/high-water integration and remaining requested work are pending"]
        result["status"] = "PASS"
    print(json.dumps(result, indent=2))


def cleanup(cluster):
    cluster.kubectl("delete", "validatingwebhookconfiguration", "pc-protected-fixture", "--ignore-not-found", check=False)
    pods = json.loads(cluster.kubectl("-n", EXECUTION, "get", "pods", "-o", "json").stdout)["items"]
    for pod in pods:
        cluster.kubectl("-n", EXECUTION, "patch", "pod", pod["metadata"]["name"], "--type=merge", "-p", '{"metadata":{"finalizers":[]}}', check=False)
    for namespace in (EXECUTION, CONTROL):
        cluster.kubectl("delete", "namespace", namespace, "--ignore-not-found", "--wait=false", check=False)


if __name__ == "__main__":
    try:
        main()
    finally:
        cleanup(Cluster(sys.argv[1]))
