"""Synthetic reference backends only. No physical or operational acceptance."""
import hashlib
import threading
import time
import unittest
from dataclasses import replace
from production.gateway import Held
from production.write_authority import (
    AtomicWriteBackend, OrderedWriteAuthority, WriteIntent, WriteResult,
    RootGroupBackend, RootGroupIntent, activate_root_group,
)

H = 'a' * 64
DATA = b'exact bytes\x00\xff'


def intent():
    return WriteIntent('operation-1', H, H, 0, hashlib.sha256(DATA).hexdigest(), 1, 1, 1, 1, len(DATA))


def deadline():
    return time.monotonic() + 3


class SyntheticAtomic(AtomicWriteBackend):
    def __init__(self):
        self.lock = threading.Lock()
        self.revoked = False
        self.results = {}
        self.attempted = set()
        self.output = b''
        self.order = 0
        self.lose_reply = False

    def commit_write(self, request, data, limit):
        with self.lock:
            if self.revoked or request.operation in self.attempted:
                raise Held('revoked_or_attempted')
            self.attempted.add(request.operation)
            if any(v != 1 for v in (request.native_revision, request.runtime_revision,
                                   request.storage_revision, request.decision_revision)):
                raise Held('stale')
            if request.sequence != len(self.results):
                raise Held('sequence')
            self.order += 1
            self.output += data
            result = WriteResult(request, len(data), self.order)
            self.results[request.operation] = result
            if self.lose_reply:
                raise OSError('lost')
            return result

    def revoke(self, binding_hash, expected_revision, limit):
        with self.lock:
            if binding_hash != H or expected_revision != 1:
                raise Held('wrong_revoke')
            self.revoked = True
            self.order += 1
            return self.order

    def inspect_write(self, request, limit):
        result = self.results.get(request.operation)
        if result is not None and result.intent != request:
            raise Held('conflicting_inspection')
        return result


class SyntheticGroup(RootGroupBackend):
    def __init__(self, heads):
        self.heads = heads
        self.pinned = None
        self.activated = False
        self.lose_reply = False

    def pin_intent(self, request, limit):
        if self.pinned is not None or request.history_revision != 1:
            raise Held('intent_consumed_or_ahead')
        self.pinned = request
        return request

    def activate_exact(self, request, limit):
        if self.pinned != request or self.heads != request.expected_heads or self.activated:
            raise Held('cas')
        self.heads = request.proposed_heads
        self.activated = True
        if self.lose_reply:
            raise Held('lost_completion')
        return request

    def inspect_intent(self, request, limit):
        return (self.pinned == request, self.heads)


class WriteAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.backend = SyntheticAtomic()
        self.authority = OrderedWriteAuthority(self.backend)

    def test_exact_effect(self):
        result = self.authority.commit_write(intent(), DATA, deadline())
        self.assertEqual(result.accepted, len(DATA))
        self.assertEqual(self.backend.output, DATA)

    def test_revoke_before_effect(self):
        self.backend.revoke(H, 1, deadline())
        with self.assertRaises(Held):
            self.authority.commit_write(intent(), DATA, deadline())
        self.assertEqual(self.backend.output, b'')

    def test_effect_before_revoke_is_charged(self):
        result = self.authority.commit_write(intent(), DATA, deadline())
        order = self.backend.revoke(H, 1, deadline())
        self.assertLess(result.order, order)
        self.assertEqual(self.authority.inspect_write(intent(), deadline()), result)

    def test_lost_reply_inspect_never_replays(self):
        self.backend.lose_reply = True
        with self.assertRaises(Held):
            self.authority.commit_write(intent(), DATA, deadline())
        self.assertEqual(self.authority.inspect_write(intent(), deadline()).accepted, len(DATA))
        for owner in (self.authority, OrderedWriteAuthority(self.backend)):
            with self.assertRaises(Held):
                owner.commit_write(intent(), DATA, deadline())
        self.assertEqual(self.backend.output, DATA)

    def test_each_revision_is_current(self):
        for field in ('native_revision', 'runtime_revision', 'storage_revision', 'decision_revision'):
            with self.subTest(field=field), self.assertRaises(Held):
                OrderedWriteAuthority(SyntheticAtomic()).commit_write(replace(intent(), **{field: 2}), DATA, deadline())

    def test_bad_bytes_and_sequence(self):
        with self.assertRaises(Held):
            self.authority.commit_write(intent(), b'other', deadline())
        with self.assertRaises(Held):
            self.authority.commit_write(replace(intent(), sequence=1), DATA, deadline())
        self.assertEqual(self.backend.output, b'')

    def test_partial_result_is_uncertain(self):
        self.backend.commit_write = lambda req, data, limit: WriteResult(req, 1, 1)
        with self.assertRaises(Held):
            self.authority.commit_write(intent(), DATA, deadline())
        with self.assertRaises(Held):
            self.authority.commit_write(intent(), DATA, deadline())

    def test_invalid_deadlines(self):
        for limit in (float('nan'), float('inf'), True, time.monotonic() - 1):
            with self.subTest(limit=limit), self.assertRaises(Held):
                self.authority.commit_write(intent(), DATA, limit)

    def test_missing_backend_refuses(self):
        with self.assertRaises(Held):
            OrderedWriteAuthority(object())

    def group(self):
        return RootGroupIntent('group-1', H, H, H,
                               (('parent', 1, H), ('projection', 2, H)),
                               (('parent', 2, H), ('projection', 3, H)), 1)

    def test_complete_group_pin_before_activation(self):
        request = self.group()
        backend = SyntheticGroup(request.expected_heads)
        self.assertEqual(activate_root_group(backend, request, deadline()), request)
        self.assertEqual(backend.pinned, request)
        self.assertEqual(backend.heads, request.proposed_heads)

    def test_root_group_missing_child_refused(self):
        request = replace(self.group(), proposed_heads=(('parent', 2, H),))
        with self.assertRaises(Held):
            activate_root_group(SyntheticGroup(request.expected_heads), request, deadline())

    def test_cas_conflict_retains_prospective_pin(self):
        request = self.group()
        backend = SyntheticGroup((('parent', 3, H), ('projection', 4, H)))
        with self.assertRaises(Held):
            activate_root_group(backend, request, deadline())
        self.assertEqual(backend.pinned, request)
        self.assertFalse(backend.activated)

    def test_lost_activation_completion_inspect_only(self):
        request = self.group()
        backend = SyntheticGroup(request.expected_heads)
        backend.lose_reply = True
        with self.assertRaises(Held):
            activate_root_group(backend, request, deadline())
        self.assertEqual(backend.inspect_intent(request, deadline()), (True, request.proposed_heads))
        with self.assertRaises(Held):
            activate_root_group(backend, request, deadline())

    def test_generation_rollback_refused(self):
        request = replace(self.group(), proposed_heads=self.group().expected_heads)
        with self.assertRaises(Held):
            activate_root_group(SyntheticGroup(request.expected_heads), request, deadline())


if __name__ == '__main__':
    unittest.main()
