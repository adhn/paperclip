"""Deterministic runtime-boundary protocol rehearsal, NOT a runtime authority.

No socket, process, provider, receipt, installer or production backend is supplied.
Caller-supplied route/alias facts are synthetic inputs, never physical evidence.
The retained model object represents independent history for fault rehearsals; it
has no durability, authentication, custody or protection against host mutation.
"""
from copy import deepcopy
from dataclasses import dataclass, field
from threading import RLock

from production.gateway import Held


EFFECTS = frozenset({'start', 'exec', 'resume', 'restore', 'recover', 'write'})
ROUTES = frozenset({'cri', 'containerd', 'ttrpc', 'shim', 'runc', 'kata',
                    'nvidia', 'other-daemon', 'maintenance', 'boot-recovery'})


@dataclass(frozen=True)
class RuntimeBinding:
    owner: str
    original_scopes: tuple[str, ...]
    command_hash: str
    pod_uid: str
    node_boot_runtime: tuple[str, ...]
    physical_contract: str

    def __post_init__(self):
        if (not all(isinstance(v, str) and v for v in
                    (self.owner, self.command_hash, self.pod_uid, self.physical_contract))
                or not isinstance(self.original_scopes, tuple)
                or not isinstance(self.node_boot_runtime, tuple)
                or not self.original_scopes or not self.node_boot_runtime
                or not all(isinstance(v, str) and v for v in
                           self.original_scopes + self.node_boot_runtime)
                or len(set(self.original_scopes)) != len(self.original_scopes)
                or len(set(self.node_boot_runtime)) != len(self.node_boot_runtime)):
            raise Held('invalid_runtime_binding')


@dataclass
class _Owner:
    binding: RuntimeBinding
    deny: int | None = None
    barrier: int | None = None
    effects: dict = field(default_factory=dict)


class RetainedRuntimeRehearsal:
    """Bounded synthetic independent history, shared by restart model instances."""
    def __init__(self, max_owners=2, max_effects=64):
        if type(max_owners) is not int or not 1 <= max_owners <= 2:
            raise Held('owner_bound')
        if type(max_effects) is not int or not 1 <= max_effects <= 64:
            raise Held('effect_bound')
        self.max_owners, self.max_effects = max_owners, max_effects
        self.owners = {}
        self.revision = 0
        self.trace = []
        self.lock = RLock()

    def _record(self, owner, action, operation=None):
        self.revision += 1
        self.trace.append((self.revision, owner, action, operation))
        return self.revision

    def snapshot(self):
        with self.lock:
            return deepcopy((self.revision, self.owners))


