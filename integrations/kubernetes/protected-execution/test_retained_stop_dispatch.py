import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from production.gateway import Held
from production.owned_effect_dispatch import PipeEffectOwner
from production.retained_stop_dispatch import RetainedStopDispatch


class RetainedStopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.binding = b'original\x00owner:epoch-old/task-immutable'
        self.digest = hashlib.sha256(self.binding).hexdigest()
        self.reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        self.stop = RetainedStopDispatch(self.root / 'stop.sqlite', writer,
                                         original_binding=self.binding)

    def tearDown(self):
        self.stop.close()
        os.close(self.reader)
        self.temp.cleanup()

    def test_held_and_denied_new_work_does_not_disable_original_control(self):
        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        work = PipeEffectOwner(self.root / 'work.sqlite', writer)
        try:
            with patch('production.owned_effect_dispatch.os.write', side_effect=OSError('lost')):
                with self.assertRaises(Held):
                    work.enqueue('uncertain', 'command', b'work', generation=1)
            work.deny(generation=1)
            with self.assertRaises(Held):
                work.enqueue('stop-through-denied-work', 'stop', b'x', generation=1)
            result = self.stop.request_stop('stop-original', original_binding_digest=self.digest)
            self.assertEqual(result['status'], 'enqueued')
            frame = json.loads(os.read(self.reader, 65536))
            payload = json.loads(base64.b64decode(frame['payload']))
            self.assertEqual(frame['route'], 'stop')
            self.assertEqual(payload, {'version': 1, 'action': 'stop-exact-original',
                                      'originalBinding': base64.b64encode(self.binding).decode(),
                                      'originalBindingDigest': self.digest})
            self.assertEqual(work.inspect('uncertain')['status'], 'pending')
            with self.assertRaises(BlockingIOError): os.read(reader, 65536)
        finally:
            work.close()
            os.close(reader)

    def test_wrong_original_refuses_without_creating_intent_or_bytes(self):
        for digest in ('0' * 64, None, True, self.digest.upper()):
            with self.assertRaises(Held):
                self.stop.request_stop('wrong', original_binding_digest=digest)
            with self.assertRaises(Held):
                self.stop.inspect('wrong', original_binding_digest=digest)
        self.assertIsNone(self.stop.inspect('wrong', original_binding_digest=self.digest))
        with self.assertRaises(BlockingIOError): os.read(self.reader, 65536)

    def test_uncertain_stop_inspects_without_replay_or_replacement(self):
        write = os.write
        def lost(fd, frame):
            write(fd, frame)
            raise OSError('written but completion lost')
        with patch('production.owned_effect_dispatch.os.write', lost):
            with self.assertRaises(Held):
                self.stop.request_stop('original', original_binding_digest=self.digest)
        self.assertEqual(json.loads(os.read(self.reader, 65536))['operation'], 'original')
        self.stop.close()
        os.close(self.reader)
        self.reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        self.stop = RetainedStopDispatch(self.root / 'stop.sqlite', writer,
                                         original_binding=self.binding)
        self.assertEqual(self.stop.inspect('original', original_binding_digest=self.digest)['status'], 'pending')
        for operation in ('original', 'new-id'):
            with self.assertRaises(Held):
                self.stop.request_stop(operation, original_binding_digest=self.digest)
        with self.assertRaises(BlockingIOError): os.read(self.reader, 65536)

    def test_exact_completed_submission_cannot_be_replayed(self):
        self.stop.request_stop('once', original_binding_digest=self.digest)
        os.read(self.reader, 65536)
        with self.assertRaises(Held):
            self.stop.request_stop('once', original_binding_digest=self.digest)
        self.assertEqual(self.stop.inspect('once', original_binding_digest=self.digest)['status'], 'enqueued')
        with self.assertRaises(BlockingIOError): os.read(self.reader, 65536)

    def test_bad_binding_refuses_before_taking_descriptor_custody(self):
        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            for binding in (b'', b'x' * 513, 'owner', bytearray(b'owner')):
                with self.assertRaises(Held):
                    RetainedStopDispatch(self.root / 'bad.sqlite', writer, original_binding=binding)
                os.fstat(writer)
            self.assertFalse((self.root / 'bad.sqlite').exists())
        finally:
            os.close(reader)
            os.close(writer)

    def test_reopen_cannot_retarget_or_drop_persistent_original_binding(self):
        self.stop.close()
        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            with self.assertRaises(Held):
                RetainedStopDispatch(self.root / 'stop.sqlite', writer,
                                     original_binding=b'replacement')
            os.fstat(writer)
            with self.assertRaises(Held):
                PipeEffectOwner(self.root / 'stop.sqlite', writer)
            os.fstat(writer)
            with self.assertRaises(BlockingIOError): os.read(reader, 65536)
        finally:
            os.close(reader)
            os.close(writer)

    def test_existing_generic_work_history_cannot_be_adopted_as_control(self):
        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        work = PipeEffectOwner(self.root / 'generic.sqlite', writer)
        work.close()
        reader2, writer2 = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            with self.assertRaises(Held):
                RetainedStopDispatch(self.root / 'generic.sqlite', writer2,
                                     original_binding=self.binding)
            os.fstat(writer2)
        finally:
            for fd in (reader, reader2, writer2): os.close(fd)

    def test_legacy_unbound_database_cannot_be_promoted(self):
        import sqlite3
        path = self.root / 'legacy.sqlite'
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE state (id INTEGER PRIMARY KEY, generation INTEGER, denied INTEGER)')
            db.execute('INSERT INTO state VALUES (1, 1, 0)')
        path.chmod(0o600)
        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            with self.assertRaises(Held):
                RetainedStopDispatch(path, writer, original_binding=self.binding)
            os.fstat(writer)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('SELECT * FROM custody').fetchall(), [])
            with self.assertRaises(BlockingIOError): os.read(reader, 65536)
        finally:
            os.close(reader)
            os.close(writer)

    def test_maximum_original_binding_still_enqueues_bounded_exact_frame(self):
        reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        binding = bytes(range(256)) * 2
        owner = RetainedStopDispatch(self.root / 'maximum.sqlite', writer,
                                     original_binding=binding)
        try:
            owner.request_stop('maximum', original_binding_digest=hashlib.sha256(binding).hexdigest())
            frame = json.loads(os.read(reader, 65536))
            payload = base64.b64decode(frame['payload'])
            self.assertLessEqual(len(payload), 1024)
            self.assertEqual(base64.b64decode(json.loads(payload)['originalBinding']), binding)
        finally:
            owner.close()
            os.close(reader)
