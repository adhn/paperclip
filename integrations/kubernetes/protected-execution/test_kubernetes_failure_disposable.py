"""Separate actual API experiment: external consume survives later refusal.

Both validators are dispatched by Kubernetes; their ordering is not assumed.
The assertion independently reads the committed current-consumption history after
CREATE fails and proves no Pod persisted, then removes the refusing validator and
proves the same still-valid permit remains spent. This fixture authority is not
the assembled native DB. It grants no production storage/capacity/release claim.
"""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from authority import canonical, digest, sign
from kubernetes_boundary import WorkloadGuard
from test_kubernetes_boundary import fixture
from test_kubernetes_disposable import Cluster, NamespacedAPI, NODE, CONTROL, EXECUTION, command, provision, cleanup

REJECT = "pc-protected-fixture-later-refusal"


def main():
    cluster = Cluster(sys.argv[1])
    mode = "drop" if len(sys.argv) > 3 and sys.argv[3] == "drop" else "validator"
    # Main fixture cleanup is asynchronous. Never borrow its namespace/PVC
    # incarnation or erase occupied history; this is a separate experiment.
    for namespace in (CONTROL, EXECUTION):
        observed = cluster.kubectl("get", "namespace", namespace, "-o", "json", check=False)
        if observed.returncode == 0:
            cluster.kubectl("wait", "--for=delete", "namespace/" + namespace, "--timeout=45s")
            observed = cluster.kubectl("get", "namespace", namespace, "-o", "json", check=False)
        assert observed.returncode != 0 and b"Error from server (NotFound)" in observed.stderr, observed.stderr.decode()
    p, c, _ = fixture()
    p["runtimeAuthority"] = "fixture-kind-namespace"
    c["invocation"] = "post-allow-refused-invocation-" + mode
    c["owner"]["attempt"] = "synthetic-refusal-attempt-" + mode
    c["argv"] = ["-c", "raise AssertionError('refused CREATE body must never execute')"]
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
        {c["storage"]: {"name": "attempt-state", "uid": "pending", "owner": digest(c["owner"])}}, journal_key=os.urandom(32))
    with tempfile.TemporaryDirectory(prefix="pc-kind-refusal-") as directory:
        provision(cluster, guard, image, Path(directory), copy.deepcopy(c), sys.argv[2], admission_path="/fixture-drop" if mode == "drop" else "/validate")
        config = json.loads(cluster.kubectl("get", "validatingwebhookconfiguration", "pc-protected-fixture", "-o", "json").stdout)
        if mode == "validator":
            deny = copy.deepcopy(config)
            deny["metadata"] = {"name": REJECT}
            webhook = deny["webhooks"][0]
            webhook["name"] = "refuse.paperclip.fixture"
            webhook["clientConfig"]["service"]["path"] = "/fixture-refuse"
            webhook["namespaceSelector"] = {"matchLabels": {"paperclip.fixture": "protected"}}
            webhook["rules"][0]["operations"] = ["CREATE"]
            webhook["sideEffects"] = "None"
            cluster.install(deny)
            # The control namespace is outside the consume guard's selector. A
            # dry-run there proves the refusing validator is active/authenticated
            # before any actual execution-namespace CREATE can occur.
            probe = guard.manifest({**c, "journalGrant": {}})
            probe["metadata"]["namespace"] = CONTROL
            probe["metadata"]["name"] = "refusal-readiness"
            probe["spec"]["serviceAccountName"] = "supervisor"
            for _ in range(40):
                ready = cluster.kubectl("create", "--dry-run=server", "-f", "-", data=canonical(probe), user=api.user, check=False)
                # Supervisor deliberately has no control-namespace create RBAC;
                # fixture operator submits only this non-persisting readiness probe.
                if b"synthetic independent validator rejection" in ready.stderr:
                    break
                ready = cluster.kubectl("create", "--dry-run=server", "-f", "-", data=canonical(probe), check=False)
                if b"synthetic independent validator rejection" in ready.stderr:
                    break
                time.sleep(.25)
            assert b"synthetic independent validator rejection" in ready.stderr, ready.stderr.decode()
        else:
            # A refused dry-run attests the current drop endpoint is active;
            # fault injection happens only AFTER successful real consumption.
            for _ in range(40):
                probe = guard.manifest({**c, "journalGrant": {}})
                ready = cluster.kubectl("create", "--dry-run=server", "-f", "-", data=canonical(probe), user=api.user, check=False)
                if b"protected workload contract refused" in ready.stderr:
                    break
                time.sleep(.25)
            assert b"protected workload contract refused" in ready.stderr, ready.stderr.decode()
        body = {"contract": copy.deepcopy(c), "target": {"storage": c["storage"], "pvcUid": guard.storages[c["storage"]]["uid"],
            "pvcName": "attempt-state", "image": image, "template": "synthetic"}, "expires": int(time.time()) + 55}
        c["journalGrant"] = {"body": body, "mac": sign(guard.journal_key, "native-journal-grant-v1", body)}
        captured = guard.manifest(c)
        response = cluster.kubectl("create", "-f", "-", data=canonical(captured), user=api.user, check=False)
        assert response.returncode != 0
        code = "import sqlite3,json; print(json.dumps([json.loads(r[0]) for r in sqlite3.connect('/current/launch.sqlite').execute('select binding from consumes')]))"
        def history():
            return json.loads(cluster.kubectl("-n", CONTROL, "exec", "deployment/guard", "--", "python3", "-c", code).stdout)
        consumed = history()
        assert len(consumed) == 1, "failed CREATE must independently prove consume committed"
        assert api.list_pods() == [], "rejecting validator must prevent persistence/body"
        attempts_code = "import sqlite3,json; print(json.dumps([{'binding':json.loads(r[0]),'outcome':r[1]} for r in sqlite3.connect('/current/launch.sqlite').execute('select binding,outcome from attempts')]))"
        attempts_before_retry = json.loads(cluster.kubectl("-n", CONTROL, "exec", "deployment/guard", "--", "python3", "-c", attempts_code).stdout)
        if mode == "validator":
            cluster.kubectl("delete", "validatingwebhookconfiguration", REJECT)
        else:
            config["metadata"] = {"name": "pc-protected-fixture"}
            config["webhooks"][0]["clientConfig"]["service"]["path"] = "/validate"
            cluster.install(config)
        assert body["expires"] > time.time(), "replay must still be valid"
        retry = cluster.kubectl("create", "-f", "-", data=canonical(captured), user=api.user, check=False)
        assert retry.returncode != 0 and history() == consumed and api.list_pods() == []
        attempts_after_retry = json.loads(cluster.kubectl("-n", CONTROL, "exec", "deployment/guard", "--", "python3", "-c", attempts_code).stdout)
        new_attempts = attempts_after_retry[len(attempts_before_retry):]
        assert new_attempts and all(x["outcome"] == "denied_consumed" for x in new_attempts)
        assert all(x["binding"]["podUid"] != consumed[0]["podUid"] and x["binding"]["reviewUid"] != consumed[0]["reviewUid"] for x in new_attempts)
        print(json.dumps({"status": "PASS", "scope": "separate disposable kind v1.34 API failure experiment", "productionAcceptance": False,
            "mode": mode, "checks": ["fault endpoint positively attested before real CREATE", "actual API CREATE fails while current consume commits exactly once and no Pod persists", "removing fault cannot reopen captured still-valid consumed permit"],
            "attemptsBeforeClientRetry": attempts_before_retry, "attemptsAfterClientRetry": attempts_after_retry, "apiCreateFailure": response.stderr.decode(),
            "consumed": consumed[0], "gaps": ["validator invocation ordering not assumed", "no claim about unobserved internal retransmissions or storage-backend failure", "not assembled native DB admission or capacity/storage release"]}, indent=2))


if __name__ == "__main__":
    cluster = Cluster(sys.argv[1])
    try:
        main()
    finally:
        cluster.kubectl("delete", "validatingwebhookconfiguration", REJECT, "--ignore-not-found", check=False)
        cleanup(cluster)
