"""Fail-closed verifier contract for independently retained legacy history.

No issuer, signer, key, transport or durable ledger is implemented here. A valid
observation is NOT a use permit: the native caller still needs a mandatory
ordered use/revocation guard spanning its actual effect. Never cache observations
as accepted-decision authority, including across a database restore.
"""
from dataclasses import dataclass
from typing import Protocol
import copy
import uuid

from legacy_review import BINDINGS, ReviewHeld, canonical, digest
from production.evidence_bridge import exact, fresh, hexhash, integer, text

PINS = {"instance", "authorityIncarnation", "historyDomain", "historyIncarnation", "historyFloor", "verifierKeyHandle"}
REF = {"source", "holdHash", "sequence", "decisionHash"}
PURPOSES = {"admission", "lifecycle"}
DOMAIN = b"paperclip-legacy-current-history-v1\0"


class ProtectedSignatureVerifier(Protocol):
    """Verify only. Implementations must not expose secret/MAC or signing access.

    key_handle names a separately protected pinned public verification identity,
    not a caller path, URL, supplied public key or issuer echo. Key rotation and
    retired-key denial require independent protected installation/review.
    """
    def verify(self, key_handle: str, message: bytes, signature: str) -> bool: ...


class CurrentHistoryIssuer(Protocol):
    """Absent production issuer/request channel; declaration is not authority.

    Own complete source histories and prospective/uncertain append intents
    outside Paperclip DB/files rollback. Resolve full original closure itself;
    never trust requester omission or copy its latest decisions into a response.
    Transport must have cancellable operation ownership; a socket timer alone
    cannot bound a synchronous backend. No implementation is installed here.
    """
    def observe(self, request: dict) -> dict: ...


@dataclass(frozen=True)
class CurrentHistoryObservation:
    request_hash: str
    history_revision: int
    expires_at: int
    # Deliberately no "authorized", reusable permit or executable callback.


def pins_valid(pins):
    exact(pins, PINS)
    for key, value in pins.items():
        integer(value, 1) if key == "historyFloor" else text(value)


def original_hold(hold):
    exact(hold, BINDINGS)
    for key in ("companyId", "agentId", "runId", "leaseId", "environmentId", "epoch"):
        try:
            valid = type(hold[key]) is str and str(uuid.UUID(hold[key])) == hold[key]
        except (ValueError, TypeError, AttributeError):
            valid = False
        if not valid:
            raise ReviewHeld("history_original_uuid_required")
    if hold["source"] != "lease:" + hold["leaseId"]:
        raise ReviewHeld("history_supported_original_source_required")
    hexhash(hold["holdHash"]); hexhash(hold["policyHash"])
    scopes = hold["scopes"]
    if type(scopes) is not list or not 0 < len(scopes) <= 64:
        raise ReviewHeld("history_exact_original_scopes_required")
    for scope in scopes:
        text(scope)
    if len(set(scopes)) != len(scopes):
        raise ReviewHeld("history_exact_original_scopes_required")


def build_use_request(*, pins, holds, accepted, purpose, challenge, now):
    """Trusted native full inventory only; issuer must independently confirm it.

    Historical policy/epoch/scopes are preserved exactly, not normalized to
    current policy or expanded into reservation scopes. No source is filtered.
    accepted is the local immutable decision reference for EVERY original hold.
    Missing local reconciliation refuses before consulting external authority.
    """
    pins_valid(pins); hexhash(challenge); integer(now, 1)
    if type(purpose) is not str or purpose not in PURPOSES:
        raise ReviewHeld("history_use_purpose")
    if type(holds) is not list or not 0 < len(holds) <= 256 or type(accepted) is not list or len(accepted) != len(holds):
        raise ReviewHeld("history_complete_closure_required")
    for hold in holds:
        original_hold(hold)
    originals = {h["source"]: h for h in holds}
    if len(originals) != len(holds):
        raise ReviewHeld("history_duplicate_source")
    refs = {}
    for reference in accepted:
        exact(reference, REF)
        text(reference["source"]); integer(reference["sequence"], 1)
        hexhash(reference["decisionHash"]); hexhash(reference["holdHash"])
        source = reference["source"]
        if source in refs or source not in originals or reference["holdHash"] != originals[source]["holdHash"]:
            raise ReviewHeld("history_complete_closure_required")
        refs[source] = reference
    closure = [{"hold": originals[source], "accepted": refs[source]} for source in sorted(originals)]
    return copy.deepcopy(dict(kind="legacy-current-use-request-v1", pins=pins, closure=closure,
                              closureHash=digest(closure), purpose=purpose, challenge=challenge, now=now))


