"""Actual scoped-token API wire fixture in the explicit disposable kind cluster.

Fixture operator kubectl/Docker provisions the existing isolated webhook. The API
client itself uses only pinned HTTPS+memory-only short-lived SA bearer auth. This
fixture's independent current consumer is SQLite, NOT assembled native admission.
/bin/sleep is bounded and synthetic; API deletion never means stable retirement.
"""
import argparse
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time

from authority import Held, digest, sign
from kubernetes_api import KubernetesAPI
from kubernetes_boundary import WorkloadGuard
from test_kubernetes_api import OTHER_CA
from test_kubernetes_boundary import fixture
from test_kubernetes_disposable import Cluster, NamespacedAPI, NODE, CONTROL, EXECUTION, command, provision, cleanup


def expect_held(operation):
    try: operation()
    except Held: return
    raise AssertionError("expected scoped API refusal")


def configure_running_contract(policy, contract, image):
    # A terminal or unscheduled Pod's deletion grace is normalized to zero by
    # Kubernetes before admission. Exercise the unchanged graceful-delete guard
    # with a scheduled running Pod; this never establishes runtime stop proof.
    policy["templates"]["synthetic"].update(image=image, entrypoint="/bin/sleep")
    contract["argv"] = ["60"]
    contract["commandHash"] = digest(contract["argv"])
    contract["policy"] = digest(policy)


