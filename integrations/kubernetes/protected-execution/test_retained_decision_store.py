"""Disposable SQLite durability/CAS only; no operational custody or native effects."""
import copy
import os
import tempfile
import unittest

from legacy_review import ReviewHeld, digest
from production.decision_history import build_intent_request
from production.retained_decision_store import RetainedDecisionStore
import test_decision_history


class RetainedDecisionStoreTests(unittest.TestCase):
    def setUp(self):
        fixture = test_decision_history.DecisionHistoryTests()
        fixture.setUp()
        self.pins, self.hold, self.now = fixture.pins, fixture.holds[0], fixture.now
        self.directory = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.directory.name, 'retained.sqlite')
        self.store = RetainedDecisionStore.provision(self.path, pins=self.pins, holds=[self.hold])
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(lambda: self.store.close())

    def request(self, sequence=1, previous=None, action='reconcile'):
        return build_intent_request(pins=self.pins, hold=self.hold, sequence=sequence,
            previous_hash=previous, decision_hash=digest(['decision', sequence, action]),
            inventory_hash=digest('inventory'), approval_hash=digest('approval'),
            action=action, challenge=digest('challenge'), now=self.now)

    def test_interrupted_transaction_rolls_back_actual_sql_and_preserves_error(self):
        class Interrupted(BaseException):
            pass

        for rollback_failure in ('', 'before', 'after'):
            with self.subTest(rollback_failure=rollback_failure):
                database = self.store.db
                original = Interrupted('transaction interrupted')

                class RollbackConnection:
                    def __init__(self):
                        self.rollbacks = 0

                    def execute(self, *args):
                        return database.execute(*args)

                    def rollback(self):
                        self.rollbacks += 1
                        if rollback_failure == 'before':
                            raise RuntimeError('rollback failed before completion')
                        database.rollback()
                        if rollback_failure == 'after':
                            raise RuntimeError('rollback acknowledgement lost')

                    def close(self):
                        database.close()

                connection = RollbackConnection()
                self.store.db = connection
                try:
                    with self.assertRaises(Interrupted) as caught:
                        with self.store._transaction():
                            connection.execute('UPDATE metadata SET revision=revision+1 WHERE id=1')
                            raise original
                    self.assertIs(caught.exception, original)
                    self.assertEqual(connection.rollbacks, 1)
                    if rollback_failure:
                        self.assertIsNone(self.store.db)
                        with self.assertRaisesRegex(ReviewHeld, 'closed_or_uncertain'):
                            self.store.prepare(self.request(), expected_revision=8)
                    else:
                        self.assertFalse(database.in_transaction)
                        self.assertEqual(database.execute('SELECT revision FROM metadata WHERE id=1').fetchone(), (8,))
                finally:
                    if rollback_failure:
                        self.store = RetainedDecisionStore(self.path, pins=self.pins)
                        self.assertEqual(self.store.db.execute('SELECT revision FROM metadata WHERE id=1').fetchone(), (8,))
                    else:
                        self.store.db = database

    def test_reopen_retains_uncertainty_and_exact_retry(self):
        request = self.request()
        first = self.store.prepare(request, expected_revision=8)
        self.assertEqual(first['status'], 'prospective-uncertain')
        self.assertFalse(first['current'])
        self.store.close()
        self.store = RetainedDecisionStore(self.path, pins=self.pins)
        self.assertEqual(first, self.store.inspect(request['intentHash']))
        self.assertEqual(first, self.store.prepare(request, expected_revision=9))
        with self.assertRaises(ReviewHeld):
            self.store.prepare(self.request(2, request['intent']['decisionHash'], 'revoke'), expected_revision=9)

    def test_revision_cas_and_competing_connection(self):
        other = RetainedDecisionStore(self.path, pins=self.pins)
        self.addCleanup(other.close)
        self.store.prepare(self.request(), expected_revision=8)
        with self.assertRaisesRegex(ReviewHeld, 'revision_cas'):
            other.prepare(self.request(), expected_revision=8)

    def test_committed_revoke_supersedes_old_history_without_permit(self):
        first = self.request()
        self.store.prepare(first, expected_revision=8)
        committed = self.store.record_committed(first['intentHash'], expected_revision=9)
        self.assertTrue(committed['current'])
        revoke = self.request(2, first['intent']['decisionHash'], 'revoke')
        self.store.prepare(revoke, expected_revision=10)
        self.assertFalse(self.store.inspect(first['intentHash'])['current'])
        result = self.store.record_committed(revoke['intentHash'], expected_revision=11)
        self.assertEqual(result['intent']['action'], 'revoke')
        self.assertEqual(result['status'], 'committed-exact')
        self.assertNotIn('authorized', result)
        self.assertNotIn('revoked-settled', result.values())
        self.assertEqual(result, self.store.record_committed(revoke['intentHash'], expected_revision=12))

    def test_unknown_never_permits_retry_or_implicit_creation(self):
        with self.assertRaises(ReviewHeld):
            self.store.inspect(digest('unknown'))
        with self.assertRaises(Exception):
            RetainedDecisionStore(os.path.join(self.directory.name, 'absent'), pins=self.pins)
        with self.assertRaises(FileExistsError):
            RetainedDecisionStore.provision(self.path, pins=self.pins, holds=[self.hold])

    def test_exact_original_inventory_and_predecessor_required(self):
        request = self.request()
        changed = copy.deepcopy(self.hold)
        changed['scopes'].append('new-family')
        request['intent']['hold'] = changed
        request['intentHash'] = digest(request['intent'])
        with self.assertRaises(ReviewHeld):
            self.store.prepare(request, expected_revision=8)
        with self.assertRaises(ReviewHeld):
            self.store.prepare(self.request(2, digest('missing')), expected_revision=8)
        self.assertEqual(self.store.prepare(self.request(), expected_revision=8)['historyRevision'], 9)

    def test_symlink_and_hardlink_refuse(self):
        alias = os.path.join(self.directory.name, 'alias')
        os.symlink(self.path, alias)
        with self.assertRaises(ReviewHeld):
            RetainedDecisionStore(alias, pins=self.pins)
        os.unlink(alias)
        os.link(self.path, alias)
        with self.assertRaises(ReviewHeld):
            RetainedDecisionStore(self.path, pins=self.pins)

    def test_permissive_file_refuses(self):
        os.chmod(self.path, 0o640)
        with self.assertRaises(ReviewHeld):
            RetainedDecisionStore(self.path, pins=self.pins)

    def test_replacement_during_sqlite_open_refuses(self):
        from unittest.mock import patch
        import sqlite3
        connect = sqlite3.connect
        def replace_then_connect(*args, **kwargs):
            # Simulate replacement between checked descriptor and SQLite open.
            os.rename(self.path, self.path + '.original')
            with open(self.path, 'wb'):
                pass
            os.chmod(self.path, 0o600)
            return connect(*args, **kwargs)
        with patch('production.retained_decision_store.sqlite3.connect', side_effect=replace_then_connect):
            with self.assertRaisesRegex(ReviewHeld, 'file_replaced'):
                RetainedDecisionStore(self.path, pins=self.pins)

    def test_non_dictionary_request_is_held(self):
        for request in (None, [], 'request'):
            with self.assertRaises(ReviewHeld):
                self.store.prepare(request, expected_revision=8)

    def test_wrong_pins_fail_reopen(self):
        for changes in ({'historyIncarnation':'restored'}, {'historyFloor':9}):
            with self.assertRaises(ReviewHeld):
                RetainedDecisionStore(self.path, pins={**self.pins, **changes})

    def test_failed_setup_closes_real_sqlite_and_preserves_original_failure(self):
        from unittest.mock import patch
        import sqlite3

        class SetupInterrupted(BaseException):
            pass

        connect = sqlite3.connect
        for phase in ('PRAGMA synchronous=FULL', 'SELECT pins,revision FROM metadata WHERE id=1'):
            for close_fails in (False, True):
                with self.subTest(phase=phase, close_fails=close_fails):
                    original = SetupInterrupted(phase)
                    opened = []

                    class FailingSetupConnection:
                        def __init__(self, connection):
                            self.connection = connection
                            self.close_calls = 0

                        def execute(self, statement, *args):
                            if statement == phase:
                                raise original
                            return self.connection.execute(statement, *args)

                        def close(self):
                            self.close_calls += 1
                            self.connection.close()
                            if close_fails:
                                raise RuntimeError('close acknowledgement lost')

                    def open_actual(*args, **kwargs):
                        connection = FailingSetupConnection(connect(*args, **kwargs))
                        opened.append(connection)
                        return connection

                    with patch('production.retained_decision_store.sqlite3.connect', side_effect=open_actual):
                        with self.assertRaises(SetupInterrupted) as caught:
                            RetainedDecisionStore(self.path, pins=self.pins)
                    self.assertIs(caught.exception, original)
                    self.assertEqual(len(opened), 1)
                    self.assertEqual(opened[0].close_calls, 1)
                    with self.assertRaises(sqlite3.ProgrammingError):
                        opened[0].connection.execute('SELECT 1')
                    # The failed constructor did not change retained history or
                    # create an operational receipt; real recovery still opens.
                    recovered = RetainedDecisionStore(self.path, pins=self.pins)
                    recovered.close()

    def test_open_identity_failure_preserves_error_when_cleanup_fails(self):
        from unittest.mock import patch
        import sqlite3

        connect = sqlite3.connect
        opened = []

        class LostClose:
            def __init__(self, connection):
                self.connection = connection
                self.close_calls = 0

            def close(self):
                self.close_calls += 1
                self.connection.close()
                raise RuntimeError('close acknowledgement lost')

        def replace_and_open(*args, **kwargs):
            os.rename(self.path, self.path + '.original')
            with open(self.path, 'wb'):
                pass
            os.chmod(self.path, 0o600)
            connection = LostClose(connect(*args, **kwargs))
            opened.append(connection)
            return connection

        with patch('production.retained_decision_store.sqlite3.connect', side_effect=replace_and_open):
            with self.assertRaisesRegex(ReviewHeld, 'file_replaced'):
                RetainedDecisionStore(self.path, pins=self.pins)
        self.assertEqual(opened[0].close_calls, 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            opened[0].connection.execute('SELECT 1')

    def test_checked_and_provision_descriptor_close_failure_closes_actual_database(self):
        from unittest.mock import patch
        import sqlite3
        real_open, real_close, connect = os.open, os.close, sqlite3.connect
        for provision in (False, True):
            for corrupt_after_connect in (False, True):
                with self.subTest(provision=provision, corrupt_after_connect=corrupt_after_connect):
                    target = self.path + '-new' if provision else self.path
                    if provision and os.path.exists(target):
                        os.unlink(target)
                    descriptors, connections, closes = [], [], []
                    original = OSError('descriptor close acknowledgement lost')

                    def track_open(path, flags, *args, **kwargs):
                        descriptor = real_open(path, flags, *args, **kwargs)
                        selected_access = os.O_WRONLY if provision else os.O_RDONLY
                        if path == target and flags & os.O_ACCMODE == selected_access:
                            descriptors.append(descriptor)
                        return descriptor

                    def lose_close(descriptor):
                        if descriptor in descriptors:
                            closes.append(descriptor)
                            real_close(descriptor)
                            raise original
                        return real_close(descriptor)

                    def track_connect(*args, **kwargs):
                        database = connect(*args, **kwargs)
                        connections.append(database)
                        if corrupt_after_connect:
                            os.chmod(target, 0o640)
                        return database

                    with patch('production.retained_decision_store.os.open', side_effect=track_open), \
                         patch('production.retained_decision_store.os.close', side_effect=lose_close), \
                         patch('production.retained_decision_store.sqlite3.connect', side_effect=track_connect):
                        expected = ReviewHeld if corrupt_after_connect else OSError
                        with self.assertRaises(expected) as caught:
                            if provision:
                                RetainedDecisionStore.provision(target, pins=self.pins, holds=[self.hold])
                            else:
                                RetainedDecisionStore(target, pins=self.pins)
                    if not corrupt_after_connect:
                        self.assertIs(caught.exception, original)
                    self.assertEqual(len(descriptors), 1)
                    self.assertEqual(closes, descriptors)  # No ambiguous FD retry.
                    self.assertEqual(len(connections), 1)
                    with self.assertRaises(sqlite3.ProgrammingError):
                        connections[0].execute('SELECT 1')
                    os.chmod(target, 0o600)


if __name__ == '__main__':
    unittest.main()