class CurrentHistoryVerifier:
    """Pure verification component. Defaults refuse; no import starts an issuer.

    Constructor inputs must come from separately protected installer/native pins,
    never from a response/request. It is not wired into production native use.
    """
    def __init__(self, *, pins=None, verifier=None):
        if pins is None or verifier is None:
            raise ReviewHeld("history_protected_verifier_unavailable")
        pins_valid(pins)
        self.pins = copy.deepcopy(pins)
        self.verifier = verifier

    def verify_use(self, request, envelope, *, now):
        integer(now, 1)
        exact(request, {"kind", "pins", "closure", "closureHash", "purpose", "challenge", "now"})
        if request["kind"] != "legacy-current-use-request-v1" or canonical(request["pins"]) != canonical(self.pins):
            raise ReviewHeld("history_protected_pins_mismatch")
        if type(request["closure"]) is not list or not 0 < len(request["closure"]) <= 256:
            raise ReviewHeld("history_complete_closure_required")
        holds, accepted = [], []
        for row in request["closure"]:
            exact(row, {"hold", "accepted"})
            holds.append(row["hold"]); accepted.append(row["accepted"])
        rebuilt = build_use_request(pins=self.pins, holds=holds, accepted=accepted,
                                    purpose=request["purpose"], challenge=request["challenge"], now=request["now"])
        if canonical(rebuilt) != canonical(request) or not now - 1000 <= request["now"] <= now:
            raise ReviewHeld("history_exact_fresh_request_required")
        exact(envelope, {"body", "signature"})
        body = envelope["body"]
        exact(body, {"kind", "pins", "requestHash", "closureHash", "historyRevision", "closureStatus", "latest", "observedAt", "expiresAt"})
        text(envelope["signature"], 8192)
        # No readable MAC root in the reviewer. An absent/failing verifier holds.
        try:
            verified = self.verifier.verify(self.pins["verifierKeyHandle"], DOMAIN + canonical(body), envelope["signature"])
        except Exception:
            raise ReviewHeld("history_signature_unavailable") from None
        if verified is not True:
            raise ReviewHeld("history_signature_invalid")
        if (body["kind"] != "legacy-current-use-observation-v1" or canonical(body["pins"]) != canonical(self.pins) or
                body["requestHash"] != digest(request) or body["closureHash"] != request["closureHash"]):
            raise ReviewHeld("history_exact_use_binding_required")
        integer(body["historyRevision"], self.pins["historyFloor"])
        expires = fresh(body, now)
        if body["observedAt"] < request["now"] or body["closureStatus"] != "complete-current":
            raise ReviewHeld("history_independent_complete_closure_required")
        latest = body["latest"]
        if type(latest) is not list or len(latest) != len(accepted):
            raise ReviewHeld("history_complete_latest_required")
        expected = {ref["source"]: ref for ref in accepted}
        seen = set()
        for current in latest:
            exact(current, REF | {"action", "status", "intentHash"})
            source = current["source"]
            text(source); integer(current["sequence"], 1)
            hexhash(current["holdHash"]); hexhash(current["decisionHash"]); hexhash(current["intentHash"])
            if source in seen or source not in expected:
                raise ReviewHeld("history_complete_latest_required")
            seen.add(source)
            if current["status"] != "committed-exact" or current["action"] != "reconcile":
                raise ReviewHeld("history_revoked_or_uncertain")
            if any(current[key] != expected[source][key] for key in REF):
                raise ReviewHeld("history_local_rollback_or_conflict")
        return CurrentHistoryObservation(digest(request), body["historyRevision"], expires)


