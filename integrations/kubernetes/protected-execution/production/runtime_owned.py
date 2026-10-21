"""Owned runtime authority calls; no runtime installer or retirement evidence.

Only a protected backend factory may be supplied. The backend executes the effect
inside its own ordered authority transaction; this API never returns a permit for
a subsequent caller effect. Local worker death retains remote uncertainty.
"""
from dataclasses import asdict, dataclass

from production.gateway import Held
from production.operation_worker import OperationWorker
from production.runtime_boundary import RuntimeBinding


_FIELDS = {
    'recover_before_exposure': frozenset(('runtime_identity', 'route_inventory',
                                         'independent_history', 'unresolved_intents')),
    'commit_prospective_intent': frozenset(('binding', 'operation', 'route', 'effect',
                                          'payload_hash', 'expected_history')),
    'execute_at_effect': frozenset(('binding', 'operation', 'expected_history')),
    'inspect_exact_intent': frozenset(('binding', 'operation', 'challenge', 'minimum_history')),
    'revoke_ordered': frozenset(('binding', 'operation', 'expected_history')),
    'inspect_completed_retirement': frozenset(('binding', 'challenge', 'minimum_history')),
}


class RuntimeWorkerHandler:
    """One recovered adapter lifetime. Construction must not expose runtime routes.

    Successful recovery is an internal backend completion, not caller-supplied
    route evidence. Re-recovery first closes the local gate. Inspection/revocation
    remain available while held; prospective work and actual effects require
    completed recovery. The backend must independently enforce current history
    and revocation at every actual effect, including previously opened streams.
    """
    def __init__(self, backend):
        self._backend, self._recovered = backend, False

    def __call__(self, operation, arguments, deadline):
        if operation not in _FIELDS or type(arguments) is not dict or set(arguments) != _FIELDS[operation]:
            raise Held('runtime_owned_request_invalid')
        if operation == 'recover_before_exposure':
            self._recovered = False
        elif operation in ('commit_prospective_intent', 'execute_at_effect') and not self._recovered:
            raise Held('runtime_owned_recovery_required')
        arguments = dict(arguments)
        if 'binding' in arguments:
            binding = arguments['binding']
            if type(binding) is not dict or set(binding) != set(RuntimeBinding.__dataclass_fields__):
                raise Held('runtime_owned_binding_invalid')
            binding = dict(binding)
            for key in ('original_scopes', 'node_boot_runtime'):
                if type(binding[key]) is not list:
                    raise Held('runtime_owned_binding_invalid')
                binding[key] = tuple(binding[key])
            arguments['binding'] = RuntimeBinding(**binding)
        # No caller callback, process, command body or old authorization token is
        # accepted here. Only the authority backend can perform the bound effect.
        result = getattr(self._backend, operation)(**arguments)
        if operation == 'recover_before_exposure':
            if result is not None:
                raise Held('runtime_owned_recovery_result_invalid')
            self._recovered = True
        return result


@dataclass(frozen=True)
class _Factory:
    backend_factory: object

    def __call__(self):
        return RuntimeWorkerHandler(self.backend_factory())


class RuntimeAuthorityOwner:
    """Persistent cancellable runtime worker; never replaces or replays a call.

    A local deadline/cancel kills its entire owned process group and permanently
    holds the worker. This is not remote cancellation, B, storage fencing or
    native release. Backend factory provenance and mandatory runtime placement
    require a separately reviewed deployment. Standalone use cannot close bypasses.
    """
    def __init__(self, backend_factory, startup_seconds=3):
        self._worker = OperationWorker(_Factory(backend_factory), startup_seconds)

    def call(self, action, *, deadline, cancel=None, **arguments):
        if action not in _FIELDS or set(arguments) != _FIELDS[action]:
            raise Held('runtime_owned_request_invalid')
        if 'binding' in arguments:
            if not isinstance(arguments['binding'], RuntimeBinding):
                raise Held('runtime_owned_binding_invalid')
            arguments['binding'] = asdict(arguments['binding'])
        return self._worker.call(action, arguments, deadline, cancel)

    def close(self):
        self._worker.close()
