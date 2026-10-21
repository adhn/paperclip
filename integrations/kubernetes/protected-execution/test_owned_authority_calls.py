"""Disposable local ownership checks, never backend/physical acceptance."""
import hashlib
import threading
import time
import unittest

from production.gateway import Held
from production.owned_authority_calls import (OwnedRootGroupBackend, OwnedDecisionAuthority,
    OwnedAtomicWriteBackend, OwnedOrderedDecisionUse, AuthorityWorkerHandler)
from production.write_authority import RootGroupIntent, AtomicWriteBackend, WriteIntent, WriteResult


class Root:
    def pin_intent(self, intent, deadline):
        return intent
    activate_exact = pin_intent
    inspect_intent = pin_intent


class BlockingRoot(Root):
    def pin_intent(self, intent, deadline):
        time.sleep(20)


class DelayedRoot(Root):
    def pin_intent(self, intent, deadline):
        time.sleep(0.3)
        return intent


class Decision:
    def execute(self, request, *, deadline_at):
        return {"request": request, "deadline": deadline_at}
    revoke = execute
    inspect = execute


class BlockingDecision(Decision):
    def execute(self, request, *, deadline_at):
        time.sleep(20)


class Write(AtomicWriteBackend):
    def __init__(self):
        self.count = 0
    def commit_write(self, intent, data, deadline):
        self.count += 1
        return WriteResult(intent, len(data), self.count)
    def inspect_write(self, intent, deadline):
        return WriteResult(intent, intent.byte_count, self.count)
    def revoke(self, binding_hash, expected_revision, deadline):
        return dict(binding_hash=binding_hash, expected_revision=expected_revision)


class BlockingVerifier:
    def verify(self, *args):
        time.sleep(20)


def blocked_complete_decision_factory():
    from production.decision_use import OrderedDecisionUse
    from legacy_review import digest
    from test_decision_use import SyntheticAuthority
    from test_decision_history import DecisionHistoryTests
    fixture = DecisionHistoryTests()
    fixture.setUp()
    fixture.now = int(time.time() * 1000)
    authority = SyntheticAuthority(fixture)
    authority.effects[digest("effect")] = digest("request")
    return OrderedDecisionUse(pins=fixture.pins, verifier=BlockingVerifier(), authority=authority,
        clock=lambda: int(time.time() * 1000))