class ProspectiveDecisionIssuer(Protocol):
    """Separately protected issuer; no implementation or signing access here.

    prepare retains the exact prospective intent before any native append and
    independently verifies full inventory, evidence and operator consent. CAS
    covers predecessor, history incarnation and high-water state outside native
    rollback. inspect must read retained state, including uncertain intents;
    absence never licenses an append retry. Keys remain issuer-only and retired
    identities cannot be resurrected by restoring native DB/files.
    """
    def prepare(self, request: dict) -> dict: ...
    def inspect(self, request: dict) -> dict: ...


INTENT_DOMAIN = b"paperclip-legacy-prospective-inspection-v1\0"


def build_intent_request(*, pins, hold, sequence, previous_hash, decision_hash,
                         inventory_hash, approval_hash, action, challenge, now):
    """Exact prospective append identity, retained BEFORE any native append.

    The issuer independently resolves full inventory and approval; hashes are not
    evidence by themselves. An uncertain append is inspected under this exact
    intent, never replaced with a new sequence or replayed on timeout.
    """
    pins_valid(pins); original_hold(hold); integer(sequence, 1)
    for value in (decision_hash, inventory_hash, approval_hash, challenge):
        hexhash(value)
    integer(now, 1)
    if action not in ("reconcile", "revoke") or (sequence == 1) != (previous_hash is None):
        raise ReviewHeld("history_append_intent_cas")
    if previous_hash is not None:
        hexhash(previous_hash)
    if action == "revoke" and sequence == 1:
        raise ReviewHeld("history_revoke_predecessor_required")
    intent = dict(hold=copy.deepcopy(hold), sequence=sequence, previousHash=previous_hash,
                  decisionHash=decision_hash, inventoryHash=inventory_hash,
                  approvalHash=approval_hash, action=action)
    return dict(kind="legacy-prospective-inspection-request-v1", pins=copy.deepcopy(pins),
                intent=intent, intentHash=digest(intent), challenge=challenge, now=now)


def verify_intent_inspection(*, pins, verifier, request, envelope, now):
    """Returns exact observation, never append/use permission or retry advice."""
    pins_valid(pins); integer(now, 1)
    exact(request, {"kind", "pins", "intent", "intentHash", "challenge", "now"})
    intent = request["intent"]
    exact(intent, {"hold", "sequence", "previousHash", "decisionHash", "inventoryHash", "approvalHash", "action"})
    rebuilt = build_intent_request(pins=pins, hold=intent["hold"], sequence=intent["sequence"],
        previous_hash=intent["previousHash"], decision_hash=intent["decisionHash"],
        inventory_hash=intent["inventoryHash"], approval_hash=intent["approvalHash"],
        action=intent["action"], challenge=request["challenge"], now=request["now"])
    if canonical(rebuilt) != canonical(request) or not now - 1000 <= request["now"] <= now:
        raise ReviewHeld("history_exact_intent_required")
    exact(envelope, {"body", "signature"}); text(envelope["signature"], 8192)
    body = envelope["body"]
    exact(body, {"kind", "pins", "requestHash", "intentHash", "historyRevision", "status", "observedAt", "expiresAt"})
    try:
        verified = verifier.verify(pins["verifierKeyHandle"], INTENT_DOMAIN + canonical(body), envelope["signature"])
    except Exception:
        raise ReviewHeld("history_intent_verifier_unavailable") from None
    if verified is not True:
        raise ReviewHeld("history_intent_signature")
    if (body["kind"] != "legacy-prospective-inspection-v1" or canonical(body["pins"]) != canonical(pins)
            or body["requestHash"] != digest(request) or body["intentHash"] != request["intentHash"]):
        raise ReviewHeld("history_intent_binding")
    integer(body["historyRevision"], pins["historyFloor"]); fresh(body, now)
    if body["observedAt"] < request["now"] or body["status"] != "committed-exact":
        raise ReviewHeld("history_prospective_or_uncertain_remains_held")
    return CurrentHistoryObservation(digest(request), body["historyRevision"], body["expiresAt"])
