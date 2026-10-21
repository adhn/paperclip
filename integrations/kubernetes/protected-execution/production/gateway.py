"""Inactive production control-client component; NOT an authority or stream server.

No installer, CLI, fallback, state database, exec or Pod recreation.
Both production server integrations are absent. Never install fixture endpoints.
"""
import base64
import hashlib
import http.client
import ipaddress
import json
import re
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit


class Held(Exception):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def exact(value, names):
    if type(value) is not dict or set(value) != set(names.split()):
        raise Held("invalid_gateway_contract")


def name(value):
    if type(value) is not str or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,511}", value):
        raise Held("invalid_gateway_identity")


def hexhash(value):
    if type(value) is not str or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise Held("invalid_gateway_hash")


def pins(value):
    exact(value, "instance pool policy epoch authorityIncarnation historyDomain historyIncarnation historyFloor")
    for key, item in value.items():
        if key == "historyFloor":
            if type(item) is not int or item < 1:
                raise Held("invalid_gateway_history_floor")
            continue
        if key == "instance":
            # Original immutable instance keys include physical namespace/PVC
            # delimiters. Preserve bytes; this value is hashed, never a path/URL.
            if type(item) is not str or not 0 < len(item) <= 4096 or any(ord(c) < 32 or ord(c) == 127 for c in item):
                raise Held("invalid_gateway_instance")
        else:
            name(item)
    # Immutable host configuration; never derived from a response or provider.
    return json.loads(canonical(value))


class JsonMTLS:
    """Fixed literal-IP TLS origin, pinned CA/client identity, one request only.

    Literal IP removes unbounded DNS lookup from the total network deadline.
    Certificate must contain that IP SAN; no insecure hostname override exists.
    Ambient proxy, redirect, discovery, bearer URL and retries are unavailable.
    """
    def __init__(self, origin, ca, certificate, key, timeout=3):
        try:
            parsed = urlsplit(origin)
        except (ValueError, TypeError):
            raise Held("fixed_native_https_origin_required") from None
        if (parsed.scheme != "https" or parsed.username or parsed.password or
                parsed.path or parsed.query or parsed.fragment or not parsed.hostname):
            raise Held("fixed_native_https_origin_required")
        try:
            ipaddress.ip_address(parsed.hostname)
            port = parsed.port or 443
        except ValueError:
            raise Held("literal_ip_tls_origin_required") from None
        if type(timeout) not in (int, float) or not 0 < timeout <= 10:
            raise Held("bounded_gateway_deadline_required")
        self._host, self._port, self._timeout = parsed.hostname, port, timeout
        self._context = ssl.create_default_context(cafile=ca)
        self._context.minimum_version = ssl.TLSVersion.TLSv1_2
        self._context.load_cert_chain(certificate, key)

    def post(self, path, value):
        if path not in ("/v1/stdin/consume", "/v1/stdin/open", "/v1/stdin/close", "/v1/stdin/claim-stream", "/v1/stdin/inspect", "/v1/stdin/write"):
            raise Held("unsupported_gateway_operation")
        raw = canonical(value)
        if len(raw) > 16384:
            raise Held("gateway_request_limit")
        deadline = time.monotonic() + self._timeout
        connection = http.client.HTTPSConnection(self._host, self._port,
                                                 timeout=self._timeout, context=self._context)
        def remaining():
            left = deadline - time.monotonic()
            if left <= 0:
                raise Held("gateway_deadline")
            if connection.sock:
                connection.sock.settimeout(left)
        timer = None
        raw_socket = None
        try:
            # Separate remaining-budget timeouts for TCP and TLS handshake;
            # HTTPSConnection.connect's same timeout for both could double it.
            raw_socket = socket.socket(socket.AF_INET6 if ":" in self._host else socket.AF_INET,
                                       socket.SOCK_STREAM)
            raw_socket.settimeout(max(0.001, deadline - time.monotonic()))
            raw_socket.connect((self._host, self._port))
            left = deadline - time.monotonic()
            if left <= 0:
                raise Held("gateway_deadline")
            raw_socket.settimeout(left)
            connection.sock = self._context.wrap_socket(raw_socket, server_hostname=self._host)
            # A slow TLS peer must not stretch header parsing beyond the total
            # deadline. Closing the original socket also interrupts getresponse.
            wire = connection.sock
            def expire():
                try:
                    wire.shutdown(2)
                except OSError:
                    pass
                wire.close()
            timer = threading.Timer(max(0, deadline - time.monotonic()), expire)
            timer.daemon = True
            timer.start()
            remaining()
            connection.request("POST", path, raw, {"Content-Type": "application/json"})
            remaining()
            response = connection.getresponse()
            if response.status != 200 or response.getheader("Content-Type") != "application/json":
                raise Held("gateway_refused")
            # Byte-at-a-time reads bound slow-drip response bodies by one deadline.
            # Replies are small; never follow Location or trust Content-Length.
            chunks = bytearray()
            while True:
                remaining()
                chunk = response.read(1)
                if not chunk:
                    break
                chunks.extend(chunk)
                if len(chunks) > 16384:
                    raise Held("gateway_response_limit")
            remaining()
            def unique(items):
                result = {}
                for k, v in items:
                    if k in result:
                        raise Held("gateway_duplicate_key")
                    result[k] = v
                return result
            return json.loads(chunks, object_pairs_hook=unique,
                              parse_constant=lambda _: (_ for _ in ()).throw(Held("gateway_nonfinite")))
        except Exception:
            # Do not expose endpoint credentials, identities, peer data or payload.
            raise Held("gateway_request_uncertain") from None
        finally:
            if timer is not None:
                timer.cancel()
            connection.close()
            if raw_socket is not None:
                raw_socket.close()


