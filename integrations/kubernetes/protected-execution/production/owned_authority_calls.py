"""Inactive owned synchronous authority adapters; no backend or installer.

Only local process ownership is bounded. Killing a worker neither retracts a
remote operation nor releases any native occupancy. Protected importable
factories must retain durable no-replay/uncertainty state outside this process.
"""
from dataclasses import asdict, dataclass
import math
import threading
import time

from production.gateway import Held, canonical
from production.operation_worker import OperationWorker
from production.write_authority import RootGroupBackend, RootGroupIntent, remaining
from production.write_authority import AtomicWriteBackend, WriteIntent, WriteResult, OrderedWriteAuthority
from production.gateway import hexhash


def _intent(value):
    fields = set(RootGroupIntent.__dataclass_fields__)
    if type(value) is not dict or set(value) != fields:
        raise Held("exact_root_intent_wire_required")
    value = dict(value)
    for key in ("expected_heads", "proposed_heads"):
        if type(value[key]) is not list or any(type(row) is not list for row in value[key]):
            raise Held("exact_root_heads_wire_required")
        value[key] = tuple(tuple(row) for row in value[key])
    result = RootGroupIntent(**value)
    result.validate()
    return result


def _wire(intent):
    # Normalize tuples exactly as the worker's JSON channel does.
    import json
    return json.loads(canonical(asdict(intent)))


KINDS = {"execute": "legacy-ordered-effect-v1", "revoke": "legacy-ordered-revoke-v1",
         "inspect": "legacy-ordered-inspection-v1"}
USE_ARGUMENTS = {
    "execute": {"holds", "accepted", "purpose", "challenge", "now", "effect"},
    "revoke": {"intent", "challenge", "now"},
    "inspect": {"request_hash", "effect_id", "challenge", "now"},
}


def _decision(operation, arguments):
    if operation not in KINDS or type(arguments) is not dict or set(arguments) != {"request", "deadline_at"}:
        raise Held("allowlisted_decision_call_required")
    request, deadline_at = arguments["request"], arguments["deadline_at"]
    if (type(request) is not dict or request.get("kind") != KINDS[operation]
            or type(deadline_at) is not int or request.get("deadlineAt") != deadline_at):
        raise Held("exact_decision_call_binding_required")
    return request, deadline_at


@dataclass(frozen=True)
class AuthorityWorkerFactory:
    """Protected factory reference, never a caller-selected import path or URL."""
    backend_factory: object
    family: str

    def __call__(self):
        if self.family not in ("root", "decision", "write", "decision-use"):
            raise Held("allowlisted_authority_family_required")
        return AuthorityWorkerHandler(self.backend_factory(), self.family)


class AuthorityWorkerHandler:
    def __init__(self, backend, family):
        self.backend, self.family = backend, family
        self._writes = OrderedWriteAuthority(backend) if family == "write" else None
        if family == "decision-use":
            from production.decision_use import OrderedDecisionUse
            if type(backend) is not OrderedDecisionUse:
                raise Held("complete_ordered_decision_use_required")

    def __call__(self, operation, arguments, deadline):
        remaining(deadline)
        if self.family == "decision-use":
            if (operation not in USE_ARGUMENTS or type(arguments) is not dict
                    or set(arguments) != USE_ARGUMENTS[operation]):
                raise Held("exact_ordered_decision_arguments_required")
            return getattr(self.backend, operation)(**arguments)
        if self.family == "write":
            if operation == "revoke":
                if type(arguments) is not dict or set(arguments) != {"binding_hash", "expected_revision"}:
                    raise Held("exact_write_revoke_required")
                hexhash(arguments["binding_hash"])
                if type(arguments["expected_revision"]) is not int or arguments["expected_revision"] < 1:
                    raise Held("current_write_revision_required")
                return self.backend.revoke(arguments["binding_hash"], arguments["expected_revision"], deadline)
            if operation not in ("commit_write", "inspect_write"):
                raise Held("allowlisted_write_call_required")
            expected = {"intent", "data"} if operation == "commit_write" else {"intent"}
            if type(arguments) is not dict or set(arguments) != expected:
                raise Held("exact_write_arguments_required")
            intent = WriteIntent(**arguments["intent"])
            intent.validate()
            if operation == "commit_write":
                data = bytes.fromhex(arguments["data"])
                # Reuse exact bytes/hash/count and result validation in the worker.
                result = self._writes.commit_write(intent, data, deadline)
            else:
                result = self.backend.inspect_write(intent, deadline)
                if result is None:
                    return None
                OrderedWriteAuthority._result(intent, result)
            return asdict(result)
        if self.family == "root":
            if operation not in ("pin_intent", "activate_exact", "inspect_intent"):
                raise Held("allowlisted_root_call_required")
            intent = _intent(arguments)
            result = getattr(self.backend, operation)(intent, deadline)
            if result is None and operation == "inspect_intent":
                return None
            if type(result) is not RootGroupIntent or result != intent:
                raise Held("exact_root_result_required")
            return _wire(result)
        request, deadline_at = _decision(operation, arguments)
        if deadline_at <= int(time.time() * 1000):
            raise Held("decision_deadline_expired")
        return getattr(self.backend, operation)(request, deadline_at=deadline_at)


