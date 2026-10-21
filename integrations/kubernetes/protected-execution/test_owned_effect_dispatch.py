import base64
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from production.gateway import Held
from production.owned_effect_dispatch import PipeEffectOwner
from production.route_policy import COMMAND_ROUTES

class PipeOwnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / 'owner.sqlite'
        self.reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        self.owner = PipeEffectOwner(self.db, writer)
    def tearDown(self):
        self.owner.close()
        os.close(self.reader)
        self.temp.cleanup()
    def read(self):
        return os.read(self.reader, 65536)
    def restart(self):
        self.owner.close()
        os.close(self.reader)
        self.reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        self.owner = PipeEffectOwner(self.db, writer)
    def test_all_routes_actual_exact_bytes_no_replay(self):
        for i, route in enumerate(sorted(COMMAND_ROUTES)):
            operation = f'op-{i}'
            self.assertEqual(self.owner.enqueue(operation, route, b'\x00exact\xff', generation=1)['status'], 'enqueued')
            frame = json.loads(self.read())
            self.assertEqual((frame['operation'], frame['route'], base64.b64decode(frame['payload'])), (operation, route, b'\x00exact\xff'))
            with self.assertRaises(Held): self.owner.enqueue(operation, route, b'\x00exact\xff', generation=1)
            with self.assertRaises(BlockingIOError): self.read()
    def test_pending_is_durable_before_actual_write(self):
        write = os.write
        def checked(fd, frame):
            db = sqlite3.connect(self.db)
            self.assertEqual(db.execute('SELECT status FROM intents').fetchone(), ('pending',))
            db.close()
            return write(fd, frame)
        with patch('production.owned_effect_dispatch.os.write', checked):
            self.owner.enqueue('a', 'command', b'bytes', generation=1)
    def test_lost_reply_after_effect_never_replays(self):
        write = os.write
        def lost(fd, frame):
            write(fd, frame)
            raise OSError('synthetic lost completion')
        with patch('production.owned_effect_dispatch.os.write', lost):
            with self.assertRaises(Held): self.owner.enqueue('a', 'command', b'bytes', generation=1)
        self.assertEqual(json.loads(self.read())['operation'], 'a')
        self.assertEqual(self.owner.inspect('a')['status'], 'pending')
        self.restart()
        with self.assertRaises(Held): self.owner.enqueue('a', 'command', b'bytes', generation=1)
        with self.assertRaises(Held): self.owner.enqueue('b', 'stop', b'bytes', generation=1)
        self.assertEqual(self.owner.inspect('a')['status'], 'pending')
        with self.assertRaises(BlockingIOError): self.read()
        self.owner.deny(generation=1)
    def test_deny_persistent_and_queued_bytes_not_retracted(self):
        self.owner.enqueue('a', 'command', b'old', generation=1)
        self.owner.deny(generation=1)
        self.assertEqual(base64.b64decode(json.loads(self.read())['payload']), b'old')
        self.restart()
        with self.assertRaises(Held): self.owner.enqueue('b', 'command', b'new', generation=1)
        self.assertIsNone(self.owner.inspect('b'))
    def test_stale_unknown_or_conflicting_intent_has_no_effect(self):
        for route, generation, payload in [('unknown', 1, b'x'), ('command', 0, b'x'), ('command', 2, b'x'), ('command', True, b'x'), ('command', 1, b'x'*1025)]:
            with self.assertRaises(Held): self.owner.enqueue('a', route, payload, generation=generation)
        self.assertIsNone(self.owner.inspect('a'))
        with self.assertRaises(BlockingIOError): self.read()
        self.owner.enqueue('a', 'command', b'one', generation=1)
        self.read()
        with self.assertRaises(Held): self.owner.enqueue('a', 'command', b'two', generation=1)
        with self.assertRaises(BlockingIOError): self.read()
    def test_retained_generation_change_cannot_reidentify_live_owner(self):
        prior = self.owner.enqueue('prior', 'command', b'exact', generation=1)
        self.read()
        before = self.owner._attempt.read_bytes()
        self.owner._db.execute('UPDATE state SET generation=2 WHERE id=1')
        for generation in (2, 1):
            with self.assertRaises(Held):
                self.owner.enqueue('new', 'command', b'forbidden', generation=generation)
        self.assertEqual(self.owner.inspect('prior'), prior)
        self.assertIsNone(self.owner.inspect('new'))
        self.assertEqual(self.owner._attempt.read_bytes(), before)
        with self.assertRaises(BlockingIOError): self.read()
        # A detected retained-identity inconsistency poisons this live owner;
        # changing the SQL field back is not an uncertainty-recovery mechanism.
        self.owner._db.execute('UPDATE state SET generation=1 WHERE id=1')
        with self.assertRaises(Held):
            self.owner.enqueue('later', 'command', b'forbidden', generation=1)

    def test_existing_special_or_aliased_denial_refuses_without_sql_or_target_mutation(self):
        prior = self.owner.enqueue('prior', 'command', b'exact', generation=1)
        self.read()
        target = Path(self.temp.name) / 'untouched'
        target.write_bytes(b'keep-exact')
        target.chmod(0o600)
        for kind in ('symlink', 'fifo', 'hardlink', 'nonprivate'):
            with self.subTest(kind=kind):
                marker = self.owner._denial
                if kind == 'symlink': marker.symlink_to(target)
                elif kind == 'fifo': os.mkfifo(marker, 0o600)
                elif kind == 'hardlink': os.link(target, marker)
                else:
                    marker.write_bytes(b'denied\n')
                    marker.chmod(0o644)
                actual = self.owner._db
                sql_calls = []
                class Observe:
                    def execute(inner, sql, args=()):
                        sql_calls.append(sql)
                        return actual.execute(sql, args)
                try:
                    with patch.object(self.owner, '_db', Observe()):
                        with self.assertRaises(Held): self.owner.deny(generation=1)
                    self.assertEqual(sql_calls, [])
                    self.assertEqual(target.read_bytes(), b'keep-exact')
                    self.assertEqual(self.owner.inspect('prior'), prior)
                    with self.assertRaises(Held):
                        self.owner.enqueue('fresh', 'command', b'forbidden', generation=1)
                    with self.assertRaises(BlockingIOError): self.read()
                finally:
                    # Fixture cleanup only; the production owner never clears a marker.
                    marker.unlink()

    def test_nonprivate_parent_refuses_before_creating_owner_state(self):
        parent = Path(self.temp.name) / 'shared'
        parent.mkdir(mode=0o755)
        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            with self.assertRaisesRegex(Held, 'private_state_parent_required'):
                PipeEffectOwner(parent / 'refused.sqlite', writer)
            self.assertEqual(list(parent.iterdir()), [])
            os.write(writer, b'caller-still-owns')
            self.assertEqual(os.read(reader, 64), b'caller-still-owns')
        finally:
            os.close(reader)
            os.close(writer)

    def test_failed_constructor_attempts_all_cleanup_and_preserves_setup_error(self):
        database = Path(self.temp.name) / 'failed.sqlite'
        actual_db = sqlite3.connect(database)
        database.chmod(0o600)
        acquired = []
        open_actual, fcntl_actual = os.open, fcntl.fcntl
        def opened(*args, **kwargs):
            fd = open_actual(*args, **kwargs)
            acquired.append(fd)
            return fd
        def duplicated(fd, command, *args):
            result = fcntl_actual(fd, command, *args)
            if command == fcntl.F_DUPFD_CLOEXEC:
                acquired.append(result)
            return result
        class FailedSetup:
            def execute(inner, sql, args=()): return actual_db.execute(sql, args)
            def executescript(inner, sql):
                raise sqlite3.OperationalError('original setup failure')
            def close(inner):
                actual_db.close()
                raise RuntimeError('later cleanup failure')
        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            with patch('production.owned_effect_dispatch.os.open', opened), patch('production.owned_effect_dispatch.fcntl.fcntl', duplicated), patch('production.owned_effect_dispatch.sqlite3.connect', return_value=FailedSetup()):
                with self.assertRaisesRegex(sqlite3.OperationalError, 'original setup failure'):
                    PipeEffectOwner(database, writer)
            self.assertEqual(len(acquired), 3)  # parent, lock, private pipe duplicate
            for fd in acquired:
                with self.assertRaises(OSError): os.fstat(fd)
            os.write(writer, b'caller-retained')
            self.assertEqual(os.read(reader, 64), b'caller-retained')
            reopened = PipeEffectOwner(database, writer)
            writer = None
            try:
                reopened.enqueue('new', 'command', b'after-failed-setup', generation=1)
                self.assertEqual(json.loads(os.read(reader, 4096))['operation'], 'new')
            finally:
                reopened.close()
        finally:
            actual_db.close()
            os.close(reader)
            if writer is not None: os.close(writer)

    def test_second_owner_refused(self):
        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            with self.assertRaises(BlockingIOError): PipeEffectOwner(self.db, writer)
        finally:
            os.close(reader)
            os.close(writer)
    def test_deny_and_write_are_serialized(self):
        entered, finish, denied = threading.Event(), threading.Event(), threading.Event()
        write, errors = os.write, []
        def blocked(fd, frame):
            entered.set()
            if not finish.wait(2): raise RuntimeError('test timed out')
            return write(fd, frame)
        def enqueue():
            try: self.owner.enqueue('a', 'command', b'pre-deny', generation=1)
            except BaseException as error: errors.append(error)
        def deny():
            try:
                self.owner.deny(generation=1)
                denied.set()
            except BaseException as error: errors.append(error)
        with patch('production.owned_effect_dispatch.os.write', blocked):
            first, second = threading.Thread(target=enqueue), threading.Thread(target=deny)
            first.start()
            self.assertTrue(entered.wait(2))
            second.start()
            self.assertFalse(denied.wait(.02))
            finish.set()
            first.join(2)
            second.join(2)
        self.assertEqual(errors, [])
        self.assertTrue(denied.is_set())
        self.assertEqual(json.loads(self.read())['operation'], 'a')
        with self.assertRaises(Held): self.owner.enqueue('b', 'command', b'post-deny', generation=1)
    def test_commit_reply_loss_on_intent_holds_before_any_pipe_write(self):
        original = self.owner._db
        class LostCommit:
            def execute(inner, sql, args=()):
                result = original.execute(sql, args)
                if sql.startswith('INSERT INTO intents'):
                    raise sqlite3.OperationalError('synthetic committed but reply lost')
                return result
            def close(inner): original.close()
        self.owner._db = LostCommit()
        with self.assertRaises(Held): self.owner.enqueue('a', 'command', b'x', generation=1)
        self.assertEqual(self.owner.inspect('a')['status'], 'pending')
        with self.assertRaises(Held): self.owner.enqueue('b', 'command', b'x', generation=1)
        with self.assertRaises(BlockingIOError): self.read()

    def test_completed_barrier_restart_keeps_exact_result_and_allows_fresh_effect(self):
        retained = self.owner.enqueue('first', 'command', b'exact', generation=1)
        first_frame = self.read()
        self.assertEqual(self.owner._attempt.read_bytes(), first_frame)
        self.restart()
        self.assertEqual(self.owner.inspect('first'), retained)
        self.owner.enqueue('next', 'command', b'next', generation=1)
        self.assertEqual(json.loads(self.read())['operation'], 'next')
        self.assertEqual(self.owner.inspect('first'), retained)

    def test_corrupt_barrier_holds_restart_without_losing_prior_inspection(self):
        retained = self.owner.enqueue('first', 'command', b'exact', generation=1)
        self.read()
        self.owner._attempt.write_bytes(b'{')
        self.restart()
        self.assertEqual(self.owner.inspect('first'), retained)
        with self.assertRaises(Held):
            self.owner.enqueue('next', 'command', b'next', generation=1)
        with self.assertRaises(BlockingIOError): self.read()

    def test_partial_preparation_holds_restart_even_with_prior_completed_marker(self):
        retained = self.owner.enqueue('first', 'command', b'exact', generation=1)
        self.read()
        self.owner._preparing.write_bytes(b'{')
        self.restart()
        self.assertEqual(self.owner.inspect('first'), retained)
        with self.assertRaises(Held):
            self.owner.enqueue('next', 'command', b'next', generation=1)
        with self.assertRaises(BlockingIOError): self.read()

    def test_failed_deny_persistence_holds_live_owner(self):
        original = self.owner._db
        class FailedDeny:
            def execute(inner, sql, args=()):
                if sql.startswith('UPDATE state SET denied'):
                    raise sqlite3.OperationalError('synthetic no persisted deny')
                return original.execute(sql, args)
            def close(inner): original.close()
        self.owner._db = FailedDeny()
        with self.assertRaises(Held): self.owner.deny(generation=1)
        with self.assertRaises(Held): self.owner.enqueue('a', 'command', b'x', generation=1)
        self.assertIsNone(self.owner.inspect('a'))
        with self.assertRaises(BlockingIOError): self.read()

    def test_intent_parent_sync_failure_prevents_pipe_effect_and_holds_restart(self):
        with patch('production.owned_effect_dispatch.os.fsync', side_effect=OSError('directory sync failed')):
            with self.assertRaises(Held): self.owner.enqueue('a', 'command', b'x', generation=1)
        self.assertEqual(self.owner.inspect('a')['status'], 'pending')
        with self.assertRaises(BlockingIOError): self.read()
        self.restart()
        with self.assertRaises(Held): self.owner.enqueue('b', 'command', b'x', generation=1)

    def test_deny_parent_sync_failure_holds_and_retains_deny(self):
        with patch('production.owned_effect_dispatch.os.fsync', side_effect=OSError('directory sync failed')):
            with self.assertRaises(Held): self.owner.deny(generation=1)
        with self.assertRaises(Held): self.owner.enqueue('a', 'command', b'x', generation=1)
        self.restart()
        with self.assertRaises(Held): self.owner.enqueue('b', 'command', b'x', generation=1)
        with self.assertRaises(BlockingIOError): self.read()

    def test_initial_parent_sync_failure_keeps_descriptor_with_caller(self):
        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            with patch('production.owned_effect_dispatch.os.fsync', side_effect=OSError('directory sync failed')):
                with self.assertRaises(OSError): PipeEffectOwner(Path(self.temp.name) / 'other.sqlite', writer)
            self.assertEqual(os.write(writer, b'caller-owned'), 12)
            self.assertEqual(os.read(reader, 32), b'caller-owned')
        finally:
            os.close(reader)
            os.close(writer)

    def test_transferred_original_reuse_cannot_redirect_effect_or_close(self):
        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        owner = PipeEffectOwner(Path(self.temp.name) / 'private.sqlite', writer)
        replacement_reader, replacement_writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        # The newly allocated reader may reuse the consumed caller number.
        if replacement_reader == writer:
            duplicate = os.dup(replacement_reader)
            os.close(replacement_reader)
            replacement_reader = duplicate
        os.dup2(replacement_writer, writer)
        try:
            self.assertFalse(os.get_inheritable(owner._fd))
            owner.enqueue('private', 'command', b'exact', generation=1)
            self.assertEqual(json.loads(os.read(reader, 65536))['operation'], 'private')
            with self.assertRaises(BlockingIOError): os.read(replacement_reader, 32)
            owner.deny(generation=1)
            with self.assertRaises(Held): owner.enqueue('denied', 'command', b'x', generation=1)
            owner.close()
            os.write(writer, b'caller-reused')
            self.assertEqual(os.read(replacement_reader, 32), b'caller-reused')
        finally:
            owner.close()
            for fd in {reader, writer, replacement_reader, replacement_writer}: os.close(fd)

    def test_failed_constructor_closes_private_duplicate_only(self):
        import fcntl
        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        duplicates = []
        original = fcntl.fcntl
        def tracked(fd, command, *args):
            result = original(fd, command, *args)
            if command == fcntl.F_DUPFD_CLOEXEC: duplicates.append(result)
            return result
        try:
            with patch('production.owned_effect_dispatch.fcntl.fcntl', tracked), patch('production.owned_effect_dispatch.os.fsync', side_effect=OSError('sync failed')):
                with self.assertRaises(OSError): PipeEffectOwner(Path(self.temp.name) / 'failed.sqlite', writer)
            self.assertEqual(len(duplicates), 1)
            with self.assertRaises(OSError): os.fstat(duplicates[0])
            os.write(writer, b'caller')
            self.assertEqual(os.read(reader, 32), b'caller')
        finally:
            os.close(reader)
            os.close(writer)

    def test_nonprivate_parent_refused(self):
        parent = Path(self.temp.name) / 'shared'
        parent.mkdir(mode=0o755)
        parent.chmod(0o755)
        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            with self.assertRaises(Held): PipeEffectOwner(parent / 'state.sqlite', writer)
            self.assertFalse((parent / 'state.sqlite').exists())
        finally:
            os.close(reader)
            os.close(writer)

    def test_broken_pipe_retains_pending(self):
        os.close(self.reader)
        self.reader = os.open('/dev/null', os.O_RDONLY)
        with self.assertRaises(Held): self.owner.enqueue('a', 'command', b'x', generation=1)
        self.assertEqual(self.owner.inspect('a')['status'], 'pending')

if __name__ == '__main__': unittest.main()
