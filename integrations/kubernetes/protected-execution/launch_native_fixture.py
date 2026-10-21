"""DISPOSABLE kind -> mTLS webhook -> REAL native PostgreSQL consumption.

Host Docker fixture machinery is never deployable. Only CREATE consumption is
accepted here: /bin/true is a synthetic no-op, storage attestation is explicitly a
boolean fixture and stable retirement is unavailable. No provider executes.
"""
import argparse
import copy
import ipaddress
import json
import os
from pathlib import Path
import selectors
import subprocess
import time

from authority import Held, canonical, digest
from kubernetes_boundary import WorkloadGuard
from test_kubernetes_boundary import fixture
from test_kubernetes_disposable import Cluster, NamespacedAPI, NODE, CONTROL, EXECUTION, command, provision, cleanup

CONTAINER = "pc-native-launch-disposable"
LATER_REFUSAL = "pc-native-launch-later-refusal"


def wait_for_native_ip(attempts=100):
    # Docker registers the container before its network namespace/IP is ready.
    # Successful inspect is not itself a network-start acknowledgement.
    for _ in range(attempts):
        observed = command(["docker", "inspect", CONTAINER, "--format", "{{json .NetworkSettings.Networks}}"], check=False)
        if observed.returncode == 0:
            try:
                candidate = json.loads(observed.stdout).get("kind", {}).get("IPAddress", "")
                return str(ipaddress.IPv4Address(candidate))
            except (ValueError, TypeError, AttributeError):
                pass
        time.sleep(.05)
    raise Held("native_fixture_container_not_started")


