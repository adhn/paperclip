"""Synthetic stream enforcer contracts; no production issuer/backend acceptance."""
import base64
import copy
import hashlib
import hmac
import json
from http.server import HTTPServer
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from production.gateway import Held, JsonMTLS, canonical, digest
from production.stream_server import (AuthorityPin, ExistingStream, ExistingStreamBackend,
                                      StreamControl, tls_handler)


from production.write_authority import AtomicWriteBackend, WriteIntent, WriteResult


PINS = dict(instance="original", pool="codex", policy="policy", epoch="epoch",
            authorityIncarnation="native-authority", historyDomain="native-history",
            historyIncarnation="history", historyFloor=42)
ATTACH = dict(version=1, pins=PINS, attach=dict(commandId="command", invocation="invocation",
              physical=dict(pool="codex", uid="pod", container="engine", node="node", storage="volume"),
              stdin="exclusive", claim=dict(id="claim", bindingHash="a" * 64)))
RECEIPT = dict(version=1, status="committed", requestHash=digest(ATTACH), pins=PINS,
               claim=ATTACH["attach"]["claim"], ticket="ticket", historyRevision=43)
OPEN = dict(receipt=RECEIPT, attach=ATTACH)
CERT = b"synthetic-peer-certificate-only-for-direct-unit-contract"
RUNTIME = AuthorityPin("independent-runtime", "runtime-history", 5, b"r" * 32)
STORAGE = AuthorityPin("independent-storage", "storage-history", 7, b"s" * 32)


class Native:
    """Synthetic permanent consumption. Production uses native PostgreSQL."""
    def __init__(self, events):
        self.events, self.used, self.change = events, False, lambda result: result

    def post(self, path, body):
        self.events.append("native-commit")
        if path != "/v1/stdin/claim-stream" or self.used:
            raise Held("ticket_consumed")
        self.used = True
        return self.change(dict(version=1, status="committed", receiptHash=digest(body["receipt"]),
                 attachHash=digest(body["attach"]), streamIncarnation=body["streamIncarnation"],
                 consumptionId="consumption", physical=copy.deepcopy(ATTACH["attach"]["physical"]),
                 claim=copy.deepcopy(ATTACH["attach"]["claim"]), pins=copy.deepcopy(PINS), historyRevision=44))


class Backend(ExistingStreamBackend, AtomicWriteBackend):
    """Synthetic independently keyed proof issuer/existing capability, never deploy."""
    def __init__(self, events):
        self.events, self.change = events, lambda result: result
        self.fail_acquire = self.fail_close = False

    def proofs(self, binding, challenge, deadline):
        self.events.append("independent-proofs")
        result = {}
        for role, key, pin in (("runtime-start", "runtime", RUNTIME), ("storage-exclusive", "storage", STORAGE)):
            body = dict(role=role, domain=pin.domain, incarnation=pin.incarnation, revision=pin.floor,
                        bindingHash=digest(binding), challenge=challenge, issuedAt=int(time.time()),
                        expiresAt=int(time.time()) + 10)
            mac = hmac.new(pin.key, b"paperclip-stream-authority-v1\0" + canonical(body), hashlib.sha256).hexdigest()
            result[key] = dict(body=body, mac=mac)
        return self.change(result)

    def acquire_exact(self, binding, authority, deadline):
        self.events.append("acquire-existing")
        if self.fail_acquire:
            raise Held("uncertain_acquisition")
        return ExistingStream("existing-capability", digest(binding))

    def resolve_write_intent(self, stream, binding, authority, operation, sequence, data_hash, byte_count, deadline):
        self.write_context = (stream, authority)
        return WriteIntent(operation, digest(binding), "c" * 64, sequence, data_hash,
                           44, authority.runtime_revision, authority.storage_revision, 1, byte_count)

    def commit_write(self, intent, data, deadline):
        stream, authority = self.write_context
        return WriteResult(intent, self.write_exact(stream, authority, intent.sequence, data, deadline), intent.sequence + 1)

    def revoke(self, binding_hash, expected_revision, deadline):
        raise Held("synthetic_revoke_not_installed")

    def inspect_write(self, intent, deadline):
        return None

    def write_exact(self, stream, authority, sequence, data, deadline):
        self.events.append(("write", sequence, data))
        return len(data)

    def close_exact(self, stream, deadline):
        self.events.append("close-only")
        if self.fail_close:
            raise Held("uncertain_close")


