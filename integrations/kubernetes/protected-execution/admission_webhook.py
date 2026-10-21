"""Fixed validating AdmissionReview HTTPS service, non-root, no cluster token."""
import hashlib
import http.server
import json
import os
import re
import socket
from pathlib import Path
import ssl
from authority import Held, canonical
from kubernetes_boundary import WorkloadGuard


class Handler(http.server.BaseHTTPRequestHandler):
    guard = None
    api_fingerprint = None

    def log_message(self, *_):
        pass  # Never log request bodies, arguments, credentials or keys.

    def do_POST(self):
        try:
            if self.api_fingerprint is not None and hashlib.sha256(self.connection.getpeercert(binary_form=True)).hexdigest() != self.api_fingerprint:
                raise Held("wrong_authenticated_apiserver")
            size = int(self.headers.get("Content-Length", "0"))
            path = self.path.split("?", 1)[0]
            fixture_faults = os.environ.get("PAPERCLIP_DISPOSABLE_CURRENT_AUTHORITY") == "yes" or os.environ.get("PAPERCLIP_DISPOSABLE_ADMISSION_FAULTS") == "yes"
            fixture_refuse = path == "/fixture-refuse" and fixture_faults
            fixture_drop = path == "/fixture-drop" and fixture_faults
            if (path != "/validate" and not fixture_refuse and not fixture_drop) or not 0 < size <= 1048576:
                raise Held("invalid_review")
            review = json.loads(self.rfile.read(size))
            if review.get("apiVersion") != "admission.k8s.io/v1" or review.get("kind") != "AdmissionReview":
                raise Held("invalid_review")
            request = review["request"]
            response = {"uid": request["uid"], "allowed": False}
            try:
                if fixture_refuse:
                    response["status"] = {"code": 403, "message": "synthetic independent validator rejection"}
                else:
                    self.guard.validate(request)
                    response["allowed"] = True
            except Exception:
                response["status"] = {"code": 403, "message": "protected workload contract refused"}
            if fixture_drop and response["allowed"]:
                # Fault injection only: consume has committed; API never sees
                # allow. Never restore the permit after this uncertain response.
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            data = canonical({"apiVersion": "admission.k8s.io/v1", "kind": "AdmissionReview", "response": response})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            self.send_error(400)


def main():
    if os.getuid() != 2000 or os.getgid() != 2000:
        raise Held("webhook_requires_nonroot_uid")
    config = json.loads(Path("/config/guard.json").read_bytes())
    # Independent native grant key is absent from supervisor/provider. It must
    # never be stored in their policy or user-mutable configuration.
    Handler.api_fingerprint = config.pop("apiserver_fingerprint", None)
    if not isinstance(Handler.api_fingerprint, str) or not re.fullmatch("[0-9a-f]{64}", Handler.api_fingerprint):
        raise Held("pinned_authenticated_apiserver_required")
    fixture = config.pop("disposable_current_authority", None)
    consumer = config.pop("native_consumer", None)
    if fixture and consumer:
        raise Held("conflicting_current_launch_authorities")
    if fixture:
        # Explicit fixture-only mode. This independent history is never mounted
        # in the supervisor/provider; it is not a production native service.
        if os.environ.get("PAPERCLIP_DISPOSABLE_CURRENT_AUTHORITY") != "yes":
            raise Held("disposable_authority_is_not_deployable")
        from launch_consumption import FixtureCurrentAuthority
        consumer = FixtureCurrentAuthority("/current/launch.sqlite", config["admission_identity"])
        consumer.register(fixture["contract"], fixture["target"])
    elif consumer:
        from launch_consumption import OnlineLaunchConsumer
        consumer = OnlineLaunchConsumer(**consumer)
    if consumer is None:
        raise Held("current_native_launch_authority_required")
    Handler.guard = WorkloadGuard(**config, journal_key=Path("/tls/journal.key").read_bytes(), launch_consumer=consumer)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", 8443), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain("/tls/tls.crt", "/tls/tls.key")
    if Handler.api_fingerprint is not None:
        context.load_verify_locations(cafile="/tls/apiserver-client.crt")
        context.verify_mode = ssl.CERT_REQUIRED
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