class RuntimeBoundaryRehearsal:
    """All model effects require recovery plus exact route/effect coverage.

    Recovery validates equality against retained history, including unresolved
    ownership. It never retries an effect. Production mandatory routing, physical
    inventories and atomic durable history remain separate missing integrations.
    """
    def __init__(self, retained, coverage):
        self._retained = retained
        self._coverage = frozenset(coverage)
        self._ready = False
        self._revision = None

    def recover(self, snapshot, incarnations):
        with self._retained.lock:
            self._ready = False
            required = {(route, effect) for route in ROUTES for effect in EFFECTS}
            if self._coverage != required:
                raise Held('runtime_route_coverage_incomplete')
            if snapshot != self._retained.snapshot():
                raise Held('runtime_history_discontinuity')
            expected = {inc for owner in self._retained.owners.values()
                        for inc in owner.binding.node_boot_runtime}
            if frozenset(incarnations) != expected:
                raise Held('runtime_recovery_inventory_incomplete')
            self._revision = self._retained.revision
            self._ready = True

    def _current(self):
        if not self._ready or self._revision != self._retained.revision:
            raise Held('runtime_recovery_required')

    def _record(self, owner, action, operation=None):
        self._revision = self._retained._record(owner, action, operation)
        return self._revision

    def register(self, binding):
        with self._retained.lock:
            self._current()
            existing = self._retained.owners.get(binding.owner)
            if existing:
                if existing.binding != binding:
                    raise Held('runtime_owner_rebinding')
                return
            if any(o.binding.pod_uid == binding.pod_uid for o in self._retained.owners.values()):
                raise Held('runtime_uid_rebinding')
            if len(self._retained.owners) >= self._retained.max_owners:
                raise Held('runtime_owner_bound')
            self._retained.owners[binding.owner] = _Owner(binding)
            self._record(binding.owner, 'register')

    def _owner(self, owner):
        self._current()
        if owner not in self._retained.owners:
            raise Held('runtime_unknown_owner')
        return self._retained.owners[owner]

    def intent(self, owner, operation, route, effect, payload_hash):
        with self._retained.lock:
            state = self._owner(owner)
            if state.deny is not None or (route, effect) not in self._coverage:
                raise Held('runtime_effect_denied')
            if not isinstance(operation, str) or not operation or not isinstance(payload_hash, str) or not payload_hash:
                raise Held('runtime_invalid_intent')
            if operation in state.effects:
                raise Held('runtime_inspect_existing_intent')
            if sum(len(o.effects) for o in self._retained.owners.values()) >= self._retained.max_effects:
                raise Held('runtime_effect_bound')
            state.effects[operation] = dict(route=route, effect=effect, payload_hash=payload_hash,
                                            status='intent', aliases=(), stopped=())
            self._record(owner, 'intent', operation)

    def accept(self, owner, operation):
        with self._retained.lock:
            state = self._owner(owner)
            item = self._item(state, operation)
            if state.deny is not None or item['status'] != 'intent':
                raise Held('runtime_effect_denied')
            item['status'] = 'accepted'
            self._record(owner, 'accepted', operation)

    @staticmethod
    def _item(state, operation):
        if operation not in state.effects:
            raise Held('runtime_unknown_intent')
        return state.effects[operation]

    def settle(self, owner, operation, aliases):
        """Synthetic backend outcome; () means definitively no lasting effect.

        Accepted work may complete after T. Unknown replies must not call this.
        """
        with self._retained.lock:
            state = self._owner(owner)
            item = self._item(state, operation)
            aliases = tuple(aliases)
            if item['status'] != 'accepted' or len(aliases) > 4 or len(set(aliases)) != len(aliases):
                raise Held('runtime_invalid_settlement')
            if not all(isinstance(a, str) and a for a in aliases):
                raise Held('runtime_invalid_alias')
            occupied = {a for o in self._retained.owners.values()
                        for e in o.effects.values() for a in e['aliases']}
            if occupied.intersection(aliases):
                raise Held('runtime_alias_collision')
            item.update(status='settled', aliases=aliases)
            self._record(owner, 'settled', operation)

    def stop(self, owner, operation, aliases):
        """Model verified worker termination, not a process-stop implementation."""
        with self._retained.lock:
            state = self._owner(owner)
            item = self._item(state, operation)
            aliases = tuple(aliases)
            if item['status'] != 'settled' or aliases != item['aliases'] or item['stopped'] == aliases:
                raise Held('runtime_stop_not_exact')
            item['stopped'] = aliases
            self._record(owner, 'stopped', operation)

    def deny(self, owner):
        with self._retained.lock:
            state = self._owner(owner)
            if state.deny is None:
                state.deny = self._record(owner, 'T')
                # Unaccepted intentions cannot have forwarded effects in this
                # protocol. Accepted work remains occupied until settled/stopped.
                for item in state.effects.values():
                    if item['status'] == 'intent':
                        item['status'] = 'denied-before-accept'
            return state.deny

    def complete(self, owner, incarnations):
        with self._retained.lock:
            state = self._owner(owner)
            if state.deny is None:
                raise Held('runtime_missing_deny')
            if frozenset(incarnations) != frozenset(state.binding.node_boot_runtime):
                raise Held('runtime_retirement_inventory_incomplete')
            if any(e['status'] not in ('settled', 'denied-before-accept') or
                   e['aliases'] != e['stopped'] for e in state.effects.values()):
                raise Held('runtime_unresolved_effects')
            if state.barrier is None:
                state.barrier = self._record(owner, 'B')
            # Deliberately no receipt shape accepted by native/storage verifiers.
            return {'kind': 'synthetic-runtime-barrier', 'T': state.deny, 'B': state.barrier}

    def inspect(self, owner, operation=None):
        with self._retained.lock:
            state = self._owner(owner)
            return deepcopy(state if operation is None else self._item(state, operation))


class MandatoryRuntimeAuthority:
    """Unavailable production integration interface; every default refuses.

    An implementation must durably order prospective intent, each actual effect
    (including every stream write), and revocation at its unavoidable boundary.
    Exact inspection recovers the same intent after reply loss without replay.
    Startup/recovery must not expose any start-capable route until independent
    current history, all old incarnations and unresolved workers are accounted
    for. A Python method override alone cannot establish mandatory routing.
    """
    def recover_before_exposure(self, *, runtime_identity, route_inventory,
                                independent_history, unresolved_intents):
        raise Held('mandatory_runtime_backend_unavailable')

    def commit_prospective_intent(self, *, binding, operation, route, effect,
                                  payload_hash, expected_history):
        raise Held('mandatory_runtime_backend_unavailable')

    def authorize_at_effect(self, *, binding, operation, expected_history):
        # Historical compatibility surface only; a return value is never a
        # permit to perform an effect in a different transaction.
        raise Held('mandatory_runtime_backend_unavailable')

    def execute_at_effect(self, *, binding, operation, expected_history):
        """Perform the retained exact intent under authority-owned ordering.

        No command body is accepted for retry. Implementations must resolve the
        already committed intent, check current revocation/history, perform the
        actual effect and retain uncertain outcomes in that same authority.
        Returning completion is historical evidence, never a later-effect permit.
        """
        raise Held('mandatory_runtime_backend_unavailable')

    def inspect_exact_intent(self, *, binding, operation, challenge, minimum_history):
        raise Held('mandatory_runtime_backend_unavailable')

    def revoke_ordered(self, *, binding, operation, expected_history):
        raise Held('mandatory_runtime_backend_unavailable')

    def inspect_completed_retirement(self, *, binding, challenge, minimum_history):
        raise Held('mandatory_runtime_backend_unavailable')