class AttachGateway:
    """Control plane only. mTLS endpoints must implement durable enforcement.

    Server implementation is a rollout blocker. Passing unit-test fake objects
    validates ordering only and is never production authorization.
    """
    def __init__(self, native, stream, expected_pins):
        self._native, self._stream = native, stream
        self._pins = pins(expected_pins)

    def attach(self, request):
        request = json.loads(canonical(request))
        exact(request, "commandId invocation physical stdin claim")
        if request["stdin"] != "exclusive":
            raise Held("exclusive_stdin_required")
        for field in ("commandId", "invocation"):
            name(request[field])
        exact(request["physical"], "pool uid container node storage")
        for value in request["physical"].values():
            name(value)
        if request["physical"]["pool"] != self._pins["pool"]:
            raise Held("gateway_pool_mismatch")
        exact(request["claim"], "id bindingHash")
        name(request["claim"]["id"])
        hexhash(request["claim"]["bindingHash"])
        body = {"version": 1, "pins": self._pins, "attach": json.loads(canonical(request))}
        receipt = self._native.post("/v1/stdin/consume", body)
        exact(receipt, "version status requestHash pins claim ticket historyRevision")
        if (type(receipt["version"]) is not int or receipt["version"] != 1 or
                receipt["status"] != "committed" or receipt["requestHash"] != digest(body) or
                pins(receipt["pins"]) != self._pins or receipt["claim"] != request["claim"] or
                type(receipt["historyRevision"]) is not int or
                receipt["historyRevision"] < self._pins["historyFloor"]):
            raise Held("native_stdin_consumption_unverified")
        name(receipt["ticket"])
        # No provider bytes or stream open before authenticated native commit.
        opened = self._stream.post("/v1/stdin/open", {"receipt": receipt, "attach": body})
        exact(opened, "version status receiptHash handle")
        if (type(opened["version"]) is not int or opened["version"] != 1 or
                opened["status"] != "owned" or opened["receiptHash"] != digest(receipt)):
            raise Held("stream_ownership_unverified")
        name(opened["handle"])
        return Attachment(self._stream, opened["handle"], digest(receipt))


