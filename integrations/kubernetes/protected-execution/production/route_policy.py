"""Immutable static routing contract; no execution authority or installer.

References name required integration artifacts, never evidence they exist or are
current. Successful lookup cannot authorize a later effect. Mandatory native
routing before authentication/setup and actual authority-owned effects are absent.
"""
from dataclasses import dataclass
from production.gateway import Held

COMMAND_ROUTES = frozenset({
    'setup', 'command', 'probe', 'service-start', 'service-stop',
    'file-upload', 'file-download', 'bundle-upload', 'bundle-download',
    'tar-upload', 'tar-download', 'stdin-write', 'epoch', 'stop', 'recovery',
})
DEPENDENCIES = frozenset({
    'runtime-effect-boundary', 'current-independent-history',
    'atomic-effect-deny-ordering', 'physical-stale-writer-exclusion',
    'exact-retained-owner', 'uncertain-operation-inspection',
    'stdout-stderr-exit-signal-framing', 'recovery-before-exposure',
})


def _name(value):
    return (type(value) is str and 0 < len(value) <= 256
            and value == value.strip() and all(32 < ord(c) < 127 for c in value))


@dataclass(frozen=True)
class DependencyReference:
    """Review reference only, never a verified physical/current-history fact."""
    dependency: str
    reference: str

    def __post_init__(self):
        if (type(self.dependency) is not str or self.dependency not in DEPENDENCIES
                or not _name(self.reference)):
            raise Held('route_dependency_invalid')


@dataclass(frozen=True)
class RouteBinding:
    route: str
    protected_factory: str
    dependencies: tuple[DependencyReference, ...]

    def __post_init__(self):
        if (type(self.route) is not str or self.route not in COMMAND_ROUTES
                or not _name(self.protected_factory)
                or type(self.dependencies) is not tuple
                or any(type(d) is not DependencyReference for d in self.dependencies)
                or len(self.dependencies) != len(DEPENDENCIES)
                or frozenset(d.dependency for d in self.dependencies) != DEPENDENCIES):
            raise Held('route_binding_incomplete')


@dataclass(frozen=True)
class RoutePolicy:
    """Complete candidate manifest pinned to one exact reviewed source inventory.

    One protected composition covers every route, including cancellation and
    recovery. No I/O, custody check, receipt or reusable permit is provided.
    Cancellation requires exact retained authority for old owners; transport
    closure never establishes retirement B. Physical exclusion must cover old
    descriptors/mounts/credential writers independently.
    """
    source_inventory: str
    protected_factory: str
    bindings: tuple[RouteBinding, ...]

    def __post_init__(self):
        if (not _name(self.source_inventory) or not _name(self.protected_factory)
                or type(self.bindings) is not tuple
                or any(type(b) is not RouteBinding for b in self.bindings)
                or len(self.bindings) != len(COMMAND_ROUTES)
                or frozenset(b.route for b in self.bindings) != COMMAND_ROUTES
                or any(b.protected_factory != self.protected_factory for b in self.bindings)):
            raise Held('route_policy_incomplete')

    def require_route(self, route, *, source_inventory, protected_factory):
        """Return static requirements only; refuse unknown routes or drift.

        Installer must independently verify retained source/factory identity.
        Matching caller strings do not prove installation or authorize execution.
        """
        if (type(route) is not str or route not in COMMAND_ROUTES
                or not _name(source_inventory) or source_inventory != self.source_inventory
                or not _name(protected_factory) or protected_factory != self.protected_factory):
            raise Held('route_policy_refused')
        return next(b for b in self.bindings if b.route == route)
