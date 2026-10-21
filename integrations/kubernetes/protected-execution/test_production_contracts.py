"""Control-client contracts only. Synthetic replies confer NO authority proof."""
import copy
import io
import unittest
from unittest.mock import patch
from production.gateway import AttachGateway, Held, JsonMTLS, digest, pins, inspect_consumption


PINS = dict(instance="original", pool="codex", policy="pinned-policy", epoch="held-epoch",
            authorityIncarnation="original-authority", historyDomain="independent",
            historyIncarnation="original-history", historyFloor=42)
REQUEST = dict(commandId="command", invocation="invocation", stdin="exclusive",
               physical=dict(pool="codex", uid="pod", container="engine", node="node", storage="original-volume"),
               claim=dict(id="claim", bindingHash="a" * 64))


class Endpoint:
    """Test stub; never deploy or confuse with independently verified authority."""
    def __init__(self, events, role, change=lambda value: value):
        self.events, self.role, self.change = events, role, change

    def post(self, path, body):
        self.events.append((path, copy.deepcopy(body)))
        if self.role == "native":
            result = dict(version=1, status="committed", requestHash=digest(body),
                          pins=copy.deepcopy(PINS), claim=body["attach"]["claim"],
                          ticket="native-ticket", historyRevision=43)
        elif path.endswith("/open"):
            result = dict(version=1, status="owned", receiptHash=digest(body["receipt"]), handle="stream-handle")
        elif path.endswith("/write"):
            import base64
            result = dict(status="written", receiptHash=body["receiptHash"], sequence=body["sequence"],
                          dataHash=body["dataHash"], bytes=len(base64.b64decode(body["data"])))
        else:
            result = dict(status="closed", receiptHash=body["receiptHash"])
        return self.change(result)