class _Owner:
    def __init__(self, backend_factory, family, cancel=None):
        self._worker = OperationWorker(AuthorityWorkerFactory(backend_factory, family))
        self._cancel, self._held = cancel, False
        self._submission = threading.Lock()

    def _call(self, operation, arguments, deadline):
        # A contender owns no submitted work and must never close the worker
        # underneath the current caller when its own queue deadline expires.
        while True:
            left = remaining(deadline)
            if self._cancel is not None and self._cancel.is_set():
                raise Held("authority_wait_cancelled")
            if self._submission.acquire(timeout=min(left, 0.02)):
                break
        try:
            if self._held:
                raise Held("authority_owner_permanently_held")
            remaining(deadline)
            if self._cancel is not None and self._cancel.is_set():
                raise Held("authority_wait_cancelled")
            try:
                return self._worker.call(operation, arguments, deadline, self._cancel)
            except BaseException:
                # Only this caller can own a submitted operation now.
                self._held = True
                self._worker.close()
                raise Held("authority_operation_uncertain_or_refused") from None
        finally:
            self._submission.release()

    def close(self):
        self._held = True
        self._worker.close()


class OwnedRootGroupBackend(_Owner, RootGroupBackend):
    def __init__(self, backend_factory, *, cancel=None):
        super().__init__(backend_factory, "root", cancel)

    def _root(self, operation, intent, deadline):
        remaining(deadline)
        if type(intent) is not RootGroupIntent:
            raise Held("exact_root_intent_required")
        intent.validate()
        result = self._call(operation, _wire(intent), deadline)
        if result is None and operation == "inspect_intent":
            return None
        try:
            result = _intent(result)
            if result != intent:
                raise Held("root_response_binding")
            return result
        except Exception:
            self.close()
            raise Held("root_response_unverified") from None

    def pin_intent(self, intent, deadline):
        return self._root("pin_intent", intent, deadline)

    def activate_exact(self, intent, deadline):
        return self._root("activate_exact", intent, deadline)

    def inspect_intent(self, intent, deadline):
        return self._root("inspect_intent", intent, deadline)


class OwnedDecisionAuthority(_Owner):
    def __init__(self, backend_factory, *, cancel=None):
        super().__init__(backend_factory, "decision", cancel)

    def _decision_call(self, operation, request, deadline_at):
        arguments = dict(request=request, deadline_at=deadline_at)
        _decision(operation, arguments)
        left = (deadline_at - time.time() * 1000) / 1000
        if not math.isfinite(left) or not 0 < left <= 5:
            raise Held("bounded_decision_deadline_required")
        # OperationWorker additionally caps all calls at three seconds.
        return self._call(operation, arguments, time.monotonic() + min(left, 3))

    def execute(self, request, *, deadline_at):
        return self._decision_call("execute", request, deadline_at)

    def revoke(self, request, *, deadline_at):
        return self._decision_call("revoke", request, deadline_at)

    def inspect(self, request, *, deadline_at):
        return self._decision_call("inspect", request, deadline_at)