class StreamContracts(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.native, self.backend = Native(self.events), Backend(self.events)
        self.server = self.control()

    def control(self, backend="default", fingerprint=None):
        return StreamControl(self.native, self.backend if backend == "default" else backend,
                             PINS, fingerprint or hashlib.sha256(CERT).hexdigest(),
                             "stream-incarnation", RUNTIME, STORAGE)

    def call(self, body=OPEN, path="/v1/stdin/open", cert=CERT, server=None):
        return (server or self.server).dispatch(path, canonical(body), cert, time.monotonic() + 3)

    def test_native_commit_independent_proofs_then_exact_existing_acquire(self):
        reply = self.call()
        self.assertEqual(self.events, ["native-commit", "independent-proofs", "acquire-existing"])
        self.assertEqual(reply["receiptHash"], digest(RECEIPT))
        self.assertEqual(reply["status"], "owned")

    def test_missing_backend_or_wrong_tls_peer_has_no_effect(self):
        for backend, cert in ((None, CERT), (object(), CERT), (self.backend, b"wrong-cert")):
            with self.assertRaises(Held):
                self.call(cert=cert, server=self.control(backend=backend))
        self.assertEqual(self.events, [])

    def test_exact_request_and_pins_refuse_before_consumption(self):
        for request in ({**OPEN, "peerIdentity": "trusted"},
                        {**OPEN, "attach": {**ATTACH, "pins": {**PINS, "epoch": "replacement"}}},
                        {**OPEN, "receipt": {**RECEIPT, "historyRevision": 1}},
                        {**OPEN, "receipt": {**RECEIPT, "status": "uncommitted"}}):
            with self.subTest(request=list(request)), self.assertRaises(Held):
                self.call(request)
        self.assertEqual(self.events, [])

    def test_every_native_binding_checked_before_backend(self):
        for key, value in (("status", "uncommitted"), ("version", True), ("receiptHash", "b" * 64),
                           ("attachHash", "b" * 64), ("streamIncarnation", "other"),
                           ("physical", {}), ("claim", {}), ("pins", {**PINS, "epoch": "old"}),
                           ("historyRevision", 42), ("historyRevision", 43), ("historyRevision", True), ("consumptionId", "unsafe/path")):
            with self.subTest(key=key):
                self.setUp()
                self.native.change = lambda result, k=key, v=value: {**result, k: v}
                with self.assertRaises(Held):
                    self.call()
                self.assertEqual(self.events, ["native-commit"])

    def test_uncertain_consumption_and_server_restart_never_reacquire(self):
        self.native.change = lambda _: (_ for _ in ()).throw(Held("lost_commit_reply"))
        with self.assertRaises(Held):
            self.call()
        with self.assertRaises(Held):
            self.call()
        # New local memory cannot clear native permanent ticket consumption.
        self.native.change = lambda result: result
        with self.assertRaises(Held):
            self.call(server=self.control())
        self.assertEqual(self.events, ["native-commit", "native-commit"])

    def test_proof_string_bad_signature_wrong_domain_and_missing_storage_hold(self):
        changes = (lambda _: "fixture-proof", lambda r: {"runtime": r["runtime"]},
                   lambda r: {**r, "runtime": {**r["runtime"], "mac": "0" * 64}},
                   lambda r: {**r, "storage": r["runtime"]})
        for change in changes:
            with self.subTest(change=change):
                self.setUp()
                self.backend.change = change
                with self.assertRaises(Held):
                    self.call()
                self.assertEqual(self.events, ["native-commit", "independent-proofs"])
                self.assertTrue(self.native.used)

    def test_stale_or_other_binding_challenge_signed_proof_refused(self):
        for field, value in (("bindingHash", "b" * 64), ("challenge", "other"),
                             ("revision", 1), ("expiresAt", 1), ("incarnation", "old")):
            self.setUp()
            def change(result, field=field, value=value):
                body = {**result["runtime"]["body"], field: value}
                mac = hmac.new(RUNTIME.key, b"paperclip-stream-authority-v1\0" + canonical(body), hashlib.sha256).hexdigest()
                return {**result, "runtime": dict(body=body, mac=mac)}
            self.backend.change = change
            with self.assertRaises(Held):
                self.call()
            self.assertNotIn("acquire-existing", self.events)

    def test_close_only_and_no_double_close_or_reopen(self):
        reply = self.call()
        close = dict(handle=reply["handle"], receiptHash=reply["receiptHash"])
        self.assertEqual(self.call(close, "/v1/stdin/close"), dict(status="closed", receiptHash=digest(RECEIPT)))
        with self.assertRaises(Held):
            self.call(close, "/v1/stdin/close")
        with self.assertRaises(Held):
            self.call()
        self.assertEqual(self.events.count("acquire-existing"), 1)
        self.assertEqual(self.events.count("close-only"), 1)
        self.assertTrue(self.native.used)

    def test_uncertain_acquire_or_close_retains_consumption(self):
        self.backend.fail_acquire = True
        with self.assertRaises(Held):
            self.call()
        self.assertTrue(self.native.used)
        with self.assertRaises(Held):
            self.call()
        self.setUp()
        reply = self.call()
        self.backend.fail_close = True
        close = dict(handle=reply["handle"], receiptHash=reply["receiptHash"])
        for _ in range(2):
            with self.assertRaises(Held):
                self.call(close, "/v1/stdin/close")
        self.assertEqual(self.events.count("close-only"), 1)
        self.assertTrue(self.native.used)

    def test_concurrent_duplicate_has_only_one_native_commit_and_acquire(self):
        def call():
            try:
                self.call()
            except Held:
                pass
        threads = [threading.Thread(target=call) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(self.events.count("native-commit"), 1)
        self.assertEqual(self.events.count("acquire-existing"), 1)

    def test_proof_expiry_is_retained_and_shortens_backend_effect_deadline(self):
        def change(result):
            for key, pin in (("runtime", RUNTIME), ("storage", STORAGE)):
                body = result[key]["body"]
                body["expiresAt"] = body["issuedAt"] + 2
                result[key]["mac"] = hmac.new(pin.key, b"paperclip-stream-authority-v1\0" + canonical(body), hashlib.sha256).hexdigest()
            return result
        self.backend.change = change
        acquire = self.backend.acquire_exact
        def checked(binding, authority, deadline):
            self.assertLessEqual(deadline - time.monotonic(), 2)
            self.assertLessEqual(authority.expires_at - time.time(), 2)
            return acquire(binding, authority, deadline)
        self.backend.acquire_exact = checked
        self.call()

    def test_late_exact_acquire_attempts_close_only_and_retains_consumption(self):
        acquire = self.backend.acquire_exact
        def late(binding, authority, deadline):
            stream = acquire(binding, authority, deadline)
            self.server._remaining = lambda _: (_ for _ in ()).throw(Held("elapsed_after_acquire"))
            return stream
        self.backend.acquire_exact = late
        with self.assertRaises(Held):
            self.call()
        self.assertEqual(self.events, ["native-commit", "independent-proofs", "acquire-existing", "close-only"])
        self.assertTrue(self.native.used)

    def test_acquire_after_shorter_proof_deadline_closes_even_with_caller_time_left(self):
        acquire = self.backend.acquire_exact
        def late(binding, authority, deadline):
            stream = acquire(binding, authority, deadline)
            # Advance only the wall clock past the signed proof validity; the
            # outer caller monotonic deadline remains three seconds in future.
            patcher = patch("production.stream_server.time.time", return_value=authority.expires_at)
            patcher.start()
            self.addCleanup(patcher.stop)
            return stream
        self.backend.acquire_exact = late
        with self.assertRaises(Held):
            self.call()
        self.assertEqual(self.events, ["native-commit", "independent-proofs", "acquire-existing", "close-only"])
        self.assertTrue(self.native.used)

    def test_shortened_monotonic_acquire_deadline_checked_after_backend_return(self):
        def short_proofs(result):
            for key, pin in (("runtime", RUNTIME), ("storage", STORAGE)):
                body = result[key]["body"]
                body["expiresAt"] = body["issuedAt"] + 2
                result[key]["mac"] = hmac.new(pin.key, b"paperclip-stream-authority-v1\0" + canonical(body), hashlib.sha256).hexdigest()
            return result
        self.backend.change = short_proofs
        acquire = self.backend.acquire_exact
        actual_clock, clock = time.monotonic, {}
        def late(binding, authority, deadline):
            stream = acquire(binding, authority, deadline)
            clock["now"] = deadline + 0.001
            return stream
        self.backend.acquire_exact = late
        with patch("production.stream_server.time.monotonic", side_effect=lambda: clock.get("now", actual_clock())):
            with self.assertRaises(Held):
                self.call()
        self.assertEqual(self.events, ["native-commit", "independent-proofs", "acquire-existing", "close-only"])
        self.assertTrue(self.native.used)

    def test_size_duplicate_json_and_deadline_refuse(self):
        for raw in (b'{"x":1,"x":2}', b'x' * 16385, b'{"x":NaN}'):
            with self.assertRaises(Held):
                self.server.dispatch("/v1/stdin/open", raw, CERT, time.monotonic() + 3)
        with self.assertRaises(Held):
            self.server.dispatch("/v1/stdin/open", canonical(OPEN), CERT, time.monotonic() - 1)
        self.assertEqual(self.events, [])

    def write_request(self, reply, data=b"exact\x00bytes", sequence=0):
        return dict(handle=reply["handle"], receiptHash=reply["receiptHash"], sequence=sequence,
                    dataHash=hashlib.sha256(data).hexdigest(), data=base64.b64encode(data).decode("ascii"))

    def test_every_write_obtains_fresh_proofs_and_forwards_exact_bytes(self):
        reply = self.call()
        request = self.write_request(reply)
        result = self.call(request, "/v1/stdin/write")
        self.assertEqual(result, dict(status="written", receiptHash=reply["receiptHash"], sequence=0,
                                      dataHash=request["dataHash"], bytes=11))
        self.call(self.write_request(reply, b"next", 1), "/v1/stdin/write")
        self.assertEqual(self.events.count("independent-proofs"), 3)
        self.assertEqual(self.events[-1], ("write", 1, b"next"))
        with self.assertRaises(Held):
            self.call(request, "/v1/stdin/write")

    def test_write_validation_precedes_effect_and_uncertain_write_cannot_retry(self):
        reply = self.call()
        request = self.write_request(reply)
        for field, value in (("sequence", True), ("sequence", 1), ("dataHash", "f" * 64),
                             ("data", "!!!"), ("data", ""), ("receiptHash", "f" * 64)):
            with self.subTest(field=field), self.assertRaises(Held):
                self.call({**request, field: value}, "/v1/stdin/write")
        self.assertEqual(self.events.count("independent-proofs"), 1)
        def uncertain(*args):
            self.events.append("ambiguous-write")
            return 1  # Partial writes never resume/replay the remaining bytes.
        self.backend.write_exact = uncertain
        for _ in range(2):
            with self.assertRaises(Held):
                self.call(request, "/v1/stdin/write")
        self.assertEqual(self.events.count("ambiguous-write"), 1)
        self.call(dict(handle=reply["handle"], receiptHash=reply["receiptHash"]), "/v1/stdin/close")
        self.assertTrue(self.native.used)

    def test_revocation_between_proof_and_write_is_enforced_by_backend_gate(self):
        reply = self.call()
        def revoke(*args):
            self.events.append("revoked-at-effect")
            raise Held("current_runtime_or_storage_revoked")
        self.backend.write_exact = revoke
        request = self.write_request(reply)
        for _ in range(2):
            with self.assertRaises(Held):
                self.call(request, "/v1/stdin/write")
        self.assertEqual(self.events.count("revoked-at-effect"), 1)
        self.assertTrue(self.native.used)

    def test_missing_atomic_backend_cannot_use_old_write_hook(self):
        reply = self.call()
        self.server._writes = None
        with self.assertRaises(Held):
            self.call(self.write_request(reply), "/v1/stdin/write")
        self.assertFalse(any(isinstance(event, tuple) and event[0] == "write" for event in self.events))

    def test_resolved_intent_cannot_change_exact_stream_byte_binding(self):
        from dataclasses import replace
        for field, value in (("operation", "other"), ("binding_hash", "f" * 64),
                             ("sequence", 1), ("byte_count", 1), ("data_hash", "f" * 64),
                             ("runtime_revision", 6), ("storage_revision", 8)):
            with self.subTest(field=field):
                self.setUp()
                reply = self.call()
                resolve = self.backend.resolve_write_intent
                self.backend.resolve_write_intent = lambda *args: replace(resolve(*args), **{field: value})
                with self.assertRaises(Held):
                    self.call(self.write_request(reply), "/v1/stdin/write")
                self.assertFalse(any(isinstance(event, tuple) and event[0] == "write" for event in self.events))

    def test_production_listener_refuses_unowned_synchronous_control(self):
        with self.assertRaises(Held):
            tls_handler(self.server)

    def test_actual_loopback_mutual_tls_role_and_one_use_close_only(self):
        # Actual local TLS transport with synthetic authorities/native/backend.
        # No fixture certificate/key is used outside this disposable directory.
        with tempfile.TemporaryDirectory(prefix="paperclip-stream-tls-") as directory:
            directory = Path(directory)
            for role in ("server", "gateway", "wrong-role"):
                subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                                "-days", "1", "-subj", "/CN=" + role,
                                "-addext", "subjectAltName=IP:127.0.0.1",
                                "-keyout", str(directory / (role + ".key")),
                                "-out", str(directory / (role + ".crt"))],
                               check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            trusted = directory / "clients.pem"
            trusted.write_bytes((directory / "gateway.crt").read_bytes() + (directory / "wrong-role.crt").read_bytes())
            der = ssl.PEM_cert_to_DER_cert((directory / "gateway.crt").read_text())
            control = self.control(fingerprint=hashlib.sha256(der).hexdigest())
            server = HTTPServer(("127.0.0.1", 0), tls_handler(control, synthetic_test=True))
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.load_cert_chain(directory / "server.crt", directory / "server.key")
            context.verify_mode = ssl.CERT_REQUIRED
            context.load_verify_locations(trusted)
            server.socket = context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
            thread.start()
            try:
                origin = "https://127.0.0.1:" + str(server.server_port)
                wrong = JsonMTLS(origin, str(directory / "server.crt"),
                                 str(directory / "wrong-role.crt"), str(directory / "wrong-role.key"))
                with self.assertRaises(Held):
                    wrong.post("/v1/stdin/open", OPEN)
                self.assertEqual(self.events, [])
                client = JsonMTLS(origin, str(directory / "server.crt"),
                                  str(directory / "gateway.crt"), str(directory / "gateway.key"))
                reply = client.post("/v1/stdin/open", OPEN)
                self.assertEqual(reply["status"], "owned")
                with self.assertRaises(Held):
                    client.post("/v1/stdin/open", OPEN)
                close = dict(handle=reply["handle"], receiptHash=reply["receiptHash"])
                self.assertEqual(client.post("/v1/stdin/close", close)["status"], "closed")
                self.assertEqual(self.events, ["native-commit", "independent-proofs", "acquire-existing", "close-only"])
                self.assertTrue(self.native.used)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)
                self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
