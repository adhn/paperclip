"""Local owned adapter contracts; no physical runtime/retirement acceptance."""
import threading
import time
import unittest

from production.gateway import Held
from production.runtime_boundary import MandatoryRuntimeAuthority, RuntimeBinding
from production.runtime_owned import RuntimeAuthorityOwner


BINDING = RuntimeBinding('original', ('shared-original',), 'command', 'pod', ('boot',), 'physical')
RECOVERY = dict(runtime_identity='runtime', route_inventory=[], independent_history='head', unresolved_intents=[])


class Backend(MandatoryRuntimeAuthority):
    def __init__(self):
        self.revoked, self.intent, self.effects = False, None, 0

    def recover_before_exposure(self, **arguments):
        if arguments['runtime_identity'] == 'blocked':
            time.sleep(20)
        if arguments['runtime_identity'] == 'refused':
            raise Held('recovery_refused')
        if arguments['runtime_identity'] == 'malformed':
            return {'recovered': True}

    def commit_prospective_intent(self, **arguments):
        if self.revoked or self.intent is not None:
            raise Held('held')
        self.intent = arguments['operation']
        return {'retained': self.intent}

    def execute_at_effect(self, **arguments):
        if self.revoked or self.intent != arguments['operation'] or self.effects:
            raise Held('held')
        if arguments['expected_history'] == 'blocked':
            time.sleep(20)
        self.effects += 1
        return {'completed': arguments['operation'], 'effects': self.effects}

    def revoke_ordered(self, **arguments):
        self.revoked = True
        return {'revoked': True}

    def inspect_exact_intent(self, **arguments):
        return {'intent': self.intent, 'effects': self.effects, 'revoked': self.revoked}


def factory():
    return Backend()


def unavailable_factory():
    return MandatoryRuntimeAuthority()


class OwnedRuntimeContracts(unittest.TestCase):
    def owner(self, backend_factory=factory):
        owner = RuntimeAuthorityOwner(backend_factory)
        self.addCleanup(owner.close)
        return owner

    def call(self, owner, action, **arguments):
        return owner.call(action, deadline=time.monotonic() + 1, **arguments)

    def recover(self, owner, identity='runtime'):
        return self.call(owner, 'recover_before_exposure', **dict(RECOVERY, runtime_identity=identity))

    def commit(self, owner):
        return self.call(owner, 'commit_prospective_intent', binding=BINDING,
                         operation='one', route='cri', effect='exec', payload_hash='hash', expected_history='head')

    def execute(self, owner):
        return self.call(owner, 'execute_at_effect', binding=BINDING, operation='one', expected_history='head')

    def test_recovery_required_and_completion_does_not_permit_replay(self):
        owner = self.owner()
        with self.assertRaises(Held):
            self.commit(owner)
        self.recover(owner)
        self.commit(owner)
        self.assertEqual(self.execute(owner), {'completed': 'one', 'effects': 1})
        with self.assertRaises(Held):
            self.execute(owner)

    def test_recovery_refusal_and_bad_reply_close_gate(self):
        for identity in ('refused', 'malformed'):
            owner = self.owner()
            self.recover(owner)
            with self.assertRaises(Held):
                self.recover(owner, identity)
            with self.assertRaises(Held):
                self.commit(owner)

    def test_revoke_can_run_before_recovery_and_blocks_later_effect(self):
        owner = self.owner()
        self.call(owner, 'revoke_ordered', binding=BINDING, operation='one', expected_history='head')
        self.recover(owner)
        with self.assertRaises(Held):
            self.commit(owner)
        result = self.call(owner, 'inspect_exact_intent', binding=BINDING, operation='one', challenge='fresh', minimum_history='head')
        self.assertTrue(result['revoked'])
        self.assertEqual(result['effects'], 0)

    def test_atomic_backend_entry_rechecks_revocation_after_committed_intent(self):
        owner = self.owner()
        self.recover(owner)
        self.commit(owner)
        self.call(owner, 'revoke_ordered', binding=BINDING, operation='one', expected_history='head')
        with self.assertRaises(Held):
            self.execute(owner)

    def test_default_backend_never_recovers(self):
        owner = self.owner(unavailable_factory)
        with self.assertRaises(Held):
            self.recover(owner)
        with self.assertRaises(Held):
            self.commit(owner)

    def test_synchronous_recovery_is_killed_and_never_replaced(self):
        owner = self.owner()
        started = time.monotonic()
        with self.assertRaises(Held):
            owner.call('recover_before_exposure', deadline=started + .1,
                       **dict(RECOVERY, runtime_identity='blocked'))
        self.assertLess(time.monotonic() - started, .8)
        self.assertFalse(owner._worker._process.is_alive())
        with self.assertRaises(Held):
            self.recover(owner)

    def test_effect_cancellation_owns_blocking_backend_and_preserves_unknown(self):
        owner = self.owner()
        self.recover(owner)
        self.commit(owner)
        cancel = threading.Event()
        timer = threading.Timer(.1, cancel.set)
        timer.start()
        try:
            with self.assertRaises(Held):
                owner.call('execute_at_effect', deadline=time.monotonic() + 2,
                           cancel=cancel, binding=BINDING, operation='one', expected_history='blocked')
        finally:
            timer.cancel()
        self.assertFalse(owner._worker._process.is_alive())
        with self.assertRaises(Held):
            self.execute(owner)

    def test_no_generic_dispatch_body_or_authorization_permit(self):
        owner = self.owner()
        for operation, arguments in [('authorize_at_effect', {}), ('execute_at_effect',
                dict(binding=BINDING, operation='one', expected_history='head', command='echo bypass'))]:
            with self.assertRaises(Held):
                self.call(owner, operation, **arguments)


if __name__ == '__main__':
    unittest.main()
