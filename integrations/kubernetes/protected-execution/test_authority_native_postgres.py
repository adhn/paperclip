"""Root-scheduled disposable PostgreSQL fixture; never connects outside container.

Requires explicit PAPERCLIP_FIXTURE_CONTAINER=paperclip-native-fixture-<suffix>.
Root alone creates/starts/removes the pinned, network-none, no-port container.
No automatic pull/build/container creation and no installed Python dependencies.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import time
import unittest
import uuid

SQL = Path(__file__).parent / 'sql-review' / 'authority-native-fixture.sql'
DATABASE = 'paperclip_fixture'
EXECUTOR = 'paperclip_authority_executor'
INCARNATION = str(uuid.UUID(int=1))
REQUEST_HASH = 'a' * 64
INVENTORY = 'b' * 64


def literal(value):
    if value is None:
        return 'NULL'
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def identifier(number):
    return str(uuid.UUID(int=number))


def array(values):
    return 'ARRAY[' + ','.join(literal(x) for x in values) + ']::text[]'


class NativePostgresFixture(unittest.TestCase):
    @classmethod
    def command(cls, user='postgres', database=DATABASE):
        return ['docker', 'exec', '-i', cls.container, 'psql', '-X', '-qAt',
                '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database]

    @classmethod
    def query(cls, sql, user='postgres', ok=True, timeout=10, database=DATABASE,
              discard_output=False):
        result = subprocess.run(cls.command(user, database), input=sql, text=True,
            stdout=subprocess.DEVNULL if discard_output else subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=timeout, check=False)
        if ok and result.returncode:
            raise AssertionError('fixture SQL failed: ' + result.stderr)
        if not ok and result.returncode == 0:
            raise AssertionError('fixture SQL unexpectedly succeeded')
        return '' if discard_output else ((result.stdout or '') + (result.stderr if not ok else '')).strip()

    @classmethod
    def setUpClass(cls):
        cls.container = os.environ.get('PAPERCLIP_FIXTURE_CONTAINER', '')
        if not cls.container:
            raise unittest.SkipTest('explicit root-scheduled disposable container required; DB tests NOT RUN')
        if re.fullmatch(r'paperclip-native-fixture-[a-z0-9-]+', cls.container) is None:
            raise RuntimeError('refusing non-fixture container name')
        cls.query('CREATE DATABASE paperclip_fixture;', database='postgres')
        cls.query(SQL.read_text(encoding='utf-8'))

    def setUp(self):
        self.query('''TRUNCATE paperclip_h.release_facts, paperclip_h.claims,
            paperclip_h.operations, paperclip_h.approved_requests,
            paperclip_h.prospective_denials, paperclip_h.original_holds,
            paperclip_h.scopes, paperclip_h.generation;
            INSERT INTO paperclip_h.generation VALUES
            (true, '00000000-0000-0000-0000-000000000001',1,'open',repeat('b',64));
            INSERT INTO paperclip_h.scopes VALUES ('scope:a',1,false),('scope:b',1,false);
            INSERT INTO paperclip_h.original_holds VALUES
            ('lease:original-A',repeat('c',64),ARRAY['scope:a'],'reconciled',1,repeat('d',64),true),
            ('lease:original-B',repeat('e',64),ARRAY['scope:a'],'reconciled',1,repeat('f',64),true);''')

    def transaction(self, call, ok=True, isolation='SERIALIZABLE'):
        return self.query("BEGIN ISOLATION LEVEL " + isolation + ";"
            "SET LOCAL statement_timeout='2500ms'; SET LOCAL lock_timeout='750ms';"
            "SET LOCAL idle_in_transaction_session_timeout='3s';" + call + '; COMMIT;', EXECUTOR, ok)

    def descriptor(self, claim=20, run=30, scopes=None, sources=None, inventory=INVENTORY):
        return dict(claim=identifier(claim), run=identifier(run),
                    scopes=['scope:a'] if scopes is None else scopes,
                    sources=['lease:original-A', 'lease:original-B'] if sources is None else sources,
                    inventoryHash=inventory)

    def retain(self, operation=10, kind='claim', target=20, descriptor=None, epoch=1):
        descriptor = self.descriptor() if descriptor is None else descriptor
        self.query('INSERT INTO paperclip_h.approved_requests VALUES (' + ','.join([
            literal(identifier(operation)), literal(INCARNATION), str(epoch), literal(REQUEST_HASH),
            literal(kind), literal(identifier(target)), literal(json.dumps(descriptor))+'::jsonb']) + ');')

    def claim_call(self, operation=10, claim=20, run=30, epoch=1, descriptor=None, request_hash=REQUEST_HASH):
        d = self.descriptor(claim=claim, run=run) if descriptor is None else descriptor
        return 'SELECT paperclip_h.claim(' + ','.join([
            literal(identifier(operation)), literal(request_hash), literal(INCARNATION), literal(epoch),
            literal(d['claim']), literal(d['run']), array(d['scopes']), array(d['sources']),
            literal(d['inventoryHash'])]) + ')'

    def inspect_call(self, operation=10, target=20, kind='claim', descriptor=None):
        d = self.descriptor() if descriptor is None else descriptor
        return 'SELECT paperclip_h.inspect_operation(' + ','.join([
            literal(identifier(operation)), literal(REQUEST_HASH), literal(INCARNATION), '1',
            literal(kind), literal(identifier(target)), literal(json.dumps(d))+'::jsonb']) + ')'

    def retain_deny(self, operation=11, deny=40):
        self.query('INSERT INTO paperclip_h.prospective_denials VALUES (' +
            literal(identifier(deny)) + ",'lease:original-A',repeat('1',64),repeat('d',64),2,repeat('2',64),'prospective');")
        descriptor = dict(deny=identifier(deny), source='lease:original-A', intentHash='1'*64,
                          previousDecisionHash='d'*64, nextSequence=2, operatorApprovalHash='2'*64)
        self.retain(operation, 'deny', deny, descriptor)
        return 'SELECT paperclip_h.deny(' + ','.join([
            literal(identifier(operation)), literal(REQUEST_HASH), literal(INCARNATION), '1',
            literal(identifier(deny))]) + ')'

    def make_claim(self):
        self.retain()
        self.assertIn('committed-exact', self.transaction(self.claim_call()))

    def test_actual_role_owner_and_function_grants(self):
        self.assertEqual(self.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='paperclip_authority_owner'"), 'f')
        self.assertEqual(self.query("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
            "JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='paperclip_h' AND r.rolname<>'paperclip_authority_owner'"), '0')
        for statement in (
                "INSERT INTO paperclip_h.scopes VALUES ('forged',99,false)",
                "UPDATE paperclip_h.generation SET epoch=9",
                "SELECT paperclip_h.require_generation('" + INCARNATION + "',1)",
                'SET ROLE paperclip_authority_owner',
                'CREATE TABLE paperclip_h.bypass(x int)'):
            with self.subTest(statement=statement):
                self.query(statement, EXECUTOR, ok=False)
        self.query('SELECT paperclip_h.inspect_operation(NULL,NULL,NULL,NULL,NULL,NULL,NULL)',
                   'paperclip_fixture_untrusted', ok=False)

    def test_claim_commits_effect_and_journal_atomically(self):
        self.make_claim()
        self.assertEqual(self.query("SELECT phase FROM paperclip_h.claims"), 'occupied')
        self.assertEqual(self.query("SELECT status FROM paperclip_h.operations"), 'committed-exact')

    def test_missing_generation_and_held_generation_refuse(self):
        self.retain()
        self.query("UPDATE paperclip_h.generation SET phase='held'")
        self.assertIn('authority generation held', self.transaction(self.claim_call(), ok=False))
        self.query('DELETE FROM paperclip_h.generation')
        self.transaction(self.claim_call(), ok=False)
        self.assertEqual(self.query('SELECT count(*) FROM paperclip_h.claims'), '0')

    def test_stale_generation_and_wrong_isolation_refuse(self):
        self.retain()
        self.assertIn('generation held', self.transaction(self.claim_call(epoch=2), ok=False))
        self.assertIn('serializable transaction required', self.transaction(self.claim_call(), ok=False,
                                                                          isolation='READ COMMITTED'))
        # Actual former-epoch request after the authoritative epoch advances.
        # The retained original request remains epoch1; it is not rekeyed/reissued.
        self.query('UPDATE paperclip_h.generation SET epoch=2')
        self.assertIn('generation held', self.transaction(self.claim_call(epoch=1), ok=False))
        self.assertEqual(self.query('SELECT count(*) FROM paperclip_h.operations'), '0')
        self.assertEqual(self.query('SELECT count(*) FROM paperclip_h.claims'), '0')

    def test_null_identity_and_payload_refuse(self):
        self.retain()
        values = [identifier(10), REQUEST_HASH, INCARNATION, 1, identifier(20), identifier(30),
                  "ARRAY['scope:a']::text[]", "ARRAY['lease:original-A','lease:original-B']::text[]", INVENTORY]
        encoded = [literal(x) for x in values]
        encoded[6:8] = values[6:8]
        for field in range(len(encoded)):
            args = encoded.copy()
            args[field] = 'NULL'
            with self.subTest(field=field):
                self.transaction('SELECT paperclip_h.claim('+','.join(args)+')', ok=False)
        self.assertEqual(self.query('SELECT count(*) FROM paperclip_h.operations'), '0')

    def test_unretained_and_altered_exact_request_refuse(self):
        self.transaction(self.claim_call(), ok=False)
        self.retain()
        for d in (self.descriptor(run=31), self.descriptor(scopes=['scope:b']),
                  self.descriptor(inventory='9'*64), self.descriptor(sources=[])):
            with self.subTest(descriptor=d):
                self.assertIn('retained exact prospective', self.transaction(self.claim_call(descriptor=d), ok=False))
        self.assertIn('retained exact prospective', self.transaction(self.claim_call(request_hash='9'*64), ok=False))
        self.assertEqual(self.query('SELECT count(*) FROM paperclip_h.claims'), '0')

    def test_held_unsupported_or_omitted_original_shared_source_refuse(self):
        self.retain()
        for update in ("status='held'", 'supported=false'):
            self.query('UPDATE paperclip_h.original_holds SET '+update+" WHERE source='lease:original-A'")
            with self.subTest(update=update):
                self.assertIn('shared hold closure remains held', self.transaction(self.claim_call(), ok=False))
            self.query("UPDATE paperclip_h.original_holds SET status='reconciled',supported=true")
        self.query('DELETE FROM paperclip_h.approved_requests')
        omitted = self.descriptor(sources=['lease:original-B'])
        self.retain(descriptor=omitted)
        self.assertIn('shared hold closure remains held', self.transaction(self.claim_call(descriptor=omitted), ok=False))

    def test_noncanonical_unknown_and_capacity_scope_refuse(self):
        for scopes in (['scope:a','scope:a'], ['scope:b','scope:a'], ['missing'], ['']):
            descriptor = self.descriptor(scopes=scopes)
            self.query('DELETE FROM paperclip_h.approved_requests')
            self.retain(descriptor=descriptor)
            with self.subTest(scopes=scopes):
                self.transaction(self.claim_call(descriptor=descriptor), ok=False)
        self.query('DELETE FROM paperclip_h.approved_requests')
        self.make_claim()
        second = self.descriptor(claim=21,run=31)
        self.retain(12,target=21,descriptor=second)
        self.assertIn('scope capacity occupied', self.transaction(self.claim_call(12,descriptor=second), ok=False))

    def test_discarded_commit_reply_inspects_original_without_replay(self):
        self.retain()
        self.query('BEGIN ISOLATION LEVEL SERIALIZABLE;'+self.claim_call()+';COMMIT;',
                   EXECUTOR, discard_output=True)
        self.assertEqual(self.query(self.inspect_call(), EXECUTOR), 'committed-exact')
        self.assertIn('already-recorded-inspect-original', self.transaction(self.claim_call()))
        self.assertEqual(self.query('SELECT count(*) FROM paperclip_h.claims'), '1')
        self.query(self.inspect_call(descriptor=self.descriptor(run=99)), EXECUTOR, ok=False)

    def test_prospective_and_unknown_inspection_never_advise_retry(self):
        self.retain()
        self.assertEqual(self.query(self.inspect_call(), EXECUTOR), 'prospective-uncertain')
        self.query(self.inspect_call(operation=999), EXECUTOR, ok=False)
        self.assertEqual(self.query('SELECT count(*) FROM paperclip_h.operations'), '0')

    def test_native_deny_preserves_existing_claim_and_blocks_new_claim(self):
        self.make_claim()
        deny = self.retain_deny()
        self.assertIn('native-denied-only', self.transaction(deny))
        self.assertEqual(self.query('SELECT phase FROM paperclip_h.claims'), 'occupied')
        self.assertEqual(self.query("SELECT stage FROM paperclip_h.prospective_denials"), 'native-denied')
        self.assertIn('already-recorded-inspect-original', self.transaction(deny))
        second = self.descriptor(claim=21,run=31)
        self.retain(12,target=21,descriptor=second)
        self.assertIn('shared hold closure remains held', self.transaction(self.claim_call(12,descriptor=second), ok=False))

    def test_deny_predecessor_and_mutated_prospective_refuse(self):
        deny = self.retain_deny()
        self.query("UPDATE paperclip_h.original_holds SET decision_sequence=2")
        self.assertIn('predecessor conflict', self.transaction(deny, ok=False))
        self.query("UPDATE paperclip_h.original_holds SET decision_sequence=1")
        self.query("UPDATE paperclip_h.prospective_denials SET operator_approval_hash=repeat('3',64)")
        self.assertIn('retained exact prospective', self.transaction(deny, ok=False))
        self.assertEqual(self.query('SELECT count(*) FROM paperclip_h.operations'), '0')

    def test_release_requires_exact_facts_and_consumes_once(self):
        self.make_claim()
        descriptor = dict(claim=identifier(20),run=identifier(30),factsHash='3'*64)
        self.retain(13,'release',20,descriptor)
        call = 'SELECT paperclip_h.release('+','.join([
            literal(identifier(13)),literal(REQUEST_HASH),literal(INCARNATION),'1',
            literal(identifier(20)),literal(identifier(30)),literal('3'*64)])+')'
        self.transaction(call, ok=False)
        self.query("INSERT INTO paperclip_h.release_facts VALUES ('"+identifier(20)+"','"+identifier(30)+
            "','"+INCARNATION+"',1,repeat('4',64),repeat('5',64),repeat('6',64),repeat('3',64),now()-interval '1s',NULL)")
        self.assertIn('release facts incomplete', self.transaction(call, ok=False))
        self.query("UPDATE paperclip_h.release_facts SET valid_until=now()+interval '1 minute',epoch=2")
        self.transaction(call, ok=False)
        self.query('UPDATE paperclip_h.release_facts SET epoch=1')
        self.assertIn('committed-exact', self.transaction(call))
        self.assertIn('already-recorded-inspect-original', self.transaction(call))
        self.assertEqual(self.query('SELECT phase FROM paperclip_h.claims'), 'released')
        self.assertEqual(self.query('SELECT consumed_by FROM paperclip_h.release_facts'), identifier(13))

    def prepare_release(self, lifetime='10 seconds'):
        self.make_claim()
        self.retain(13, 'release', 20,
                    dict(claim=identifier(20), run=identifier(30), factsHash='3'*64))
        self.query("INSERT INTO paperclip_h.release_facts VALUES ('"+identifier(20)+"','"+
            identifier(30)+"','"+INCARNATION+"',1,repeat('4',64),repeat('5',64),"+
            "repeat('6',64),repeat('3',64),clock_timestamp()+interval "+literal(lifetime)+",NULL)")
        return 'SELECT paperclip_h.release('+','.join([
            literal(identifier(13)),literal(REQUEST_HASH),literal(INCARNATION),'1',
            literal(identifier(20)),literal(identifier(30)),literal('3'*64)])+')'

    def test_release_expiry_during_caller_delay_rolls_back_at_commit(self):
        call = self.prepare_release('1500 milliseconds')
        error = self.transaction(call + '; SELECT pg_sleep(1.7)', ok=False)
        self.assertIn('release facts stale at deferred transaction boundary', error)
        self.assertEqual(self.query('SELECT phase FROM paperclip_h.claims'), 'occupied')
        self.assertEqual(self.query('SELECT consumed_by IS NULL FROM paperclip_h.release_facts'), 't')
        self.assertEqual(self.query('SELECT count(*) FROM paperclip_h.operations'), '1')
        descriptor = dict(claim=identifier(20),run=identifier(30),factsHash='3'*64)
        self.assertEqual(self.query(self.inspect_call(13,20,'release',descriptor), EXECUTOR),
                         'prospective-uncertain')

    def test_early_constraint_flush_characterizes_remaining_commit_gap(self):
        # An actual attack characterization, NOT a protection/acceptance test.
        # SQL grants cannot deny SET CONSTRAINTS to the executor. After this
        # successful early flush there is no pending trigger to run at COMMIT.
        call = self.prepare_release('1500 milliseconds')
        self.transaction(call + '; SET CONSTRAINTS ALL IMMEDIATE; SELECT pg_sleep(1.7)')
        self.assertEqual(self.query('SELECT phase FROM paperclip_h.claims'), 'released')
        self.assertEqual(self.query('SELECT valid_until < clock_timestamp() FROM paperclip_h.release_facts'), 't')

    def test_prepared_transactions_are_disabled_and_cannot_retain_effect(self):
        self.assertEqual(self.query('SHOW max_prepared_transactions'), '0')
        self.retain()
        error = self.query('BEGIN ISOLATION LEVEL SERIALIZABLE;'+self.claim_call()+
                           "; PREPARE TRANSACTION 'paperclip-fixture-forbidden';", EXECUTOR, ok=False)
        self.assertIn('prepared transactions are disabled', error)
        self.assertEqual(self.query('SELECT count(*) FROM pg_prepared_xacts'), '0')
        self.assertEqual(self.query('SELECT count(*) FROM paperclip_h.claims'), '0')
        self.assertEqual(self.query(self.inspect_call(), EXECUTOR), 'prospective-uncertain')

    def test_transaction_rollback_does_not_create_journal_or_claim(self):
        self.retain()
        self.query('BEGIN ISOLATION LEVEL SERIALIZABLE;'+self.claim_call()+';SELECT 1/0;COMMIT;',
                   EXECUTOR, ok=False)
        self.assertEqual(self.query('SELECT count(*) FROM paperclip_h.claims'), '0')
        self.assertEqual(self.query(self.inspect_call(), EXECUTOR), 'prospective-uncertain')

    def test_generation_lock_serializes_native_deny_and_bounds_waiter(self):
        deny = self.retain_deny()
        self.retain()
        # Locker uses a deterministic pg_stat_activity barrier, not blind sleep.
        # Its brief pg_sleep keeps the owned lock while the test submits deny.
        process = subprocess.Popen(self.command(EXECUTOR), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        try:
            process.stdin.write("SET application_name='paperclip-fixture-locker';"
                "BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL statement_timeout='6s'; "
                "SET LOCAL idle_in_transaction_session_timeout='6s';"+self.claim_call()+";SELECT pg_sleep(3);COMMIT;")
            process.stdin.close()
            deadline = time.monotonic()+2
            observed = False
            while time.monotonic() < deadline:
                active = self.query("SELECT count(*) FROM pg_stat_activity WHERE "
                    "application_name='paperclip-fixture-locker' AND wait_event='PgSleep'", timeout=2)
                if active == '1':
                    observed = True
                    break
                time.sleep(.02)
            self.assertTrue(observed, 'fixture never reached bounded lock barrier')
            error = self.transaction(deny, ok=False)
            self.assertIn('lock timeout', error)
            self.assertEqual(self.query('SELECT count(*) FROM paperclip_h.operations'), '0')
            process.wait(timeout=6)
            self.assertEqual(process.returncode,0,process.stderr.read())
            self.assertEqual(self.query('SELECT count(*) FROM paperclip_h.claims'), '1')
            self.assertIn('native-denied-only', self.transaction(deny))
            self.assertEqual(self.query('SELECT count(*) FROM paperclip_h.operations'), '2')
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=2)
            for stream in (process.stdout,process.stderr):
                if stream:
                    stream.close()


if __name__ == '__main__':
    unittest.main()
