"""Actual local stop pipe/journal failures; root alone schedules execution.

These tests exercise submission custody, never receiver termination or runtime T/B.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from production.gateway import Held
from production.owned_effect_dispatch import PipeEffectOwner
from production.retained_stop_dispatch import RetainedStopDispatch


class RetainedStopAdversarialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.binding = b'original-owner\x00old-epoch/exact-task'
        self.digest = hashlib.sha256(self.binding).hexdigest()
        self.reader, self.writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        self.stop = None

    def tearDown(self):
        if self.stop is not None:
            self.stop.close()
        os.close(self.reader)
        if self.writer is not None:
            os.close(self.writer)
        self.temp.cleanup()

    def start(self):
        self.stop = RetainedStopDispatch(self.base / 'stop.sqlite', self.writer,
                                         original_binding=self.binding)
        self.writer = None

    def test_full_stop_pipe_retains_unknown_intent_without_holding_independent_work(self):
        filled = 0
        chunk = b'x' * 4096
        while True:
            try:
                filled += os.write(self.writer, chunk)
            except BlockingIOError:
                break
        self.start()
        with self.assertRaises(Held):
            self.stop.request_stop('full-pipe', original_binding_digest=self.digest)
        self.assertEqual(self.stop.inspect('full-pipe', original_binding_digest=self.digest)['status'], 'pending')
        drained = bytearray()
        while True:
            try:
                drained.extend(os.read(self.reader, 65536))
            except BlockingIOError:
                break
        self.assertEqual(bytes(drained), b'x' * filled)
        # Available capacity after draining must not turn uncertainty into a retry.
        with self.assertRaises(Held):
            self.stop.request_stop('another-id', original_binding_digest=self.digest)
        with self.assertRaises(BlockingIOError):
            os.read(self.reader, 65536)
        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        work = PipeEffectOwner(self.base / 'work.sqlite', writer)
        try:
            result = work.enqueue('independent', 'command', b'exact-work', generation=1)
            self.assertEqual(result['status'], 'enqueued')
            self.assertEqual(json.loads(os.read(reader, 65536))['operation'], 'independent')
        finally:
            work.close()
            os.close(reader)

    def test_failed_prospective_stop_insert_has_no_bytes_and_holds_control(self):
        self.start()
        actual = self.stop._owner._db
        class FailedInsert:
            def execute(self, sql, parameters=()):
                if sql.startswith('INSERT INTO intents'):
                    raise sqlite3.OperationalError('prospective persistence unavailable')
                return actual.execute(sql, parameters)
        with patch.object(self.stop._owner, '_db', FailedInsert()):
            with self.assertRaises(Held):
                self.stop.request_stop('not-persisted', original_binding_digest=self.digest)
        self.assertEqual(self.stop.inspect('not-persisted', original_binding_digest=self.digest)['status'], 'pending')
        with self.assertRaises(Held):
            self.stop.request_stop('new-id', original_binding_digest=self.digest)
        with self.assertRaises(BlockingIOError):
            os.read(self.reader, 65536)

    def restart(self):
        self.stop.close()
        self.stop = None
        os.close(self.reader)
        self.reader, self.writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        self.start()

    def test_failed_prospective_insert_holds_after_restart_without_replaying(self):
        self.start()
        actual = self.stop._owner._db
        class FailedInsert:
            def execute(self, sql, parameters=()):
                if sql.startswith('INSERT INTO intents'):
                    raise sqlite3.OperationalError('insert failed before persistence')
                return actual.execute(sql, parameters)
        with patch.object(self.stop._owner, '_db', FailedInsert()):
            with self.assertRaises(Held):
                self.stop.request_stop('missing-intent', original_binding_digest=self.digest)
        self.restart()
        self.assertEqual(self.stop.inspect('missing-intent', original_binding_digest=self.digest)['status'], 'pending')
        for operation in ('missing-intent', 'fresh-after-restart'):
            with self.assertRaises(Held):
                self.stop.request_stop(operation, original_binding_digest=self.digest)
        with self.assertRaises(BlockingIOError):
            os.read(self.reader, 65536)

    def test_failed_deny_retains_prior_inspection_and_restart_hold(self):
        self.start()
        original = self.stop.request_stop('prior', original_binding_digest=self.digest)
        os.read(self.reader, 65536)
        actual = self.stop._owner._db
        class FailedDeny:
            def execute(self, sql, parameters=()):
                if sql.startswith('UPDATE state SET denied=1'):
                    raise sqlite3.OperationalError('deny failed before persistence')
                return actual.execute(sql, parameters)
        with patch.object(self.stop._owner, '_db', FailedDeny()):
            with self.assertRaises(Held):
                self.stop._owner.deny(generation=1)
        self.restart()
        self.assertEqual(self.stop.inspect('prior', original_binding_digest=self.digest), original)
        with self.assertRaises(Held):
            self.stop.request_stop('after-failed-deny', original_binding_digest=self.digest)
        with self.assertRaises(BlockingIOError):
            os.read(self.reader, 65536)

    def test_completion_persistence_failure_retains_actual_byte_and_pending_restart(self):
        self.start()
        actual = self.stop._owner._db
        class FailedCompletion:
            def execute(self, sql, parameters=()):
                if sql.startswith("UPDATE intents SET status='enqueued'"):
                    raise sqlite3.OperationalError('completion failed after pipe write')
                return actual.execute(sql, parameters)
        with patch.object(self.stop._owner, '_db', FailedCompletion()):
            with self.assertRaises(Held):
                self.stop.request_stop('written-unknown', original_binding_digest=self.digest)
        frame = json.loads(os.read(self.reader, 65536))
        self.assertEqual(frame['operation'], 'written-unknown')
        self.assertEqual(frame['route'], 'stop')
        self.restart()
        retained = self.stop.inspect('written-unknown', original_binding_digest=self.digest)
        self.assertEqual(retained['status'], 'pending')
        self.assertEqual(retained['generation'], 1)
        for operation in ('written-unknown', 'fresh-after-unknown'):
            with self.assertRaises(Held):
                self.stop.request_stop(operation, original_binding_digest=self.digest)
        with self.assertRaises(BlockingIOError):
            os.read(self.reader, 65536)

    def test_deny_generation_read_failure_preserves_inspection_and_durable_hold(self):
        self.start()
        retained = self.stop.request_stop('accepted-before-deny', original_binding_digest=self.digest)
        os.read(self.reader, 65536)
        actual = self.stop._owner._db
        class FailedGenerationRead:
            def execute(self, sql, parameters=()):
                if sql == 'SELECT generation FROM state WHERE id=1':
                    raise sqlite3.OperationalError('generation read temporarily unavailable')
                return actual.execute(sql, parameters)
        with patch.object(self.stop._owner, '_db', FailedGenerationRead()):
            with self.assertRaises(Held):
                self.stop._owner.deny(generation=1)
        self.assertEqual(self.stop.inspect('accepted-before-deny', original_binding_digest=self.digest), retained)
        with self.assertRaises(Held):
            self.stop.request_stop('after-deny-read-error', original_binding_digest=self.digest)
        with self.assertRaises(BlockingIOError):
            os.read(self.reader, 65536)
        self.restart()
        self.assertEqual(self.stop.inspect('accepted-before-deny', original_binding_digest=self.digest), retained)
        with self.assertRaises(Held):
            self.stop.request_stop('after-deny-read-error-restart', original_binding_digest=self.digest)
        with self.assertRaises(BlockingIOError):
            os.read(self.reader, 65536)

    def test_stale_or_malformed_deny_refuses_without_poisoning_original_control(self):
        self.start()
        for generation in (0, 2, True, None, '1'):
            with self.assertRaises(Held):
                self.stop._owner.deny(generation=generation)
        self.assertFalse(os.path.lexists(self.stop._owner._denial))
        retained = self.stop.request_stop('original-still-available', original_binding_digest=self.digest)
        self.assertEqual(json.loads(os.read(self.reader, 65536))['operation'], 'original-still-available')
        self.restart()
        self.assertEqual(self.stop.inspect('original-still-available', original_binding_digest=self.digest), retained)
        self.stop.request_stop('fresh-original-after-restart', original_binding_digest=self.digest)
        self.assertEqual(json.loads(os.read(self.reader, 65536))['operation'], 'fresh-original-after-restart')
        with self.assertRaises(BlockingIOError):
            os.read(self.reader, 65536)

    def test_failed_attempt_selection_preserves_preparation_and_prior_inspection(self):
        self.start()
        retained = self.stop.request_stop('accepted-before-preparation', original_binding_digest=self.digest)
        os.read(self.reader, 65536)
        with patch('production.owned_effect_dispatch.os.replace', side_effect=OSError('selection interrupted')):
            with self.assertRaises(Held):
                self.stop.request_stop('prepared-only', original_binding_digest=self.digest)
        self.assertEqual(self.stop.inspect('accepted-before-preparation', original_binding_digest=self.digest), retained)
        self.assertEqual(self.stop.inspect('prepared-only', original_binding_digest=self.digest)['status'], 'pending')
        with self.assertRaises(BlockingIOError):
            os.read(self.reader, 65536)
        self.restart()
        self.assertEqual(self.stop.inspect('accepted-before-preparation', original_binding_digest=self.digest), retained)
        self.assertEqual(self.stop.inspect('prepared-only', original_binding_digest=self.digest)['status'], 'pending')
        for operation in ('prepared-only', 'fresh-after-selection-error'):
            with self.assertRaises(Held):
                self.stop.request_stop(operation, original_binding_digest=self.digest)
        with self.assertRaises(BlockingIOError):
            os.read(self.reader, 65536)

    def _assert_corrupt_marker_refuses_identity_and_effects(self, suffix):
        canonical = b'{"generation":1,"operation":"invented","payload":"","route":"stop"}\n'
        oversized = json.dumps({'generation': 1, 'operation': 'invented',
                                'payload': base64.b64encode(b'x' * 1025).decode(),
                                'route': 'stop'}, sort_keys=True, separators=(',', ':')).encode() + b'\n'
        malformed = (
            canonical.replace(b'"operation":"invented"', b'"operation":"earlier","operation":"invented"'),
            b' ' + canonical,
            canonical.rstrip(b'\n'),
            canonical.replace(b'"payload":""', b'"payload":false'),
            canonical.replace(b'"payload":""', b'"payload":"!"'),
            canonical.replace(b'"payload":""', b'"payload":"eA==="'),
            canonical.replace(b'"generation":1', b'"generation":true'),
            canonical.replace(b'"route":"stop"', b'"route":[]'),
            oversized,
        )
        for frame in malformed:
            with self.subTest(suffix=suffix, frame=frame[:100]):
                with tempfile.TemporaryDirectory() as directory:
                    database = Path(directory) / 'stop.sqlite'
                    reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
                    control = None
                    try:
                        control = RetainedStopDispatch(database, writer, original_binding=self.binding)
                        writer = None
                        retained = control.request_stop('prior', original_binding_digest=self.digest)
                        os.read(reader, 65536)
                        control.close()
                        control = None
                        marker = Path(str(database) + suffix)
                        marker.write_bytes(frame)
                        marker.chmod(0o600)
                        os.close(reader)
                        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
                        control = RetainedStopDispatch(database, writer, original_binding=self.binding)
                        writer = None
                        self.assertEqual(control.inspect('prior', original_binding_digest=self.digest), retained)
                        # Corrupt bytes hold globally, but cannot invent exact pending identity.
                        self.assertIsNone(control.inspect('invented', original_binding_digest=self.digest))
                        self.assertIsNone(control.inspect('earlier', original_binding_digest=self.digest))
                        with self.assertRaises(Held):
                            control.request_stop('fresh', original_binding_digest=self.digest)
                        with self.assertRaises(BlockingIOError):
                            os.read(reader, 65536)
                    finally:
                        if control is not None:
                            control.close()
                        os.close(reader)
                        if writer is not None:
                            os.close(writer)

    def test_corrupt_selected_frames_hold_without_fabricating_pending_identity(self):
        self._assert_corrupt_marker_refuses_identity_and_effects('.attempt')

    def test_corrupt_preparing_frames_hold_without_fabricating_pending_identity(self):
        self._assert_corrupt_marker_refuses_identity_and_effects('.attempt.pending')

    def test_deny_retry_resyncs_existing_barrier_before_fallible_sql(self):
        self.start()
        retained = self.stop.request_stop('before-sync-failure', original_binding_digest=self.digest)
        os.read(self.reader, 65536)
        owner = self.stop._owner
        actual_db = owner._db
        actual_fsync = os.fsync
        events = []
        fail_marker_sync = True

        def sync(fd):
            info = os.fstat(fd)
            marker = owner._denial.stat() if owner._denial.exists() else None
            if marker is not None and (info.st_dev, info.st_ino) == (marker.st_dev, marker.st_ino):
                events.append('marker-sync')
                if fail_marker_sync:
                    raise OSError('denial inode sync unavailable')
            return actual_fsync(fd)

        class ObservedSql:
            def execute(self, sql, parameters=()):
                if sql == 'SELECT generation FROM state WHERE id=1':
                    events.append('generation-read')
                if sql.startswith('UPDATE state SET denied=1'):
                    events.append('deny-update')
                return actual_db.execute(sql, parameters)

        with patch('production.owned_effect_dispatch.os.fsync', side_effect=sync), patch.object(owner, '_db', ObservedSql()):
            # First creation leaves an inode but no successful durability barrier.
            # Retrying must not treat its mere existence as completed fsync.
            for attempt in range(2):
                with self.subTest(attempt=attempt):
                    with self.assertRaises(Held):
                        owner.deny(generation=1)
                    self.assertEqual(events, ['marker-sync'] * (attempt + 1))
                    self.assertEqual(actual_db.execute('SELECT denied FROM state WHERE id=1').fetchone(), (0,))
                    self.assertEqual(self.stop.inspect('before-sync-failure', original_binding_digest=self.digest), retained)
                    with self.assertRaises(Held):
                        self.stop.request_stop('after-sync-failure', original_binding_digest=self.digest)
            fail_marker_sync = False
            events.clear()
            owner.deny(generation=1)
            self.assertEqual(events, ['marker-sync', 'generation-read', 'deny-update'])
        self.restart()
        self.assertEqual(self.stop.inspect('before-sync-failure', original_binding_digest=self.digest), retained)
        with self.assertRaises(Held):
            self.stop.request_stop('after-synced-deny', original_binding_digest=self.digest)
        with self.assertRaises(BlockingIOError):
            os.read(self.reader, 65536)

    def test_close_sqlite_error_still_releases_owned_descriptors_and_lock(self):
        self.start()
        retained = self.stop.request_stop('before-close-error', original_binding_digest=self.digest)
        os.read(self.reader, 65536)
        owner = self.stop._owner
        actual_db = owner._db
        descriptors = (owner._fd, owner._parentfd, owner._lockfd)
        close_calls = []

        class FailedClose:
            def close(self):
                close_calls.append('sqlite-close')
                actual_db.close()
                raise sqlite3.OperationalError('connection close reported failure')

        try:
            with patch.object(owner, '_db', FailedClose()):
                with self.assertRaises(sqlite3.OperationalError):
                    self.stop.close()
                # Idempotent repeated close must not retry an ambiguous descriptor
                # number or skip remaining independent cleanup from the first call.
                self.stop.close()
            self.assertEqual(close_calls, ['sqlite-close'])
            for descriptor in descriptors:
                with self.assertRaises(OSError):
                    os.fstat(descriptor)
        finally:
            # Clean up the deliberately failing old implementation on assertion
            # failure, before any descriptor numbers can be reused by this test.
            for descriptor in descriptors:
                try:
                    os.fstat(descriptor)
                except OSError:
                    continue
                os.close(descriptor)
        self.restart()
        self.assertEqual(self.stop.inspect('before-close-error', original_binding_digest=self.digest), retained)
        with self.assertRaises(Held):
            self.stop.request_stop('before-close-error', original_binding_digest=self.digest)
        self.stop.request_stop('after-clean-close', original_binding_digest=self.digest)
        self.assertEqual(json.loads(os.read(self.reader, 65536))['operation'], 'after-clean-close')
        with self.assertRaises(BlockingIOError):
            os.read(self.reader, 65536)

    def test_denied_control_restarts_with_exact_inspection_and_no_new_submission(self):
        self.start()
        original = self.stop.request_stop('retained', original_binding_digest=self.digest)
        os.read(self.reader, 65536)
        self.stop._owner.deny(generation=1)
        self.stop.close()
        self.stop = None
        os.close(self.reader)
        self.reader, self.writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        self.start()
        self.assertEqual(self.stop.inspect('retained', original_binding_digest=self.digest), original)
        with self.assertRaises(Held):
            self.stop.inspect('retained', original_binding_digest=hashlib.sha256(b'replacement').hexdigest())
        for operation in ('retained', 'fresh-id'):
            with self.assertRaises(Held):
                self.stop.request_stop(operation, original_binding_digest=self.digest)
        with self.assertRaises(BlockingIOError):
            os.read(self.reader, 65536)


if __name__ == '__main__':
    unittest.main()
