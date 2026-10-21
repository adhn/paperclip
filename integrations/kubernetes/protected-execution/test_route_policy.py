"""Pure static contracts; no installed routing or runtime acceptance."""
from dataclasses import FrozenInstanceError, replace
import unittest
from production.gateway import Held
from production.route_policy import (
    COMMAND_ROUTES, DEPENDENCIES, DependencyReference, RouteBinding, RoutePolicy,
)


def references():
    return tuple(DependencyReference(d, 'review/' + d) for d in sorted(DEPENDENCIES))


def binding(route):
    return RouteBinding(route, 'protected-composition-v1', references())


def policy():
    return RoutePolicy('exact-source-inventory', 'protected-composition-v1',
                       tuple(binding(r) for r in sorted(COMMAND_ROUTES)))


class RoutePolicyTests(unittest.TestCase):
    def test_every_known_route_returns_requirements_only(self):
        candidate = policy()
        for route in COMMAND_ROUTES:
            with self.subTest(route=route):
                result = candidate.require_route(route, source_inventory=candidate.source_inventory,
                                                 protected_factory=candidate.protected_factory)
                self.assertIsInstance(result, RouteBinding)
                self.assertEqual(frozenset(d.dependency for d in result.dependencies), DEPENDENCIES)

    def test_each_missing_route_refuses_manifest(self):
        candidate = policy()
        for route in COMMAND_ROUTES:
            with self.subTest(route=route), self.assertRaises(Held):
                replace(candidate, bindings=tuple(b for b in candidate.bindings if b.route != route))

    def test_duplicate_cannot_cover_missing_route(self):
        candidate = policy()
        with self.assertRaises(Held):
            replace(candidate, bindings=candidate.bindings[:-1] + (candidate.bindings[0],))

    def test_unknown_and_legacy_fallback_routes_refuse(self):
        candidate = policy()
        for route in ('*', 'legacy-ssh', 'unjournalled', 'unknown', '', None, True, []):
            with self.subTest(route=route), self.assertRaises(Held):
                candidate.require_route(route, source_inventory=candidate.source_inventory,
                                        protected_factory=candidate.protected_factory)

    def test_unknown_route_cannot_be_registered(self):
        with self.assertRaises(Held):
            binding('legacy-ssh')

    def test_every_missing_dependency_refuses_every_route(self):
        for route in COMMAND_ROUTES:
            for dependency in DEPENDENCIES:
                with self.subTest(route=route, dependency=dependency), self.assertRaises(Held):
                    replace(binding(route), dependencies=tuple(d for d in references()
                                                              if d.dependency != dependency))

    def test_duplicate_dependency_cannot_cover_missing_proof(self):
        refs = references()
        with self.assertRaises(Held):
            replace(binding('stop'), dependencies=refs[:-1] + (refs[0],))

    def test_route_cannot_select_alternate_composition(self):
        candidate = policy()
        with self.assertRaises(Held):
            replace(candidate, bindings=(replace(candidate.bindings[0], protected_factory='other'),)
                    + candidate.bindings[1:])

    def test_absent_or_changed_installation_identity_refuses_lookup(self):
        candidate = policy()
        for source, factory in ((None, candidate.protected_factory),
                                ('old-source', candidate.protected_factory),
                                (candidate.source_inventory, None),
                                (candidate.source_inventory, 'legacy')):
            with self.subTest(source=source, factory=factory), self.assertRaises(Held):
                candidate.require_route('setup', source_inventory=source, protected_factory=factory)

    def test_nested_manifest_is_immutable(self):
        candidate = policy()
        for value, field in ((candidate, 'source_inventory'), (candidate.bindings[0], 'route'),
                             (candidate.bindings[0].dependencies[0], 'reference')):
            with self.assertRaises(FrozenInstanceError):
                setattr(value, field, 'changed')

    def test_mutable_containers_refuse_instead_of_snapshot_drift(self):
        with self.assertRaises(Held):
            replace(policy(), bindings=list(policy().bindings))
        with self.assertRaises(Held):
            replace(binding('command'), dependencies=list(references()))

    def test_invalid_dependency_references_refuse(self):
        for dependency, reference in (('unknown', 'review'), ('exact-retained-owner', ''),
                                      ('exact-retained-owner', 'new\nline'),
                                      ('exact-retained-owner', True), ([], 'review')):
            with self.subTest(dependency=dependency, reference=reference), self.assertRaises(Held):
                DependencyReference(dependency, reference)


if __name__ == '__main__':
    unittest.main()
