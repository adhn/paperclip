"""Synthetic in-process order only; no native transaction/issuer/key custody."""
import copy
import unittest
from legacy_review import ReviewHeld, canonical, digest
from production.decision_use import DOMAIN, OrderedDecisionUse
from production.decision_history import (INTENT_DOMAIN, build_intent_request,
                                         verify_intent_inspection)
import test_decision_history as history_fixture


class SyntheticAuthority:
    def __init__(self, fixture):
        self.f = fixture
        self.order = 0
        self.denied = False
        self.effects = {}
        self.calls = []
        self.retained_intents = {}

    def receipt(self, request, status):
        self.order += 1
        body = dict(kind='legacy-ordered-completion-v1', pins=self.f.pins,
                    requestHash=digest(request), historyRevision=9, order=self.order,
                    status=status, observedAt=self.f.now, expiresAt=self.f.now+1000)
        signature=digest(body)
        self.f.verifier.messages[signature]=(self.f.pins['verifierKeyHandle'],DOMAIN+canonical(body))
        return dict(body=body,signature=signature)

    def execute(self, request, *, deadline_at):
        assert deadline_at == request["deadlineAt"]
        self.calls.append(('execute', copy.deepcopy(request)))
        if self.denied:
            raise ReviewHeld('denied')
        effect=request['effect']['effectId']
        if effect in self.effects:
            raise ReviewHeld('consumed_inspect_required')
        self.effects[effect]=digest(request)
        return self.receipt(request,'effect-completed')

    def revoke(self, request, *, deadline_at):
        assert deadline_at == request["deadlineAt"]
        if self.retained_intents.get(request["intent"]["intentHash"]) != request["intent"]:
            raise ReviewHeld("unknown_or_conflicting_intent")
        self.calls.append(('revoke', copy.deepcopy(request)))
        self.denied=True
        return self.receipt(request,'revoked-settled')

    def inspect(self, request, *, deadline_at):
        assert deadline_at == request["deadlineAt"]
        self.calls.append(('inspect', copy.deepcopy(request)))
        if self.effects.get(request['effectId']) != request['requestHash']:
            raise ReviewHeld('unknown')
        return self.receipt(request,'effect-completed')