class NativeFixture:
    def __init__(self, directory, image):
        self.directory = directory
        existing = command(["docker", "inspect", CONTAINER], check=False)
        if existing.returncode == 0 or b"No such object" not in existing.stderr:
            raise Held("native_fixture_refuses_existing_or_unverified_container")
        directory.mkdir(mode=0o755)
        self.log = (directory / "native-stderr.log").open("wb")
        self.process = subprocess.Popen(["docker", "run", "--rm", "-i", "--name", CONTAINER,
            "--network", "kind", "--user", "2000:2000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--memory", "768m", "--memory-swap", "1g", "--cpus", ".5", "--pids-limit", "128",
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777", "--mount", f"type=bind,src={directory},dst=/fixture,readonly",
            "-e", "PAPERCLIP_DISPOSABLE_NATIVE_LAUNCH=yes", "-e", "HOME=/tmp", "--entrypoint", "node", image,
            "--import", "/app/server/node_modules/tsx/dist/loader.mjs", "/app/server/src/__tests__/fixtures/protected-launch-native-fixture.ts"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log)
        self.buffer = b""
        try:
            self.ip = wait_for_native_ip()
            for name in ("server", "client"):
                argv = ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", str(directory / f"native-{name}.key"),
                    "-out", str(directory / f"native-{name}.crt"), "-subj", f"/CN=disposable-native-{name}"]
                argv += ["-addext", f"subjectAltName=IP:{self.ip}"] if name == "server" else ["-addext", "extendedKeyUsage=clientAuth"]
                command(argv)
                (directory / f"native-{name}.key").chmod(0o644)  # only synthetic keys, fixture-private bind mount
        except BaseException:
            self.close()
            raise

    def request(self, value, timeout=180):
        self.process.stdin.write(canonical(value) + b"\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            while time.monotonic() < deadline:
                while b"\n" in self.buffer:
                    line, self.buffer = self.buffer.split(b"\n", 1)
                    if line.startswith(b"PC_NATIVE_JSON "):
                        result = json.loads(line[len(b"PC_NATIVE_JSON "):])
                        if isinstance(result, dict) and "error" in result:
                            raise Held(result["error"])
                        return result
                if not selector.select(max(0, deadline - time.monotonic())):
                    break
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise Held("native_fixture_exited_see_native_stderr")
                self.buffer += chunk
        raise Held("native_fixture_control_timeout")

    def initialize(self, context, target, policy):
        prepared = self.request({"op": "initialize", "context": context, "target": target, "policy": policy, "namespace": EXECUTION})
        return {**prepared, "native_consumer": {"endpoint": f"https://{self.ip}:8444/consume-pod-create", "ca": "/tls/native-ca.crt",
            "certificate": "/tls/native-client.crt", "key": "/tls/native-client.key"}, "tls_files": {
            "native-ca.crt": str(self.directory / "native-server.crt"), "native-client.crt": str(self.directory / "native-client.crt"),
            "native-client.key": str(self.directory / "native-client.key")}}

    def close(self):
        if self.process.poll() is None:
            try:
                self.request({"op": "shutdown"}, timeout=10)
                self.process.wait(timeout=15)
            except Exception:
                command(["docker", "stop", "--time", "5", CONTAINER], check=False)
        self.log.close()


def run(args):
    cluster = Cluster(args.kubeconfig)
    for namespace in (CONTROL, EXECUTION):
        observed = cluster.kubectl("get", "namespace", namespace, "-o", "json", check=False)
        if observed.returncode == 0:
            cluster.kubectl("wait", "--for=delete", "namespace/" + namespace, "--timeout=45s")
            observed = cluster.kubectl("get", "namespace", namespace, "-o", "json", check=False)
        if observed.returncode == 0 or b"Error from server (NotFound)" not in observed.stderr:
            raise Held("native_fixture_requires_fresh_namespaces")
    evidence = Path(args.evidence).resolve()
    evidence.mkdir(mode=0o700)  # refuse reuse
    # Aggregate two-container ceiling: 2 GiB kind + 768 MiB native; no other
    # native/build/kind suite may run concurrently. Hosted-only full source image.
    # kind has its documented hosted 1024-PID exception plus native128; this
    # is NOT a claim to satisfy the separate local256-PID test budget.
    command(["docker", "update", "--memory", "2g", "--memory-swap", "4g", "--cpus", "1.5", NODE])
    backend = None
    try:
        backend = NativeFixture(evidence / "native-tls", args.native_image)
        p, c, _ = fixture()
        p["runtimeAuthority"] = "fixture-kind-namespace"
        images = command(["docker", "exec", NODE, "ctr", "-n", "k8s.io", "images", "list"]).stdout.decode().splitlines()
        imported = [line.split()[2] for line in images if line.startswith("docker.io/library/python:3.11-slim-bookworm ")]
        assert len(imported) == 1
        image = "docker.io/library/python@" + imported[0]
        command(["docker", "exec", NODE, "ctr", "-n", "k8s.io", "images", "tag", "--force", "docker.io/library/python:3.11-slim-bookworm", image])
        p["templates"]["synthetic"].update(image=image, entrypoint="/bin/true")
        c["policy"] = digest(p)
        api = NamespacedAPI(cluster)
        guard = WorkloadGuard(EXECUTION, api.user, p, {"synthetic": image},
            {c["storage"]: {"name": "attempt-state", "uid": "pending", "owner": digest(c["owner"])}}, journal_key=os.urandom(32))
        temp = evidence / "guard"
        temp.mkdir()
        seeded = provision(cluster, guard, image, temp, c, args.apiserver_certificate,
            admission_path="/fixture-drop" if args.mode == "drop" else "/validate", native_backend=backend.initialize, fixture_faults=args.mode == "validator")
        webhook = json.loads(cluster.kubectl("get", "validatingwebhookconfiguration", "pc-protected-fixture", "-o", "json").stdout)
        webhook["metadata"] = {"name": "pc-protected-fixture"}
        (evidence / "webhook.json").write_text(json.dumps(webhook))
        # Warm/positively attest the webhook before issuing the native grant.
        # No immutable permit exists during potentially slow Pod scheduling.
        readiness = guard.manifest({**c, "owner": seeded["owner"], "journalGrant": {}})
        for _ in range(80):
            ready = cluster.kubectl("create", "--dry-run=server", "-f", "-", data=canonical(readiness), user=api.user, check=False)
            if b"protected workload contract refused" in ready.stderr:
                break
            time.sleep(.25)
        assert b"protected workload contract refused" in ready.stderr, ready.stderr.decode()
        if args.mode == "validator":
            deny = copy.deepcopy(webhook)
            deny["metadata"] = {"name": LATER_REFUSAL}
            validator = deny["webhooks"][0]
            validator["name"] = "native-refuse.paperclip.fixture"
            validator["clientConfig"]["service"]["path"] = "/fixture-refuse"
            validator["namespaceSelector"] = {"matchLabels": {"paperclip.fixture": "protected"}}
            validator["rules"][0]["operations"] = ["CREATE"]
            validator["sideEffects"] = "None"
            cluster.install(deny)
            control_probe = copy.deepcopy(readiness)
            control_probe["metadata"].update(namespace=CONTROL, name="native-validator-readiness")
            control_probe["spec"]["serviceAccountName"] = "supervisor"
            for _ in range(40):
                refused = cluster.kubectl("create", "--dry-run=server", "-f", "-", data=canonical(control_probe), check=False)
                if b"synthetic independent validator rejection" in refused.stderr:
                    break
                time.sleep(.1)
            assert b"synthetic independent validator rejection" in refused.stderr, refused.stderr.decode()
        c = backend.request({"op": "prepare"})
        captured = guard.manifest(c)
        if args.mode == "cancel":
            assert backend.request({"op": "cancel"})["cancelled"]
        if args.mode == "storage":
            assert backend.request({"op": "storage", "current": False}) == {"storageCurrent": False}
        before_loss = None
        if args.mode == "database-loss":
            before_loss = backend.request({"op": "history"})
            assert before_loss == []
            assert backend.request({"op": "destroyDatabase"})["destroyed"]
        response = cluster.kubectl("create", "-f", "-", data=canonical(captured), user=api.user, check=False)
        history = backend.request({"op": "history"}) if args.mode != "database-loss" else None
        if args.mode == "database-loss":
            assert response.returncode != 0 and api.list_pods() == []
            assert c["journalGrant"]["body"]["expires"] > time.time(), "backend-loss control must not be expiry denial"
            result = {"deniedBeforeConsume": args.mode, "beforeDatabaseLossHistory": before_loss, "databaseDestroyed": True,
                "currentHistoryVerified": False, "databaseRecoveryVerified": False}
        elif args.mode in ("cancel", "storage"):
            assert response.returncode != 0 and history == [] and api.list_pods() == []
            assert c["journalGrant"]["body"]["expires"] > time.time(), "current-state control must not be expiry denial"
            result = {"deniedBeforeConsume": args.mode}
        else:
            assert len(history) == 1
            consumed = history[0]
            assert consumed["contract"] == {k: v for k, v in c.items() if k != "journalGrant"}
            assert consumed["podUid"] != consumed["reviewUid"]
            if args.mode in ("drop", "validator"):
                assert response.returncode != 0 and api.list_pods() == []
                if args.mode == "validator":
                    cluster.kubectl("delete", "validatingwebhookconfiguration", LATER_REFUSAL)
                    for _ in range(40):
                        allowed = cluster.kubectl("create", "--dry-run=server", "-f", "-", data=canonical(control_probe), check=False)
                        if allowed.returncode == 0:
                            break
                        time.sleep(.1)
                    assert allowed.returncode == 0, allowed.stderr.decode()
            else:
                assert response.returncode == 0, response.stderr.decode()
                persisted = json.loads(response.stdout) if response.stdout.startswith(b"{") else api.get_pod(captured["metadata"]["name"])
                assert persisted["metadata"]["uid"] == consumed["podUid"]
                # Operator-only fixture removal tests new-object replay. It is
                # explicitly NOT provider stop or same-UID runtime retirement.
                cluster.kubectl("delete", "validatingwebhookconfiguration", "pc-protected-fixture")
                for _ in range(20):
                    patched = cluster.kubectl("-n", EXECUTION, "patch", "pod", captured["metadata"]["name"], "--type=merge", "-p", '{"metadata":{"finalizers":[]}}', check=False)
                    if patched.returncode == 0:
                        break
                    time.sleep(.1)  # API-server webhook-config cache convergence
                assert patched.returncode == 0, patched.stderr.decode()
                cluster.kubectl("-n", EXECUTION, "delete", "pod", captured["metadata"]["name"], "--wait=true")
                # Reinstall original exact webhook from saved object (server
                # resourceVersion/UID deliberately omitted by install below).
                config = json.loads((evidence / "webhook.json").read_text()) if (evidence / "webhook.json").exists() else None
                if config is None:
                    raise Held("missing_fixture_webhook_checkpoint")
                cluster.install(config)
                for _ in range(20):
                    ready = cluster.kubectl("create", "--dry-run=server", "-f", "-", data=canonical(readiness), user=api.user, check=False)
                    if b"protected workload contract refused" in ready.stderr:
                        break
                    time.sleep(.1)
                assert b"protected workload contract refused" in ready.stderr, ready.stderr.decode()
            restarted = backend.request({"op": "restart"})
            assert restarted["restarted"] and restarted["journalConnectionRecreated"]
            assert c["journalGrant"]["body"]["expires"] > time.time(), "replay must use still-valid captured grant"
            retry = cluster.kubectl("create", "-f", "-", data=canonical(captured), user=api.user, check=False)
            assert retry.returncode != 0 and backend.request({"op": "history"}) == history and api.list_pods() == []
            result = {"consumed": consumed, "initialCreateReturnCode": response.returncode, "retryDenied": True}
        result.update(status="PASS", mode=args.mode, authority="real native PostgreSQL journal and mTLS endpoint", productionAcceptance=False,
            storageAttestor="synthetic boolean only", stableRetirement=False, commandExecutionAcceptance=False,
            endpointRestartVerified=args.mode in ("normal", "drop", "validator"),
            journalConnectionRecreated=args.mode in ("normal", "drop", "validator"), nativeProcessRestartVerified=False)
        (evidence / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
    finally:
        try:
            cluster.kubectl("delete", "validatingwebhookconfiguration", LATER_REFUSAL, "--ignore-not-found", check=False)
            cleanup(cluster)
        finally:
            try:
                if backend is not None:
                    backend.close()
            finally:
                observed = command(["docker", "inspect", CONTAINER], check=False)
                if observed.returncode == 0 or b"No such object" not in observed.stderr:
                    raise Held("native_fixture_container_cleanup_failed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", required=True)
    parser.add_argument("--apiserver-certificate", required=True)
    parser.add_argument("--native-image", default="paperclip-native-launch-fixture:disposable")
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--mode", choices=("normal", "cancel", "storage", "drop", "database-loss", "validator"), default="normal")
    run(parser.parse_args())