class OwnedAuthorityContracts(unittest.TestCase):
    def owner(self, cls, factory, **kwargs):
        owner = cls(factory, **kwargs)
        self.addCleanup(owner.close)
        return owner

    def intent(self):
        return RootGroupIntent("operation", "a" * 64, "b" * 64, "c" * 64,
            (("root", 1, "d" * 64),), (("root", 2, "e" * 64),), 1)

    def test_exact_root_methods_round_trip(self):
        owner = self.owner(OwnedRootGroupBackend, Root)
        intent = self.intent()
        for method in (owner.pin_intent, owner.activate_exact, owner.inspect_intent):
            self.assertEqual(method(intent, time.monotonic() + 1), intent)

    def test_blocking_root_is_killed_and_permanently_held(self):
        owner = self.owner(OwnedRootGroupBackend, BlockingRoot)
        started = time.monotonic()
        with self.assertRaises(Held):
            owner.pin_intent(self.intent(), started + 0.1)
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertFalse(owner._worker._process.is_alive())
        with self.assertRaises(Held):
            owner.inspect_intent(self.intent(), time.monotonic() + 1)

    def test_contender_timeout_does_not_close_current_worker(self):
        owner = self.owner(OwnedRootGroupBackend, DelayedRoot)
        completed = []
        first = threading.Thread(target=lambda: completed.append(owner.pin_intent(self.intent(), time.monotonic() + 2)))
        first.start()
        until = time.monotonic() + 1
        while not owner._submission.locked() and time.monotonic() < until:
            time.sleep(0.001)
        self.assertTrue(owner._submission.locked())
        started = time.monotonic()
        with self.assertRaises(Held):
            owner.inspect_intent(self.intent(), started + 0.05)
        self.assertLess(time.monotonic() - started, 0.2)
        self.assertTrue(owner._worker._process.is_alive())
        first.join(timeout=1)
        self.assertEqual(completed, [self.intent()])
        self.assertEqual(owner.inspect_intent(self.intent(), time.monotonic() + 1), self.intent())

    def test_decision_method_and_deadline_binding_round_trip(self):
        owner = self.owner(OwnedDecisionAuthority, Decision)
        for method, kind in (("execute", "effect"), ("revoke", "revoke"), ("inspect", "inspection")):
            deadline = int(time.time() * 1000) + 1000
            request = dict(kind=f"legacy-ordered-{kind}-v1", deadlineAt=deadline, binding="exact")
            self.assertEqual(getattr(owner, method)(request, deadline_at=deadline)["request"], request)

    def test_decision_wrong_method_or_deadline_rejected_before_dispatch(self):
        owner = self.owner(OwnedDecisionAuthority, Decision)
        deadline = int(time.time() * 1000) + 1000
        request = dict(kind="legacy-ordered-revoke-v1", deadlineAt=deadline)
        with self.assertRaises(Held):
            owner.execute(request, deadline_at=deadline)
        with self.assertRaises(Held):
            owner.revoke(request, deadline_at=deadline + 1)

    def test_explicit_decision_cancel_kills_local_worker(self):
        cancel = threading.Event()
        owner = self.owner(OwnedDecisionAuthority, BlockingDecision, cancel=cancel)
        deadline = int(time.time() * 1000) + 2000
        timer = threading.Timer(0.1, cancel.set)
        timer.start()
        try:
            with self.assertRaises(Held):
                owner.execute(dict(kind="legacy-ordered-effect-v1", deadlineAt=deadline), deadline_at=deadline)
        finally:
            timer.cancel()
        self.assertFalse(owner._worker._process.is_alive())

    def test_worker_dispatch_is_allowlisted(self):
        for family, backend in (("root", Root()), ("decision", Decision()), ("write", Write())):
            with self.assertRaises(Held):
                AuthorityWorkerHandler(backend, family)("close", {}, time.monotonic() + 1)

    def test_write_preserves_binary_bytes_and_exact_result(self):
        owner = self.owner(OwnedAtomicWriteBackend, Write)
        data = b"exact\x00\xffbytes"
        intent = WriteIntent("write", "a" * 64, "b" * 64, 0, hashlib.sha256(data).hexdigest(), 1, 1, 1, 1, len(data))
        result = owner.commit_write(intent, data, time.monotonic() + 1)
        self.assertEqual(result, WriteResult(intent, len(data), 1))
        with self.assertRaisesRegex(Held, "write_attempt_consumed"):
            owner.commit_write(intent, data, time.monotonic() + 1)
        # Rejected local replay did not invoke the backend or poison inspection.
        self.assertEqual(owner.inspect_write(intent, time.monotonic() + 1), result)
        self.assertEqual(owner.revoke("a" * 64, 1, time.monotonic() + 1)["expected_revision"], 1)

    def test_write_wrong_bytes_refused_without_backend_call(self):
        owner = self.owner(OwnedAtomicWriteBackend, Write)
        intent = WriteIntent("write", "a" * 64, "b" * 64, 0, "c" * 64, 1, 1, 1, 1, 1)
        with self.assertRaises(Held):
            owner.commit_write(intent, b"x", time.monotonic() + 1)


class CompleteDecisionOwnershipContracts(unittest.TestCase):
    def test_blocking_verifier_is_owned_bounded_and_permanently_held(self):
        from legacy_review import digest
        owner = OwnedOrderedDecisionUse(blocked_complete_decision_factory, operation_timeout_ms=150)
        self.addCleanup(owner.close)
        def inspect():
            return owner.inspect(request_hash=digest("request"), effect_id=digest("effect"),
                challenge=digest("challenge"), now=int(time.time() * 1000))
        started = time.monotonic()
        with self.assertRaises(Held):
            inspect()
        self.assertGreaterEqual(time.monotonic() - started, 0.1)
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertFalse(owner._worker._process.is_alive())
        with self.assertRaisesRegex(Held, "permanently_held"):
            inspect()

    def test_complete_operation_timeout_and_dispatch_are_allowlisted(self):
        for timeout in (True, 0, 3001):
            with self.assertRaises(Held):
                OwnedOrderedDecisionUse(blocked_complete_decision_factory, operation_timeout_ms=timeout)
        handler = AuthorityWorkerHandler(blocked_complete_decision_factory(), "decision-use")
        for operation, arguments in (("verify", {}), ("inspect", {"callback": "shell"})):
            with self.assertRaises(Held):
                handler(operation, arguments, time.monotonic() + 1)


if __name__ == "__main__":
    unittest.main()
