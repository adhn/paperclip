"""Standalone disposable enforcing-CNI fixture. Never reads default kubeconfig.

Requires explicit pinned downloaded upstream YAML and local kind v0.30.0 binary.
Installs privileged CNI only INSIDE a named disposable Docker kind node. Nothing
here is a homelab or Paperclip production CNI/RBAC/workload proposal.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import yaml

CLUSTER = "pc-protected-network-disposable"
NODE = CLUSTER + "-control-plane"
KIND_IMAGE = "kindest/node:v1.34.0@sha256:7416a61b42b1662ca6ca89f02028ac133a309a2a30ba309614e8ec94d976dc5a"
UPSTREAM = "https://raw.githubusercontent.com/projectcalico/calico/v3.33.0/manifests/calico.yaml"
UPSTREAM_HASH = "2de8f47595fb9c41b3f47d7b767a1f8e72ecf84057af834738ff12689a234da5"
IMAGES = {
    "quay.io/calico/calico:v3.33.0": "quay.io/calico/calico@sha256:4ebc20730127bc9e8bf1db5f5a2d8b58cf37fe0e891b3c7b5471992221d213e5",
    "quay.io/calico/third-party-cni-plugins:v3.33.0": "quay.io/calico/third-party-cni-plugins@sha256:0f32f48279484c0d6f0e0d0e767b2d0e1a6c6ca34cb3421a61b989d992f3df41",
    "quay.io/calico/node:v3.33.0": "quay.io/calico/node@sha256:565d8db3200e443955557f8f28ff44ab8a4a456754bc74a19c4f2f3444af9b1c",
}


def prepare(source):
    data = Path(source).read_bytes()
    if hashlib.sha256(data).hexdigest() != UPSTREAM_HASH:
        raise RuntimeError("pinned_official_upstream_hash_mismatch")
    objects = [o for o in yaml.safe_load_all(data) if o]
    found = set()
    def walk(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "image":
                    if item not in IMAGES:
                        raise RuntimeError("unreviewed_upstream_image")
                    found.add(item)
                    value[key] = IMAGES[item]
                else:
                    walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
    walk(objects)
    if found != set(IMAGES):
        raise RuntimeError("missing_expected_upstream_images")
    # No CNI privilege/RBAC edits. This is official trusted cluster test
    # infrastructure, isolated inside disposable Docker node. Single-node pool
    # matches upstream's 192.168/16 default and uses standard iptables dataplane.
    return {"apiVersion": "v1", "kind": "List", "items": objects}


def command(argv, timeout=60, check=True):
    result = subprocess.run(list(map(str, argv)), capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(result.stderr.decode()[-2500:])
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--python-image", required=True)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    evidence = Path(args.evidence).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    prepared = json.dumps(prepare(args.source), indent=2, sort_keys=True).encode()
    manifest = evidence / "calico-pinned.json"
    manifest.write_bytes(prepared)
    (evidence / "pins.json").write_text(json.dumps({"scope": "disposable-only", "productionAcceptance": False, "upstream": UPSTREAM,
        "upstreamSha256": UPSTREAM_HASH, "renderedSha256": hashlib.sha256(prepared).hexdigest(), "images": IMAGES, "kindImage": KIND_IMAGE}, indent=2))
    if args.prepare_only:
        print("Prepared pinned CNI artifact only; no Docker/Kubernetes mutation")
        return
    if not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", args.python_image):
        raise RuntimeError("immutable_synthetic_python_image_required")
    version = command([args.kind, "version"]).stdout.decode()
    if not version.startswith("kind v0.30.0 "):
        raise RuntimeError("reviewed_kind_version_required")
    existing = command(["docker", "ps", "-a", "--filter", "label=io.x-k8s.kind.cluster", "--format", "{{.Names}}"])
    if existing.stdout.strip():
        raise RuntimeError("no_overlapping_kind_clusters_allowed")
    config = evidence / "kind.yaml"
    config.write_text("kind: Cluster\napiVersion: kind.x-k8s.io/v1alpha4\nnodes:\n- role: control-plane\nnetworking:\n  disableDefaultCNI: true\n  podSubnet: 192.168.0.0/16\n  apiServerAddress: 127.0.0.1\n")
    kubeconfig = evidence / "kubeconfig"
    created = False
    def kube(*argv, **kwargs):
        return command(["kubectl", "--kubeconfig", kubeconfig, "--request-timeout=200s", *argv], **kwargs)
    try:
        print("Creating separate pinned kind cluster", flush=True)
        # set created before call so interrupted/partial creation is cleaned up.
        created = True
        command([args.kind, "create", "cluster", "--name", CLUSTER, "--image", KIND_IMAGE, "--config", config, "--kubeconfig", kubeconfig, "--wait", "0s"], timeout=180)
        command(["docker", "update", "--memory", "3g", "--memory-swap", "4g", "--cpus", "2", "--pids-limit", "1024", NODE])
        print("Installing pinned official CNI in disposable node only", flush=True)
        kube("create", "-f", manifest, timeout=60)
        kube("-n", "kube-system", "rollout", "status", "daemonset/calico-node", "--timeout=180s", timeout=200)
        kube("-n", "kube-system", "rollout", "status", "deployment/calico-kube-controllers", "--timeout=120s", timeout=140)
        kube("wait", "--for=condition=Ready", "node", "--all", "--timeout=30s", timeout=40)
        command(["docker", "exec", NODE, "ctr", "-n", "k8s.io", "images", "pull", args.python_image], timeout=120)
        (evidence / "installed-pods.json").write_bytes(kube("get", "pods", "-A", "-o", "json").stdout)
        fixture = Path(__file__).resolve().parent.parent / "test_network_disposable.py"
        print("Running real positive/negative packet fixture", flush=True)
        result = command([sys.executable, fixture, kubeconfig, args.python_image], timeout=600)
        (evidence / "actual-network.json").write_bytes(result.stdout)
        (evidence / "actual-network.stderr").write_bytes(result.stderr)
        print(result.stdout.decode(), flush=True)
    except BaseException:
        if kubeconfig.exists():
            for name, argv in (("failure-pods.json", ("get", "pods", "-A", "-o", "json")), ("failure-events.json", ("get", "events", "-A", "-o", "json"))):
                try:
                    (evidence / name).write_bytes(kube(*argv, check=False).stdout)
                except Exception:
                    pass
        raise
    finally:
        if created:
            print("Deleting exact disposable network cluster", flush=True)
            command([args.kind, "delete", "cluster", "--name", CLUSTER, "--kubeconfig", kubeconfig], timeout=90)
            left = command(["docker", "ps", "-a", "--filter", "label=io.x-k8s.kind.cluster=" + CLUSTER, "--format", "{{.Names}}"])
            if left.stdout.strip():
                raise RuntimeError("disposable_network_node_leaked")
            (evidence / "cleanup.json").write_text(json.dumps({"cluster": CLUSTER, "containers": [], "status": "PASS"}))


if __name__ == "__main__":
    main()
