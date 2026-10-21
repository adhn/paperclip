"""Synthetic retained-history protocol tests; no real issuer/key/recovery."""
import copy
import unittest
from legacy_review import ReviewHeld, canonical, digest
from production.decision_history import CurrentHistoryVerifier, DOMAIN, build_use_request


class FakeProtectedVerifier:
    def __init__(self):
        self.messages = {}
        self.calls = []

    def verify(self, handle, message, signature):
        self.calls.append((handle, message))
        return self.messages.get(signature) == (handle, message)


class DecisionHistoryTests(unittest.TestCase):
    def setUp(self):
        self.now = 1800000000000
        self.pins = dict(instance='original-instance', authorityIncarnation='protected-authority',
                         historyDomain='outside-native-rollback', historyIncarnation='retained-history',
                         historyFloor=8, verifierKeyHandle='protected-public-key:v1')
        self.holds = []
        self.accepted = []
        for index in range(2):
            uid = lambda n: '10000000-0000-4000-8000-' + str(n).zfill(12)
            hold = dict(source='lease:'+uid(index+1),leaseId=uid(index+1),holdHash=digest(['original',index]),
                        companyId=uid(10),agentId=uid(index+20),runId=uid(index+30),environmentId=uid(40),
                        scopes=['original-shared-account','original-shared-credential'],
                        policyHash=digest('historical-policy'),epoch=uid(50))
            self.holds.append(hold)
            self.accepted.append(dict(source=hold['source'],holdHash=hold['holdHash'],
                                      sequence=1,decisionHash=digest(['reconcile1',index])))
        self.verifier = FakeProtectedVerifier()
        self.gate = CurrentHistoryVerifier(pins=self.pins,verifier=self.verifier)
        self.request = self.request_for()
        self.latest = [{**ref,'action':'reconcile','status':'committed-exact','intentHash':digest(['intent',index])}
                       for index,ref in enumerate(self.accepted)]

    def request_for(self, **changes):
        values = dict(pins=self.pins,holds=self.holds,accepted=self.accepted,purpose='admission',
                      challenge=digest('fresh-native-challenge'),now=self.now)
        values.update(changes)
        return build_use_request(**values)

    def envelope(self, request=None, **changes):
        request = self.request if request is None else request
        body = dict(kind='legacy-current-use-observation-v1',pins=copy.deepcopy(self.pins),
                    requestHash=digest(request),closureHash=request['closureHash'],historyRevision=9,
                    closureStatus='complete-current',latest=copy.deepcopy(self.latest),
                    observedAt=self.now,expiresAt=self.now+1000)
        body.update(changes)
        signature = digest(body)
        self.verifier.messages[signature] = (self.pins['verifierKeyHandle'],DOMAIN+canonical(body))
        return dict(body=body,signature=signature)

    def call(self, request=None, envelope=None, now=None):
        return self.gate.verify_use(self.request if request is None else request,
                                    self.envelope() if envelope is None else envelope,
                                    now=self.now if now is None else now)

    def test_complete_current_observation_is_not_a_permit(self):
        result=self.call()
        self.assertEqual(result.request_hash,digest(self.request))
        self.assertEqual(result.history_revision,9)
        self.assertFalse(hasattr(result,'authorized'))
        self.assertFalse(hasattr(result,'execute'))
        self.assertEqual(self.verifier.calls[0][0],self.pins['verifierKeyHandle'])

    def test_absent_protected_pins_or_verifier_refuses(self):
        for args in ({},{'pins':self.pins},{'verifier':self.verifier}):
            with self.subTest(args=list(args)),self.assertRaises(ReviewHeld):CurrentHistoryVerifier(**args)

    def test_native_restore_cannot_resurrect_reconcile_before_revoke_without_append(self):
        # Native snapshot reconcile1 is restored; independently retained revoke2 survives.
        for purpose in ('admission','lifecycle'):
            request=self.request_for(purpose=purpose)
            latest=copy.deepcopy(self.latest)
            latest[0].update(action='revoke',sequence=2,decisionHash=digest('retained-revoke2'),intentHash=digest('revoke-intent2'))
            with self.subTest(purpose=purpose),self.assertRaisesRegex(ReviewHeld,'revoked_or_uncertain'):
                self.call(request,self.envelope(request,latest=latest))
        self.assertEqual(self.accepted[0]['sequence'],1)

    def test_external_ahead_reconcile_or_conflicting_hash_is_held(self):
        for changes in ({'sequence':3,'decisionHash':digest('new-reconcile3')},{'decisionHash':digest('conflict')},
                        {'holdHash':digest('different-original')}):
            latest=copy.deepcopy(self.latest);latest[1].update(changes)
            with self.subTest(changes=changes),self.assertRaisesRegex(ReviewHeld,'rollback_or_conflict'):
                self.call(envelope=self.envelope(latest=latest))

    def test_uncertain_intent_or_missing_history_remains_occupied(self):
        for status in ('prospective','unknown','commit-uncertain','revoked','not-found'):
            latest=copy.deepcopy(self.latest);latest[0]['status']=status
            with self.subTest(status=status),self.assertRaises(ReviewHeld):self.call(envelope=self.envelope(latest=latest))
        for latest in ([],self.latest[:1],self.latest+[self.latest[0]],[self.latest[0],self.latest[0]]):
            with self.subTest(latest=len(latest)),self.assertRaises(ReviewHeld):self.call(envelope=self.envelope(latest=latest))

    def test_complete_original_inventory_cannot_be_filtered_or_normalized(self):
        for changes in ({'holds':[]},{'accepted':self.accepted[:1]},{'holds':self.holds*2,'accepted':self.accepted*2}):
            with self.subTest(changes=list(changes)),self.assertRaises(ReviewHeld):self.request_for(**changes)
        for changes in ({'source':'run:unsupported'},{'agentId':None},{'scopes':['same','same']}):
            holds=copy.deepcopy(self.holds);holds[0].update(changes)
            with self.subTest(changes=changes),self.assertRaises(ReviewHeld):self.request_for(holds=holds)
        self.assertEqual(self.request['closure'][0]['hold'],self.holds[0])
        subset=self.request_for(holds=self.holds[:1],accepted=self.accepted[:1])
        # A real issuer must discover omission itself, beyond request validation.
        with self.assertRaises(ReviewHeld):self.call(subset,self.envelope(subset,closureStatus='incomplete'))

    def test_original_scope_order_and_policy_are_bound_without_rewrite(self):
        holds=copy.deepcopy(self.holds);holds[0]['scopes'].reverse()
        request=self.request_for(holds=holds)
        self.assertNotEqual(request['closureHash'],self.request['closureHash'])
        with self.assertRaises(ReviewHeld):self.call(request,self.envelope())
        self.assertEqual(self.request['closure'][0]['hold']['policyHash'],digest('historical-policy'))

    def test_old_challenge_purpose_or_closure_observation_cannot_be_reused(self):
        envelope=self.envelope()
        for changes in ({'challenge':digest('new-challenge')},{'purpose':'lifecycle'}):
            with self.subTest(changes=changes),self.assertRaises(ReviewHeld):self.call(self.request_for(**changes),envelope)
        request=copy.deepcopy(self.request);request['closure'].reverse()
        with self.assertRaises(ReviewHeld):self.call(request,envelope)

    def test_old_incarnation_floor_or_key_handle_cannot_echo_into_trust(self):
        for changes in ({'historyRevision':7},{'pins':{**self.pins,'historyIncarnation':'restored-history'}},
                        {'pins':{**self.pins,'verifierKeyHandle':'attacker-key'}}):
            with self.subTest(changes=changes),self.assertRaises(ReviewHeld):self.call(envelope=self.envelope(**changes))
        self.pins['verifierKeyHandle']='changed-after-construction'
        with self.assertRaises(ReviewHeld):self.call(self.request_for(),self.envelope())

    def test_signature_failure_and_verifier_errors_fail_closed(self):
        envelope=self.envelope();envelope['signature']='unrecognized'
        with self.assertRaises(ReviewHeld):self.call(envelope=envelope)
        self.verifier.verify=lambda *args: 1
        with self.assertRaises(ReviewHeld):self.call()
        def unavailable(*args):raise RuntimeError('no key custody service')
        self.verifier.verify=unavailable
        with self.assertRaisesRegex(ReviewHeld,'signature_unavailable'):self.call()

    def test_observation_cannot_predate_request_or_outlive_deadline(self):
        for changes in ({'observedAt':self.now-1},{'expiresAt':self.now},{'observedAt':self.now+1},
                        {'expiresAt':self.now+60001},{'historyRevision':True}):
            with self.subTest(changes=changes),self.assertRaises(ReviewHeld):self.call(envelope=self.envelope(**changes))
        with self.assertRaises(ReviewHeld):self.call(now=self.now+1001)

    def test_request_copy_and_exact_reference_shape(self):
        request=self.request_for();self.holds[0]['scopes'].append('mutated-input')
        self.assertEqual(len(request['closure'][0]['hold']['scopes']),2)
        for changes in ({'sequence':True},{'decisionHash':'bad'},{'extra':'ignored'}):
            accepted=copy.deepcopy(self.accepted);accepted[0].update(changes)
            with self.subTest(changes=changes),self.assertRaises(ReviewHeld):self.request_for(accepted=accepted)


if __name__=='__main__':unittest.main()
