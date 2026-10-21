"""Inactive Kubernetes boundary. No kubeconfig discovery or production caller.

The independent node observer is an injected trusted interface. The only supplied
implementation is privileged fixture host code; it MUST NOT be deployed. API
status/absence alone never confirms stop. No capacity release is implemented.
"""
import copy
import hashlib
import hmac
import json
import re
import time
import uuid
from authority import Held, canonical, digest, identity, sign, strict

PREFIX = "paperclip.execution/"
FINALIZER = PREFIX + "retain-evidence"
ANNOTATIONS = "owner invocation command journal storage policy template".split()


def name_for(invocation):
    return "attempt-" + hashlib.sha256(invocation.encode()).hexdigest()[:32]


def pod_spec(image, entrypoint, argv, pvc):
    return {
        "containers": [{"name": "provider", "image": image, "imagePullPolicy": "Never",
            "command": [entrypoint], "args": argv,
            "resources": {"requests": {"cpu": "100m", "memory": "64Mi"},
                          "limits": {"cpu": "500m", "memory": "128Mi"}},
            "securityContext": {"runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000,
                "allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
                "capabilities": {"drop": ["ALL"]}, "seccompProfile": {"type": "RuntimeDefault"}},
            "volumeMounts": [{"name": "attempt", "mountPath": "/attempt"},
                             {"name": "tmp", "mountPath": "/tmp"}]}],
        "volumes": [{"name": "attempt", "persistentVolumeClaim": {"claimName": pvc}},
                    {"name": "tmp", "emptyDir": {"medium": "Memory", "sizeLimit": "16Mi"}}],
        "restartPolicy": "Never", "terminationGracePeriodSeconds": 5, "activeDeadlineSeconds": 600,
        "serviceAccountName": "paperclip-provider", "automountServiceAccountToken": False,
        "securityContext": {"runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000,
            "fsGroup": 1000, "seccompProfile": {"type": "RuntimeDefault"}},
        "enableServiceLinks": False, "dnsPolicy": "ClusterFirst", "schedulerName": "default-scheduler",
        "preemptionPolicy": "PreemptLowerPriority",
    }


