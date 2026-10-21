"""Pure loopback TLS contracts, no openssl executable or Kubernetes required.

The embedded key/certificate are public synthetic test fixtures, never deploy.
"""
CERTIFICATE = '-----BEGIN CERTIFICATE-----\nMIIDRTCCAi2gAwIBAgIUZBX7OTs0u8bg95rDCJCaXAt982UwDQYJKoZIhvcNAQEL\nBQAwJDEiMCAGA1UEAwwZZGlzcG9zYWJsZS1rdWJlcm5ldGVzLWFwaTAeFw0yNjEw\nMjAxNTU1MDVaFw0zNjEwMTcxNTU1MDVaMCQxIjAgBgNVBAMMGWRpc3Bvc2FibGUt\na3ViZXJuZXRlcy1hcGkwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCS\nQFAqfpXPwDiZ1o03RX0hsVts5ZDYuMPWnCY1gtt6RtU65KS4SDzwNftL9zV3m2op\nIHWNMzXRENPDM1yH2J46F7Pg3246aSdvsxHcsb5SDDrJtNbs0zpWEnucMOdg+GIA\njIGr+L/m01Qbw4oEo+GLuLk70J2LHk/Llg/kZJZ9QZSd6DuUD7/xpFwzdDTeBbyc\niA0gWhEKYDNWHpCc+xYK8H5C2syqLEeaa7B4q/OexKx1hP5KzaoGSySASTJi7L3Y\nGE/r/+2bZbYoO2qF7eoig02+ZS0O2MyzYFo8dLcQaowQ26LH2FAm/gmnHVouF4DK\nJG50fFSPF0RDFp+vlLbzAgMBAAGjbzBtMB0GA1UdDgQWBBS2U9RM/HULJvGVoods\ny/0Q6dpjrjAfBgNVHSMEGDAWgBS2U9RM/HULJvGVoodsy/0Q6dpjrjAPBgNVHRMB\nAf8EBTADAQH/MBoGA1UdEQQTMBGHBH8AAAGCCWxvY2FsaG9zdDANBgkqhkiG9w0B\nAQsFAAOCAQEAV16smCcYBEKkVXoTFCEqUaaGUX+T2sUEw21RBwoDJ++yTHOWkfXG\nvKGLWfq+JhspWDoe42X3si0VPuxPqI173psZgWKNfFYU/u52PFYSZ7XZ+idOmCpx\nD2NzK3w4amJfh9Mgi4AM9VrCFp5ajB+/ExiHIcvyPCpwBZ3AhJk1D4xUMm00Q/Bt\nHDhonrQUretKFbE+vLsc02UwUk3xq2VhocLxa0qBTQ40tRUsGXgMVXQuGCnOUCZ9\nPsPKATjMFMGVsWTwaWQAe2kWoEcECq3mcFmgt/GaQKj+HIzlRjKOAFfvqH/leBGA\nUk/abt1xa8UJ4BU8aVF+jiXugHXjeMtsjA==\n-----END CERTIFICATE-----\n'
PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCSQFAqfpXPwDiZ\n1o03RX0hsVts5ZDYuMPWnCY1gtt6RtU65KS4SDzwNftL9zV3m2opIHWNMzXRENPD\nM1yH2J46F7Pg3246aSdvsxHcsb5SDDrJtNbs0zpWEnucMOdg+GIAjIGr+L/m01Qb\nw4oEo+GLuLk70J2LHk/Llg/kZJZ9QZSd6DuUD7/xpFwzdDTeBbyciA0gWhEKYDNW\nHpCc+xYK8H5C2syqLEeaa7B4q/OexKx1hP5KzaoGSySASTJi7L3YGE/r/+2bZbYo\nO2qF7eoig02+ZS0O2MyzYFo8dLcQaowQ26LH2FAm/gmnHVouF4DKJG50fFSPF0RD\nFp+vlLbzAgMBAAECggEALfdUuuZqQ4+Qupk6bSLD/3D04TcN3W/E7ZDKWYs1XCsj\nHY17UAg0TvNIdknOXjdUmHSBPc3YnksBo5pi/LdSk8ObX5QZ2vXt1Sec95ZN0Q/S\n8k6KNoj1DtRkUWT1c/7dHnsKzngyKGRHTSqaGHdBjl6SqYAZ4/206rHRcOFEgz09\ntZFpjjdE/wRFdqW0B/hnhu6g66PbNyqHw6DTaWHagUIX8Znl0HEnp7oSleEb8+ac\nIOjqixfMiruMZDZNNqyG0ocEMISuQGTZpoeB6pAjPWJL0Z8QTa++q0Q9ObSCe2rF\n8Y47Rznm7s3fjAKpqI/zEqrgtXdUPOFUj/8OIMinMQKBgQDJJ11wAjMi5LAEc9Jt\nuuObHVprTTOUsoQnS9sPzrGN+RmQ3KajXzWwOTKPMYTTmKJw1Jya7ILtmOxwszIm\n//m7wkYug4Ue8/NlBujxUziLNO9k4UK29P+ddGo6dvLXgNG4x/S1mgCLBwkr2Z/a\n5dqgyaSzrIOz83K9mdfukVSn/QKBgQC6ILj9b+Wrz92XxKnSsx+NTxQUyLnGwG9p\nTP8vDJzA4OOdPWpuUN37Xh6UPbxkZHVNzgjh/RkAjZVMeXaTg9aHTfMOjDAnGyQk\nS9Z1GIibL9OtW5Hx5z1HRRb6iWgrRo1ZdSUbl+q72C9ZnaNobG8j1BSayUNmdyIo\nvFbzVrC1rwKBgAHR8l1+F5pcOV+A8Ml/ZGnV5SiNZUcWKm30mMHW2/Jt65ZM+NEH\nnoO+sL9s8ke73NRqiBQ6yaB+vrzyUiTaMhdJ1bq8A+tYx74FRvxQBXX0/6mJBEKF\niv6QvBlVVDMw/jTO0l8GSrT3VlToPjML22OTD4N0ryhkrogaqUKGXB69AoGAHqk9\nUCKaxw7bBiFTiG4RiIm6WSIn2GHi+InCj9GYEP37APAZFEsmBj6e8vSokDEsUcDb\nHb8/2yN3sL1hlzNkp61jmMXnOMnzzjbgATIlbssWJ7yp8huRsKfk/SidjGN27YGq\ntzzzYjZetniNbqpONKy/KDB3de2yJtu/xx5ExekCgYEAgw/wLRI5/jPXiObDcZnF\nhPNOnBQGmQemeLfCLLq23vxg0rFcsRYM4zGNz+ZU5ZEvrTXGzQ3ubqlcs8GcYkZL\nrSzBN1x54F3QkLAUJAqweOj4KpwsK8j1cHg2s4dNaOjZfdOmma8eB3suqPWYaKxL\nUaT0NGfdQS7OvTNbXNTF7Rc=\n-----END PRIVATE KEY-----\n'
OTHER_CA = '-----BEGIN CERTIFICATE-----\nMIIDPjCCAiagAwIBAgIUc1MQNX4ofn9xCUyniqD3hCRtT+cwDQYJKoZIhvcNAQEL\nBQAwJjEkMCIGA1UEAwwbZGlzcG9zYWJsZS11bnJlbGF0ZWQtYXBpLWNhMB4XDTI2\nMTAyMDE2MDAyNFoXDTM2MTAxNzE2MDAyNFowJjEkMCIGA1UEAwwbZGlzcG9zYWJs\nZS11bnJlbGF0ZWQtYXBpLWNhMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC\nAQEA21CoTP/SpCHBTa/tyCEGQqmy5/hvwffGxnpMc6/b7XZKu74/EhUn8EcH7ZWn\nMkLipfwQuIT7o1T1HNEAIjLc+0v+leu4Ah/FxU9KWF8VwEe2kNhamnRuwL1OhQEK\nLp08nTa+TPWg1CZHy3ac+Dc6w5kk73eqLD5/zRte5idLpxHDhz8KwXQJC6eNrvQL\ng5LjcmybI0YiOvghz+ZCRX0JadBYJC/gA04WqDA3Uhu2Z5LL/pH2r8iBF8sFxVGH\n5J6SjA+xIxxioLlUKBV66WpsE+BauEoxb5XIvNYbsL+1Cgwolb2DVVqoaPSQeddU\nYILRtxm6Qk0NF2Nih/aASKioOwIDAQABo2QwYjAdBgNVHQ4EFgQUr93wdl/YoAwH\na4l+hNsUSlZxHREwHwYDVR0jBBgwFoAUr93wdl/YoAwHa4l+hNsUSlZxHREwDwYD\nVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMA0GCSqGSIb3DQEBCwUAA4IB\nAQA+jLvYu98hOO4H54yCMmKUqn+4HzgYoTSFkjPTMWAEZraozPPk375Lsdes4f+n\n4x2Mb82MiCkrOZ8y72JNGPufdasZZtCBN5igBzbwhohSaY4ibz4JDSNHaYrMTelN\nvvsKwhSiutuZY0x7YeQc2CosoMgxglY9I9gFNrwhurbV48WNYE2OVrnqC69NLoPR\n5AyntbVLpx/lhHkovj9kwc6CD7VZc8n2RqpQeJUvlpJbYQus/FdejLFKyzkBb7U9\nZWDIi/6K5NmZGPI36Ns7WGj3AmRjA5sCigbgqUXHggxRPFlvQA6tY+W7j5vf0PZ7\nabVcrvRqBFkA0u/38YyJFmmx\n-----END CERTIFICATE-----\n'

