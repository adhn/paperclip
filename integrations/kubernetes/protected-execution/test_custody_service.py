"""Actual disposable cryptography; no operational keys, issuer or acceptance."""
import base64
import builtins
import copy
import hashlib
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from legacy_review import ReviewHeld
from production.custody_service import DOMAINS, TRUST_PATH, ProtectedEd25519Verifier
from production.decision_history import CurrentHistoryVerifier
from legacy_review import canonical, digest
import test_decision_history


class CustodyVerifierTests(unittest.TestCase):
    def setUp(self):
        self.private = Ed25519PrivateKey.generate()
        public = self.private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        self.handle = 'ed25519:' + hashlib.sha256(public).hexdigest()
        self.bundle = {'version': 1, 'keys': [{'handle': self.handle, 'publicKey': public.hex(), 'status': 'active'}]}
        self.message = DOMAINS[0] + b'{"requestHash":"disposable"}'
        self.signature = base64.b64encode(self.private.sign(self.message)).decode('ascii')
        self.read = self.enterContext(patch('production.custody_service.protected_read', side_effect=lambda path: copy.deepcopy(self.bundle)))
        self.verifier = ProtectedEd25519Verifier()

    def test_real_signature_and_fixed_protected_path(self):
        self.assertTrue(self.verifier.verify(self.handle, self.message, self.signature))
        self.read.assert_called_once_with(TRUST_PATH)

    def test_altered_message_and_wrong_signer_refuse(self):
        self.assertFalse(self.verifier.verify(self.handle, self.message + b' ', self.signature))
        wrong = base64.b64encode(Ed25519PrivateKey.generate().sign(self.message)).decode('ascii')
        self.assertFalse(self.verifier.verify(self.handle, self.message, wrong))

    def test_retirement_reloaded_on_same_object(self):
        self.assertTrue(self.verifier.verify(self.handle, self.message, self.signature))
        self.bundle['keys'][0]['status'] = 'retired'
        self.assertFalse(self.verifier.verify(self.handle, self.message, self.signature))

    def test_unknown_handle_does_not_select_a_path(self):
        self.assertFalse(self.verifier.verify('ed25519:' + '0' * 64, self.message, self.signature))
        with self.assertRaises(ReviewHeld):
            self.verifier.verify('/tmp/key', self.message, self.signature)

    def test_noncanonical_or_malformed_signatures_refuse(self):
        for value in (self.signature + '\n', self.signature[:-1], '!' * 88, 4, 'A' * 88):
            with self.subTest(value=value), self.assertRaises(ReviewHeld):
                self.verifier.verify(self.handle, self.message, value)

    def test_domain_and_message_bounds(self):
        for message in (b'', b'other\0' + self.message, DOMAINS[0], self.message.decode(), DOMAINS[0] + b'x' * (2 * 1024 * 1024)):
            with self.subTest(message_type=type(message)), self.assertRaises(ReviewHeld):
                self.verifier.verify(self.handle, message, self.signature)

    def test_duplicate_key_and_mismatched_fingerprint_hold(self):
        self.bundle['keys'].append(copy.deepcopy(self.bundle['keys'][0]))
        with self.assertRaises(ReviewHeld):
            self.verifier.verify(self.handle, self.message, self.signature)
        self.bundle['keys'].pop()
        self.bundle['keys'][0]['handle'] = 'ed25519:' + '0' * 64
        with self.assertRaises(ReviewHeld):
            self.verifier.verify(self.handle, self.message, self.signature)

    def test_missing_or_unprotected_bundle_holds(self):
        self.read.side_effect = ReviewHeld('bridge_unprotected_parent')
        with self.assertRaises(ReviewHeld):
            self.verifier.verify(self.handle, self.message, self.signature)

    def test_missing_crypto_dependency_holds(self):
        original_import = builtins.__import__
        def unavailable(name, *args, **kwargs):
            if name.startswith('cryptography'):
                raise ImportError('disposable missing dependency')
            return original_import(name, *args, **kwargs)
        with patch('builtins.__import__', side_effect=unavailable), self.assertRaises(ReviewHeld):
            self.verifier.verify(self.handle, self.message, self.signature)

    def test_unsupported_algorithm_refuses(self):
        with self.assertRaises(ReviewHeld):
            self.verifier.verify('rsa:' + '0' * 64, self.message, self.signature)

    def test_current_history_component_uses_real_signatures_and_revoke_refuses(self):
        # Reuse exact full-closure fixture shapes; replace its fake verifier.
        fixture = test_decision_history.DecisionHistoryTests()
        fixture.setUp()
        fixture.pins['verifierKeyHandle'] = self.handle
        request = fixture.request_for()
        body = fixture.envelope(request)['body']
        gate = CurrentHistoryVerifier(pins=fixture.pins, verifier=self.verifier)
        def envelope(value):
            return {'body': value, 'signature': base64.b64encode(self.private.sign(DOMAINS[0] + canonical(value))).decode('ascii')}
        observation = gate.verify_use(request, envelope(body), now=fixture.now)
        self.assertEqual(observation.request_hash, digest(request))
        self.assertFalse(hasattr(observation, 'authorized'))
        tampered = envelope(body)
        tampered['body'] = {**body, 'historyRevision': 10}
        with self.assertRaises(ReviewHeld):
            gate.verify_use(request, tampered, now=fixture.now)
        revoked = copy.deepcopy(body)
        revoked['latest'][0]['action'] = 'revoke'
        revoked['latest'][0]['sequence'] = 2
        revoked['latest'][0]['decisionHash'] = digest('disposable revoke2')
        with self.assertRaises(ReviewHeld):
            gate.verify_use(request, envelope(revoked), now=fixture.now)


if __name__ == '__main__':
    unittest.main()
