"""Synthetic artifacts only; no production keys, facts, A decisions or append."""
import copy
import hmac
import json
import unittest
from unittest.mock import patch

from legacy_review import BINDINGS, DOMAINS, ReviewHeld, canonical, digest
from production.evidence_bridge import (CONFIG_PATH, MAX_BYTES, EvidenceBridge,
                                       decode, protected_read)


class SyntheticEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.now = 1800000000000
        self.keys = {k: bytes.fromhex(digest('SYNTHETIC-ONLY-' + k)) for k in (*DOMAINS, 'inventory', 'continuity', 'inspection')}
        self.pins = dict(instance='original-instance', policyHash=digest('original-policy'),
                         epoch='10000000-0000-4000-8000-000000000001',
                         authorityIncarnation='original-authority', historyDomain='independent-current-domain',
                         historyIncarnation='current-history', historyFloor=7)
        hold = dict(source='lease:10000000-0000-4000-8000-000000000002',
                    leaseId='10000000-0000-4000-8000-000000000002',
                    holdHash=digest('original-hold'), companyId='10000000-0000-4000-8000-000000000003',
                    agentId='10000000-0000-4000-8000-000000000004', runId='10000000-0000-4000-8000-000000000005',
                    environmentId='10000000-0000-4000-8000-000000000006',
                    scopes=['original-shared-account', 'original-shared-credential'],
                    policyHash=self.pins['policyHash'], epoch=self.pins['epoch'])
        fingerprint = digest([dict(source=hold['source'],holdHash=hold['holdHash'])])
        decision = dict(**hold, kind='present-day-legacy-reconciliation-v1', action='reconcile',
                        sequence=1, previousHash=None, observedAt=self.now-100, expiresAt=self.now+30000,
                        restoration={})
        artifacts = {}
        for domain in DOMAINS:
            body = dict(**copy.deepcopy(hold), kind='legacy-'+domain+'-evidence-v1', outcome='verified',
                        evidenceHash=digest('SYNTHETIC-OBSERVATION-'+domain), observedAt=self.now-100, expiresAt=self.now+20000)
            if domain == 'operator':
                body.update(approvedArtifacts={k:digest(v['body']) for k,v in artifacts.items()}, approvedAction='reconcile', approvedInventoryHash=fingerprint, approvedDecision=dict(sequence=decision['sequence'],previousHash=decision['previousHash']))
            artifacts[domain] = self.sign(domain, body, legacy=True)
            field = dict(route='routeRevocationHash',retirement='retiredIncarnationHash',stop='wholePodStopHash',operator='operatorApprovalHash').get(domain)
            if field:
                decision[field] = digest(body)
            else:
                decision['restoration'][domain] = digest(body)
        self.config = dict(version=1, pins=self.pins, roots={k:'/protected/'+k for k in self.keys},
                           inventoryPath='/protected/inventory-document', bundlesPath='/protected/bundles',
                           continuityPath='/protected/continuity-document', inspectionPath='/protected/inspection-document')
        self.request = dict(operation='review',decision=decision,holds=[hold],inventoryHash=fingerprint,
                            now=self.now,challenge=digest('fresh-native-challenge'))
        inventory = dict(kind='legacy-authoritative-hold-inventory-v1',holds=[hold],inventoryHash=fingerprint,
                         observedAt=self.now-1,expiresAt=self.now+10000)
        continuity = dict(kind='legacy-authority-continuity-v1',pins=self.pins,historyRevision=8,
                          challenge=self.request['challenge'],inventoryHash=fingerprint,
                          observedAt=self.now-1,expiresAt=self.now+5000)
        self.files = {CONFIG_PATH:self.config, **{'/protected/'+k:{'key':v.hex()} for k,v in self.keys.items()},
                      self.config['inventoryPath']:self.sign('inventory',inventory,legacy=True),
                      self.config['continuityPath']:self.sign('continuity',continuity),
                      self.config['bundlesPath']:{hold['source']:dict(decision=decision,artifacts=artifacts)}}
        self.original = copy.deepcopy(self.files)

    def sign(self, domain, body, legacy=False):
        prefix = (b'paperclip-legacy-inventory-v1\0' if domain == 'inventory' else
                  b'paperclip-legacy-review-v1\0'+domain.encode()+b'\0') if legacy else b'paperclip-legacy-bridge-v1\0'+domain.encode()+b'\0'
        return dict(body=copy.deepcopy(body),mac=hmac.digest(self.keys[domain],prefix+canonical(body),'sha256').hex())

    def call(self, request=None):
        def read(path):
            if path not in self.files:
                raise ReviewHeld('synthetic_missing_protected_file')
            return copy.deepcopy(self.files[path])
        with patch('production.evidence_bridge.protected_read',side_effect=read), \
             patch('production.evidence_bridge.time.time',return_value=self.now/1000):
            return EvidenceBridge().handle(copy.deepcopy(self.request if request is None else request))

    def test_complete_synthetic_review_returns_shortest_deadline_no_authority(self):
        result = self.call()
        self.assertEqual(result,dict(decisionHash=digest(self.request['decision']),inventoryHash=self.request['inventoryHash'],
                                     expiresAt=self.now+5000,challenge=self.request['challenge'],operationalAcceptance=False))
        self.assertEqual(self.files,self.original)

    def test_each_protected_input_is_mandatory(self):
        for path in list(self.files):
            with self.subTest(path=path):
                saved=self.files.pop(path)
                with self.assertRaises(ReviewHeld): self.call()
                self.files[path]=saved

    def test_no_caller_supplied_paths_or_partial_inventory(self):
        for changes in ({'configPath':'/tmp/untrusted'}, {'holds':[]}, {'holds':self.request['holds']*2}, {'inventoryHash':digest('filtered')}):
            with self.subTest(changes=changes),self.assertRaises(ReviewHeld):
                self.call({**self.request,**changes})

    def test_changed_original_binding_or_scope_order_held(self):
        for key,value in [('agentId','10000000-0000-4000-8000-000000000099'),
                          ('scopes',list(reversed(self.request['holds'][0]['scopes']))),
                          ('holdHash',digest('changed-original-hold'))]:
            request=copy.deepcopy(self.request);request['holds'][0][key]=value
            with self.subTest(key=key),self.assertRaises(ReviewHeld):self.call(request)

    def test_every_artifact_and_complete_bundle_required(self):
        source=self.request['decision']['source']
        for domain in DOMAINS:
            files=copy.deepcopy(self.files)
            del self.files[self.config['bundlesPath']][source]['artifacts'][domain]
            with self.subTest(domain=domain),self.assertRaises(ReviewHeld):self.call()
            self.files=files
        self.files[self.config['bundlesPath']]={}
        with self.assertRaises(ReviewHeld):self.call()

    def test_each_independent_root_and_authentication_required(self):
        self.files['/protected/stop']=copy.deepcopy(self.files['/protected/route'])
        with self.assertRaises(ReviewHeld):self.call()
        self.files=copy.deepcopy(self.original)
        self.files[self.config['continuityPath']]['mac']='0'*64
        with self.assertRaises(ReviewHeld):self.call()

    def test_continuity_challenge_current_pins_and_revision_cannot_be_echoed(self):
        for change in ({'challenge':digest('old-challenge')}, {'historyRevision':6},
                       {'pins':{**self.pins,'historyIncarnation':'restored-old-domain'}},
                       {'inventoryHash':digest('other-inventory')}, {'expiresAt':self.now},
                       {'observedAt':self.now+1}):
            original=copy.deepcopy(self.files[self.config['continuityPath']]['body'])
            self.files[self.config['continuityPath']]=self.sign('continuity',{**original,**change})
            with self.subTest(change=change),self.assertRaises(ReviewHeld):self.call()
            self.files[self.config['continuityPath']]=self.sign('continuity',original)

    def test_complete_shared_inventory_order_independent_but_subset_never_accepted(self):
        sibling=copy.deepcopy(self.request['holds'][0])
        sibling.update(source='lease:10000000-0000-4000-8000-000000000098',
                       leaseId='10000000-0000-4000-8000-000000000098',holdHash=digest('original-shared-sibling'))
        decision=copy.deepcopy(self.request['decision']);decision.update(sibling)
        artifacts={}
        for domain in DOMAINS:
            body=dict(**copy.deepcopy(sibling),kind='legacy-'+domain+'-evidence-v1',outcome='verified',
                      evidenceHash=digest('SYNTHETIC-SIBLING-'+domain),observedAt=self.now-100,expiresAt=self.now+20000)
            if domain=='operator':
                body.update(approvedArtifacts={k:digest(v['body']) for k,v in artifacts.items()},approvedAction='reconcile',approvedDecision=dict(sequence=decision['sequence'],previousHash=decision['previousHash']))
            artifacts[domain]=self.sign(domain,body,legacy=True)
            field=dict(route='routeRevocationHash',retirement='retiredIncarnationHash',stop='wholePodStopHash',operator='operatorApprovalHash').get(domain)
            if field: decision[field]=digest(body)
            else: decision['restoration'][domain]=digest(body)
        self.files[self.config['bundlesPath']][sibling['source']]=dict(decision=decision,artifacts=artifacts)
        request=copy.deepcopy(self.request);request['holds'].append(sibling)
        fingerprint=digest(sorted((dict(source=h['source'],holdHash=h['holdHash']) for h in request['holds']),key=lambda h:h['source']))
        request['inventoryHash']=fingerprint
        inventory=copy.deepcopy(self.files[self.config['inventoryPath']]['body'])
        inventory.update(holds=list(reversed(request['holds'])),inventoryHash=fingerprint)
        self.files[self.config['inventoryPath']]=self.sign('inventory',inventory,legacy=True)
        continuity=copy.deepcopy(self.files[self.config['continuityPath']]['body']);continuity['inventoryHash']=fingerprint
        self.files[self.config['continuityPath']]=self.sign('continuity',continuity)
        # A complete new sibling bundle is insufficient while the old source's
        # approval still names the prior one-hold inventory.
        with self.assertRaisesRegex(ReviewHeld,'operator_inventory_approval'):self.call(request)
        self.approve_inventory(fingerprint)
        request['decision']=copy.deepcopy(self.files[self.config['bundlesPath']][request['decision']['source']]['decision'])
        self.assertEqual(self.call(request)['inventoryHash'],fingerprint)
        with self.assertRaises(ReviewHeld):self.call(self.request)

    def test_changed_sibling_hold_requires_selected_sources_new_global_approval(self):
        # Establish two fully reviewed synthetic holds first.
        self.test_complete_shared_inventory_order_independent_but_subset_never_accepted()
        inventory=copy.deepcopy(self.files[self.config['inventoryPath']]['body'])
        original_source=self.request['decision']['source']
        sibling=next(h for h in inventory['holds'] if h['source']!=original_source)
        sibling['holdHash']=digest('changed-original-sibling-evidence')
        fingerprint=digest(sorted((dict(source=h['source'],holdHash=h['holdHash']) for h in inventory['holds']),key=lambda h:h['source']))
        inventory['inventoryHash']=fingerprint
        self.files[self.config['inventoryPath']]=self.sign('inventory',inventory,legacy=True)
        bundle=self.files[self.config['bundlesPath']][sibling['source']]
        bundle['decision']['holdHash']=sibling['holdHash']
        for domain in DOMAINS:
            body=bundle['artifacts'][domain]['body'];body['holdHash']=sibling['holdHash']
            if domain=='operator':
                body['approvedArtifacts']={k:digest(v['body']) for k,v in bundle['artifacts'].items() if k!='operator'}
                body['approvedInventoryHash']=fingerprint
            bundle['artifacts'][domain]=self.sign(domain,body,legacy=True)
            field=dict(route='routeRevocationHash',retirement='retiredIncarnationHash',stop='wholePodStopHash',operator='operatorApprovalHash').get(domain)
            if field:bundle['decision'][field]=digest(body)
            else:bundle['decision']['restoration'][domain]=digest(body)
        request=copy.deepcopy(self.request)
        request.update(holds=copy.deepcopy(inventory['holds']),inventoryHash=fingerprint,challenge=digest('changed-sibling-current-challenge'))
        request['decision']=copy.deepcopy(self.files[self.config['bundlesPath']][original_source]['decision'])
        continuity=copy.deepcopy(self.files[self.config['continuityPath']]['body'])
        continuity.update(inventoryHash=fingerprint,challenge=request['challenge'],historyRevision=9)
        self.files[self.config['continuityPath']]=self.sign('continuity',continuity)
        # All sibling evidence and its operator approval are current, yet the
        # unchanged selected source still needs consent to the new complete set.
        with self.assertRaisesRegex(ReviewHeld,'operator_inventory_approval'):self.call(request)
        self.approve_inventory(fingerprint,[original_source])
        request['decision']=copy.deepcopy(self.files[self.config['bundlesPath']][original_source]['decision'])
        self.assertEqual(self.call(request)['inventoryHash'],fingerprint)

    def approve_inventory(self, fingerprint, sources=None):
        # Synthetic explicit operator reapproval, never called by production code.
        bundles=self.files[self.config['bundlesPath']]
        for source in (bundles if sources is None else sources):
            bundle=bundles[source];body=bundle['artifacts']['operator']['body']
            body['approvedInventoryHash']=fingerprint
            body['approvedDecision']=dict(sequence=bundle['decision']['sequence'],previousHash=bundle['decision']['previousHash'])
            bundle['artifacts']['operator']=self.sign('operator',body,legacy=True)
            bundle['decision']['operatorApprovalHash']=digest(body)

    def test_operator_inventory_binding_required_for_every_authoritative_hold(self):
        source=self.request['decision']['source']
        for value in (None,digest('old-inventory')):
            files=copy.deepcopy(self.files)
            bundle=self.files[self.config['bundlesPath']][source]
            if value is None:del bundle['artifacts']['operator']['body']['approvedInventoryHash']
            else:bundle['artifacts']['operator']['body']['approvedInventoryHash']=value
            body=bundle['artifacts']['operator']['body']
            bundle['artifacts']['operator']=self.sign('operator',body,legacy=True)
            bundle['decision']['operatorApprovalHash']=digest(body)
            request=copy.deepcopy(self.request);request['decision']=copy.deepcopy(bundle['decision'])
            with self.subTest(value=value),self.assertRaisesRegex(ReviewHeld,'operator_inventory_approval'):self.call(request)
            self.files=files

    def test_old_reconcile_approval_cannot_reauthorize_after_explicit_revoke(self):
        # Synthetic independent human approvals; no native append is performed.
        source=self.request['decision']['source']
        original_request=copy.deepcopy(self.request)
        original_bundle=copy.deepcopy(self.files[self.config['bundlesPath']][source])
        self.call(original_request)
        revoked=copy.deepcopy(original_bundle['decision'])
        revoked.update(action='revoke',sequence=2,previousHash=digest(original_bundle['decision']))
        operator=copy.deepcopy(original_bundle['artifacts']['operator']['body'])
        operator.update(approvedAction='revoke',approvedDecision=dict(sequence=2,previousHash=revoked['previousHash']))
        revoked['operatorApprovalHash']=digest(operator)
        bundle=self.files[self.config['bundlesPath']][source]
        bundle.update(decision=revoked)
        bundle['artifacts']['operator']=self.sign('operator',operator,legacy=True)
        request=copy.deepcopy(original_request)
        request.update(decision=copy.deepcopy(revoked),challenge=digest('explicit-revoke-two-challenge'))
        continuity=copy.deepcopy(self.files[self.config['continuityPath']]['body'])
        continuity.update(challenge=request['challenge'],historyRevision=9)
        self.files[self.config['continuityPath']]=self.sign('continuity',continuity)
        self.assertEqual(self.call(request)['decisionHash'],digest(revoked))
        # A valid native CAS at sequence3 does not express a new human decision.
        # Reuse the genuine still-unexpired sequence1 operator MAC unchanged.
        renewed=copy.deepcopy(original_bundle['decision'])
        renewed.update(sequence=3,previousHash=digest(revoked))
        bundle['decision']=renewed
        bundle['artifacts']['operator']=copy.deepcopy(original_bundle['artifacts']['operator'])
        request.update(decision=copy.deepcopy(renewed),challenge=digest('stale-reconcile-three-challenge'))
        continuity.update(challenge=request['challenge'],historyRevision=10)
        self.files[self.config['continuityPath']]=self.sign('continuity',continuity)
        with self.assertRaisesRegex(ReviewHeld,'operator_decision_intent'):self.call(request)
        # Explicit new exact-intent approval can pass, preserving all old facts.
        operator=copy.deepcopy(original_bundle['artifacts']['operator']['body'])
        operator['approvedDecision']=dict(sequence=3,previousHash=renewed['previousHash'])
        bundle['artifacts']['operator']=self.sign('operator',operator,legacy=True)
        renewed['operatorApprovalHash']=digest(operator)
        request['decision']=copy.deepcopy(renewed)
        self.assertEqual(self.call(request)['decisionHash'],digest(renewed))
        self.assertEqual(request['inventoryHash'],original_request['inventoryHash'])

    def test_operator_intent_binds_sequence_and_previous_hash_without_bool_coercion(self):
        source=self.request['decision']['source']
        for approved in (None,dict(sequence=True,previousHash=None),dict(sequence=2,previousHash=None),
                         dict(sequence=1,previousHash=digest('other-prior')),dict(sequence=1,previousHash=None,extra='not-exact')):
            files=copy.deepcopy(self.files);request=copy.deepcopy(self.request)
            bundle=self.files[self.config['bundlesPath']][source]
            body=bundle['artifacts']['operator']['body']
            if approved is None:del body['approvedDecision']
            else:body['approvedDecision']=approved
            bundle['artifacts']['operator']=self.sign('operator',body,legacy=True)
            bundle['decision']['operatorApprovalHash']=digest(body)
            request['decision']=copy.deepcopy(bundle['decision'])
            with self.subTest(approved=approved),self.assertRaisesRegex(ReviewHeld,'operator_decision_intent'):self.call(request)
            self.files=files

    def test_unchanged_inventory_can_refresh_current_snapshot_without_operator_resign(self):
        before=copy.deepcopy(self.files[self.config['bundlesPath']])
        request=copy.deepcopy(self.request);request['challenge']=digest('fresh-challenge-same-semantic-inventory')
        inventory=copy.deepcopy(self.files[self.config['inventoryPath']]['body'])
        inventory.update(observedAt=self.now,expiresAt=self.now+11000)
        self.files[self.config['inventoryPath']]=self.sign('inventory',inventory,legacy=True)
        continuity=copy.deepcopy(self.files[self.config['continuityPath']]['body'])
        continuity.update(challenge=request['challenge'],observedAt=self.now,expiresAt=self.now+6000)
        self.files[self.config['continuityPath']]=self.sign('continuity',continuity)
        self.assertEqual(self.call(request)['inventoryHash'],request['inventoryHash'])
        self.assertEqual(before,self.files[self.config['bundlesPath']])

    def test_authenticated_expired_artifact_refuses_after_bundle_hashes_rebound(self):
        source=self.request['decision']['source']
        bundle=self.files[self.config['bundlesPath']][source]
        stop=bundle['artifacts']['stop']['body'];stop['expiresAt']=self.now
        bundle['artifacts']['stop']=self.sign('stop',stop,legacy=True)
        bundle['decision']['wholePodStopHash']=digest(stop)
        operator=bundle['artifacts']['operator']['body']
        operator['approvedArtifacts']['stop']=digest(stop)
        bundle['artifacts']['operator']=self.sign('operator',operator,legacy=True)
        bundle['decision']['operatorApprovalHash']=digest(operator)
        request=copy.deepcopy(self.request);request['decision']=copy.deepcopy(bundle['decision'])
        with self.assertRaisesRegex(ReviewHeld,'artifact_freshness'):self.call(request)

    def test_operator_action_cannot_be_switched(self):
        request=copy.deepcopy(self.request);request['decision']['action']='revoke'
        self.files[self.config['bundlesPath']][request['decision']['source']]['decision']=request['decision']
        with self.assertRaises(ReviewHeld):self.call(request)

    def test_expired_inventory_and_domain_evidence_refuse(self):
        body=copy.deepcopy(self.files[self.config['inventoryPath']]['body']);body['expiresAt']=self.now
        self.files[self.config['inventoryPath']]=self.sign('inventory',body,legacy=True)
        with self.assertRaises(ReviewHeld):self.call()
        self.files=copy.deepcopy(self.original)
        bundle=self.files[self.config['bundlesPath']][self.request['decision']['source']]
        bundle['artifacts']['stop']['body']['expiresAt']=self.now
        with self.assertRaises(ReviewHeld):self.call()

    def test_unmapped_run_source_or_wrong_epoch_cannot_be_relabelled(self):
        for change in ({'source':'run:original'}, {'agentId':None}, {'epoch':'10000000-0000-4000-8000-000000000099'}):
            request=copy.deepcopy(self.request);request['holds'][0].update(change)
            with self.subTest(change=change),self.assertRaises((ReviewHeld,ValueError,TypeError)):self.call(request)

    def test_host_clock_cannot_be_supplied_to_revive_expired_artifacts(self):
        with self.assertRaises(ReviewHeld):self.call({**self.request,'now':self.now-2000})

    def inspection(self,status='committed-exact'):
        request={k:self.request[k] for k in ('now','challenge')}
        request.update(operation='inspect',source=self.request['decision']['source'],sequence=1,decisionHash=digest(self.request['decision']))
        body={k:v for k,v in request.items() if k not in ('operation','now')}
        body.update(kind='legacy-decision-inspection-v1',pins=self.pins,historyRevision=8,status=status,
                    observedAt=self.now-1,expiresAt=self.now+1000)
        self.files[self.config['inspectionPath']]=self.sign('inspection',body)
        return request

    def test_read_only_inspection_confirms_only_exact_committed_decision(self):
        request=self.inspection()
        result=self.call(request)
        self.assertEqual(result['status'],'committed-exact')
        self.assertNotIn('retry',result)
        self.assertFalse(result['operationalAcceptance'])
        for key,value in [('sequence',2),('decisionHash',digest('other')),('challenge',digest('stale'))]:
            with self.subTest(key=key),self.assertRaises(ReviewHeld):self.call({**request,key:value})

    def test_ambiguous_missing_or_conflicting_inspection_never_grants_retry(self):
        for status in ('unknown','not-found','conflicting','pending'):
            request=self.inspection(status)
            with self.subTest(status=status),self.assertRaises(ReviewHeld):self.call(request)
        request=self.inspection();del self.files[self.config['inspectionPath']]
        with self.assertRaises(ReviewHeld):self.call(request)

    def test_strict_bounded_wire_decode(self):
        for raw in (b'{"a":1,"a":2}', b'{"x":NaN}', b'{"x":1.5}', b'['*40+b']'*40,
                    b'x'*(MAX_BYTES+1),b'{"x":9007199254740992}',b'not-json'):
            with self.subTest(raw=raw[:30]),self.assertRaises(ReviewHeld):decode(raw)
        self.assertEqual(decode(b'{"operation":"review"}'),{'operation':'review'})
        malformed=copy.deepcopy(self.request);malformed['decision']['sequence']=True
        with self.assertRaises(ReviewHeld):self.call(malformed)

    def test_real_protected_reader_rejects_unprotected_and_symlink_paths(self):
        for path in ('relative','/tmp/anything','/etc/../tmp/anything','/proc/self/status'):
            with self.subTest(path=path),self.assertRaises(ReviewHeld):protected_read(path)


if __name__=='__main__':
    unittest.main()
