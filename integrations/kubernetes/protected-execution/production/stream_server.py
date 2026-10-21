"""Inactive exact-stream control enforcer. No listener, exec or launch backend.

Runtime/storage issuers and the existing-stream backend are deployment blockers.
No fixture observer or SQLite ledger is used as production authority.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass
import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler
import json
import secrets
import socket
import ssl
import threading
import time

from production.gateway import Held, canonical, digest, exact, hexhash, name, pins
from production.write_authority import AtomicWriteBackend, OrderedWriteAuthority, WriteIntent


@dataclass(frozen=True)
class AuthorityPin:
    domain: str
    incarnation: str
    floor: int
    key: bytes

    def validate(self):
        name(self.domain)
        name(self.incarnation)
        if type(self.floor) is not int or self.floor < 1 or type(self.key) is not bytes or len(self.key) < 32:
            raise Held("invalid_stream_authority_pin")


@dataclass(frozen=True)
class VerifiedAuthority:
    binding_hash: str
    runtime_revision: int
    storage_revision: int
    challenge: str
    expires_at: int


@dataclass(frozen=True)
class ExistingStream:
    """Opaque pre-existing capability, not a process/body/launch request."""
    capability: str
    binding_hash: str


class ExistingStreamBackend(ABC):
    """Trusted adapter contract; no production adapter is supplied.

    proofs obtains fresh independently signed runtime and storage authorization
    for this complete binding/challenge. acquire_exact may acquire only the
    already-running stream named by native consumption. All methods must honor
    deadline and current cancellation/revocation before effects. Acquisition and
    every eventual stdin write must be ordered atomically against the mandatory
    runtime effect/revoke boundary: a committed ticket is not perpetual write
    permission. The bounded write API requires this absent mandatory effect gate.
    Unknown results retain native occupancy forever;
    an adapter must never implement acquire by launch/exec/recreation.
    """
    @abstractmethod
    def proofs(self, binding, challenge, deadline):
        raise NotImplementedError

    @abstractmethod
    def acquire_exact(self, binding, authority, deadline):
        raise NotImplementedError

    def resolve_write_intent(self, stream, binding, authority, operation, sequence, data_hash, byte_count, deadline):
        """Resolve complete root group and current native/decision revisions.

        Only a protected atomic backend can resolve these identities. Consumption
        history and proof floors must never substitute for current effect state.
        Resolution is not authorization: commit_write must recheck every pin and
        cancellation at its unavoidable byte-effect boundary.
        """
        raise Held("mandatory_write_intent_resolver_missing")

    @abstractmethod
    def close_exact(self, stream, deadline):
        """Close this stream only; no release, detach, kill, reset or reacquire."""
        raise NotImplementedError


def decode(raw):
    if type(raw) is not bytes or not raw or len(raw) > 16384:
        raise Held("bounded_stream_request_required")
    def unique(items):
        result = {}
        for key, value in items:
            if key in result:
                raise Held("duplicate_stream_key")
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(Held("nonfinite_stream_json")))
    except Exception:
        raise Held("invalid_stream_json") from None


class StreamControl:
    def __init__(self, native, backend, expected_pins, gateway_fingerprint,
                 stream_incarnation, runtime_pin, storage_pin):
        self._pins = pins(expected_pins)
        hexhash(gateway_fingerprint)
        name(stream_incarnation)
        if not isinstance(runtime_pin, AuthorityPin) or not isinstance(storage_pin, AuthorityPin):
            raise Held("independent_stream_authority_required")
        runtime_pin.validate()
        storage_pin.validate()
        if runtime_pin.domain == storage_pin.domain or hmac.compare_digest(runtime_pin.key, storage_pin.key):
            raise Held("distinct_stream_authorities_required")
        self._native, self._backend = native, backend
        self._writes = OrderedWriteAuthority(backend) if isinstance(backend, AtomicWriteBackend) else None
        self._peer, self._incarnation = gateway_fingerprint, stream_incarnation
        self._runtime, self._storage = runtime_pin, storage_pin
        self._lock = threading.Lock()
        self._attempted, self._streams = set(), {}

    @staticmethod
    def _remaining(deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise Held("stream_deadline")
        return remaining

    def dispatch(self, path, raw, peer_certificate, deadline):
        """peer_certificate comes only from the adapter's TLS session, never JSON."""
        self._remaining(deadline)
        if (type(peer_certificate) is not bytes or not peer_certificate or
                not hmac.compare_digest(hashlib.sha256(peer_certificate).hexdigest(), self._peer)):
            raise Held("stream_peer_refused")
        if not isinstance(self._backend, ExistingStreamBackend):
            raise Held("independent_existing_stream_backend_missing")
        if path not in ("/v1/stdin/open", "/v1/stdin/close", "/v1/stdin/write"):
            raise Held("unsupported_stream_operation")
        request = decode(raw)
        # One request at a time per server incarnation. Never wait without bound.
        if not self._lock.acquire(timeout=min(10, self._remaining(deadline))):
            raise Held("stream_busy")
        try:
            self._remaining(deadline)
            if path.endswith("/open"):
                return self._open(request, deadline)
            return self._write(request, deadline) if path.endswith("/write") else self._close(request, deadline)
        except Exception:
            raise Held("stream_control_held") from None
        finally:
            self._lock.release()

    def _validate_open(self, request):
        exact(request, "receipt attach")
        attach, receipt = request["attach"], request["receipt"]
        exact(attach, "version pins attach")
        if type(attach["version"]) is not int or attach["version"] != 1 or pins(attach["pins"]) != self._pins:
            raise Held("stream_attach_pins_refused")
        value = attach["attach"]
        exact(value, "commandId invocation physical stdin claim")
        for field in ("commandId", "invocation"):
            name(value[field])
        if value["stdin"] != "exclusive":
            raise Held("exclusive_stream_required")
        exact(value["physical"], "pool uid container node storage")
        for item in value["physical"].values():
            name(item)
        if value["physical"]["pool"] != self._pins["pool"]:
            raise Held("stream_pool_refused")
        exact(value["claim"], "id bindingHash")
        name(value["claim"]["id"])
        hexhash(value["claim"]["bindingHash"])
        exact(receipt, "version status requestHash pins claim ticket historyRevision")
        if (type(receipt["version"]) is not int or receipt["version"] != 1 or
                receipt["status"] != "committed" or receipt["requestHash"] != digest(attach) or
                pins(receipt["pins"]) != self._pins or receipt["claim"] != value["claim"] or
                type(receipt["historyRevision"]) is not int or receipt["historyRevision"] < self._pins["historyFloor"]):
            raise Held("stream_receipt_refused")
        name(receipt["ticket"])
        return attach, receipt

    def _proof(self, proof, pin, role, binding_hash, challenge):
        exact(proof, "body mac")
        body = proof["body"]
        exact(body, "role domain incarnation revision bindingHash challenge issuedAt expiresAt")
        hexhash(proof["mac"])
        expected = hmac.new(pin.key, b"paperclip-stream-authority-v1\0" + canonical(body), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(proof["mac"], expected):
            raise Held("stream_authority_authentication_failed")
        now = time.time()
        if (body["role"] != role or body["domain"] != pin.domain or body["incarnation"] != pin.incarnation or
                type(body["revision"]) is not int or body["revision"] < pin.floor or
                body["bindingHash"] != binding_hash or body["challenge"] != challenge or
                type(body["issuedAt"]) is not int or type(body["expiresAt"]) is not int or
                not body["issuedAt"] <= now < body["expiresAt"] or
                body["expiresAt"] - body["issuedAt"] > 30):
            raise Held("stream_current_authority_refused")
        return body["revision"], body["expiresAt"]

    def _open(self, request, deadline):
        attach, receipt = self._validate_open(request)
        receipt_hash = digest(receipt)
        if len(self._attempted) >= 1024:
            raise Held("stream_incarnation_full")
        if receipt["ticket"] in self._attempted:
            raise Held("stream_ticket_already_attempted")
        # Mark before online consumption: loss/timeout is never automatically retried.
        self._attempted.add(receipt["ticket"])
        self._remaining(deadline)
        consumption = self._native.post("/v1/stdin/claim-stream", {
            "version": 1, "receipt": receipt, "attach": attach,
            "streamIncarnation": self._incarnation})
        exact(consumption, "version status receiptHash attachHash streamIncarnation consumptionId physical claim pins historyRevision")
        value = attach["attach"]
        if (type(consumption["version"]) is not int or consumption["version"] != 1 or
                consumption["status"] != "committed" or consumption["receiptHash"] != receipt_hash or
                consumption["attachHash"] != digest(attach) or consumption["streamIncarnation"] != self._incarnation or
                consumption["physical"] != value["physical"] or consumption["claim"] != value["claim"] or
                pins(consumption["pins"]) != self._pins or type(consumption["historyRevision"]) is not int or
                consumption["historyRevision"] < self._pins["historyFloor"] or
                consumption["historyRevision"] <= receipt["historyRevision"]):
            raise Held("native_stream_consumption_unverified")
        name(consumption["consumptionId"])
        binding = json.loads(canonical({"consumption": consumption, "attach": attach}))
        binding_hash, challenge = digest(binding), secrets.token_hex(32)
        self._remaining(deadline)
        authority = self._current_authority(binding, challenge, deadline)
        acquire_deadline = self._effect_deadline(authority, deadline)
        stream = self._backend.acquire_exact(binding, authority, acquire_deadline)
        # Backend identity does not mint authority; cryptographic checks precede it.
        if type(stream) is not ExistingStream or stream.binding_hash != binding_hash:
            raise Held("exact_existing_stream_required")
        name(stream.capability)
        handle = secrets.token_hex(32)
        self._streams[handle] = {"stream": stream, "binding": binding, "sequence": 0,
                                 "writeHeld": False, "receiptHash": receipt_hash, "closeAttempted": False}
        # Late acquisition retains occupancy and attempts close only.
        try:
            self._remaining(acquire_deadline)
            if time.time() >= authority.expires_at:
                raise Held("stream_authority_expired_after_acquire")
        except Held:
            self._streams[handle]["closeAttempted"] = True
            try:
                self._backend.close_exact(stream, time.monotonic() + 1)
            except Exception:
                pass
            raise
        return {"version": 1, "status": "owned", "receiptHash": receipt_hash, "handle": handle}

    def _current_authority(self, binding, challenge, deadline):
        binding_hash = digest(binding)
        proofs = self._backend.proofs(binding, challenge, deadline)
        exact(proofs, "runtime storage")
        runtime_revision, runtime_expiry = self._proof(
            proofs["runtime"], self._runtime, "runtime-start", binding_hash, challenge)
        storage_revision, storage_expiry = self._proof(
            proofs["storage"], self._storage, "storage-exclusive", binding_hash, challenge)
        self._remaining(deadline)
        return VerifiedAuthority(binding_hash, runtime_revision, storage_revision,
                                 challenge, min(runtime_expiry, storage_expiry))

    def _effect_deadline(self, authority, deadline):
        self._remaining(deadline)
        proof_remaining = authority.expires_at - time.time()
        if proof_remaining <= 0:
            raise Held("stream_authority_expired")
        return min(deadline, time.monotonic() + proof_remaining)

    def _write(self, request, deadline):
        exact(request, "handle receiptHash sequence dataHash data")
        name(request["handle"])
        hexhash(request["receiptHash"])
        hexhash(request["dataHash"])
        if type(request["sequence"]) is not int or request["sequence"] < 0:
            raise Held("exact_write_sequence_required")
        if type(request["data"]) is not str or len(request["data"]) > 8192:
            raise Held("bounded_write_required")
        try:
            data = base64.b64decode(request["data"], validate=True)
        except Exception:
            raise Held("canonical_write_bytes_required") from None
        if (not 0 < len(data) <= 4096 or base64.b64encode(data).decode("ascii") != request["data"] or
                hashlib.sha256(data).hexdigest() != request["dataHash"]):
            raise Held("exact_write_bytes_required")
        row = self._streams.get(request["handle"])
        if (row is None or row["receiptHash"] != request["receiptHash"] or row["closeAttempted"] or
                row["writeHeld"] or request["sequence"] != row["sequence"]):
            raise Held("unknown_or_attempted_stream_write")
        # Mark before proof/backend operations. Any lost, rejected, partial or
        # late result permanently holds further writes; close-only stays allowed.
        row["writeHeld"] = True
        authority = self._current_authority(row["binding"], secrets.token_hex(32), deadline)
        effect_deadline = self._effect_deadline(authority, deadline)
        if self._writes is None:
            raise Held("mandatory_atomic_write_backend_missing")
        operation = digest({"binding": row["binding"], "sequence": row["sequence"]})
        intent = self._backend.resolve_write_intent(row["stream"], row["binding"], authority,
            operation, row["sequence"], request["dataHash"], len(data), effect_deadline)
        if (type(intent) is not WriteIntent or intent.operation != operation or
                intent.binding_hash != authority.binding_hash or intent.sequence != row["sequence"] or
                intent.data_hash != request["dataHash"] or intent.byte_count != len(data) or
                intent.runtime_revision != authority.runtime_revision or
                intent.storage_revision != authority.storage_revision):
            raise Held("exact_atomic_write_intent_required")
        accepted = self._writes.commit_write(intent, data, effect_deadline).accepted
        self._remaining(effect_deadline)
        if time.time() >= authority.expires_at or type(accepted) is not int or accepted != len(data):
            raise Held("exact_write_unverified")
        row["sequence"] += 1
        row["writeHeld"] = False
        return {"status": "written", "receiptHash": row["receiptHash"],
                "sequence": request["sequence"], "dataHash": request["dataHash"], "bytes": accepted}

    def _close(self, request, deadline):
        exact(request, "handle receiptHash")
        name(request["handle"])
        hexhash(request["receiptHash"])
        row = self._streams.get(request["handle"])
        if row is None or row["receiptHash"] != request["receiptHash"] or row["closeAttempted"]:
            raise Held("unknown_or_attempted_stream_close")
        row["closeAttempted"] = True
        self._remaining(deadline)
        if self._backend.close_exact(row["stream"], deadline) is not None:
            raise Held("close_only_backend_contract")
        self._remaining(deadline)
        return {"status": "closed", "receiptHash": request["receiptHash"]}


class OwnedStreamControl:
    """Process-owned native AND backend calls; protected factory builds control.

    One owner per service incarnation, no automatic worker replacement. Losing
    the worker cannot clear native tickets or authorize another stream owner.
    """
    def __init__(self, factory):
        from production.operation_worker import OperationWorker
        self._worker = OperationWorker(factory)

    def dispatch(self, path, raw, peer_certificate, deadline):
        if type(raw) is not bytes or len(raw) > 16384 or type(peer_certificate) is not bytes or len(peer_certificate) > 16384:
            raise Held("bounded_owned_dispatch_required")
        return self._worker.call("dispatch", {"path": path,
            "raw": base64.b64encode(raw).decode("ascii"),
            "peer": base64.b64encode(peer_certificate).decode("ascii")}, deadline)

    def close(self):
        self._worker.close()


class StreamWorkerHandler:
    """Return from a protected importable factory; constructed only in worker."""
    def __init__(self, control):
        if type(control) is not StreamControl:
            raise Held("exact_stream_control_required")
        self.control = control

    def __call__(self, operation, arguments, deadline):
        if operation != "dispatch":
            raise Held("unsupported_owned_operation")
        exact(arguments, "path raw peer")
        return self.control.dispatch(arguments["path"], base64.b64decode(arguments["raw"], validate=True),
                                     base64.b64decode(arguments["peer"], validate=True), deadline)


def tls_handler(control, *, synthetic_test=False):
    """Build a handler for an operator-owned mTLS HTTPServer; starts no listener.

    The caller must use CERT_REQUIRED, dedicated CA and bounded accept/handshake
    handling. Per-request fingerprint comes from SSLSocket only, never a header.
    """
    if type(control) is not OwnedStreamControl and not synthetic_test:
        raise Held("owned_stream_worker_required")
    class Handler(BaseHTTPRequestHandler):
        def handle_one_request(self):
            self._deadline = time.monotonic() + 3
            self.connection.settimeout(3)
            def expire():
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                self.connection.close()
            timer = threading.Timer(3, expire)
            timer.daemon = True
            timer.start()
            try:
                return super().handle_one_request()
            finally:
                timer.cancel()

        def log_message(self, *_args):
            pass

        def do_POST(self):
            try:
                deadline = self._deadline
                if not isinstance(self.connection, ssl.SSLSocket) or self.connection.context.verify_mode != ssl.CERT_REQUIRED:
                    raise Held("mutual_tls_required")
                lengths = self.headers.get_all("Content-Length", [])
                if (len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit() or
                        self.headers.get("Transfer-Encoding") is not None or
                        self.headers.get("Content-Type") != "application/json"):
                    raise Held("exact_bounded_http_required")
                size = int(lengths[0])
                if not 0 < size <= 16384:
                    raise Held("bounded_http_body_required")
                self.connection.settimeout(3)
                raw = self.rfile.read(size)
                if len(raw) != size:
                    raise Held("incomplete_stream_http_body")
                result = control.dispatch(self.path, raw, self.connection.getpeercert(binary_form=True), deadline)
                response, status = canonical(result), 200
            except Exception:
                response, status = b'{"error":"stream_control_held"}', 409
            try:
                self.connection.settimeout(1)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)
            finally:
                self.close_connection = True
    return Handler
