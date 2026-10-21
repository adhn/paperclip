"""Fixture-only trusted host CRI StopPodSandbox receipt. NEVER deploy this code.

CRI's official contract stops every process/container in the exact sandbox:
https://github.com/kubernetes/cri-api/blob/master/pkg/apis/runtime/v1/api.proto
A successful RPC is a separate evidence type, never synthetic cgroup metadata.
Broad injected node authority remains host test infrastructure, not supervisor API.
"""
import hmac
import json
import os
import re
import sqlite3
import time
from authority import Held, canonical, digest, identity, sign, strict

DOMAIN = "whole-pod-cri-stop-v1"
FINALIZER = "paperclip.execution/retain-evidence"


class ExactCRIStopWitness:
    def __init__(self, path, key, configuration, namespace, node, incarnation, get_pod):
        if len(key) < 32 or not re.fullmatch(r"[0-9a-f]{64}", configuration):
            raise Held("invalid_stop_witness_authority")
        self.key, self.configuration, self.namespace = key, configuration, namespace
        self.node, self.incarnation, self.get_pod = node, incarnation, get_pod
        self.db = sqlite3.connect(path, isolation_level=None)
        os.chmod(path, 0o600)
        self.db.execute("PRAGMA journal_mode=DELETE")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS pins (uid TEXT PRIMARY KEY, binding TEXT NOT NULL, receipt TEXT)")

    def close(self):
        self.db.close()

    def _sandbox(self, sandbox, physical):
        status = json.loads(self.node("crictl", "inspectp", sandbox))["status"]
        if status["id"] != sandbox or status["metadata"]["uid"] != physical["uid"] or status["metadata"]["namespace"] != self.namespace:
            raise Held("stop_sandbox_binding_changed")
        return status

    def pin(self, physical, sandbox):
        strict(physical, "pool uid container node storage")
        if not re.fullmatch(r"[0-9a-f]{64}", sandbox):
            raise Held("exact_full_sandbox_id_required")
        before = self.incarnation()
        identity(before)
        self._sandbox(sandbox, physical)
        containers = json.loads(self.node("crictl", "ps", "-a", "--pod", sandbox, "-o", "json"))["containers"]
        if len(containers) != 1 or "containerd://" + containers[0]["id"] != physical["container"]:
            raise Held("stop_pin_container_membership_changed")
        if before != self.incarnation():
            raise Held("stop_pin_runtime_changed")
        binding = {"physical": physical, "sandbox": sandbox, "runtime": before, "configuration": self.configuration, "namespace": self.namespace}
        encoded = canonical(binding).decode()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            old = self.db.execute("SELECT binding FROM pins WHERE uid=?", (physical["uid"],)).fetchone()
            if old and old[0] != encoded:
                raise Held("stop_pin_conflict")
            self.db.execute("INSERT OR IGNORE INTO pins(uid,binding) VALUES (?,?)", (physical["uid"], encoded))
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        return binding

    def _pod_retired(self, physical):
        # Independently read retained API object, never caller-provided bool.
        # A deleting API object coordinates cleanup only. It cannot fence stale
        # kubelet work or a replacement sandbox for this same Pod UID.
        pod = self.get_pod(physical)
        statuses = pod.get("status", {}).get("containerStatuses", [])
        if (pod["metadata"]["uid"] != physical["uid"] or pod["spec"].get("nodeName") != physical["node"] or
            not pod["metadata"].get("deletionTimestamp") or pod["metadata"].get("finalizers") != [FINALIZER] or
            len(statuses) != 1 or statuses[0].get("containerID") != physical["container"]):
            raise Held("stop_requires_exact_retiring_retained_pod")
        return pod["metadata"]["resourceVersion"]

    def stop(self, physical, challenge):
        identity(challenge)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute("SELECT binding,receipt FROM pins WHERE uid=?", (physical["uid"],)).fetchone()
            if not row:
                raise Held("missing_original_stop_pin")
            binding = json.loads(row[0])
            if binding["physical"] != physical or binding["configuration"] != self.configuration or self.incarnation() != binding["runtime"]:
                raise Held("stop_witness_pin_changed")
            self._pod_retired(physical)
            if row[1]:
                receipt = json.loads(row[1])
            else:
                # Missing sandbox before an observed successful RPC is held.
                # Missing cgroup alone cannot block this independent active stop.
                self._sandbox(binding["sandbox"], physical)
                containers = json.loads(self.node("crictl", "ps", "-a", "--pod", binding["sandbox"], "-o", "json"))["containers"]
                if len(containers) != 1 or "containerd://" + containers[0]["id"] != physical["container"]:
                    raise Held("stop_current_container_membership_changed")
                if self.incarnation() != binding["runtime"]:
                    raise Held("stop_runtime_changed_before_rpc")
                self.node("crictl", "stopp", binding["sandbox"])
                # node() must raise on nonzero exit/timeout/transport errors.
                if self.incarnation() != binding["runtime"]:
                    raise Held("stop_runtime_changed_after_rpc")
                version = self._pod_retired(physical)
                receipt = {"type": "exact-cri-stop-success-v1", "binding": binding, "method": "runtime.v1.RuntimeService/StopPodSandbox",
                    "completedAt": int(time.time() * 1000), "retainedPodResourceVersion": version}
                self.db.execute("UPDATE pins SET receipt=? WHERE uid=?", (canonical(receipt).decode(), physical["uid"]))
            # FULL synchronous commit precedes authenticated reply. Failure after
            # RPC/before durable receipt stays uncertain if metadata disappears.
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        body = {"challenge": challenge, "physical": physical, "configuration": self.configuration, "observedAt": int(time.time() * 1000), "receipt": receipt}
        return {"body": body, "mac": sign(self.key, DOMAIN, body)}


def verify_cri_stop(key, reply, challenge, physical, configuration, now=None):
    strict(reply, "body mac")
    body = reply["body"]
    if not hmac.compare_digest(sign(key, DOMAIN, body), reply["mac"]):
        raise Held("cri_stop_authentication_failed")
    strict(body, "challenge physical configuration observedAt receipt")
    now = int(time.time() * 1000) if now is None else now
    if (body["challenge"] != challenge or body["physical"] != physical or body["configuration"] != configuration or
        type(body["observedAt"]) is not int or not now - 10000 <= body["observedAt"] <= now + 1000):
        raise Held("cri_stop_reply_binding_changed")
    receipt = body["receipt"]
    strict(receipt, "type binding method completedAt retainedPodResourceVersion")
    binding = receipt["binding"]
    strict(binding, "physical sandbox runtime configuration namespace")
    if (receipt["type"] != "exact-cri-stop-success-v1" or receipt["method"] != "runtime.v1.RuntimeService/StopPodSandbox" or
        binding["physical"] != physical or binding["configuration"] != configuration or
        type(receipt["completedAt"]) is not int or receipt["completedAt"] > body["observedAt"] or
        not re.fullmatch(r"[0-9a-f]{64}", binding["sandbox"])):
        raise Held("cri_stop_receipt_binding_changed")
    identity(binding["runtime"])
    identity(binding["namespace"])
    identity(receipt["retainedPodResourceVersion"])
    return {"stopped": True, "stableRetirement": False, "evidence": body}