class Contracts(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.native = Endpoint(self.events, "native")
        self.stream = Endpoint(self.events, "stream")
        self.gateway = AttachGateway(self.native, self.stream, PINS)

    def test_commit_before_open_and_close_only(self):
        attachment = self.gateway.attach(REQUEST)
        attachment.cleanup()
        attachment.cleanup()
        self.assertEqual([item[0] for item in self.events],
                         ["/v1/stdin/consume", "/v1/stdin/open", "/v1/stdin/close"])
        self.assertEqual(attachment.handle, "stream-handle")

    def test_binary_write_exact_sequence_and_chunk_hash(self):
        import base64
        attachment = self.gateway.attach(REQUEST)
        for sequence, data in enumerate((b"\x00\xff\r\n", b"x" * 4096)):
            self.assertEqual(attachment.write(data), len(data))
            path, body = self.events[-1]
            self.assertEqual(path, "/v1/stdin/write")
            self.assertEqual(body["sequence"], sequence)
            self.assertEqual(base64.b64decode(body["data"]), data)
        attachment.cleanup()
        with self.assertRaises(Held):
            attachment.write(b"after-close")

    def test_uncertain_write_is_never_replayed_but_close_is_allowed(self):
        for mutation in (lambda r: {**r, "bytes": 1}, lambda r: {**r, "sequence": True},
                         lambda r: {**r, "dataHash": "b" * 64},
                         lambda r: (_ for _ in ()).throw(Held("lost_reply"))):
            with self.subTest(mutation=mutation):
                attachment = self.gateway.attach(REQUEST)
                self.stream.change = mutation
                with self.assertRaises(Held):
                    attachment.write(b"chunk")
                count = len(self.events)
                with self.assertRaises(Held):
                    attachment.write(b"chunk")
                self.assertEqual(len(self.events), count)
                self.stream.change = lambda r: r
                attachment.cleanup()
                self.assertEqual(self.events[-1][0], "/v1/stdin/close")

    def test_invalid_chunk_refuses_without_poisoning_or_forwarding(self):
        attachment = self.gateway.attach(REQUEST)
        for value in (b"", b"x" * 4097, "text", bytearray(b"x")):
            with self.assertRaises(Held):
                attachment.write(value)
        self.assertEqual(len(self.events), 2)
        self.assertEqual(attachment.write(b"valid"), 5)

    def test_native_missing_or_uncertain_never_opens(self):
        self.native.post = lambda *args: (_ for _ in ()).throw(Held("missing_authority"))
        with self.assertRaises(Held):
            self.gateway.attach(REQUEST)
        self.assertEqual(self.events, [])

    def test_every_native_receipt_binding_required(self):
        changes = [("status", "uncommitted"), ("version", True), ("requestHash", "b" * 64),
                   ("pins", {**PINS, "epoch": "old"}), ("claim", {**REQUEST["claim"], "id": "other"}),
                   ("historyRevision", 41), ("historyRevision", True), ("ticket", "unsafe/path")]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                self.events.clear()
                self.native.change = lambda r, k=key, v=value: {**r, k: v}
                with self.assertRaises(Held):
                    self.gateway.attach(REQUEST)
                self.assertEqual(len(self.events), 1)

    def test_no_structural_nonempty_receipt_substitute(self):
        self.native.change = lambda r: "fixture-proof-string"
        with self.assertRaises(Held):
            self.gateway.attach(REQUEST)
        self.assertEqual(len(self.events), 1)

    def test_response_pin_boolean_cannot_equal_integer_floor(self):
        gateway = AttachGateway(self.native, self.stream, {**PINS, "historyFloor": 1})
        self.native.change = lambda r: {**r, "pins": {**PINS, "historyFloor": True}}
        with self.assertRaises(Held):
            gateway.attach(REQUEST)
        self.assertEqual(len(self.events), 1)

    def test_lost_open_is_not_retried(self):
        def unavailable(path, value):
            self.events.append((path, value))
            raise Held("lost_response")
        self.stream.post = unavailable
        with self.assertRaises(Held):
            self.gateway.attach(REQUEST)
        self.assertEqual([e[0] for e in self.events], ["/v1/stdin/consume", "/v1/stdin/open"])

    def test_wrong_stream_binding_does_not_return_handle(self):
        self.stream.change = lambda r: {**r, "receiptHash": "b" * 64}
        with self.assertRaises(Held):
            self.gateway.attach(REQUEST)
        self.assertEqual(len(self.events), 2)

    def test_lost_close_does_not_repeat_or_release(self):
        attachment = self.gateway.attach(REQUEST)
        self.stream.change = lambda r: (_ for _ in ()).throw(Held("lost_close"))
        with self.assertRaises(Held):
            attachment.cleanup()
        attachment.cleanup()
        self.assertEqual(len(self.events), 3)

    def test_extra_fields_and_cross_pool_refuse_before_side_effect(self):
        for request in ({**REQUEST, "argv": ["provider"]},
                        {**REQUEST, "physical": {**REQUEST["physical"], "pool": "replacement"}},
                        {**REQUEST, "stdin": "shared"}):
            with self.assertRaises(Held):
                self.gateway.attach(request)
        self.assertEqual(self.events, [])

    def test_pins_snapshot_and_floor_are_host_owned(self):
        config = copy.deepcopy(PINS)
        gateway = AttachGateway(self.native, self.stream, config)
        config["epoch"] = "changed"
        gateway.attach(REQUEST)
        self.assertEqual(self.events[0][1]["pins"], PINS)
        with self.assertRaises(Held):
            AttachGateway(self.native, self.stream, {**PINS, "historyFloor": 0})

    def test_original_instance_key_is_preserved_without_new_family(self):
        original = "cluster:original/namespace:original/controller-pvc:original/database:paperclip"
        self.assertEqual(pins({**PINS, "instance": original})["instance"], original)
        with self.assertRaises(Held):
            pins({**PINS, "instance": original + "\n"})

    def test_client_refuses_redirect_proxy_url_dns_and_unbounded_timeout(self):
        for origin in ("http://127.0.0.1", "https://user:secret@127.0.0.1",
                       "https://127.0.0.1/path", "https://127.0.0.1?x=token",
                       "https://127.0.0.1#x", "https://ambient.example"):
            with self.subTest(origin=origin), self.assertRaises(Held):
                JsonMTLS(origin, "unused", "unused", "unused")
        with self.assertRaises(Held):
            JsonMTLS("https://127.0.0.1", "unused", "unused", "unused", timeout=11)

    def test_client_uses_tls_snapshot_and_no_dynamic_operation(self):
        with patch("production.gateway.ssl.create_default_context") as context:
            client = JsonMTLS("https://127.0.0.1:443", "ca", "cert", "key")
            context.assert_called_once_with(cafile="ca")
            context.return_value.load_cert_chain.assert_called_once_with("cert", "key")
            with self.assertRaises(Held):
                client.post("/exec", {})

    def wire(self, raw=b'{"ok":true}', status=200, media="application/json", clock=None, path="/v1/stdin/consume"):
        from unittest.mock import MagicMock
        response = MagicMock()
        response.status = status
        response.getheader.return_value = media
        response.read.side_effect = io.BytesIO(raw).read
        with patch("production.gateway.ssl.create_default_context") as context, \
                patch("production.gateway.socket.socket") as wire, \
                patch("production.gateway.http.client.HTTPSConnection") as http:
            http.return_value.getresponse.return_value = response
            client = JsonMTLS("https://127.0.0.1", "ca", "cert", "key")
            if clock is None:
                result = client.post(path, {})
            else:
                with patch("production.gateway.time.monotonic", side_effect=clock):
                    result = client.post(path, {})
            http.return_value.request.assert_called_once()
            wire.return_value.connect.assert_called_once_with(("127.0.0.1", 443))
            return result

    def test_wire_accepts_bounded_exact_json(self):
        self.assertEqual(self.wire(), {"ok": True})

    def test_wire_allows_only_named_native_stream_claim_operation(self):
        self.assertEqual(self.wire(path="/v1/stdin/claim-stream"), {"ok": True})

    def test_inspection_reports_only_historical_facts_and_never_opens(self):
        receipt = dict(version=1, status="committed", requestHash="a" * 64, pins=PINS,
                       claim=REQUEST["claim"], ticket="retained-ticket", historyRevision=43)
        def inspect(path, body):
            self.events.append((path, body))
            return dict(version=1, status="consumed", receipt=receipt, streamConsumption=None)
        self.native.post = inspect
        result = inspect_consumption(self.native, "retained-ticket", "a" * 64)
        self.assertTrue(result["inspectionOnly"])
        self.assertEqual([e[0] for e in self.events], ["/v1/stdin/inspect"])
        receipt["ticket"] = "foreign"
        with self.assertRaises(Held):
            inspect_consumption(self.native, "retained-ticket", "a" * 64)

    def test_wire_allows_only_named_readonly_inspection(self):
        self.assertEqual(self.wire(path="/v1/stdin/inspect"), {"ok": True})

    def test_wire_refuses_redirect_duplicate_nonfinite_and_oversize(self):
        for kwargs in (dict(status=302), dict(media="text/html"),
                       dict(raw=b'{"ok":true,"ok":false}'), dict(raw=b'{"x":NaN}'),
                       dict(raw=b'"' + b'x' * 16385 + b'"')):
            with self.subTest(kwargs=list(kwargs)), self.assertRaisesRegex(Held, "gateway_request_uncertain"):
                self.wire(**kwargs)

    def test_total_connect_deadline_expires_before_request(self):
        # Deadline=3; TCP consumed more than budget. No header/body may be sent.
        with self.assertRaisesRegex(Held, "gateway_request_uncertain"):
            self.wire(clock=[0, 0, 4])

    def test_wire_error_redacts_peer_data(self):
        with self.assertRaises(Held) as caught:
            self.wire(raw=b'{secret-provider-credentials')
        self.assertEqual(str(caught.exception), "gateway_request_uncertain")


if __name__ == "__main__":
    unittest.main()
