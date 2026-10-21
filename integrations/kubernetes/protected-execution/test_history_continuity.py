"""Pure synthetic contract tests; no operational witness or signing keys."""
import copy
import unittest

from legacy_review import ReviewHeld, digest
from production.history_continuity import (
    HISTORY_DOMAIN, WITNESS_DOMAIN, HistoryContinuityVerifier, inspection_request,
)


class SyntheticVerifier:
    """Recognizes exact test messages only; does not implement cryptography."""
    def __init__(self):
        self.messages = {}

    def envelope(self, body, domain, handle):
        from legacy_review import canonical
        signature = digest(dict(body=body, domain=domain.hex(), handle=handle))
        self.messages[(handle, domain + canonical(body), signature)] = True
        return dict(body=copy.deepcopy(body), signature=signature)

    def verify(self, handle, message, signature):
        return self.messages.get((handle, message, signature), False)


class ContinuityTests(unittest.TestCase):
    def setUp(self):
        self.pins = dict(instance='paperclip', historyDomain='retained-H', historyIncarnation='h1',
                         historyKeyHandle='history-public', witnessDomain='independent-W',
                         witnessIncarnation='w1', witnessKeyHandle='witness-public', generationFloor=2)
        self.operation = dict(operationId='1'*64, kind='native-admission-commit', source='lease:original',
                              intentHash='2'*64, requestHash='3'*64, predecessorHash='4'*64,
                              transactionHash='5'*64)
        self.request = inspection_request(pins=self.pins, operation=self.operation, challenge='6'*64, now=10000)
        self.body = dict(kind='history-continuity-snapshot-v1', pins=copy.deepcopy(self.pins),
                         generation=2, revision=10, inventoryHash='7'*64, denials=[],
                         operations=[dict(operation=copy.deepcopy(self.operation), outcome='uncertain')])
        self.signature = SyntheticVerifier()
        self.verifier = HistoryContinuityVerifier(pins=self.pins, verifier=self.signature)
        self.checkpoint = self.checkpoint_for(self.body)

    def head(self, body):
        return dict(generation=body['generation'], revision=body['revision'], snapshotHash=digest(body),
                    denialsHash=digest(body['denials']), operationsHash=digest(body['operations']))

    def checkpoint_for(self, body):
        return copy.deepcopy(dict(pins=self.pins, head=self.head(body), denials=body['denials'],
                                  operations=body['operations']))

    def run_inspection(self, body=None, proof_changes=None, **kwargs):
        body = self.body if body is None else body
        proof = dict(kind='history-independent-current-v1', pins=copy.deepcopy(self.pins),
                     requestHash=digest(self.request), head=self.head(body), observedAt=10000, expiresAt=10500)
        if proof_changes:
            proof.update(proof_changes)
        return self.verifier.inspect(request=kwargs.get('request', self.request),
            snapshot=self.signature.envelope(body, HISTORY_DOMAIN, self.pins['historyKeyHandle']),
            witness=self.signature.envelope(proof, WITNESS_DOMAIN, self.pins['witnessKeyHandle']),
            checkpoint=kwargs.get('checkpoint', self.checkpoint), now=kwargs.get('now', 10100))

    def denial(self, settlement='pending'):
        return dict(source=self.operation['source'], sequence=2, intentHash='a'*64,
                    decisionHash='b'*64, denyOrder=12, settlement=settlement)

    def test_pending_observation_has_no_authority_flags(self):
        result = self.run_inspection()
        self.assertEqual(result.outcome, 'uncertain')
        for field in ('permit', 'current', 'retry', 'authorized', 'revokedSettled'):
            self.assertFalse(hasattr(result, field))

    def test_external_pin_mutation_cannot_change_verifier_identity(self):
        external = self.verifier.pins
        external['historyKeyHandle'] = 'attacker'
        self.assertEqual(self.verifier.pins['historyKeyHandle'], 'history-public')

    def test_signed_body_bytes_and_structure_are_bounded(self):
        for extra in ('x' * (2 * 1024 * 1024), [[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[0]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]):
            body = {**self.body, 'extra': extra}
            with self.subTest(kind=type(extra).__name__), self.assertRaises(ReviewHeld):
                self.run_inspection(body)

    def test_defaults_and_collapsed_trust_refuse(self):
        with self.assertRaises(ReviewHeld):
            HistoryContinuityVerifier()
        for key, value in [('witnessDomain', self.pins['historyDomain']),
                           ('witnessKeyHandle', self.pins['historyKeyHandle'])]:
            pins = {**self.pins, key: value}
            with self.assertRaises(ReviewHeld):
                HistoryContinuityVerifier(pins=pins, verifier=self.signature)

    def test_stale_snapshot_cannot_match_independent_head(self):
        old_head = self.head(self.body)
        self.body['revision'] += 1
        with self.assertRaises(ReviewHeld):
            self.run_inspection(proof_changes=dict(head=old_head))

    def test_matching_old_snapshots_fail_fresh_challenge(self):
        newer_request = {**self.request, 'challenge': '9'*64}
        with self.assertRaises(ReviewHeld):
            self.run_inspection(request=newer_request)

    def test_matching_signed_rollback_fails_checkpoint(self):
        self.checkpoint['head']['revision'] += 1
        with self.assertRaisesRegex(ReviewHeld, 'rollback'):
            self.run_inspection()

    def test_same_revision_changed_snapshot_fails(self):
        self.body['inventoryHash'] = '8'*64
        with self.assertRaisesRegex(ReviewHeld, 'fork'):
            self.run_inspection()

    def test_generation_and_incarnation_rollback_refuse(self):
        for key, value in [('generation', 1), ('pins', {**self.pins, 'historyIncarnation': 'old'})]:
            body = {**self.body, key: value}
            with self.assertRaises(ReviewHeld):
                self.run_inspection(body)

    def test_every_operation_identity_field_is_exact(self):
        for key in self.operation:
            body = copy.deepcopy(self.body)
            value = 'revoke' if key == 'kind' else ('other-source' if key == 'source' else 'f'*64)
            body['operations'][0]['operation'][key] = value
            with self.subTest(key=key), self.assertRaises(ReviewHeld):
                self.run_inspection(body)

    def test_missing_and_duplicate_operations_hold(self):
        for records in ([], self.body['operations']*2):
            body = {**self.body, 'operations': records}
            with self.assertRaises(ReviewHeld):
                self.run_inspection(body)

    def test_missing_unrelated_uncertain_operation_holds(self):
        prior = copy.deepcopy(self.body)
        second = copy.deepcopy(prior['operations'][0])
        second['operation']['operationId'] = 'f'*64
        prior['operations'].append(second)
        prior['revision'] = 9
        with self.assertRaisesRegex(ReviewHeld, 'lost_or_rewritten'):
            self.run_inspection(checkpoint=self.checkpoint_for(prior))

    def test_uncertain_cannot_regress_to_not_recorded(self):
        self.body['revision'] += 1
        self.body['operations'][0]['outcome'] = 'not-recorded'
        with self.assertRaisesRegex(ReviewHeld, 'regressed'):
            self.run_inspection()

    def test_terminal_operation_cannot_reopen(self):
        prior = copy.deepcopy(self.body)
        prior['revision'] = 9
        for status in ('committed-exact', 'revoked-settled'):
            prior['operations'][0]['outcome'] = status
            with self.subTest(status=status), self.assertRaises(ReviewHeld):
                self.run_inspection(checkpoint=self.checkpoint_for(prior))

    def test_uncertain_can_be_inspected_as_exact_completion_only(self):
        self.body['revision'] += 1
        self.body['operations'][0]['outcome'] = 'committed-exact'
        result = self.run_inspection()
        self.assertEqual(result.outcome, 'committed-exact')
        self.assertEqual(result.operation_hash, digest(self.operation))

    def test_denial_cannot_disappear_or_change(self):
        prior = copy.deepcopy(self.body)
        prior['denials'] = [self.denial()]
        prior['revision'] = 9
        for rows in ([], [{**self.denial(), 'denyOrder': 13}], [{**self.denial(), 'decisionHash': 'c'*64}]):
            body = {**self.body, 'denials': rows}
            with self.subTest(rows=rows), self.assertRaisesRegex(ReviewHeld, 'revocation_lost_or_rewritten'):
                self.run_inspection(body, checkpoint=self.checkpoint_for(prior))

    def test_denial_settlement_is_monotone(self):
        prior = copy.deepcopy(self.body)
        prior['denials'] = [self.denial()]
        prior['revision'] = 9
        self.body['denials'] = [self.denial('settled')]
        self.run_inspection(checkpoint=self.checkpoint_for(prior))
        prior['denials'] = [self.denial('settled')]
        self.body['denials'] = [self.denial()]
        with self.assertRaisesRegex(ReviewHeld, 'regressed'):
            self.run_inspection(checkpoint=self.checkpoint_for(prior))

    def test_settled_revoke_requires_exact_settled_deny(self):
        self.body['revision'] += 1
        self.body['operations'][0]['operation']['kind'] = 'revoke'
        self.body['operations'][0]['operation']['intentHash'] = 'a'*64
        self.request = inspection_request(pins=self.pins, operation=self.body['operations'][0]['operation'],
                                          challenge='6'*64, now=10000)
        self.body['operations'][0]['outcome'] = 'revoked-settled'
        with self.assertRaisesRegex(ReviewHeld, 'not_settled'):
            self.run_inspection()
        self.body['denials'] = [self.denial('settled')]
        # Explicit independently installed older empty checkpoint; no local bootstrap.
        empty = copy.deepcopy(self.checkpoint)
        empty['operations'] = []
        empty['head']['operationsHash'] = digest([])
        self.assertEqual(self.run_inspection(checkpoint=empty).outcome, 'revoked-settled')

    def test_expiry_future_observation_and_request_freshness(self):
        for change in (dict(expiresAt=10100), dict(observedAt=10101), dict(observedAt=9999)):
            with self.subTest(change=change), self.assertRaises(ReviewHeld):
                self.run_inspection(proof_changes=change)
        with self.assertRaises(ReviewHeld):
            self.run_inspection(now=12000)

    def test_signature_wrong_key_and_boolean_truthy_rejected(self):
        original = self.signature.verify
        for value in (False, 1, None):
            self.signature.verify = lambda *args: value
            with self.assertRaises(ReviewHeld):
                self.run_inspection()
        self.signature.verify = original
        self.pins['historyKeyHandle'] = 'witness-public'
        with self.assertRaises(ReviewHeld):
            self.run_inspection()

    def test_malformed_contracts_fail_closed(self):
        for value in (None, [], 'bad', True, {}):
            with self.subTest(value=value), self.assertRaises(ReviewHeld):
                self.verifier.inspect(request=value, snapshot={}, witness={}, checkpoint={}, now=10100)
        for value in (True, -1, float('nan'), '10'):
            body = {**self.body, 'revision': value}
            with self.subTest(value=value), self.assertRaises(ReviewHeld):
                self.run_inspection(body)

    def test_snapshot_and_checkpoint_size_limits(self):
        for field in ('operations', 'denials'):
            body = copy.deepcopy(self.body)
            body[field] = [{}]*4097
            with self.subTest(field=field), self.assertRaises(ReviewHeld):
                self.run_inspection(body)


if __name__ == '__main__':
    unittest.main()