import copy
import http.server
import json
import os
from pathlib import Path
import queue
import socket
import ssl
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from authority import Held
from kubernetes_api import KubernetesAPI

NAMESPACE = "fixed-execution"
TOKEN = "synthetic-scoped-token-never-log"
PVC_UID = "11111111-1111-4111-8111-111111111111"
POD_UID = "22222222-2222-4222-8222-222222222222"


def pod(name="attempt-test", uid=POD_UID):
    return {"apiVersion": "v1", "kind": "Pod", "metadata": {"name": name, "namespace": NAMESPACE, "uid": uid, "resourceVersion": "12"},
        "spec": {"containers": [{"name": "provider", "image": "example.invalid/provider@sha256:" + "a" * 64}]}}


def manifest(name="attempt-test"):
    value = pod(name)
    value["metadata"] = {"name": name, "namespace": NAMESPACE}
    return value


def pvc():
    return {"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": {"name": "attempt-state", "namespace": NAMESPACE, "uid": PVC_UID, "resourceVersion": "4"},
        "spec": {"accessModes": ["ReadWriteOnce"]}, "status": {"phase": "Bound"}}


def delete_options(uid=POD_UID):
    return {"apiVersion": "v1", "kind": "DeleteOptions", "gracePeriodSeconds": 5, "preconditions": {"uid": uid, "resourceVersion": "12"}}


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *_): pass

    def handle_request(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(size) if size else b""
            self.server.seen.append((self.command, self.path, dict(self.headers), body))
            plan = self.server.plans.get_nowait()
            if self.headers.get("Authorization") != "Bearer " + TOKEN:
                plan = {"status": 401, "body": {"error": "unauthorized"}}
            data = plan.get("body", {})
            data = data if isinstance(data, bytes) else json.dumps(data).encode()
            if plan.get("drip_header"):
                self.connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Slow: ")
                for _ in range(150):
                    self.connection.sendall(b"x"); time.sleep(.02)
                return
            self.send_response(plan.get("status", 200))
            self.send_header("Content-Type", plan.get("content_type", "application/json"))
            if plan.get("chunked"):
                self.send_header("Transfer-Encoding", "chunked")
            else:
                self.send_header("Content-Length", str(plan.get("length", len(data))))
            for key, value in plan.get("headers", {}).items(): self.send_header(key, value)
            self.end_headers()
            if plan.get("drip_body"):
                for byte in data:
                    self.wfile.write(bytes([byte])); self.wfile.flush(); time.sleep(.02)
            elif plan.get("chunked"):
                for offset in range(0, len(data), 64):
                    chunk = data[offset:offset + 64]
                    self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
            else:
                self.wfile.write(data)
            self.wfile.flush()
            if plan.get("watch_close"):
                self.connection.settimeout(1)
                try: closed = not self.connection.recv(1)
                except (ConnectionError, ssl.SSLError): closed = True
                if closed: self.server.peer_closed.set()
            self.close_connection = True
        except (OSError, queue.Empty):
            self.close_connection = True

    do_GET = do_POST = do_DELETE = handle_request


class KubernetesTLSContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.ca = cls.root / "ca.pem"; cls.key = cls.root / "key.pem"
        cls.ca.write_text(CERTIFICATE); cls.key.write_text(PRIVATE_KEY)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.ca, cls.key)
        cls.server = Server(("127.0.0.1", 0), Handler)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.server.plans = queue.Queue(); cls.server.seen = []; cls.server.peer_closed = threading.Event()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()
        cls.origin = "https://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(timeout=1); cls.temporary.cleanup()

    def setUp(self):
        self.server.seen.clear(); self.server.peer_closed.clear()
        while not self.server.plans.empty(): self.server.plans.get_nowait()
        self.ca.write_text(CERTIFICATE)

    def api(self, **overrides):
        return KubernetesAPI(**{**dict(origin=self.origin, ca_file=str(self.ca), bearer_token=TOKEN, namespace=NAMESPACE,
            pvc_name="attempt-state", pvc_uid=PVC_UID, timeout=1), **overrides})

    def plan(self, body=None, **values):
        self.server.plans.put({"body": pod() if body is None else body, **values})

    def test_explicit_tls_pvc_pod_list_create_and_exact_uid_delete(self):
        api = self.api()
        self.plan(pvc()); self.assertEqual(api.get_storage("attempt-state")["metadata"]["uid"], PVC_UID)
        self.plan(status=201); self.assertEqual(api.create_pod(manifest())["metadata"]["uid"], POD_UID)
        self.plan(); self.assertEqual(api.get_pod("attempt-test")["metadata"]["name"], "attempt-test")
        self.plan({"apiVersion": "v1", "kind": "PodList", "metadata": {"resourceVersion": "13"}, "items": [pod()]})
        self.assertEqual(len(api.list_pods()), 1)
        self.plan(); api.delete_pod("attempt-test", delete_options())
        self.assertEqual([(m, p) for m, p, _, _ in self.server.seen], [
            ("GET", "/api/v1/namespaces/fixed-execution/persistentvolumeclaims/attempt-state"),
            ("POST", "/api/v1/namespaces/fixed-execution/pods"),
            ("GET", "/api/v1/namespaces/fixed-execution/pods/attempt-test"),
            ("GET", "/api/v1/namespaces/fixed-execution/pods?limit=128"),
            ("DELETE", "/api/v1/namespaces/fixed-execution/pods/attempt-test")])
        self.assertEqual(json.loads(self.server.seen[-1][3])["preconditions"]["uid"], POD_UID)

    def test_ca_bytes_are_snapshotted_and_ambient_proxy_is_ignored(self):
        api = self.api(); self.ca.write_text("changed after construction")
        self.plan()
        with patch.dict(os.environ, {"HTTPS_PROXY": "http://127.0.0.1:1", "ALL_PROXY": "http://127.0.0.1:1", "NO_PROXY": ""}):
            self.assertEqual(api.get_pod("attempt-test")["metadata"]["uid"], POD_UID)

    def test_typed_list_allows_items_without_both_type_fields(self):
        item = pod(); del item["apiVersion"]; del item["kind"]
        self.plan({"apiVersion": "v1", "kind": "PodList", "metadata": {"resourceVersion": "13"}, "items": [item]})
        self.assertEqual(self.api().list_pods(), [item])
        for operation, status in ((lambda api: api.get_pod("attempt-test"), 200),
                                  (lambda api: api.create_pod(manifest()), 201)):
            self.plan(item, status=status)
            with self.assertRaises(Held): operation(self.api())

    def test_list_partial_conflicting_and_untyped_outer_types_are_refused(self):
        for fields in ({"apiVersion": "v1"}, {"kind": "Pod"}, {"apiVersion": "v2", "kind": "Pod"},
                       {"apiVersion": "v1", "kind": "Secret"}, {"apiVersion": None, "kind": None}):
            item = pod(); del item["apiVersion"]; del item["kind"]; item.update(fields)
            self.plan({"apiVersion": "v1", "kind": "PodList", "metadata": {"resourceVersion": "13"}, "items": [item]})
            with self.subTest(fields=fields), self.assertRaises(Held): self.api().list_pods()
        item = pod(); del item["apiVersion"]; del item["kind"]
        for fields in ({}, {"apiVersion": "v1"}, {"kind": "PodList"}, {"apiVersion": "v1", "kind": "List"}):
            self.plan({**fields, "metadata": {"resourceVersion": "13"}, "items": [item]})
            with self.subTest(outer=fields), self.assertRaises(Held): self.api().list_pods()

    def test_untyped_list_items_preserve_identity_and_spec_guards(self):
        for mutate in (lambda item: item["metadata"].update(namespace="other"),
                       lambda item: item["metadata"].pop("uid"),
                       lambda item: item["spec"].update(hostNetwork=True)):
            item = pod(); del item["apiVersion"]; del item["kind"]; mutate(item)
            self.plan({"apiVersion": "v1", "kind": "PodList", "metadata": {"resourceVersion": "13"}, "items": [item]})
            with self.assertRaises(Held): self.api().list_pods()

    def test_hostnames_non_https_paths_and_credential_routes_are_rejected(self):
        for origin in ("http://127.0.0.1", "https://localhost", "https://127.0.0.1/api", "https://127.0.0.1?", "https://127.0.0.1#", "https://user@127.0.0.1", "https://127.0.0.1:0"):
            with self.subTest(origin=origin), self.assertRaises(Held): self.api(origin=origin)
        with self.assertRaises(Held): self.api(bearer_token="a" + "=" * 16384)
        self.assertEqual(self.server.seen, [])

    def test_unknown_namespace_name_metadata_or_pvc_routes_never_send(self):
        api = self.api()
        cases = [lambda v: v["metadata"].update(namespace="another"), lambda v: v["metadata"].update(name="../escape"),
            lambda v: v["metadata"].update(uid=POD_UID), lambda v: v["metadata"].update(generateName="prefix-"),
            lambda v: v["metadata"].update(ownerReferences=[]), lambda v: v.update(kind="Secret"),
            lambda v: v["spec"].update(hostNetwork=True), lambda v: v["spec"].update(mystery=True)]
        for mutate in cases:
            value = manifest(); mutate(value)
            with self.assertRaises(Held): api.create_pod(value)
        with self.assertRaises(Held): api.get_storage("other-pvc")
        with self.assertRaises(Held): api.get_pod("pod/exec")
        self.assertEqual(self.server.seen, [])

    def test_redirect_is_closed_and_never_followed_or_retried(self):
        self.plan({}, status=302, headers={"Location": self.origin + "/unexpected"}, watch_close=True)
        with self.assertRaises(Held): self.api().get_pod("attempt-test")
        self.assertTrue(self.server.peer_closed.wait(1))
        self.assertEqual(len(self.server.seen), 1)

    def test_authentication_refusal_does_not_expose_token(self):
        self.plan()
        secret = "wrong-private-bearer"
        with self.assertRaises(Held) as raised: self.api(bearer_token=secret).get_pod("attempt-test")
        self.assertNotIn(secret, str(raised.exception)); self.assertNotIn(secret, repr(raised.exception))
        self.assertEqual(len(self.server.seen), 1)

    def test_invalid_ca_is_refused_before_network(self):
        self.ca.write_text("invalid-ca")
        with self.assertRaises(Held): self.api()
        self.assertEqual(self.server.seen, [])

    def test_unrelated_valid_ca_rejects_real_tls_before_authorization(self):
        self.ca.write_text(OTHER_CA)
        with self.assertRaises(Held): self.api().get_pod("attempt-test")
        self.assertEqual(self.server.seen, [])

    def test_tls_handshake_has_the_same_absolute_deadline(self):
        listener = socket.socket(); listener.bind(("127.0.0.1", 0)); listener.listen(1)
        def stall():
            accepted, _ = listener.accept()
            try:
                accepted.settimeout(1); accepted.recv(65536); time.sleep(.6)
            finally: accepted.close()
        thread = threading.Thread(target=stall, daemon=True); thread.start()
        started = time.monotonic()
        try:
            with self.assertRaises(Held): self.api(origin="https://127.0.0.1:" + str(listener.getsockname()[1]), timeout=.2).get_pod("attempt-test")
            self.assertLess(time.monotonic() - started, 1.2)
        finally:
            listener.close(); thread.join(timeout=1)

    def test_unknown_schema_duplicate_json_and_wrong_target_fail_closed(self):
        replies = [b'{"kind":"Pod","kind":"Pod"}', {**pod(), "newSchema": True}, {**pod(), "kind": "Secret"}]
        for value in replies:
            self.plan(value)
            with self.assertRaises(Held): self.api().get_pod("attempt-test")
        value = pod(); value["metadata"]["namespace"] = "wrong"; self.plan(value)
        with self.assertRaises(Held): self.api().get_pod("attempt-test")
        value = pvc(); value["metadata"]["uid"] = "replaced-volume"; self.plan(value)
        with self.assertRaisesRegex(Held, "storage_incarnation_changed"): self.api().get_storage("attempt-state")

    def test_truncated_valid_json_is_not_a_successful_response(self):
        data = json.dumps(pod()).encode(); self.plan(data, length=len(data) + 10)
        with self.assertRaises(Held): self.api().get_pod("attempt-test")

    def test_bounded_chunked_and_declared_response_bodies(self):
        self.plan(chunked=True); self.assertEqual(self.api().get_pod("attempt-test")["kind"], "Pod")
        for chunked in (False, True):
            self.plan(b" " * 2049, chunked=chunked)
            with self.assertRaises(Held): self.api(max_bytes=1024).get_pod("attempt-test")

    def test_slow_drip_headers_and_body_have_one_absolute_deadline(self):
        for field in ("drip_header", "drip_body"):
            self.plan(**{field: True})
            started = time.monotonic()
            with self.assertRaises(Held): self.api(timeout=.25).get_pod("attempt-test")
            self.assertLess(time.monotonic() - started, 1.2)

    def test_no_automatic_retry_and_uncertain_create_cannot_replay(self):
        api = self.api(); self.plan({}, status=500)
        with self.assertRaises(Held): api.create_pod(manifest())
        with self.assertRaisesRegex(Held, "kubernetes_create_already_attempted"): api.create_pod(manifest())
        self.assertEqual(len(self.server.seen), 1)

    def test_refusal_exposes_only_numeric_status_and_does_not_retry_delete(self):
        api = self.api(); self.plan(); api.get_pod("attempt-test")
        private = "private-server-reason-or-token"
        self.plan({"reason": private, "message": private}, status=403, headers={"X-Private": private})
        with self.assertRaises(Held) as raised: api.delete_pod("attempt-test", delete_options())
        self.assertEqual(str(raised.exception), "kubernetes_api_refused_http_403")
        self.assertNotIn(private, repr(raised.exception))
        self.assertEqual(len(self.server.seen), 2)

    def test_disposable_running_contract_remains_guard_valid_and_bounded(self):
        from authority import digest
        from kubernetes_boundary import WorkloadGuard
        from test_kubernetes_boundary import fixture
        from test_kubernetes_api_disposable import configure_running_contract
        policy, contract, original = fixture()
        image = policy["templates"]["synthetic"]["image"]
        configure_running_contract(policy, contract, image)
        guard = WorkloadGuard(original.namespace, original.supervisor_user, policy, {"synthetic": image}, original.storages)
        value = guard.manifest(contract)
        guard.validate({"namespace": guard.namespace, "resource": {"group": "", "version": "v1", "resource": "pods"},
            "operation": "CREATE", "userInfo": {"username": guard.supervisor_user}, "object": value})
        self.assertEqual(value["spec"]["containers"][0]["command"], ["/bin/sleep"])
        self.assertEqual(value["spec"]["containers"][0]["args"], ["60"])
        self.assertEqual(contract["commandHash"], digest(["60"]))
        self.assertLessEqual(value["spec"]["activeDeadlineSeconds"], 600)

    def test_pod_replacement_and_incomplete_lists_cannot_be_absence_proof(self):
        api = self.api(); self.plan(); api.get_pod("attempt-test")
        self.plan(pod(uid="replacement-pod"))
        with self.assertRaisesRegex(Held, "incarnation_changed"): api.get_pod("attempt-test")
        self.plan({"apiVersion": "v1", "kind": "PodList", "metadata": {"resourceVersion": "13", "continue": "next"}, "items": []})
        with self.assertRaisesRegex(Held, "list_incomplete"): api.list_pods()

    def test_missing_wrong_uid_and_force_delete_are_refused_before_delete(self):
        api = self.api(); self.plan(); api.get_pod("attempt-test")
        for options in ({"kind": "DeleteOptions"}, delete_options("wrong-uid"), {**delete_options(), "gracePeriodSeconds": 0},
                        {**delete_options(), "propagationPolicy": "Foreground"}):
            with self.assertRaises(Held): api.delete_pod("attempt-test", options)
        with self.assertRaises(Held): api.delete_pod("unknown-name", delete_options())
        self.assertEqual(len(self.server.seen), 1)

    def test_delete_success_is_only_exact_api_acceptance_not_stop(self):
        api = self.api(); self.plan(); api.get_pod("attempt-test")
        self.plan({"apiVersion": "v1", "kind": "Status", "status": "Success", "details": {"name": "attempt-test", "uid": POD_UID}}, status=202)
        result = api.delete_pod("attempt-test", delete_options())
        self.assertNotIn("stopped", result); self.assertNotIn("stableRetirement", result)
        self.assertFalse(hasattr(api, "verify_retired"))


if __name__ == "__main__": unittest.main()
