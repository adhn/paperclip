"""Disposable kind creator with API-server -> webhook mTLS; NEVER deploy.

Uses explicit loopback context and pinned Kubernetes v1.34.0. Source contract:
https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/#authenticate-api-servers
No ambient kubeconfig; keys stay in caller-owned disposable evidence directory.
"""
import argparse
import base64
import json
from pathlib import Path
import subprocess

IMAGE = "kindest/node:v1.34.0@sha256:7416a61b42b1662ca6ca89f02028ac133a309a2a30ba309614e8ec94d976dc5a"
NAME = "pc-protected-disposable"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", required=True)
    parser.add_argument("--directory", required=True)
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    def run(*argv):
        subprocess.run(argv, check=True, timeout=300)
    run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", str(directory / "apiserver-client.key"),
        "-out", str(directory / "apiserver-client.crt"), "-subj", "/CN=paperclip-disposable-apiserver", "-addext", "extendedKeyUsage=clientAuth")
    kubeconfig = {"apiVersion": "v1", "kind": "Config", "users": [{"name": "guard.pc-protected-control.svc", "user": {
        "client-certificate-data": base64.b64encode((directory / "apiserver-client.crt").read_bytes()).decode(),
        "client-key-data": base64.b64encode((directory / "apiserver-client.key").read_bytes()).decode()}}]}
    (directory / "webhook-kubeconfig.json").write_text(json.dumps(kubeconfig))
    (directory / "webhook-kubeconfig.json").chmod(0o600)
    mount = "/paperclip-admission"
    admission = {"apiVersion": "apiserver.config.k8s.io/v1", "kind": "AdmissionConfiguration", "plugins": [{"name": "ValidatingAdmissionWebhook", "configuration": {
        "apiVersion": "apiserver.config.k8s.io/v1", "kind": "WebhookAdmissionConfiguration", "kubeConfigFile": mount + "/webhook-kubeconfig.json"}}]}
    (directory / "admission.json").write_text(json.dumps(admission))
    patch = {"apiVersion": "kubeadm.k8s.io/v1beta3", "kind": "ClusterConfiguration", "apiServer": {
        "extraArgs": {"admission-control-config-file": mount + "/admission.json"},
        "extraVolumes": [{"name": "paperclip-admission", "hostPath": mount, "mountPath": mount, "readOnly": True, "pathType": "Directory"}]}}
    config = {"apiVersion": "kind.x-k8s.io/v1alpha4", "kind": "Cluster", "name": NAME, "networking": {"apiServerAddress": "127.0.0.1"},
        "nodes": [{"role": "control-plane", "extraMounts": [{"hostPath": str(directory), "containerPath": mount, "readOnly": True}], "kubeadmConfigPatches": [json.dumps(patch)]}]}
    (directory / "kind.json").write_text(json.dumps(config))
    run(args.kind, "create", "cluster", "--name", NAME, "--image", IMAGE, "--config", str(directory / "kind.json"), "--kubeconfig", str(directory / "kubeconfig"), "--wait", "120s")
    manifest = subprocess.run(["docker", "exec", NAME + "-control-plane", "cat", "/etc/kubernetes/manifests/kube-apiserver.yaml"], check=True, capture_output=True, text=True, timeout=30).stdout
    if "--admission-control-config-file=" + mount + "/admission.json" not in manifest or "mountPath: " + mount not in manifest:
        raise RuntimeError("disposable apiserver admission patch was not applied")
    (directory / "apiserver-manifest.yaml").write_text(manifest)
    run("docker", "update", "--memory", "3g", "--memory-swap", "4g", "--cpus", "2", "--pids-limit", "1024", NAME + "-control-plane")
    run(args.kind, "load", "docker-image", "python:3.11-slim-bookworm", "--name", NAME)


if __name__ == "__main__":
    main()
