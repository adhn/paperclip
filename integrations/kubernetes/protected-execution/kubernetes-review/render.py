"""Pure INACTIVE boundary renderer: no cluster/client/ambient credentials.

Output installs no enabled launch path. Guard replica count is zero, so its
FailurePolicy=Fail denies provider creation. This is only a review artifact.
"""
import base64
import hashlib
import json
import re
import sys

CONTROL = "paperclip-execution-control"
EXECUTION = "paperclip-execution"


def strict(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields.split()):
        raise ValueError("unexpected or missing review input")


def render(inputs):
    strict(inputs, "mode guardImage guardConfig guardCABundle attemptPVCName attemptPVCUID storageClass storageBytes policyHash sourceCommit podSecurityVersion")
    if inputs["mode"] != "review-only-held":
        raise ValueError("activation not implemented")
    if not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", inputs["guardImage"]):
        raise ValueError("published immutable image required")
    for field in ("policyHash", "sourceCommit"):
        if not re.fullmatch(r"[0-9a-f]{64}" if field == "policyHash" else r"[0-9a-f]{40}", inputs[field]):
            raise ValueError("invalid source/policy binding")
    if not re.fullmatch(r"v1\.[0-9]{2}", inputs["podSecurityVersion"]):
        raise ValueError("explicit reviewed Kubernetes PodSecurity version required")
    for field in ("attemptPVCName", "storageClass"):
        if not re.fullmatch(r"[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?", inputs[field]):
            raise ValueError("invalid Kubernetes name")
    if not re.fullmatch(r"[0-9a-f-]{36}", inputs["attemptPVCUID"]):
        raise ValueError("observed immutable PVC UID required")
    if type(inputs["storageBytes"]) is not int or not 1024 * 1024 <= inputs["storageBytes"] <= 2 * 1024**3:
        raise ValueError("review storage exceeds bounded envelope")
    ca = base64.b64decode(inputs["guardCABundle"], validate=True)
    if not ca.startswith(b"-----BEGIN CERTIFICATE-----\n") or not ca.rstrip().endswith(b"-----END CERTIFICATE-----"):
        raise ValueError("explicit admission CA required")
    # Configuration is separately provisioned by the operator. Supervisor cannot
    # update config, signing/verifier material, CA, namespace labels or webhook.
    config = inputs["guardConfig"]
    if not isinstance(config, dict) or config.get("namespace") != EXECUTION or config.get("supervisor_user") != f"system:serviceaccount:{CONTROL}:supervisor":
        raise ValueError("guard independent namespace/identity required")
    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"))
    if hashlib.sha256(canonical(config.get("policy")).encode()).hexdigest() != inputs["policyHash"]:
        raise ValueError("guard policy hash mismatch")
    storages = config.get("storages", {})
    if len(storages) != 1 or any(s.get("name") != inputs["attemptPVCName"] or s.get("uid") != inputs["attemptPVCUID"] for s in storages.values()):
        raise ValueError("exact single retained PVC incarnation required")
    items = []
    def obj(api, kind, name, namespace=None, **fields):
        meta = {"name": name, "annotations": {"paperclip.execution/review-only": "held", "paperclip.execution/source": inputs["sourceCommit"]}}
        if namespace:
            meta["namespace"] = namespace
        result = {"apiVersion": api, "kind": kind, "metadata": meta, **fields}
        items.append(result)
        return result
    for namespace in (CONTROL, EXECUTION):
        ns = obj("v1", "Namespace", namespace)
        ns["metadata"]["labels"] = {"pod-security.kubernetes.io/enforce": "restricted", "pod-security.kubernetes.io/enforce-version": inputs["podSecurityVersion"]}
        for name in (("supervisor", "guard", "state-transfer") if namespace == CONTROL else ("paperclip-provider",)):
            obj("v1", "ServiceAccount", name, namespace, automountServiceAccountToken=False)
        obj("networking.k8s.io/v1", "NetworkPolicy", "deny-all", namespace,
            spec={"podSelector": {}, "policyTypes": ["Ingress", "Egress"]})
    obj("rbac.authorization.k8s.io/v1", "Role", "supervisor", EXECUTION, rules=[
        {"apiGroups": [""], "resources": ["pods"], "verbs": ["create", "get", "list", "delete"]},
        {"apiGroups": [""], "resources": ["persistentvolumeclaims"], "resourceNames": [inputs["attemptPVCName"]], "verbs": ["get"]}])
    obj("rbac.authorization.k8s.io/v1", "RoleBinding", "supervisor", EXECUTION,
        subjects=[{"kind": "ServiceAccount", "name": "supervisor", "namespace": CONTROL}],
        roleRef={"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "supervisor"})
    obj("v1", "ResourceQuota", "held-execution", EXECUTION, spec={"hard": {
        "pods": "1", "persistentvolumeclaims": "1", "requests.storage": str(inputs["storageBytes"]),
        "requests.cpu": "500m", "requests.memory": "128Mi", "limits.cpu": "1", "limits.memory": "256Mi"}})
    # NO PVC creation: a trusted retained existing incarnation is reviewed. The
    # supervisor cannot create/rebind/delete PVCs or mount canonical roots.
    obj("v1", "ConfigMap", "guard-config", CONTROL, immutable=True, data={"guard.json": canonical(config)})
    obj("v1", "ConfigMap", "review-storage-lock", CONTROL, immutable=True, data={"inventory.json": canonical({k: inputs[k] for k in ("attemptPVCName", "attemptPVCUID", "storageClass", "storageBytes", "policyHash", "sourceCommit")})})
    obj("v1", "Service", "guard", CONTROL, spec={"selector": {"app": "paperclip-workload-guard"}, "ports": [{"port": 443, "targetPort": 8443}]})
    obj("apps/v1", "Deployment", "guard", CONTROL, spec={"replicas": 0,
        "selector": {"matchLabels": {"app": "paperclip-workload-guard"}},
        "template": {"metadata": {"labels": {"app": "paperclip-workload-guard"}}, "spec": {
            "serviceAccountName": "guard", "automountServiceAccountToken": False,
            "securityContext": {"runAsNonRoot": True, "runAsUser": 2000, "runAsGroup": 2000, "fsGroup": 2000, "seccompProfile": {"type": "RuntimeDefault"}},
            "containers": [{"name": "guard", "image": inputs["guardImage"], "command": ["python3", "/app/admission_webhook.py"],
                "env": [{"name": "PYTHONDONTWRITEBYTECODE", "value": "1"}],
                "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
                "resources": {"requests": {"cpu": "50m", "memory": "32Mi"}, "limits": {"cpu": "250m", "memory": "128Mi"}},
                "volumeMounts": [{"name": "config", "mountPath": "/config", "readOnly": True}, {"name": "tls", "mountPath": "/tls", "readOnly": True}]}],
            "volumes": [{"name": "config", "configMap": {"name": "guard-config"}}, {"name": "tls", "secret": {"secretName": "guard-tls", "defaultMode": 288}}]}}})
    obj("admissionregistration.k8s.io/v1", "ValidatingWebhookConfiguration", "paperclip-protected-execution", webhooks=[{
        "name": "workload.paperclip.execution", "admissionReviewVersions": ["v1"], "sideEffects": "NoneOnDryRun", "failurePolicy": "Fail", "timeoutSeconds": 5,
        "matchPolicy": "Equivalent", "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": EXECUTION}},
        "clientConfig": {"service": {"namespace": CONTROL, "name": "guard", "path": "/validate"}, "caBundle": inputs["guardCABundle"]},
        "rules": [{"apiGroups": [""], "apiVersions": ["v1"], "resources": ["pods", "pods/ephemeralcontainers"], "operations": ["CREATE", "UPDATE", "DELETE"], "scope": "Namespaced"}]}])
    return {"apiVersion": "v1", "kind": "List", "items": items}


if __name__ == "__main__":
    # JSON input/output only. Caller chooses a review file; no apply invocation.
    print(json.dumps(render(json.load(open(sys.argv[1]))), indent=2, sort_keys=True))
