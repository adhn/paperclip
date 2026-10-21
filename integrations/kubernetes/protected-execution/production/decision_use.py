"""Ordered use/revoke interface; no production backend or effect executor.

An observation is never an authorization. The backend must own execution itself,
serialize every effect with deny intent, retain unfinished pre-deny work, and keep
history/replay state outside native rollback. This adapter cannot create that
ordering by checking a signature before a caller executes an effect.
"""
import copy
import time
import uuid
from typing import Protocol
from legacy_review import ReviewHeld, canonical, digest
from production.decision_history import build_use_request, pins_valid
from production.evidence_bridge import exact, fresh, hexhash, integer, text

DOMAIN = b"paperclip-legacy-ordered-effect-v1\0"


class OrderedDecisionAuthority(Protocol):
    """Protected cancellable worker protocol; not implemented by a file observer.

    execute owns the typed effect AND current full-history verification in one
    ordered boundary. No caller callback, shell command, URL, or permit is allowed.
    effectId is durably consumed before effects; duplicates inspect, never replay.
    revoke first persists deny intent, blocks future use, then settles/stops all
    admitted work before reporting revoked. Missing completion stays occupied.
    Losing transport must not cancel ownership or imply effects did not happen.
    revoke must independently resolve intentHash to the complete previously
    retained prospective intent, verify its action is revoke and compare every
    supplied reference, original hold, full inventory, operator approval and CAS
    predecessor. A caller-supplied digest alone is never revocation authority.
    deadline_at is a bounded wall-clock deadline, also signed into the request.
    Caller deadline requires worker ownership, not just a socket timeout. Passing
    it to this synchronous protocol DOES NOT implement cancellation or a timeout;
    an unresponsive backend can still block this adapter. No native call exists.
    """
    def execute(self, request: dict, *, deadline_at: int) -> dict: ...
    def revoke(self, request: dict, *, deadline_at: int) -> dict: ...
    def inspect(self, request: dict, *, deadline_at: int) -> dict: ...


class OrderedDecisionUse:
    def __init__(self, *, pins=None, verifier=None, authority=None, clock=None, operation_timeout_ms=1000):
        if pins is None or verifier is None or authority is None:
            raise ReviewHeld("ordered_decision_authority_unavailable")
        pins_valid(pins)
        integer(operation_timeout_ms, 1)
        if operation_timeout_ms > 5000:
            raise ReviewHeld("ordered_effect_deadline_bound")
        self.operation_timeout_ms = operation_timeout_ms
        self.pins = copy.deepcopy(pins)
        self.verifier, self.authority = verifier, authority
        self.clock = clock or (lambda: int(time.time() * 1000))

    def execute(self, *, holds, accepted, purpose, challenge, now, effect):
        # Descriptor targets a protected native transaction executor, not Python
        # callbacks or native follow-up effects after a permit has been returned.
        exact(effect, {"effectId", "transactionHash", "operation"})
        hexhash(effect["effectId"]); hexhash(effect["transactionHash"])
        if effect["operation"] != {"admission": "native-admission-commit", "lifecycle": "native-lifecycle-commit"}.get(purpose):
            raise ReviewHeld("ordered_effect_purpose")
        use = build_use_request(pins=self.pins, holds=holds, accepted=accepted,
                                purpose=purpose, challenge=challenge, now=now)
        request = dict(kind="legacy-ordered-effect-v1", use=use, effect=copy.deepcopy(effect))
        return self._call("execute", request, now)

    def revoke(self, *, intent, challenge, now):
        exact(intent, {"source", "holdHash", "sequence", "previousHash", "decisionHash", "intentHash"})
        text(intent["source"]); integer(intent["sequence"], 2)
        for key in ("holdHash", "previousHash", "decisionHash", "intentHash"):
            hexhash(intent[key])
        source = intent["source"]
        try:
            valid_source = source.startswith("lease:") and str(uuid.UUID(source[6:])) == source[6:]
        except (ValueError, TypeError, AttributeError):
            valid_source = False
        if not valid_source:
            raise ReviewHeld("ordered_revoke_source")
        hexhash(challenge); integer(now, 1)
        request = dict(kind="legacy-ordered-revoke-v1", pins=copy.deepcopy(self.pins),
                       intent=copy.deepcopy(intent), challenge=challenge, now=now)
        return self._call("revoke", request, now)

    def inspect(self, *, request_hash, effect_id, challenge, now):
        """Resolve exact uncertain completion without retrying the effect."""
        for value in (request_hash, effect_id, challenge):
            hexhash(value)
        integer(now, 1)
        request = dict(kind="legacy-ordered-inspection-v1", pins=copy.deepcopy(self.pins),
                       requestHash=request_hash, effectId=effect_id, challenge=challenge, now=now)
        return self._call("inspect", request, now)

    def _call(self, operation, request, now):
        started = self.clock(); integer(started, 1)
        if not started - 1000 <= now <= started:
            raise ReviewHeld("ordered_effect_request_clock")
        deadline = started + self.operation_timeout_ms
        integer(deadline, 1)
        request = {**request, "deadlineAt": deadline}
        expected_hash = digest(request)
        try:
            envelope = getattr(self.authority, operation)(copy.deepcopy(request), deadline_at=deadline)
        except Exception:
            raise ReviewHeld("ordered_effect_uncertain_inspect_required") from None
        exact(envelope, {"body", "signature"})
        body = envelope["body"]
        exact(body, {"kind", "pins", "requestHash", "historyRevision", "order", "status", "observedAt", "expiresAt"})
        text(envelope["signature"], 8192)
        try:
            verified = self.verifier.verify(self.pins["verifierKeyHandle"], DOMAIN + canonical(body), envelope["signature"])
        except Exception:
            raise ReviewHeld("ordered_effect_verification_unavailable") from None
        if verified is not True:
            raise ReviewHeld("ordered_effect_signature")
        if (body["kind"] != "legacy-ordered-completion-v1" or canonical(body["pins"]) != canonical(self.pins)
                or body["requestHash"] != expected_hash):
            raise ReviewHeld("ordered_effect_binding")
        integer(body["historyRevision"], self.pins["historyFloor"]); integer(body["order"], 1)
        completed = self.clock(); integer(completed, 1)
        if completed < started:
            raise ReviewHeld("ordered_effect_clock_regressed")
        if completed >= deadline:
            raise ReviewHeld("ordered_effect_deadline_uncertain_inspect_required")
        fresh(body, completed)
        if body["observedAt"] < now or body["status"] != {"execute": "effect-completed", "revoke": "revoked-settled", "inspect": "effect-completed"}[operation]:
            raise ReviewHeld("ordered_effect_unsettled")
        # Historical completion only; callers may inspect it, never use as a permit.
        return {"requestHash": expected_hash, "order": body["order"], "status": body["status"]}
