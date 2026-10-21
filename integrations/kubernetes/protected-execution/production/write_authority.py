"""Inactive mandatory effect interfaces. No storage/runtime adapter or installer.

The backend, NOT this process or its locks, owns distributed serialization.
Hashes name complete immutable records; they never certify physical exclusion.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass
import hashlib
import math
import threading
import time

from production.gateway import Held, hexhash, name


def remaining(deadline):
    if type(deadline) not in (int, float) or not math.isfinite(deadline):
        raise Held("bounded_write_deadline_required")
    left = deadline - time.monotonic()
    if not 0 < left <= 10:
        raise Held("bounded_write_deadline_required")
    return left


@dataclass(frozen=True)
class WriteIntent:
    operation: str
    binding_hash: str
    root_group_hash: str
    sequence: int
    data_hash: str
    native_revision: int
    runtime_revision: int
    storage_revision: int
    decision_revision: int
    byte_count: int

    def validate(self):
        name(self.operation)
        if type(self.byte_count) is not int or not 0 < self.byte_count <= 4096:
            raise Held("exact_write_length_required")
        for value in (self.binding_hash, self.root_group_hash, self.data_hash):
            hexhash(value)
        if type(self.sequence) is not int or self.sequence < 0:
            raise Held("exact_write_sequence_required")
        for value in (self.native_revision, self.runtime_revision,
                      self.storage_revision, self.decision_revision):
            if type(value) is not int or value < 1:
                raise Held("current_write_revision_required")


@dataclass(frozen=True)
class WriteResult:
    intent: WriteIntent
    accepted: int
    order: int


class AtomicWriteBackend(ABC):
    """Protected backend obligation, not an implementation.

    commit_write must atomically check exact original owner, full command and
    physical/root binding, next sequence, current native cancellation/lifetime,
    runtime and storage writer revocation, accepted decision and ordered history
    revisions, then perform the byte effect. Revisions must be exact current
    values, not merely >= a client floor. Checks before dispatch are insufficient.
    Every effect path including queued bytes shares this boundary. Physical
    stale-writer exclusion must survive partition/restart and old open handles.

    revoke orders against the SAME boundary and cancels queued effects. Its
    return is deny-intent, not retirement: pre-order uncertain I/O stays charged.
    Backend records attempted operation durably before effects; lost replies and
    recovery cannot replay it. inspect_write observes that original operation
    only. External current history survives client/database/PVC rollback.
    Calls require bounded cancellable operation ownership; timeout cannot prove
    that an independently running backend effect stopped.
    """
    @abstractmethod
    def commit_write(self, intent, data, deadline):
        raise Held("mandatory_atomic_write_backend_missing")

    @abstractmethod
    def revoke(self, binding_hash, expected_revision, deadline):
        raise Held("mandatory_ordered_revoke_backend_missing")

    @abstractmethod
    def inspect_write(self, intent, deadline):
        """Return original immutable WriteResult or None for unknown; no retry."""
        raise Held("mandatory_write_inspection_missing")


class OrderedWriteAuthority:
    def __init__(self, backend):
        if not isinstance(backend, AtomicWriteBackend):
            raise Held("mandatory_atomic_write_backend_missing")
        self.backend = backend
        self._attempted = set()
        self._lock = threading.Lock()

    @staticmethod
    def _result(intent, result, length=None):
        if (type(result) is not WriteResult or result.intent != intent or
                type(result.accepted) is not int or result.accepted <= 0 or
                result.accepted != intent.byte_count or (length is not None and result.accepted != length) or
                type(result.order) is not int or result.order < 1):
            raise Held("atomic_write_result_unverified")
        return result

    def commit_write(self, intent, data, deadline):
        remaining(deadline)
        if type(intent) is not WriteIntent:
            raise Held("exact_write_intent_required")
        intent.validate()
        if (type(data) is not bytes or len(data) != intent.byte_count or
                hashlib.sha256(data).hexdigest() != intent.data_hash):
            raise Held("exact_write_bytes_required")
        # Local replay defense only; backend durable operation ownership is mandatory.
        with self._lock:
            if len(self._attempted) >= 4096 or intent.operation in self._attempted:
                raise Held("write_attempt_consumed")
            self._attempted.add(intent.operation)
        try:
            result = self.backend.commit_write(intent, data, deadline)
            remaining(deadline)
            return self._result(intent, result, len(data))
        except Exception:
            raise Held("atomic_write_uncertain_or_refused") from None

    def inspect_write(self, intent, deadline):
        remaining(deadline)
        if type(intent) is not WriteIntent:
            raise Held("exact_write_intent_required")
        intent.validate()
        result = self.backend.inspect_write(intent, deadline)
        remaining(deadline)
        return None if result is None else self._result(intent, result)


@dataclass(frozen=True)
class RootGroupIntent:
    operation: str
    original_family_hash: str
    physical_exclusion_hash: str
    retirement_hash: str
    expected_heads: tuple
    proposed_heads: tuple
    history_revision: int

    def validate(self):
        name(self.operation)
        for value in (self.original_family_hash, self.physical_exclusion_hash, self.retirement_hash):
            hexhash(value)
        if type(self.history_revision) is not int or self.history_revision < 1:
            raise Held("current_group_history_required")
        for heads in (self.expected_heads, self.proposed_heads):
            if type(heads) is not tuple or not 0 < len(heads) <= 128:
                raise Held("complete_root_group_required")
            keys = []
            for row in heads:
                if type(row) is not tuple or len(row) != 3:
                    raise Held("exact_root_head_required")
                key, generation, content_hash = row
                name(key)
                hexhash(content_hash)
                if type(generation) is not int or generation < 1:
                    raise Held("root_generation_required")
                keys.append(key)
            if keys != sorted(set(keys)):
                raise Held("canonical_root_group_required")
        if tuple(r[0] for r in self.expected_heads) != tuple(r[0] for r in self.proposed_heads):
            raise Held("complete_root_group_required")
        if any(new[1] != old[1] + 1 for old, new in zip(self.expected_heads, self.proposed_heads)):
            raise Held("strict_root_group_successor_required")


class RootGroupBackend(ABC):
    """Backend owns authenticated complete group inventory, aliases and CAS.

    pin_intent durably records exact prospective heads in an independent restore
    domain BEFORE activation. activate_exact verifies pin/current history,
    complete authoritative group, physical exclusion and completed retirement
    again at its atomic full-group head switch. Cross-volume heads require an
    actual protected atomic protocol; independent rename calls cannot qualify.
    Ahead/local-old, missing/conflicting pin and lost completion remain occupied.
    inspect_intent never adopts, lowers high-water or retries effects.
    """
    @abstractmethod
    def pin_intent(self, intent, deadline):
        raise Held("independent_prospective_pin_missing")

    @abstractmethod
    def activate_exact(self, intent, deadline):
        raise Held("physical_root_group_cas_missing")

    @abstractmethod
    def inspect_intent(self, intent, deadline):
        raise Held("current_root_group_inspection_missing")


def activate_root_group(backend, intent, deadline):
    """Single prospective protocol attempt; backend must persist no-replay state."""
    remaining(deadline)
    if not isinstance(backend, RootGroupBackend) or type(intent) is not RootGroupIntent:
        raise Held("protected_root_group_backend_required")
    intent.validate()
    # Exact immutable intent is the pin receipt. Never accept an unbound boolean.
    if backend.pin_intent(intent, deadline) != intent:
        raise Held("prospective_intent_unverified")
    remaining(deadline)
    if backend.activate_exact(intent, deadline) != intent:
        raise Held("root_group_activation_uncertain")
    remaining(deadline)
    return intent