class OwnedAtomicWriteBackend(_Owner, AtomicWriteBackend):
    def __init__(self, backend_factory, *, cancel=None):
        super().__init__(backend_factory, "write", cancel)
        self._attempted, self._attempt_lock = set(), threading.Lock()

    def _write(self, operation, intent, deadline, data=None):
        remaining(deadline)
        if type(intent) is not WriteIntent:
            raise Held("exact_write_intent_required")
        intent.validate()
        arguments = dict(intent=asdict(intent))
        if operation == "commit_write":
            import hashlib
            if (type(data) is not bytes or len(data) != intent.byte_count
                    or hashlib.sha256(data).hexdigest() != intent.data_hash):
                raise Held("exact_write_bytes_required")
            arguments["data"] = data.hex()
            with self._attempt_lock:
                if len(self._attempted) >= 4096 or intent.operation in self._attempted:
                    raise Held("write_attempt_consumed")
                self._attempted.add(intent.operation)
        result = self._call(operation, arguments, deadline)
        if result is None and operation == "inspect_write":
            return None
        try:
            if type(result) is not dict or set(result) != {"intent", "accepted", "order"}:
                raise Held("exact_write_result_required")
            result = WriteResult(WriteIntent(**result["intent"]), result["accepted"], result["order"])
            return OrderedWriteAuthority._result(intent, result)
        except Exception:
            self.close()
            raise Held("write_response_unverified") from None

    def commit_write(self, intent, data, deadline):
        return self._write("commit_write", intent, deadline, data)

    def inspect_write(self, intent, deadline):
        return self._write("inspect_write", intent, deadline)

    def revoke(self, binding_hash, expected_revision, deadline):
        remaining(deadline)
        hexhash(binding_hash)
        if type(expected_revision) is not int or expected_revision < 1:
            raise Held("current_write_revision_required")
        return self._call("revoke", dict(binding_hash=binding_hash, expected_revision=expected_revision), deadline)


class OwnedOrderedDecisionUse(_Owner):
    """Own the entire standalone decision operation, including signature checks.

    The protected factory constructs OrderedDecisionUse, verifier and authority
    inside the worker. Result is historical completion only, never a later-use
    permit. This does not install a native ordered transaction executor.
    """
    def __init__(self, decision_factory, *, operation_timeout_ms=1000, cancel=None):
        if type(operation_timeout_ms) is not int or not 1 <= operation_timeout_ms <= 3000:
            raise Held("bounded_complete_decision_timeout_required")
        self._timeout_ms = operation_timeout_ms
        super().__init__(decision_factory, "decision-use", cancel)

    def _use(self, operation, arguments):
        if type(arguments["now"]) is not int:
            raise Held("exact_decision_now_required")
        wall = time.time() * 1000
        # Bind local ownership to the submitted operation's wall-clock lifetime;
        # waiting for a sibling consumes this same deadline, never refreshes it.
        left = (arguments["now"] + self._timeout_ms - wall) / 1000
        if not math.isfinite(left) or not 0 < left <= 3:
            raise Held("bounded_complete_decision_deadline_required")
        return self._call(operation, arguments, time.monotonic() + left)

    def execute(self, *, holds, accepted, purpose, challenge, now, effect):
        return self._use("execute", dict(holds=holds, accepted=accepted, purpose=purpose,
            challenge=challenge, now=now, effect=effect))

    def revoke(self, *, intent, challenge, now):
        return self._use("revoke", dict(intent=intent, challenge=challenge, now=now))

    def inspect(self, *, request_hash, effect_id, challenge, now):
        return self._use("inspect", dict(request_hash=request_hash, effect_id=effect_id,
            challenge=challenge, now=now))
