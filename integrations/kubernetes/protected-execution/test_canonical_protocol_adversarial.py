"""Actual socket decoder and canonical-owner effects; root schedules all tests."""
import base64
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest

from canonical_owner import CanonicalOwner, OwnerError, ROOTS, serve_connection


class CanonicalProtocolAdversarialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.owner = CanonicalOwner(self.temp.name)
        self.roots = {name: base64.b64encode(b'x').decode('ascii') for name in ROOTS}

    def tearDown(self):
        self.owner.close()
        self.temp.cleanup()

    def wire(self, payload):
        client, server = socket.socketpair()
        try:
            client.settimeout(3)
            client.sendall(payload)
            client.shutdown(socket.SHUT_WR)
            serve_connection(self.owner, server, os.getuid())
            server.shutdown(socket.SHUT_WR)
            chunks = []
            while True:
                part = client.recv(65536)
                if not part:
                    break
                chunks.append(part)
            return json.loads(b''.join(chunks))['result']
        finally:
            server.close()
            client.close()

    def request(self, **overrides):
        value = dict(action='publish', operation_id='candidate', expected_generation=0, roots=self.roots)
        value.update(overrides)
        return json.dumps(value, separators=(',', ':')).encode()

    def refuses_without_effect(self, payload):
        before = {str(path.relative_to(self.temp.name)): path.read_bytes()
                  for path in Path(self.temp.name).rglob('*') if path.is_file()}
        with self.assertRaises(OwnerError):
            self.wire(payload)
        after = {str(path.relative_to(self.temp.name)): path.read_bytes()
                 for path in Path(self.temp.name).rglob('*') if path.is_file()}
        self.assertEqual(after, before)
        self.assertEqual(self.owner.snapshot()['generation'], 0)
        self.assertEqual(self.owner.inspect('candidate'), {'state': 'absent'})

    def test_duplicate_mutating_envelope_fields_refuse_before_any_owner_effect(self):
        raw = self.request().decode()
        for fragment in ('"action":"deny",', '"operation_id":"other",',
                         '"expected_generation":1,', '"roots":{},'):
            with self.subTest(fragment=fragment):
                self.refuses_without_effect(('{' + fragment + raw[1:]).encode())

    def test_duplicate_root_names_including_escaped_spelling_refuse(self):
        for key in ('workspace', '\\u0077orkspace'):
            roots = '{"workspace":"eA==","' + key + '":"eQ==","session":"eA==","config":"eA=="}'
            raw = '{"action":"publish","operation_id":"candidate","expected_generation":0,"roots":' + roots + '}'
            with self.subTest(key=key):
                self.refuses_without_effect(raw.encode())

    def test_noncanonical_malformed_and_nonstring_base64_refuse(self):
        for value in ('eB==', 'eA===', 'eA', 'eA==\n', '*A==', None, 7, ['eA==']):
            with self.subTest(value=value):
                roots = dict(self.roots, workspace=value)
                self.refuses_without_effect(self.request(roots=roots))

    def test_nonobject_nonfinite_and_wrong_root_shapes_refuse(self):
        for payload in (b'[]', b'null', b'42', b'"publish"',
                        self.request(expected_generation=float('nan')),
                        self.request(expected_generation=1.0),
                        b'{"action":"inspect","operation_id":"candidate","extra":1.0}',
                        b'{"action":"inspect","operation_id":"candidate","extra":1e999}',
                        self.request(expected_generation=float('inf')),
                        self.request().replace(b'"expected_generation":0', b'"expected_generation":1e999'),
                        self.request(roots=[]), self.request(roots='workspace'),
                        self.request(roots=dict(self.roots, unexpected='eA=='))):
            with self.subTest(payload=payload):
                self.refuses_without_effect(payload)

    def test_valid_publish_exact_inspection_and_deny_remain_available(self):
        receipt = self.wire(self.request())
        inspected = self.wire(b'{"action":"inspect","operation_id":"candidate"}')
        self.assertEqual(inspected, {'state': 'published', 'receipt': receipt})
        self.assertEqual(self.wire(b'{"action":"deny","expected_generation":1}'),
                         {'denied': True, 'generation': 1})
        self.assertEqual(self.wire(b'{"action":"inspect","operation_id":"candidate"}'), inspected)
        with self.assertRaises(OwnerError):
            self.wire(self.request(operation_id='new-work', expected_generation=1))
        self.assertEqual(self.owner.inspect('new-work'), {'state': 'absent'})

    def test_uncertain_restart_keeps_wire_inspection_and_persistent_deny(self):
        def fail(phase):
            if phase == 'group_durable':
                raise OSError('publication interrupted after durable group')
        self.owner.fault = fail
        with self.assertRaises(OSError):
            self.wire(self.request())
        self.owner.close()
        self.owner = CanonicalOwner(self.temp.name)
        self.assertEqual(self.wire(b'{"action":"inspect","operation_id":"candidate"}')['state'], 'uncertain')
        self.wire(b'{"action":"deny","expected_generation":0}')
        self.owner.close()
        self.owner = CanonicalOwner(self.temp.name)
        self.assertEqual(self.wire(b'{"action":"inspect","operation_id":"candidate"}')['state'], 'uncertain')
        with self.assertRaises(OwnerError):
            self.wire(self.request(operation_id='new-work'))
        self.assertEqual(self.owner.inspect('new-work'), {'state': 'absent'})


if __name__ == '__main__':
    unittest.main()
