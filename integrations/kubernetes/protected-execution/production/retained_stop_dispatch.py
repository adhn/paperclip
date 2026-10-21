"""Exact retained-owner stop submission on a separate local control pipe.

Trusted installation supplies an immutable original binding and a private control
pipe already dedicated to that owner. No descriptor is discovered from a caller
PID, path, new epoch or replacement sandbox. The component owns actual durable
intent and atomic pipe submission, independently of a held new-work owner.

This is NOT installed runtime stop authority: a trusted receiver must authenticate
and interpret the exact original binding and own the actual stop. Enqueued bytes
prove neither consumption, termination, descendant exclusion nor retirement B.
No new-work route, arbitrary control payload, release or retry is exposed. Pipe,
SQLite, directory custody and rollback limits of PipeEffectOwner still apply.
"""
import hashlib
import json

from production.gateway import Held
from production.owned_effect_dispatch import PipeEffectOwner


class RetainedStopDispatch:
    def __init__(self, database, writer_fd, *, original_binding, generation=1):
        # Exact opaque bytes come from trusted retained custody, never route input.
        # Snapshot before taking descriptor custody. No canonicalization/rebinding.
        if type(original_binding) is not bytes or not 1 <= len(original_binding) <= 512:
            raise Held('bounded_original_stop_binding_required')
        import base64
        self._digest = hashlib.sha256(original_binding).hexdigest()
        self._payload = json.dumps({
            'version': 1, 'action': 'stop-exact-original',
            'originalBinding': base64.b64encode(original_binding).decode('ascii'),
            'originalBindingDigest': self._digest,
        }, sort_keys=True, separators=(',', ':')).encode()
        self._generation = generation
        self._owner = PipeEffectOwner(database, writer_fd, generation=generation,
                                      owner_binding=hashlib.sha256(
                                          b'paperclip.stop-exact-original.v1\x00' + original_binding).digest())

    def _exact(self, original_binding_digest):
        if type(original_binding_digest) is not str or original_binding_digest != self._digest:
            raise Held('original_stop_binding_mismatch')

    def request_stop(self, operation, *, original_binding_digest):
        """One actual exact pipe submission; uncertainty holds this control lane.

        No fallback to a replacement, signal-by-PID, or replay of an old intent.
        Caller-visible success is only local enqueue, never stopped/released.
        """
        self._exact(original_binding_digest)
        return self._owner.enqueue(operation, 'stop', self._payload,
                                   generation=self._generation)

    def inspect(self, operation, *, original_binding_digest):
        """Exact historical local submission only, including while stop is held."""
        self._exact(original_binding_digest)
        return self._owner.inspect(operation)

    def close(self):
        self._owner.close()
