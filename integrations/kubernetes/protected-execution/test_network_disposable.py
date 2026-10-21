"""Actual packet fixture for a SEPARATE enforcing-CNI kind cluster.

No CNI installer. Explicit loopback kubeconfig and exact fixture cluster required.
Admin exec/namespace cleanup belong only to this host fixture, never workloads.
Cannot pass on kindnet's non-enforcing NetworkPolicy implementation.
"""
import json
import re
from pathlib import Path
import subprocess
import sys
import time
from authority import canonical, Held

CLUSTER = "pc-protected-network-disposable"
SOURCE, ALLOWED, FORBIDDEN = "pc-network-source", "pc-network-allowed", "pc-network-forbidden"


class PacketFixture:
    def __init__(self, kubeconfig, image):
        self.kubeconfig = str(Path(kubeconfig).resolve())
        if not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", image):
            raise Held("immutable_fixture_image_required")
        self.image = image
        config = self.call("config", "view", "--raw", "-o", "json")
        if config["current-context"] != "kind-" + CLUSTER or len(config["clusters"]) != 1 or not config["clusters"][0]["cluster"]["server"].startswith("https://127.0.0.1:"):
            raise Held("explicit_separate_loopback_kind_cluster_required")
        labels = json.loads(subprocess.run(["docker", "inspect", CLUSTER + "-control-plane", "--format", "{{json .Config.Labels}}"], check=True, capture_output=True, timeout=10).stdout)
        if labels.get("io.x-k8s.kind.cluster") != CLUSTER:
            raise Held("wrong_disposable_cluster")

    def raw(self, *args, data=None, check=True, timeout=30):
        result = subprocess.run(["kubectl", "--kubeconfig", self.kubeconfig, "--request-timeout=150s", *args], input=data, capture_output=True, timeout=timeout)
        if check and result.returncode:
            raise Held(result.stderr.decode()[-1500:])
        return result

    def call(self, *args, data=None):
        return json.loads(self.raw(*args, data=data).stdout)

    def install(self, obj):
        return self.call("create", "-f", "-", "-o", "json", data=canonical(obj))

    def pod(self, namespace, name, server=False):
        code = ("import http.server; http.server.HTTPServer(('0.0.0.0',8080),http.server.SimpleHTTPRequestHandler).serve_forever()" if server else "import time; time.sleep(900)")
        return self.install({"apiVersion": "v1", "kind": "Pod", "metadata": {"namespace": namespace, "name": name, "labels": {"app": name}}, "spec": {
            "automountServiceAccountToken": False, "enableServiceLinks": False, "restartPolicy": "Never", "activeDeadlineSeconds": 900, "terminationGracePeriodSeconds": 1,
            "securityContext": {"runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000, "seccompProfile": {"type": "RuntimeDefault"}},
            "containers": [{"name": name, "image": self.image, "imagePullPolicy": "Never", "command": ["python3", "-c", code],
                "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
                "resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"cpu": "100m", "memory": "64Mi"}}}]}})

    def connect(self, host, port):
        # Fixed Python argv, no shell, no request body/credentials. The client is
        # untrusted and has no cluster token; host admin exec is fixture-only.
        code = "import socket,sys; s=socket.socket(); s.settimeout(1); r=s.connect_ex((sys.argv[1],int(sys.argv[2]))); s.close(); sys.exit(0 if r==0 else 9)"
        result = self.raw("-n", SOURCE, "exec", "client", "--", "python3", "-c", code, host, str(port), check=False)
        if result.returncode not in (0, 9):
            raise Held("client_probe_transport_uncertain")
        return result.returncode == 0

    def expect(self, host, port, allowed):
        # NetworkPolicy propagation is async. Require three stable observations,
        # bounded to 12 seconds, rather than treating one transient as evidence.
        deadline, stable = time.monotonic() + 12, 0
        while time.monotonic() < deadline:
            stable = stable + 1 if self.connect(host, port) == allowed else 0
            if stable >= 3:
                return
            time.sleep(.2)
        raise Held("packet_policy_expectation_failed:" + str(allowed) + ":" + host + ":" + str(port))


def main():
    fixture = PacketFixture(sys.argv[1], sys.argv[2])
    # Refuse reuse of existing namespaces: previous policies/resources would make
    # baseline reachability and negative conclusions ambiguous.
    for namespace in (SOURCE, ALLOWED, FORBIDDEN):
        if fixture.raw("get", "namespace", namespace, check=False).returncode == 0:
            raise Held("existing_network_fixture_namespace")
    checks = []
    created = []
    try:
        for namespace in (SOURCE, ALLOWED, FORBIDDEN):
            fixture.install({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": namespace, "labels": {"pod-security.kubernetes.io/enforce": "restricted"}}})
            created.append(namespace)
        original = fixture.pod(SOURCE, "client")
        client_uids = [original["metadata"]["uid"]]
        fixture.pod(SOURCE, "sibling", True)
        fixture.pod(ALLOWED, "allowed", True)
        fixture.pod(FORBIDDEN, "control", True)
        for namespace in created:
            fixture.raw("-n", namespace, "wait", "--for=condition=Ready", "pod", "--all", "--timeout=20s")
        allowed = fixture.call("-n", ALLOWED, "get", "pod", "allowed", "-o", "json")["status"]["podIP"]
        sibling = fixture.call("-n", SOURCE, "get", "pod", "sibling", "-o", "json")["status"]["podIP"]
        forbidden = fixture.call("-n", FORBIDDEN, "get", "pod", "control", "-o", "json")["status"]["podIP"]
        service = fixture.install({"apiVersion": "v1", "kind": "Service", "metadata": {"name": "control", "namespace": FORBIDDEN}, "spec": {"selector": {"app": "control"}, "ports": [{"port": 443, "targetPort": 8080}]}})
        vip = service["spec"]["clusterIP"]
        api = fixture.call("-n", "default", "get", "service", "kubernetes", "-o", "json")["spec"]["clusterIP"]
        endpoints = fixture.call("-n", "default", "get", "endpoints", "kubernetes", "-o", "json")
        direct_api = [(addr["ip"], port["port"]) for subset in endpoints["subsets"] for addr in subset["addresses"] for port in subset["ports"]]
        if len(direct_api) != 1:
            raise Held("single_disposable_API_endpoint_required")
        targets = [(allowed, 8080), (sibling, 8080), (forbidden, 8080), (vip, 443), (api, 443), direct_api[0]]
        for host, port in targets:
            fixture.expect(host, port, True)
        checks.append("positive baseline for allowed/sibling/control Pod, control service VIP, API VIP and direct API endpoint")
        fixture.install({"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": {"name": "deny-all", "namespace": SOURCE}, "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]}})
        for host, port in targets:
            fixture.expect(host, port, False)
        checks.append("actual deny-all packets block sibling/unrelated control Pods/Service DNAT and API VIP/direct endpoint")
        fixture.install({"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": {"name": "one-target", "namespace": SOURCE}, "spec": {"podSelector": {"matchLabels": {"app": "client"}}, "policyTypes": ["Egress"], "egress": [{"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": ALLOWED}}, "podSelector": {"matchLabels": {"app": "allowed"}}}], "ports": [{"protocol": "TCP", "port": 8080}]}]}})
        fixture.expect(allowed, 8080, True)
        for host, port in targets[1:]:
            fixture.expect(host, port, False)
        checks.append("narrow target/port positive while control/API direct and NAT routes remain denied")
        fixture.raw("-n", SOURCE, "delete", "pod", "client", "--grace-period=1", "--wait=true", "--timeout=20s")
        replacement = fixture.pod(SOURCE, "client")
        client_uids.append(replacement["metadata"]["uid"])
        assert client_uids[0] != client_uids[1]
        fixture.raw("-n", SOURCE, "wait", "--for=condition=Ready", "pod/client", "--timeout=20s")
        fixture.expect(allowed, 8080, True)
        for host, port in targets[1:]:
            fixture.expect(host, port, False)
        checks.append("fresh client Pod UID receives same exact callback allow and forbidden route denials")
        fixture.raw("-n", "kube-system", "rollout", "restart", "daemonset/calico-node")
        restart_samples = []
        for cycle in range(2):
            for host, port in targets[1:]:
                status = fixture.call("-n", "kube-system", "get", "daemonset", "calico-node", "-o", "json")["status"]
                if fixture.connect(host, port):
                    raise Held("forbidden_route_open_during_CNI_restart")
                restart_samples.append({"cycle": cycle, "host": host, "port": port, "result": "denied", "cniReady": status.get("numberReady", 0), "cniUpdated": status.get("updatedNumberScheduled", 0)})
        fixture.raw("-n", "kube-system", "rollout", "status", "daemonset/calico-node", "--timeout=120s", timeout=140)
        fixture.expect(allowed, 8080, True)
        for host, port in targets[1:]:
            fixture.expect(host, port, False)
        checks.append("restarted enforcing CNI preserves callback reachability and all forbidden route denials")
        print(json.dumps({"status": "PASS", "scope": "separate enforcing-CNI kind synthetic packet fixture only", "productionAcceptance": False, "checks": checks, "clientPodUIDs": client_uids, "restartSamples": restart_samples,
            "routes": {"callback": [allowed, 8080], "denied": targets[1:]},
            "remaining": ["public/DNS/IPv6/LAN/metadata negatives", "node restart/partition and native admission holds", "real homelab CNI and authenticated routes"]}, indent=2))
    finally:
        for namespace in reversed(created):
            fixture.raw("delete", "namespace", namespace, "--wait=false", check=False)


if __name__ == "__main__":
    main()