class OrderedDecisionTests(unittest.TestCase):
    def setUp(self):
        self.f=history_fixture.DecisionHistoryTests();self.f.setUp()
        self.backend=SyntheticAuthority(self.f)
        self.gate=OrderedDecisionUse(pins=self.f.pins,verifier=self.f.verifier,authority=self.backend,clock=lambda:self.f.now)
        self.args=dict(holds=self.f.holds,accepted=self.f.accepted,purpose='admission',
                       challenge=digest('nonce'),now=self.f.now,
                       effect=dict(effectId=digest('unique-operation'),transactionHash=digest('exact-native-transaction'),
                                   operation='native-admission-commit'))
        self.intent=dict(source=self.f.holds[0]['source'],holdHash=self.f.holds[0]['holdHash'],
                         sequence=2,previousHash=self.f.accepted[0]['decisionHash'],
                         decisionHash=digest('revoke2'),intentHash=digest('exact-revoke-intent'))
        self.backend.retained_intents[self.intent['intentHash']] = copy.deepcopy(self.intent)

    def test_revoke_source_requires_canonical_uuid(self):
        for source in ('lease:', 'lease:arbitrary', 'lease:10000000000040008000000000000001',
                       'lease:ABCDEF00-0000-4000-8000-000000000001', 'run:'+self.f.holds[0]['leaseId']):
            intent={**self.intent, 'source':source}
            with self.subTest(source=source),self.assertRaisesRegex(ReviewHeld,'revoke_source'):
                self.gate.revoke(intent=intent,challenge=digest('nonce'),now=self.f.now)
        self.assertEqual(self.backend.calls,[])

    def test_revoke_requires_retained_exact_intent(self):
        for changes in ({'intentHash':digest('unknown')},{'decisionHash':digest('other-decision')},
                        {'previousHash':digest('wrong-predecessor')}):
            with self.subTest(changes=changes),self.assertRaises(ReviewHeld):
                self.gate.revoke(intent={**self.intent,**changes},challenge=digest('nonce'),now=self.f.now)
        self.assertFalse(self.backend.denied)

    def test_deadline_is_bounded_and_bound_into_request(self):
        for timeout in (0, True, 5001):
            with self.subTest(timeout=timeout),self.assertRaises(ReviewHeld):
                OrderedDecisionUse(pins=self.f.pins,verifier=self.f.verifier,authority=self.backend,
                                   operation_timeout_ms=timeout)
        self.gate.execute(**self.args)
        self.assertEqual(self.backend.calls[0][1]['deadlineAt'],self.f.now+1000)

    def test_missing_backend_or_custody_refuses(self):
        for args in ({},{'pins':self.f.pins,'verifier':self.f.verifier}):
            with self.assertRaises(ReviewHeld):OrderedDecisionUse(**args)

    def test_effect_completes_inside_backend_and_returns_no_permit(self):
        result=self.gate.execute(**self.args)
        self.assertEqual(len(self.backend.effects),1)
        self.assertEqual(set(result),{'requestHash','order','status'})
        with self.assertRaises(ReviewHeld):self.gate.execute(**self.args)
        self.assertEqual(len(self.backend.effects),1)

    def test_revoke_orders_before_next_effect(self):
        first=self.gate.execute(**self.args)
        revoked=self.gate.revoke(intent=self.intent,challenge=digest('revoke-nonce'),now=self.f.now)
        self.assertGreater(revoked['order'],first['order'])
        args=copy.deepcopy(self.args);args['effect']['effectId']=digest('new-operation')
        with self.assertRaises(ReviewHeld):self.gate.execute(**args)
        self.assertEqual(len(self.backend.effects),1)

    def test_uncertain_effect_is_inspected_without_replay(self):
        real=self.backend.execute
        def lost(request, **kwargs):
            real(request, **kwargs)
            raise TimeoutError('response lost after effect')
        self.backend.execute=lost
        with self.assertRaisesRegex(ReviewHeld,'uncertain'):self.gate.execute(**self.args)
        request_hash=self.backend.effects[self.args['effect']['effectId']]
        self.gate.inspect(request_hash=request_hash,effect_id=self.args['effect']['effectId'],
                          challenge=digest('inspect-nonce'),now=self.f.now)
        self.assertEqual([call[0] for call in self.backend.calls],['execute','inspect'])
        with self.assertRaises(ReviewHeld):
            self.gate.inspect(request_hash=digest('other-transaction'),effect_id=self.args['effect']['effectId'],
                              challenge=digest('inspect-nonce2'),now=self.f.now)

    def test_exact_effect_descriptor_and_purpose(self):
        for change in ({'operation':'shell'},{'effectId':True},{'transactionHash':'bad'},{'callback':'run-this'}):
            args=copy.deepcopy(self.args);args['effect'].update(change)
            with self.subTest(change=change),self.assertRaises(ReviewHeld):self.gate.execute(**args)
        self.assertEqual(self.backend.calls,[])

    def test_receipt_cannot_be_rebound_or_forged(self):
        original=self.backend.receipt
        for change in ({'requestHash':digest('other')},{'status':'authorized'}, {'order':True},
                       {'historyRevision':7},{'pins':{**self.f.pins,'historyIncarnation':'rollback'}}):
            def altered(request,status,change=change):
                value=original(request,status);value['body'].update(change)
                value['signature']=digest(value['body'])
                self.f.verifier.messages[value['signature']]=(self.f.pins['verifierKeyHandle'],DOMAIN+canonical(value['body']))
                return value
            self.backend.receipt=altered
            args=copy.deepcopy(self.args);args['effect']['effectId']=digest(change)
            with self.subTest(change=change),self.assertRaises(ReviewHeld):self.gate.execute(**args)

    def test_completion_expiry_is_checked_after_backend_returns(self):
        original=self.backend.execute
        def delayed(request, **kwargs):
            receipt=original(request, **kwargs)
            self.f.now += 1001
            return receipt
        self.backend.execute=delayed
        with self.assertRaises(ReviewHeld):self.gate.execute(**self.args)
        self.assertEqual(len(self.backend.effects),1)

    def test_observation_envelope_is_not_completion(self):
        self.backend.execute=lambda request, **kwargs:self.f.envelope()
        with self.assertRaises(ReviewHeld):self.gate.execute(**self.args)

    def test_prospective_inspection_exact_cas_and_unknown_hold(self):
        request=build_intent_request(pins=self.f.pins,hold=self.f.holds[0],sequence=2,
            previous_hash=self.f.accepted[0]['decisionHash'],decision_hash=digest('next'),
            inventory_hash=digest(self.f.holds),approval_hash=digest('operator-consent'),
            action='revoke',challenge=digest('inspect-intent'),now=self.f.now)
        body=dict(kind='legacy-prospective-inspection-v1',pins=self.f.pins,requestHash=digest(request),
                  intentHash=request['intentHash'],historyRevision=9,status='committed-exact',
                  observedAt=self.f.now,expiresAt=self.f.now+1000)
        def verify(body,request=request):
            signature=digest(body)
            self.f.verifier.messages[signature]=(self.f.pins['verifierKeyHandle'],INTENT_DOMAIN+canonical(body))
            return verify_intent_inspection(pins=self.f.pins,verifier=self.f.verifier,request=request,
                envelope=dict(body=body,signature=signature),now=self.f.now)
        result=verify(body);self.assertFalse(hasattr(result,'authorized'))
        for change in ({'status':'prospective'},{'status':'commit-uncertain'}, {'status':'not-found'},
                       {'intentHash':digest('different-intent')},{'historyRevision':7}):
            with self.subTest(change=change),self.assertRaises(ReviewHeld):verify({**body,**change})
        changed=copy.deepcopy(request);changed['intent']['approvalHash']=digest('different-consent')
        with self.assertRaises(ReviewHeld):verify(body,changed)


if __name__=='__main__':unittest.main()