class WorkloadGuard:
    """Independent fail-closed validating webhook, fixed image/SA/PVC/config.

    Policy/attempt PVC map is installed by a separate fixture operator. The
    supervisor has no write access. A production storage grant service is pending;
    this map cannot safely be edited to reuse occupied storage.
    """
    def __init__(self, namespace, supervisor_user, policy, images, storages, journal_key=None, launch_consumer=None, admission_identity=None):
        self.namespace, self.supervisor_user = namespace, supervisor_user
        self.policy, self.images, self.storages = policy, images, storages
        self.journal_key = journal_key
        self.launch_consumer, self.admission_identity = launch_consumer, admission_identity
        if launch_consumer is not None and (journal_key is None or not admission_identity):
            raise Held("current_consume_requires_native_grant_and_identity")
        if journal_key is not None and len(journal_key) < 32:
            raise Held("weak_journal_grant_key")
        for template, image in images.items():
            if policy["templates"].get(template, {}).get("image") != image:
                raise Held("workload_image_policy_mismatch")
            if not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", image):
                raise Held("image_digest_required")

    def manifest(self, contract):
        if contract["policy"] != digest(self.policy):
            raise Held("workload_policy_mismatch")
        template = contract["template"]
        if template not in self.images or contract["storage"] not in self.storages:
            raise Held("unapproved_workload_or_storage")
        binding = self.storages[contract["storage"]]
        if binding["owner"] != digest(contract["owner"]):
            raise Held("storage_owner_mismatch")
        values = [digest(contract["owner"]), contract["invocation"], contract["commandHash"],
                  contract["journalHash"], contract["storage"], contract["policy"], template]
        annotations = {PREFIX + k: v for k, v in zip(ANNOTATIONS, values)}
        if self.journal_key is not None:
            annotations[PREFIX + "grant"] = canonical(contract["journalGrant"]).decode()
        return {"apiVersion": "v1", "kind": "Pod", "metadata": {
            "name": name_for(contract["invocation"]), "namespace": self.namespace,
            "labels": {PREFIX + "pool": self.policy["pool"]},
            "annotations": annotations,
            "finalizers": [FINALIZER]}, "spec": pod_spec(self.images[template],
                self.policy["templates"][template]["entrypoint"], contract["argv"], binding["name"])}

    def validate(self, request):
        if (request.get("namespace") != self.namespace or request.get("subResource", "") or
            request.get("resource") != {"group": "", "version": "v1", "resource": "pods"}):
            raise Held("wrong_admission_target")
        if request.get("userInfo", {}).get("username") != self.supervisor_user:
            raise Held("only_supervisor_may_write_provider_pods")
        operation = request.get("operation")
        if operation == "DELETE":
            pod, options = request["oldObject"], request["options"]
            preconditions = options.get("preconditions", {})
            if (preconditions != {"uid": pod["metadata"]["uid"], "resourceVersion": pod["metadata"]["resourceVersion"]} or
                type(options.get("gracePeriodSeconds")) is not int or not 1 <= options["gracePeriodSeconds"] <= 5):
                raise Held("exact_graceful_delete_required")
            return
        if operation != "CREATE":
            # No finalizer/metadata/volume rewrite or ephemeral-container path.
            raise Held("provider_pod_is_immutable")
        if self.launch_consumer is not None and request.get("dryRun", False):
            raise Held("dry_run_has_no_launch_authority")
        pod = request["object"]
        meta = pod["metadata"]
        allowed_meta = {"name", "namespace", "labels", "annotations", "finalizers", "creationTimestamp", "managedFields", "uid", "resourceVersion", "generation"}
        if set(meta) - allowed_meta or meta.get("finalizers") != [FINALIZER]:
            raise Held("unapproved_pod_metadata")
        annotations = meta.get("annotations", {})
        if set(annotations) != {PREFIX + k for k in ANNOTATIONS + (["grant"] if self.journal_key is not None else [])}:
            raise Held("unapproved_annotations")
        values = {k: annotations[PREFIX + k] for k in ANNOTATIONS}
        for value in values.values():
            identity(value)
        for field in ("owner", "command", "journal", "policy"):
            if not re.fullmatch("[0-9a-f]{64}", values[field]):
                raise Held("invalid_workload_binding")
        if (values["policy"] != digest(self.policy) or values["template"] not in self.images or
            values["storage"] not in self.storages or
            self.storages[values["storage"]]["owner"] != values["owner"] or
            meta.get("name") != name_for(values["invocation"]) or
            meta.get("labels") != {PREFIX + "pool": self.policy["pool"]}):
            raise Held("workload_owner_policy_mismatch")
        if self.journal_key is not None:
            envelope = json.loads(annotations[PREFIX + "grant"])
            strict(envelope, "body mac")
            grant = envelope["body"]
            if not hmac.compare_digest(sign(self.journal_key, "native-journal-grant-v1", grant), envelope["mac"]):
                raise Held("uncommitted_journal_grant")
            strict(grant, "contract target expires")
            if type(grant["expires"]) is not int or not time.time() < grant["expires"] <= time.time() + 60:
                raise Held("expired_journal_grant")
            contract = grant["contract"]
            target = grant["target"]
            strict(target, "storage pvcUid pvcName image template")
            storage = self.storages[values["storage"]]
            if (target != {"storage": values["storage"], "pvcUid": storage["uid"], "pvcName": storage["name"],
                "image": self.images[values["template"]], "template": values["template"]} or
                digest(contract["owner"]) != values["owner"] or
                contract["invocation"] != values["invocation"] or contract["journalHash"] != values["journal"] or
                contract["commandHash"] != values["command"] or contract["policy"] != values["policy"] or
                contract["storage"] != values["storage"] or contract["template"] != values["template"] or
                contract["argv"] != pod["spec"]["containers"][0].get("args")):
                raise Held("journal_workload_binding_changed")
        spec = copy.deepcopy(pod["spec"])
        # Remove only exact API-server defaults; all other fields are compared,
        # including unknown future fields. Fail closed on version/default drift.
        if spec.pop("serviceAccount", "paperclip-provider") != "paperclip-provider":
            raise Held("unapproved_service_account")
        if spec.pop("priority", 0) != 0:
            raise Held("unapproved_priority")
        defaults = [{"key": "node.kubernetes.io/" + condition, "operator": "Exists", "effect": "NoExecute", "tolerationSeconds": 300}
                    for condition in ("not-ready", "unreachable")]
        if spec.pop("tolerations", defaults) != defaults:
            raise Held("unapproved_tolerations")
        containers = spec.get("containers", [])
        if len(containers) != 1:
            raise Held("one_provider_container_required")
        container = containers[0]
        if container.pop("terminationMessagePath", "/dev/termination-log") != "/dev/termination-log" or container.pop("terminationMessagePolicy", "File") != "File":
            raise Held("unapproved_termination_message")
        argv = container.get("args")
        if (not isinstance(argv, list) or not 1 <= len(argv) <= 128 or
            any(not isinstance(v, str) or "\0" in v or len(v) > 65536 for v in argv) or
            len(canonical(argv)) > 131072 or digest(argv) != values["command"]):
            raise Held("workload_command_mismatch")
        expected = pod_spec(self.images[values["template"]],
            self.policy["templates"][values["template"]]["entrypoint"], argv,
            self.storages[values["storage"]]["name"])
        if spec != expected:
            raise Held("unapproved_workload_spec")
        if self.launch_consumer is not None:
            # Called after every validation, synchronously before allowed=True.
            # Never cache an allow or retry an ambiguous consume. Even an exact
            # repeated AdmissionReview is denied: safe false negatives retain
            # occupancy if persistence failed after this side effect.
            identity(request.get("uid", ""))
            identity(meta.get("uid", ""))
            binding = {"version": 1, **self.admission_identity,
                "reviewUid": request["uid"], "podUid": meta["uid"],
                "namespace": self.namespace, "name": meta["name"],
                "objectHash": digest(pod), "contract": contract, "target": target}
            receipt = self.launch_consumer.consume(binding)
            if (not isinstance(receipt, dict) or set(receipt) != {"consumed", "bindingHash"} or
                receipt["consumed"] is not True or receipt["bindingHash"] != digest(binding)):
                raise Held("current_launch_consume_unconfirmed")