class Attachment:
    def __init__(self, stream, handle, receipt_hash):
        self.handle, self._stream, self._receipt_hash = handle, stream, receipt_hash
        self._closed = False
        self._write_held = False
        self._sequence = 0
        self._lock = threading.Lock()

    def write(self, data):
        """Forward one exact bounded chunk; uncertain writes permanently hold.

        The stream service must authenticate current native/runtime/storage
        authorization and order every effect against revocation. This client
        never treats a receipt or previous write as continuing permission.
        """
        if type(data) is not bytes or not 0 < len(data) <= 4096:
            raise Held("bounded_exact_stream_bytes_required")
        if not self._lock.acquire(blocking=False):
            raise Held("attachment_busy")
        try:
            if self._closed or self._write_held:
                raise Held("attachment_write_held")
            sequence, data_hash = self._sequence, hashlib.sha256(data).hexdigest()
            # Mark before sending. No replay after lost/partial/invalid replies.
            self._write_held = True
            result = self._stream.post("/v1/stdin/write", {
                "handle": self.handle, "receiptHash": self._receipt_hash,
                "sequence": sequence, "dataHash": data_hash,
                "data": base64.b64encode(data).decode("ascii")})
            exact(result, "status receiptHash sequence dataHash bytes")
            if (result["status"] != "written" or result["receiptHash"] != self._receipt_hash or
                    type(result["sequence"]) is not int or result["sequence"] != sequence or
                    result["dataHash"] != data_hash or type(result["bytes"]) is not int or
                    result["bytes"] != len(data)):
                raise Held("stream_write_uncertain")
            self._sequence += 1
            self._write_held = False
            return len(data)
        except Exception:
            raise Held("stream_write_held") from None
        finally:
            self._lock.release()

    def cleanup(self):
        # Close-only, including when runtime retirement failed. No authority for
        # native release, storage detach, reattachment or another writer.
        if not self._lock.acquire(blocking=False):
            raise Held("attachment_busy")
        try:
            if self._closed:
                return
            self._closed = True  # Uncertain response never causes automatic replay.
            result = self._stream.post("/v1/stdin/close", {
                "handle": self.handle, "receiptHash": self._receipt_hash})
            exact(result, "status receiptHash")
            if result != {"status": "closed", "receiptHash": self._receipt_hash}:
                raise Held("stream_close_uncertain")
        finally:
            self._lock.release()


def inspect_consumption(native, ticket, request_hash):
    """Read exact historical facts after response loss; never a retry permit.

    Current native authority authenticates the peer. Unknown/refused inspection
    holds; this function cannot consume, open, reset, adopt or reacquire a writer.
    Historical pins intentionally do not become fresh runtime/storage authority.
    """
    name(ticket)
    hexhash(request_hash)
    result = native.post("/v1/stdin/inspect", {"ticket": ticket, "requestHash": request_hash})
    exact(result, "version status receipt streamConsumption")
    if type(result["version"]) is not int or result["version"] != 1 or result["status"] not in ("consumed", "stream-claimed"):
        raise Held("native_inspection_unverified")
    receipt = result["receipt"]
    exact(receipt, "version status requestHash pins claim ticket historyRevision")
    if (type(receipt["version"]) is not int or receipt["version"] != 1 or receipt["status"] != "committed" or
            receipt["ticket"] != ticket or receipt["requestHash"] != request_hash or
            type(receipt["historyRevision"]) is not int or receipt["historyRevision"] < 1):
        raise Held("native_inspection_binding_mismatch")
    pins(receipt["pins"])
    exact(receipt["claim"], "id bindingHash")
    name(receipt["claim"]["id"])
    hexhash(receipt["claim"]["bindingHash"])
    stream = result["streamConsumption"]
    if result["status"] == "consumed":
        if stream is not None:
            raise Held("native_inspection_binding_mismatch")
    else:
        exact(stream, "version status receiptHash attachHash streamIncarnation consumptionId physical claim pins historyRevision")
        if (type(stream["version"]) is not int or stream["version"] != 1 or stream["status"] != "committed" or
                stream["receiptHash"] != digest(receipt) or stream["attachHash"] != request_hash or
                canonical(stream["claim"]) != canonical(receipt["claim"]) or canonical(stream["pins"]) != canonical(receipt["pins"]) or
                type(stream["historyRevision"]) is not int or stream["historyRevision"] <= receipt["historyRevision"]):
            raise Held("native_inspection_binding_mismatch")
    return {"inspectionOnly": True, "historical": json.loads(canonical(result))}
