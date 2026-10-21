"""Inspection-only history continuity component; no issuer, service or permission.

The separately pinned current witness MUST live outside both native and history
restore/admin domains, retain monotone generations and refuse retired identities.
Two matching restored snapshots cannot implement it. Signatures authenticate what
those missing authorities assert, not their placement or factual completeness.
No result authorizes append, retry, effect, release or revocation settlement.
An installed authority-owned transaction must recheck current history at effect.
"""
import copy
from dataclasses import dataclass

from legacy_review import ReviewHeld, canonical, digest
from production.evidence_bridge import MAX_BYTES, decode, exact, fresh, hexhash, integer, text

HISTORY_DOMAIN = b"paperclip-history-continuity-snapshot-v1\0"
WITNESS_DOMAIN = b"paperclip-history-independent-current-v1\0"
PIN_FIELDS = {"instance", "historyDomain", "historyIncarnation", "historyKeyHandle",
              "witnessDomain", "witnessIncarnation", "witnessKeyHandle", "generationFloor"}
HEAD_FIELDS = {"generation", "revision", "snapshotHash", "denialsHash", "operationsHash"}
OP_FIELDS = {"operationId", "kind", "source", "intentHash", "requestHash",
             "predecessorHash", "transactionHash"}
DENIAL_FIELDS = {"source", "sequence", "intentHash", "decisionHash", "denyOrder", "settlement"}


def _pins(pins):
    exact(pins, PIN_FIELDS)
    for key, value in pins.items():
        integer(value, 1) if key == "generationFloor" else text(value)
    if (pins["historyDomain"] == pins["witnessDomain"] or
            pins["historyKeyHandle"] == pins["witnessKeyHandle"]):
        raise ReviewHeld("continuity_independent_witness_required")


def _head(head, floor):
    exact(head, HEAD_FIELDS)
    integer(head["generation"], floor); integer(head["revision"], 1)
    hexhash(head["snapshotHash"]); hexhash(head["denialsHash"]); hexhash(head["operationsHash"])


def _operation(operation):
    exact(operation, OP_FIELDS)
    for key in ("operationId", "intentHash", "requestHash", "transactionHash"):
        hexhash(operation[key])
    if operation["predecessorHash"] is not None:
        hexhash(operation["predecessorHash"])
    text(operation["source"])
    if operation["kind"] not in ("native-admission-commit", "native-lifecycle-commit", "revoke"):
        raise ReviewHeld("continuity_typed_operation_required")


def _denials(rows):
    if type(rows) is not list or len(rows) > 4096:
        raise ReviewHeld("continuity_denial_inventory_required")
    seen = set()
    for row in rows:
        exact(row, DENIAL_FIELDS)
        text(row["source"]); integer(row["sequence"], 2); integer(row["denyOrder"], 1)
        hexhash(row["intentHash"]); hexhash(row["decisionHash"])
        if row["settlement"] not in ("pending", "settled"):
            raise ReviewHeld("continuity_denial_unsettled")
        key = (row["source"], row["sequence"])
        if key in seen:
            raise ReviewHeld("continuity_duplicate_denial")
        seen.add(key)
    if rows != sorted(rows, key=lambda row: (row["source"], row["sequence"])):
        raise ReviewHeld("continuity_canonical_denials_required")


def inspection_request(*, pins, operation, challenge, now):
    """Trusted caller supplies a fresh unguessable challenge per inspection.

    operation is the original durable pre-submission descriptor, never a new
    operation identity after response loss. Challenge generation/storage and
    protected outstanding-request ownership are installer responsibilities.
    """
    _pins(pins); _operation(operation); hexhash(challenge); integer(now, 1)
    return copy.deepcopy(dict(kind="history-continuity-inspect-v1", pins=pins,
                              operation=operation, challenge=challenge, now=now))


@dataclass(frozen=True)
class HistoricalOperationInspection:
    request_hash: str
    operation_hash: str
    generation: int
    revision: int
    outcome: str
    # Historical observation only. Deliberately no permit/current/retry flag.


