"""Bounded deterministic rehearsal only: no processes, sockets or real receipts."""
import unittest

from production.gateway import Held
from production.runtime_boundary import (EFFECTS, ROUTES, MandatoryRuntimeAuthority,
    RetainedRuntimeRehearsal, RuntimeBinding, RuntimeBoundaryRehearsal)


class RuntimeBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.history = RetainedRuntimeRehearsal()
        self.coverage = {(r, e) for r in ROUTES for e in EFFECTS}
        self.gate = RuntimeBoundaryRehearsal(self.history, self.coverage)
        self.gate.recover(self.history.snapshot(), ())
        for name in ('a', 'b'):
            self.gate.register(RuntimeBinding(name, ('shared-original',), 'command',
                                             'pod-' + name, ('node/boot/runtime',), 'physical'))

    def restart(self, snapshot=None, incarnations=('node/boot/runtime',)):
        gate = RuntimeBoundaryRehearsal(self.history, self.coverage)
        gate.recover(self.history.snapshot() if snapshot is None else snapshot, incarnations)
        return gate

    def queue(self, owner='a', operation='op', effect='start'):
        self.gate.intent(owner, operation, 'shim', effect, 'payload')
        self.gate.accept(owner, operation)

    def test_six_lost_reply_or_crash_cut_points(self):
        # Before intent; intent committed; forwarded/accepted; effect happened
        # but result lost; result committed/reply lost; T committed before B.
        for cut in range(6):
            with self.subTest(cut=cut):
                self.setUp()
                self.queue('b', 'sibling')
                self.gate.settle('b', 'sibling', ('sibling-process',))
                before = self.gate.inspect('b')
                if cut >= 1:
                    self.gate.intent('a', 'op', 'shim', 'start', 'payload')
                if cut >= 2:
                    self.gate.accept('a', 'op')
                if cut >= 4:
                    self.gate.settle('a', 'op', ('a-process',))
                if cut == 5:
                    self.gate.deny('a')
                self.gate = self.restart()
                self.gate.deny('a')
                if cut >= 2:
                    with self.assertRaises(Held):
                        self.gate.complete('a', ('node/boot/runtime',))
                    if cut < 4:
                        self.gate.settle('a', 'op', ('a-process',))
                    self.gate.stop('a', 'op', ('a-process',))
                result = self.gate.complete('a', ('node/boot/runtime',))
                self.assertEqual(result['kind'], 'synthetic-runtime-barrier')
                self.assertGreater(result['B'], result['T'])
                self.assertEqual(before, self.gate.inspect('b'))
                with self.assertRaises(Held):
                    self.gate.intent('a', 'new', 'shim', 'start', 'payload')

    def test_every_route_and_effect_required(self):
        for route in ROUTES:
            for effect in EFFECTS:
                gate = RuntimeBoundaryRehearsal(self.history, self.coverage - {(route, effect)})
                with self.assertRaises(Held):
                    gate.recover(self.history.snapshot(), ('node/boot/runtime',))

    def test_unknown_route_refused(self):
        with self.assertRaises(Held):
            self.gate.intent('a', 'op', 'alternate-unknown', 'exec', 'payload')

    def test_recovery_starts_held(self):
        gate = RuntimeBoundaryRehearsal(self.history, self.coverage)
        with self.assertRaises(Held):
            gate.deny('a')

    def test_joint_local_rollback_does_not_reset_retained_deny(self):
        old = self.history.snapshot()
        self.gate.deny('a')
        with self.assertRaises(Held):
            self.restart(old)
        gate = self.restart()
        with self.assertRaises(Held):
            gate.intent('a', 'new', 'cri', 'start', 'payload')

    def test_changed_history_requires_exact_recovery(self):
        second = self.restart()
        self.gate.deny('a')
        with self.assertRaises(Held):
            second.intent('b', 'op', 'cri', 'start', 'payload')

    def test_missing_or_extra_incarnation_blocks_recovery(self):
        for incarnations in ((), ('node/boot/runtime', 'unknown')):
            with self.assertRaises(Held):
                self.restart(incarnations=incarnations)

    def test_unknown_worker_blocks_barrier_indefinitely(self):
        self.queue()
        self.gate.deny('a')
        for _ in range(3):
            self.gate = self.restart()
            with self.assertRaises(Held):
                self.gate.complete('a', ('node/boot/runtime',))
        self.assertEqual('accepted', self.gate.inspect('a', 'op')['status'])

    def test_incomplete_incarnation_blocks_barrier(self):
        self.gate.deny('a')
        with self.assertRaises(Held):
            self.gate.complete('a', ())

    def test_each_write_requires_own_current_authorization(self):
        self.queue(effect='write')
        self.gate.deny('a')
        with self.assertRaises(Held):
            self.gate.intent('a', 'write2', 'shim', 'write', 'second-bytes')
        self.gate.settle('a', 'op', ('queued-write-worker',))
        with self.assertRaises(Held):
            self.gate.complete('a', ('node/boot/runtime',))
        self.gate.stop('a', 'op', ('queued-write-worker',))
        self.gate.complete('a', ('node/boot/runtime',))

    def test_inspection_is_copy_and_does_not_replay(self):
        self.queue()
        self.gate.inspect('a', 'op')['status'] = 'settled'
        self.assertEqual('accepted', self.gate.inspect('a', 'op')['status'])
        with self.assertRaises(Held):
            self.gate.intent('a', 'op', 'shim', 'start', 'payload')

    def test_alias_ownership_collision_and_wrong_stop_refused(self):
        self.queue('a', 'one')
        self.queue('b', 'two')
        self.gate.settle('a', 'one', ('one-process',))
        with self.assertRaises(Held):
            self.gate.settle('b', 'two', ('one-process',))
        with self.assertRaises(Held):
            self.gate.stop('a', 'one', ('two-process',))

    def test_no_effect_result_can_settle_after_deny(self):
        self.queue()
        self.gate.deny('a')
        self.gate.settle('a', 'op', ())
        self.gate.complete('a', ('node/boot/runtime',))

    def test_permanent_uid_and_original_scope_binding(self):
        self.gate.deny('a')
        self.gate.complete('a', ('node/boot/runtime',))
        self.gate = self.restart()
        with self.assertRaises(Held):
            self.gate.register(RuntimeBinding('new', ('new-family',), 'command',
                                             'pod-a', ('node/boot/runtime',), 'physical'))
        with self.assertRaises(Held):
            self.gate.register(RuntimeBinding('a', ('new-family',), 'command',
                                             'pod-a', ('node/boot/runtime',), 'physical'))

    def test_bounded_owners_and_effects(self):
        with self.assertRaises(Held):
            self.gate.register(RuntimeBinding('c', ('scope',), 'command', 'pod-c', ('node',), 'physical'))
        history = RetainedRuntimeRehearsal(max_effects=1)
        gate = RuntimeBoundaryRehearsal(history, self.coverage)
        gate.recover(history.snapshot(), ())
        gate.register(self.gate.inspect('a').binding)
        gate.intent('a', 'op', 'shim', 'start', 'payload')
        with self.assertRaises(Held):
            gate.intent('a', 'op2', 'shim', 'start', 'payload')

    def test_production_interface_defaults_refuse(self):
        backend = MandatoryRuntimeAuthority()
        calls = [
            ('recover_before_exposure', dict(runtime_identity=None, route_inventory=None,
                independent_history=None, unresolved_intents=None)),
            ('commit_prospective_intent', dict(binding=None, operation=None, route=None,
                effect=None, payload_hash=None, expected_history=None)),
            ('authorize_at_effect', dict(binding=None, operation=None, expected_history=None)),
            ('inspect_exact_intent', dict(binding=None, operation=None, challenge=None, minimum_history=None)),
            ('revoke_ordered', dict(binding=None, operation=None, expected_history=None)),
            ('inspect_completed_retirement', dict(binding=None, challenge=None, minimum_history=None)),
        ]
        for method, arguments in calls:
            with self.subTest(method=method), self.assertRaises(Held):
                getattr(backend, method)(**arguments)


if __name__ == '__main__':
    unittest.main()
