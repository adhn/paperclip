"""Single authenticated stdio request, suitable only for the disposable fixture.

No shell evaluation, dynamic import, profiles, provider tools, or host socket.
A production authenticated transport and native DB ACK integration are pending.
"""
import http.client
import json
import os
from pathlib import Path
import socket
import sys
from authority import Authority, Held, Ledger, canonical, digest, request, sign
import hmac


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=15)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class FixtureRuntime:
    def __init__(self, key):
        self.key = key

    def call(self, operation, value):
        sent = request(self.key, operation, value)
        connection = UnixConnection("/broker/runtime.sock")
        try:
            connection.request("POST", "/runtime", canonical(sent), {"Content-Type": "application/json"})
            response = connection.getresponse()
            body = response.read(1048577)
            if response.status != 200 or len(body) > 1048576:
                raise Held("runtime_unavailable")
            reply = json.loads(body)
            if not hmac.compare_digest(sign(self.key, "runtime-reply", reply["body"]), reply["mac"]) or reply["body"]["requestHash"] != digest(sent["body"]):
                raise Held("runtime_authentication_failed")
            return reply["body"]["result"]
        finally:
            connection.close()

    def launch(self, contract, template):
        return self.call("launch", {"contract": contract, "template": template})

    def attest(self):
        return self.call("attest", {})

    def inspect(self, physical):
        return self.call("inspect", physical)

    def stop_and_inspect(self, physical):
        return self.call("stopAndInspect", physical)


def main():
    if os.getuid() != 2000 or os.getgid() != 2000:
        raise Held("supervisor_requires_distinct_nonroot_uid")
    os.umask(0o077)
    config = Path("/config")
    policy = json.loads((config / "policy.json").read_bytes())
    if sys.argv[1:] == ["initialize-disposable-ledger"]:
        Ledger.initialize("/ledger", policy)
        return
    if sys.argv[1:]:
        raise Held("unsupported_entrypoint")
    ledger = Ledger("/ledger", policy, (config / "incarnation").read_text().strip())
    runtime = FixtureRuntime((config / "runtime.key").read_bytes())
    authority = Authority(ledger, policy, (config / "request.key").read_bytes(), (config / "ack.key").read_bytes(), runtime)
    raw = sys.stdin.buffer.read(1048577)
    if len(raw) > 1048576:
        raise Held("control_request_too_large")
    print(canonical(authority.call(json.loads(raw))).decode(), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never leak contracts, keys, argv, state or credentials in an error.
        print('{"error":"protected_execution_held"}', flush=True)
        sys.exit(1)