def verify_observation(key, reply, challenge, physical, configuration, now=None):
    """Independent fresh node/CRI witness; never provider data or Pod absence.

    The witness must pin its node/runtime incarnation at launch and inspect ALL
    sandbox containers plus its cgroup. Missing runtime metadata is uncertainty.
    No production implementation/authority for this witness is shipped here.
    """
    strict(reply, "body mac")
    body = reply["body"]
    if not hmac.compare_digest(sign(key, "whole-pod-observation-v1", body), reply["mac"]):
        raise Held("node_witness_authentication_failed")
    strict(body, "challenge physical configuration observedAt runtime sandbox containers cgroupEmpty")
    now = int(time.time() * 1000) if now is None else now
    if (body["challenge"] != challenge or body["physical"] != physical or body["configuration"] != configuration or
        type(body["observedAt"]) is not int or not now - 10000 <= body["observedAt"] <= now + 1000):
        raise Held("node_witness_binding_or_freshness_failed")
    strict(body["runtime"], "node incarnation")
    if body["runtime"]["node"] != physical["node"]:
        raise Held("wrong_node_witness")
    identity(body["runtime"]["incarnation"])
    strict(body["sandbox"], "uid state podUid")
    if body["sandbox"]["podUid"] != physical["uid"]:
        raise Held("wrong_sandbox_witness")
    identity(body["sandbox"]["uid"])
    containers = body["containers"]
    if not isinstance(containers, list) or len(containers) != 1:
        raise Held("unknown_or_missing_sandbox_containers")
    strict(containers[0], "id state")
    if containers[0]["id"] != physical["container"]:
        raise Held("wrong_container_witness")
    stopped = (body["sandbox"]["state"] == "SANDBOX_NOTREADY" and
        containers[0]["state"] == "CONTAINER_EXITED" and body["cgroupEmpty"] is True)
    return {"stopped": stopped, "evidence": body}


