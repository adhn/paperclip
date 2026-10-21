"""Actual isolated supervisor/provider containers, synthetic CLI/auth only.

Run as a disposable Docker fixture harness, NOT inside either trusted workload.
The fixture broker has host authority, is local-only, and is never a deployable
production component. Its Unix socket is mounted only by supervisor containers.
"""
import contextlib
import hmac
import http.server
import json
import os
from pathlib import Path
import socketserver
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid
from authority import Held, canonical, digest, request, sign, verify_ack
from docker_runtime import DockerRuntime
from test_authority import policy


def run():
    prefix = "pc-protected-" + uuid.uuid4().hex[:12]
    image = DockerRuntime.command("image", "inspect", "paperclip-protected-disposable", "--format", "{{.Id}}")
    provider_image = DockerRuntime.command("image", "inspect", "paperclip-protected-synthetic", "--format", "{{.Id}}")
    spec = policy()
    spec["templates"]["synthetic"]["image"] = provider_image
    spec["runtimeAuthority"] = DockerRuntime.command("info", "--format", "{{.ID}}")
    # Preserve the actual saved scope families while all owner IDs/data remain
    # synthetic. A new container/pool cannot manufacture fresh Codex scopes.
    saved = json.loads((Path(__file__).resolve().parent.parent / "docs/bootstrap-review/held-policy.json").read_text())
    codex = next(owner for owner in saved["legacyOwners"] if owner["providerAccount"].startswith("codex:"))
    spec["families"] = [{key: codex["providerAccount"] if key == "account" else codex[key]
                         for key in "runner account workspace session credential".split()}]
    keys = {name: os.urandom(32) for name in ("request", "ack", "runtime")}
    runtime = DockerRuntime(spec, prefix)
    observations = []
    with tempfile.TemporaryDirectory(prefix=prefix) as directory:
        root = Path(directory)
        ledger, config, broker = (root / name for name in ("ledger", "config", "broker"))
        for path in (ledger, config, broker):
            path.mkdir(mode=0o755)
        (config / "policy.json").write_bytes(canonical(spec))
        for name, value in keys.items():
            (config / (name + ".key")).write_bytes(value)
        for path in config.iterdir():
            path.chmod(0o444)

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                try:
                    if self.path != "/runtime":
                        raise Held("unknown_runtime_route")
                    size = int(self.headers["Content-Length"])
                    if not 0 < size <= 1048576:
                        raise Held("runtime_request_too_large")
                    envelope = json.loads(self.rfile.read(size))
                    body = envelope["body"]
                    if not hmac.compare_digest(sign(keys["runtime"], "request", body), envelope["mac"]) or time.time() >= body["expires"]:
                        raise Held("runtime_authentication")
                    operation, value = body["op"], body["value"]
                    if operation == "attest" and value == {}:
                        result = runtime.attest()
                    elif operation == "launch":
                        result = runtime.launch(value["contract"], value["template"])
                    elif operation == "inspect":
                        result = runtime.inspect(value)
                    elif operation == "stopAndInspect":
                        result = runtime.stop_and_inspect(value)
                    else:
                        raise Held("unsupported_runtime_operation")
                    reply = {"requestHash": digest(body), "result": result}
                    payload = canonical({"body": reply, "mac": sign(keys["runtime"], "runtime-reply", reply)})
                    self.send_response(200)
                except Exception:
                    payload = b'{"error":"runtime_held"}'
                    self.send_response(409)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        class Server(socketserver.UnixStreamServer):
            pass

        server = Server(str(broker / "runtime.sock"), Handler)
        # Disposable volume preparation only; both actual workloads remain
        # non-root. The harness has Docker permission, not host chown rights.
        runtime.command("run", "--rm", "--network", "none", "--user", "0:0", "--entrypoint", "python3",
            "--mount", f"type=bind,src={root},dst=/fixture", image, "-c",
            "import os; os.chown('/fixture/ledger',2000,2000); os.chmod('/fixture/ledger',0o700); "
            "os.chown('/fixture/broker/runtime.sock',2000,2000); os.chmod('/fixture/broker/runtime.sock',0o660)")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def supervisor(payload=None, arguments=()):
            result = subprocess.run(["docker", "run", "--rm", "-i", "--name", prefix + "-supervisor",
                "--network", "none", "--user", "2000:2000", "--read-only", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--memory", "128m", "--cpus", "0.5", "--pids-limit", "64",
                "--mount", f"type=bind,src={ledger},dst=/ledger",
                "--mount", f"type=bind,src={config},dst=/config,readonly",
                "--mount", f"type=bind,src={broker},dst=/broker,readonly", image, *arguments],
                input=canonical(payload) if payload else b"", capture_output=True, timeout=35)
            if result.returncode:
                raise Held("supervisor_request_held")
            return json.loads(result.stdout) if result.stdout.strip() else None

        try:
            supervisor(arguments=("initialize-disposable-ledger",))
            incarnation = runtime.command("run", "--rm", "--network", "none", "--user", "2000:2000", "--entrypoint", "python3",
                "--mount", f"type=bind,src={ledger},dst=/ledger", image, "-c",
                "import sqlite3; print(sqlite3.connect('/ledger/ledger.sqlite').execute('SELECT incarnation FROM meta').fetchone()[0])")
            (config / "incarnation").write_text(incarnation)
            (config / "incarnation").chmod(0o444)
            pin = {"instance": spec["instance"], "policy": digest(spec), "pool": spec["pool"],
                   "incarnation": incarnation, "generation": 0, "epoch": None}

            def call(operation, value):
                nonlocal pin
                sent = request(keys["request"], operation, value)
                response = supervisor(sent)
                pin = verify_ack(keys["ack"], response, sent, pin)
                return response["body"]["result"]

            epoch = {"expectedGeneration": 0, "epoch": "disposable-epoch"}
            assert call("acknowledgeEpoch", epoch) == {"status": "acknowledged"}
            assert call("acknowledgeEpoch", epoch) == {"status": "acknowledged"}
            observations.append("non-root supervisor restart and independently verified lost-ACK retry")

            # Every control request gets a fresh supervisor process/container.
            # The ledger remains the same separate UID-2000 durable mount.
            script = r"""
import json, os, pathlib, subprocess, sys, time
assert os.getuid() == 1000
for path in ['/ledger/ledger.sqlite', '/config/ack.key', '/broker/runtime.sock', '/var/run/docker.sock', '/var/run/secrets/kubernetes.io/serviceaccount/token']:
    assert not os.path.exists(path), path
child = subprocess.Popen([sys.executable, '-c', 'import time,pathlib; p=pathlib.Path("/attempt/ticks");\nwhile True:\n p.open("a").write("tick\\n"); time.sleep(.05)'], start_new_session=True)
pathlib.Path('/attempt/ready').write_text(json.dumps({'uid':os.getuid(),'descendant':child.pid}))
while True: time.sleep(1)
"""
            owner = {key: "exact-" + key for key in "company agent nativeId environment lease attempt".split()}
            owner.update(spec["families"][0], nativeKind="run")
            contract = {"version": 1, "instance": spec["instance"], "policy": digest(spec), "epoch": epoch["epoch"],
                "generation": 1, "owner": owner, "invocation": "exact-disposable-invocation", "commandHash": digest(["-c", script]),
                "journalHash": digest({"syntheticCommittedJournal": 1}), "storage": "exact-disposable-storage",
                "template": "synthetic", "argv": ["-c", script]}
            started = call("authorizeInvocation", contract)
            assert started["status"] == "started", started
            physical = started["physical"]
            assert call("authorizeInvocation", contract) == started
            container = json.loads(runtime.command("inspect", physical["container"]))[0]
            assert container["Config"]["User"] == "1000:1000"
            assert container["HostConfig"]["ReadonlyRootfs"] and container["HostConfig"]["NetworkMode"] == "none"
            assert len(container["Mounts"]) == 1 and container["Mounts"][0]["Destination"] == "/attempt"
            for _ in range(50):
                probe = subprocess.run(["docker", "exec", physical["container"], "python3", "-c",
                    "from pathlib import Path; assert Path('/attempt/ready').exists() and Path('/attempt/ticks').stat().st_size > 0"], capture_output=True)
                if probe.returncode == 0:
                    break
                time.sleep(0.1)
            else:
                raise AssertionError("synthetic provider did not become ready")
            observations.append("actual UID-1000 provider cannot see ledger, control keys, broker, daemon or service-account token")
            observations.append("duplicate invocation creates one exact container with retained per-attempt volume")
            wrong = json.loads(canonical(contract))
            wrong["owner"]["lease"] = "sibling"
            try:
                call("stopAndInspect", wrong)
                raise AssertionError("wrong lease accepted")
            except Held:
                pass
            assert runtime.inspect(physical)["status"] == "running"
            stopped = call("stopAndInspect", contract)
            assert stopped["status"] == "stopped" and stopped["occupied"] is True
            volume = container["Mounts"][0]["Name"]

            def ticks():
                return runtime.command("run", "--rm", "--network", "none", "--user", "1000:1000", "--read-only",
                    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "64m", "--pids-limit", "32",
                    "--mount", f"type=volume,src={volume},dst=/attempt,readonly", "--entrypoint", "/usr/local/bin/python3",
                    provider_image, "-c", "from pathlib import Path; print(Path('/attempt/ticks').read_bytes().hex())")

            first_ticks = ticks()
            assert first_ticks and first_ticks == ticks()
            observations.append("exact independently observed engine stop; descendant namespace stopped; occupancy retained")
            observations.append("retained uncommitted descendant output stays byte-identical after stop")
            assert call("inspect", contract)["status"] == "stopped"
            runtime.command("rm", physical["container"])
            lost = call("inspect", contract)
            assert lost["status"] == "uncertain" and lost["occupied"]
            observations.append("removed runtime object is uncertain rather than fabricated termination proof")
            try:
                call("acknowledgeEpoch", {"expectedGeneration": 1, "epoch": "replacement"})
                raise AssertionError("occupied takeover accepted")
            except Held:
                pass
            observations.append("restart preserves occupancy and refuses epoch takeover")
            return {"status": "PASS", "supervisorImageId": image, "syntheticImageId": provider_image,
                    "checks": observations, "productionAcceptance": False}
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
            runtime.cleanup()
            subprocess.run(["docker", "rm", "-f", prefix + "-supervisor"], capture_output=True, timeout=20)
            runtime.command("run", "--rm", "--network", "none", "--user", "0:0", "--entrypoint", "python3",
                "--mount", f"type=bind,src={root},dst=/fixture", image, "-c",
                f"import os; [(os.chown(os.path.join(p,n),{os.getuid()},{os.getgid()})) for p,ds,fs in os.walk('/fixture') for n in ds+fs]")


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