def run(args):
    cluster = Cluster(args.kubeconfig)
    for namespace in (CONTROL, EXECUTION):
        observed = cluster.kubectl("get", "namespace", namespace, "-o", "json", check=False)
        if observed.returncode == 0:
            cluster.kubectl("wait", "--for=delete", "namespace/" + namespace, "--timeout=45s")
            observed = cluster.kubectl("get", "namespace", namespace, "-o", "json", check=False)
        if observed.returncode == 0 or b"Error from server (NotFound)" not in observed.stderr:
            raise Held("scoped_api_fixture_requires_fresh_namespaces")
    try:
        policy, contract, _ = fixture()
        policy["runtimeAuthority"] = "fixture-kind-namespace"
        lines = command(["docker", "exec", NODE, "ctr", "-n", "k8s.io", "images", "list"]).stdout.decode().splitlines()
        imported = [line.split()[2] for line in lines if line.startswith("docker.io/library/python:3.11-slim-bookworm ")]
        assert len(imported) == 1
        image = "docker.io/library/python@" + imported[0]
        command(["docker", "exec", NODE, "ctr", "-n", "k8s.io", "images", "tag", "--force", "docker.io/library/python:3.11-slim-bookworm", image])
        configure_running_contract(policy, contract, image)
        setup_api = NamespacedAPI(cluster)  # trusted fixture setup ONLY
        guard = WorkloadGuard(EXECUTION, setup_api.user, policy, {"synthetic": image},
            {contract["storage"]: {"name": "attempt-state", "uid": "pending", "owner": digest(contract["owner"])}}, journal_key=os.urandom(32))
        with tempfile.TemporaryDirectory(prefix="pc-scoped-api-") as directory:
            temp = Path(directory)
            provision(cluster, guard, image, temp, copy.deepcopy(contract), args.apiserver_certificate)
            config = json.loads(cluster.kubectl("config", "view", "--raw", "-o", "json").stdout)
            ca = base64.b64decode(config["clusters"][0]["cluster"]["certificate-authority-data"], validate=True)
            ca_file = temp / "api-ca.pem"; ca_file.write_bytes(ca)
            bad_ca = temp / "unrelated-ca.pem"; bad_ca.write_text(OTHER_CA)
            origin = config["clusters"][0]["cluster"]["server"]
            # This token is neither printed nor persisted. All subsequent client
            # requests use actual bearer auth, never kubectl impersonation.
            token = cluster.kubectl("-n", CONTROL, "create", "token", "supervisor", "--duration=10m").stdout.decode().strip()
            options = dict(origin=origin, ca_file=str(ca_file), bearer_token=token, namespace=EXECUTION,
                pvc_name="attempt-state", pvc_uid=guard.storages[contract["storage"]]["uid"], timeout=3)
            api = KubernetesAPI(**options)
            observed_pvc = api.get_storage("attempt-state")
            expect_held(lambda: KubernetesAPI(**{**options, "pvc_uid": "wrong-pvc-incarnation"}).get_storage("attempt-state"))
            expect_held(lambda: KubernetesAPI(**{**options, "ca_file": str(bad_ca)}).list_pods())
            expect_held(lambda: KubernetesAPI(**{**options, "bearer_token": "synthetic-invalid-bearer"}).list_pods())
            assert api.list_pods() == []
            target = {"storage": contract["storage"], "pvcUid": options["pvc_uid"], "pvcName": "attempt-state", "image": image, "template": "synthetic"}
            grant = {"contract": copy.deepcopy(contract), "target": target, "expires": int(time.time()) + 55}
            contract["journalGrant"] = {"body": grant, "mac": sign(guard.journal_key, "native-journal-grant-v1", grant)}
            # Warm/attest the webhook before any actual CREATE. This dry-run is
            # fixture operator traffic, never an adapter retry or dispatch.
            manifest = guard.manifest(contract)
            for _ in range(40):
                ready = cluster.kubectl("create", "--dry-run=server", "-f", "-", data=json.dumps(manifest).encode(), check=False)
                if b"protected workload contract refused" in ready.stderr: break
                time.sleep(.1)
            assert b"protected workload contract refused" in ready.stderr, ready.stderr.decode()
            created = api.create_pod(manifest)
            name, uid = created["metadata"]["name"], created["metadata"]["uid"]
            assert [item["metadata"]["uid"] for item in api.list_pods()] == [uid]
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                observed = api.get_pod(name)
                if observed.get("status", {}).get("phase") == "Running" and observed["spec"].get("nodeName"): break
                time.sleep(.1)
            assert observed.get("status", {}).get("phase") == "Running" and observed["spec"].get("nodeName")
            deletion = {"apiVersion": "v1", "kind": "DeleteOptions", "gracePeriodSeconds": 5,
                "preconditions": {"uid": "wrong-pod-incarnation", "resourceVersion": observed["metadata"]["resourceVersion"]}}
            expect_held(lambda: api.delete_pod(name, deletion))
            unchanged = api.get_pod(name)
            assert unchanged["metadata"]["uid"] == uid and not unchanged["metadata"].get("deletionTimestamp")
            deletion["preconditions"] = {"uid": uid, "resourceVersion": unchanged["metadata"]["resourceVersion"]}
            api.delete_pod(name, deletion)
            retained = api.get_pod(name)
            assert retained["metadata"]["uid"] == uid and retained["metadata"].get("deletionTimestamp")
            result = {"status": "PASS", "scope": "actual scoped bearer HTTPS Pod/PVC wire only", "productionAcceptance": False,
                "subject": setup_api.user, "apiOrigin": origin, "apiCaSha256": hashlib.sha256(ca).hexdigest(), "podUid": uid,
                "pvcUid": observed_pvc["metadata"]["uid"], "checks": ["real scoped SA auth", "fixed PVC UID", "wrongCA/token/PVC UID refused",
                    "create/list/get", "wrongUID delete refused and original UID retained", "exactUID graceful API deletion accepted with retained object"],
                "consumerAuthority": "disposable SQLite fixture, NOT native PostgreSQL", "stableRetirement": False,
                "namespaceUIDAttestation": False, "nativeAcceptance": False, "providerExecution": False}
            # Only this secret-free result is written to requested evidence.
            if args.result:
                Path(args.result).write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps(result))
    finally:
        cleanup(cluster)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", required=True)
    parser.add_argument("--apiserver-certificate", required=True)
    parser.add_argument("--result")
    run(parser.parse_args())