class KubernetesRuntime:
    """Narrow namespace API supplied explicitly; never discovers ambient auth.

    api supports only list_pods/get_pod/create_pod/delete_pod/get_storage. Witness
    handles independently authenticated pool attestation and node observations.
    A timeout consumes the invocation upstream; this adapter never retries create.
    """
    def __init__(self, policy, guard, api, witness, witness_key):
        self.policy, self.guard, self.api, self.witness, self.witness_key = policy, guard, api, witness, witness_key
        if len(witness_key) < 32:
            raise Held("weak_witness_key")

    def attest(self):
        # Witness must attest independent guard configuration, physical pool and
        # namespace/storage incarnation. Returning our own policy hash is invalid.
        result = self.witness.attest(digest(self.policy))
        strict(result, "authority configuration")
        return {**result, "objects": [p["metadata"]["uid"] for p in self.api.list_pods()]}

    def launch(self, contract, template):
        if self.policy["templates"].get(contract["template"]) != template:
            raise Held("runtime_template_mismatch")
        storage = self.guard.storages[contract["storage"]]
        if self.api.get_storage(storage["name"])["metadata"]["uid"] != storage["uid"]:
            raise Held("storage_incarnation_changed")
        pod = self.api.create_pod(self.guard.manifest(contract))
        pod_uid = pod["metadata"]["uid"]
        # Bounded readiness inspection only. No repeated create/body replay.
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            pod = self.api.get_pod(pod["metadata"]["name"])
            if pod["metadata"]["uid"] != pod_uid:
                raise Held("pod_incarnation_changed")
            statuses = pod.get("status", {}).get("containerStatuses", [])
            if len(statuses) == 1 and statuses[0].get("containerID") and pod["spec"].get("nodeName"):
                physical = {"pool": self.policy["pool"], "uid": pod_uid,
                    "container": statuses[0]["containerID"], "node": pod["spec"]["nodeName"], "storage": contract["storage"]}
                self.witness.bind(physical)  # protected durable runtime-incarnation pin
                return physical
            time.sleep(0.1)
        raise Held("pod_launch_uncertain")

    def _pod(self, physical):
        if physical["pool"] != self.policy["pool"]:
            raise Held("wrong_pool")
        pods = [p for p in self.api.list_pods() if p["metadata"]["uid"] == physical["uid"]]
        if len(pods) != 1:
            raise Held("exact_pod_missing")
        pod = pods[0]
        if (pod["spec"].get("nodeName") != physical["node"] or
            pod["metadata"]["annotations"].get(PREFIX + "storage") != physical["storage"] or
            pod["metadata"].get("finalizers") != [FINALIZER]):
            raise Held("pod_binding_changed")
        statuses = pod.get("status", {}).get("containerStatuses", [])
        if len(statuses) != 1 or statuses[0].get("containerID") != physical["container"]:
            raise Held("container_binding_changed")
        return pod

    def inspect(self, physical):
        try:
            pod = self._pod(physical)
            challenge = str(uuid.uuid4())
            reply = self.witness.observe(physical, challenge)
            if "receipt" in reply.get("body", {}):
                from cri_stop_witness import verify_cri_stop
                result = verify_cri_stop(self.witness_key, reply, challenge, physical, digest(self.policy))
            else:
                result = verify_observation(self.witness_key, reply, challenge, physical, digest(self.policy))
            terminated = pod["status"]["containerStatuses"][0].get("state", {}).get("terminated")
            status = "confirmed_stopped" if result["stopped"] and terminated else "uncertain"
            if not result["stopped"] and not terminated and not pod["metadata"].get("deletionTimestamp"):
                status = "running"
            return {"physical": physical, "status": status, "evidence": result["evidence"]}
        except Exception:
            return {"physical": physical, "status": "uncertain", "evidence": None}

    def verify_retired(self, physical, observation):
        # StopPodSandbox retires the pinned original sandbox only. Kubernetes
        # CREATE admission cannot fence a stale kubelet recreating this Pod UID.
        # No approved stable retirement authority is installed by this adapter.
        return False

    def stop_and_inspect(self, physical):
        pod = self._pod(physical)
        if not pod["metadata"].get("deletionTimestamp"):
            self.api.delete_pod(pod["metadata"]["name"], {
                "apiVersion": "v1", "kind": "DeleteOptions", "gracePeriodSeconds": 5,
                "preconditions": {"uid": physical["uid"], "resourceVersion": pod["metadata"]["resourceVersion"]}})
        # A separately trusted exact node witness can perform/persist a CRI
        # StopPodSandbox RPC. Supervisor receives no generic node authority.
        # Only the disposable implementation exists; production remains held.
        if hasattr(self.witness, "stop_exact"):
            self.witness.stop_exact(physical)
        # Caller may inspect again. Never conclude stopped from DELETE success.
        return self.inspect(physical)