class HistoryContinuityVerifier:
    def __init__(self, *, pins=None, verifier=None):
        if pins is None or verifier is None:
            raise ReviewHeld("continuity_protected_authorities_unavailable")
        _pins(pins)
        self._pins = copy.deepcopy(pins)
        self.verifier = verifier

    @property
    def pins(self):
        return copy.deepcopy(self._pins)

    def _signed(self, envelope, domain, handle):
        exact(envelope, {"body", "signature"}); text(envelope["signature"], 8192)
        body = envelope["body"]
        if type(body) is not dict:
            raise ReviewHeld("continuity_snapshot_object_required")
        try:
            encoded = canonical(body)
            if len(encoded) > MAX_BYTES:
                raise ReviewHeld("continuity_snapshot_size_limit")
            decode(encoded)  # Shared JSON depth/node/string/scalar limits.
        except (TypeError, RecursionError, UnicodeError):
            raise ReviewHeld("continuity_snapshot_encoding") from None
        try:
            valid = self.verifier.verify(handle, domain + encoded, envelope["signature"])
        except Exception:
            raise ReviewHeld("continuity_signature_unavailable") from None
        if valid is not True:
            raise ReviewHeld("continuity_signature_invalid")
        return body

    def inspect(self, *, request, snapshot, witness, checkpoint, now):
        """Compare exact uncertain operation and independently witnessed history.

        checkpoint is installed protected monotone state outside native/history
        restores, NOT request-supplied history or a local SQLite current flag.
        Cold bootstrap, witness rollover and checkpoint CAS need explicit review.
        The method neither updates checkpoint nor resolves a pending operation.
        A caller must not turn 'not-recorded' into safe replay advice.
        """
        integer(now, 1)
        exact(request, {"kind", "pins", "operation", "challenge", "now"})
        _pins(request["pins"])
        expected = inspection_request(pins=self._pins, operation=request["operation"],
                                      challenge=request["challenge"], now=request["now"])
        if canonical(expected) != canonical(request) or not now - 1000 <= request["now"] <= now:
            raise ReviewHeld("continuity_exact_fresh_request_required")
        exact(checkpoint, {"pins", "head", "denials", "operations"})
        _pins(checkpoint["pins"])
        if canonical(checkpoint["pins"]) != canonical(self._pins):
            raise ReviewHeld("continuity_checkpoint_identity")
        _head(checkpoint["head"], self._pins["generationFloor"])
        _denials(checkpoint["denials"])
        if digest(checkpoint["denials"]) != checkpoint["head"]["denialsHash"]:
            raise ReviewHeld("continuity_checkpoint_denials")
        if (type(checkpoint["operations"]) is not list or len(checkpoint["operations"]) > 4096 or
                digest(checkpoint["operations"]) != checkpoint["head"]["operationsHash"]):
            raise ReviewHeld("continuity_checkpoint_operations")
        prior_ids = set()
        for prior in checkpoint["operations"]:
            exact(prior, {"operation", "outcome"}); _operation(prior["operation"])
            if prior["operation"]["operationId"] in prior_ids or prior["outcome"] not in (
                    "not-recorded", "uncertain", "committed-exact", "revoked-settled"):
                raise ReviewHeld("continuity_checkpoint_operations")
            prior_ids.add(prior["operation"]["operationId"])
        body = self._signed(snapshot, HISTORY_DOMAIN, self._pins["historyKeyHandle"])
        exact(body, {"kind", "pins", "generation", "revision", "inventoryHash", "denials", "operations"})
        if body["kind"] != "history-continuity-snapshot-v1" or canonical(body["pins"]) != canonical(self._pins):
            raise ReviewHeld("continuity_history_identity")
        integer(body["generation"], self._pins["generationFloor"]); integer(body["revision"], 1)
        hexhash(body["inventoryHash"]); _denials(body["denials"])
        records = body["operations"]
        if type(records) is not list or not 0 < len(records) <= 4096:
            raise ReviewHeld("continuity_operation_inventory_required")
        seen, record = set(), None
        for row in records:
            exact(row, {"operation", "outcome"}); _operation(row["operation"])
            op = row["operation"]
            if op["operationId"] in seen:
                raise ReviewHeld("continuity_duplicate_operation")
            seen.add(op["operationId"])
            if row["outcome"] not in ("not-recorded", "uncertain", "committed-exact", "revoked-settled"):
                raise ReviewHeld("continuity_unknown_outcome")
            if row["outcome"] == "revoked-settled":
                if op["kind"] != "revoke" or not any(denial["source"] == op["source"] and
                        denial["intentHash"] == op["intentHash"] and denial["settlement"] == "settled"
                        for denial in body["denials"]):
                    raise ReviewHeld("continuity_revocation_not_settled")
            if op["operationId"] == request["operation"]["operationId"]:
                record = row
        if records != sorted(records, key=lambda row: row["operation"]["operationId"]):
            raise ReviewHeld("continuity_canonical_operations_required")
        if record is None:
            raise ReviewHeld("continuity_unknown_operation_held")
        if canonical(record["operation"]) != canonical(request["operation"]):
            raise ReviewHeld("continuity_exact_uncertain_operation_required")
        current = dict(generation=body["generation"], revision=body["revision"],
                       snapshotHash=digest(body), denialsHash=digest(body["denials"]), operationsHash=digest(records))
        proof = self._signed(witness, WITNESS_DOMAIN, self._pins["witnessKeyHandle"])
        exact(proof, {"kind", "pins", "requestHash", "head", "observedAt", "expiresAt"})
        _head(proof["head"], self._pins["generationFloor"]); fresh(proof, now)
        if (proof["kind"] != "history-independent-current-v1" or
                canonical(proof["pins"]) != canonical(self._pins) or
                proof["requestHash"] != digest(request) or proof["observedAt"] < request["now"] or
                canonical(proof["head"]) != canonical(current)):
            raise ReviewHeld("continuity_independent_current_binding")
        old = checkpoint["head"]
        if current["generation"] < old["generation"] or current["revision"] < old["revision"]:
            raise ReviewHeld("continuity_history_rollback")
        if current["revision"] == old["revision"] and current != old:
            raise ReviewHeld("continuity_same_revision_fork")
        new_denials = {(row["source"], row["sequence"]): row for row in body["denials"]}
        for prior in checkpoint["denials"]:
            newer = new_denials.get((prior["source"], prior["sequence"]))
            if newer is None or any(newer[key] != prior[key] for key in DENIAL_FIELDS - {"settlement"}):
                raise ReviewHeld("continuity_revocation_lost_or_rewritten")
            if prior["settlement"] == "settled" and newer["settlement"] != "settled":
                raise ReviewHeld("continuity_revocation_regressed")
        current_ops = {row["operation"]["operationId"]: row for row in records}
        for prior in checkpoint["operations"]:
            newer = current_ops.get(prior["operation"]["operationId"])
            if newer is None or canonical(newer["operation"]) != canonical(prior["operation"]):
                raise ReviewHeld("continuity_uncertain_operation_lost_or_rewritten")
            old_outcome, new_outcome = prior["outcome"], newer["outcome"]
            if ((old_outcome in ("committed-exact", "revoked-settled") and new_outcome != old_outcome) or
                    (old_outcome == "uncertain" and new_outcome == "not-recorded")):
                raise ReviewHeld("continuity_operation_outcome_regressed")
        return HistoricalOperationInspection(digest(request), digest(record["operation"]),
                                             body["generation"], body["revision"], record["outcome"])
