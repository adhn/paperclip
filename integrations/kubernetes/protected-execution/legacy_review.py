"""Offline present-day legacy evidence review; never signs or appends decisions.

All trust roots are supplied by the protected host, never by an evidence bundle.
This validates a contract, not a real node/route/storage observation. Production
issuers and independent review remain rollout gates. Synthetic roots prove tests
only and cannot establish facts about the historical A holds.
"""
import hashlib
import hmac
import json
import re


class ReviewHeld(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


DOMAINS = ("route", "retirement", "stop", "workspace", "session", "credential", "operator")
BINDINGS = ("source", "holdHash", "companyId", "agentId", "runId", "leaseId", "environmentId", "scopes", "policyHash", "epoch")


def review_legacy_decision(decision, artifacts, roots, *, now):
    """Return immutable artifact hashes after exact, independently trusted review.

    Does not release holds, create receipts, alter lifecycle or produce a MAC for
    the native decision. It is intentionally unsuitable as an operational signer.
    Every artifact is bound to one original hold, not only its shared scopes.
    """
    if set(roots) != set(DOMAINS) or any(not isinstance(k, bytes) or len(k) < 32 for k in roots.values()):
        raise ReviewHeld("protected_trust_roots_required")
    # Each authority/domain has a distinct root. A provider key cannot act as a
    # stop observer or an operator, even in an accidentally collapsed install.
    if len(set(roots.values())) != len(DOMAINS):
        raise ReviewHeld("independent_roots_required")
    if set(artifacts) != set(DOMAINS):
        raise ReviewHeld("complete_evidence_required")
    if decision.get("action") not in ("reconcile", "revoke") or decision.get("kind") != "present-day-legacy-reconciliation-v1":
        raise ReviewHeld("review_only_reconciliation")
    if not all(key in decision for key in BINDINGS) or decision["source"] != "lease:" + decision["leaseId"]:
        raise ReviewHeld("original_lease_required")
    if not isinstance(decision["scopes"], list) or not decision["scopes"] or len(set(decision["scopes"])) != len(decision["scopes"]):
        raise ReviewHeld("exact_scopes_required")
    expected_hashes = {"route": decision.get("routeRevocationHash"), "retirement": decision.get("retiredIncarnationHash"),
        "stop": decision.get("wholePodStopHash"), "operator": decision.get("operatorApprovalHash"), **decision.get("restoration", {})}
    verified = {}
    for domain in DOMAINS:
        envelope = artifacts[domain]
        if not isinstance(envelope, dict) or set(envelope) != {"body", "mac"}:
            raise ReviewHeld("artifact_envelope")
        body = envelope["body"]
        expected = hmac.digest(roots[domain], b"paperclip-legacy-review-v1\0" + domain.encode() + b"\0" + canonical(body), "sha256").hex()
        if not isinstance(envelope["mac"], str) or not hmac.compare_digest(envelope["mac"], expected):
            raise ReviewHeld("artifact_authentication")
        if body.get("kind") != "legacy-" + domain + "-evidence-v1" or body.get("outcome") != "verified":
            raise ReviewHeld("artifact_unverified")
        if any(body.get(key) != decision[key] for key in BINDINGS):
            raise ReviewHeld("artifact_original_hold_binding")
        observed, expires = body.get("observedAt"), body.get("expiresAt")
        if type(observed) is not int or type(expires) is not int or not now - 3_600_000 <= observed <= now < expires <= observed + 3_600_000:
            raise ReviewHeld("artifact_freshness")
        if not isinstance(body.get("evidenceHash"), str) or not re.fullmatch("[a-f0-9]{64}", body["evidenceHash"]):
            raise ReviewHeld("artifact_evidence_hash")
        if not re.fullmatch("[a-f0-9]{64}", expected_hashes.get(domain, "")) or digest(body) != expected_hashes[domain]:
            raise ReviewHeld("artifact_decision_hash")
        verified[domain] = digest(body)
    # Operator approval signs the exact independently verified artifacts. It cannot
    # be copied onto a changed stop/route/state bundle with a newly invented hash.
    approved = artifacts["operator"]["body"].get("approvedArtifacts")
    if (approved != {key: value for key, value in verified.items() if key != "operator"}
        or artifacts["operator"]["body"].get("approvedAction") != decision["action"]):
        raise ReviewHeld("operator_bundle_binding")
    # Explicit conservative revoke path uses the same complete independently
    # authenticated bundle. It grants no reconciliation: native action=revoke
    # appends history and restores occupancy; it never deletes accepted facts.
    review_expiry = min(envelope["body"]["expiresAt"] for envelope in artifacts.values())
    if "expiresAt" in decision:
        if type(decision["expiresAt"]) is not int or decision["expiresAt"] <= now:
            raise ReviewHeld("decision_freshness")
        review_expiry = min(review_expiry, decision["expiresAt"])
    return {"decisionHash": digest(decision), "artifacts": verified,
            "expiresAt": review_expiry,
            "operationalAcceptance": False}


def review_shared_holds(holds, bundles, roots, *, now):
    """Require an independently reviewed exact bundle for every original hold."""
    sources = [hold["source"] for hold in holds]
    if not sources or len(set(sources)) != len(sources) or set(sources) != set(bundles):
        raise ReviewHeld("every_original_shared_hold_required")
    results = {}
    for hold in holds:
        bundle = bundles[hold["source"]]
        decision = bundle["decision"]
        if any(decision.get(key) != hold.get(key) for key in BINDINGS):
            raise ReviewHeld("shared_hold_changed")
        results[hold["source"]] = review_legacy_decision(decision, bundle["artifacts"], roots, now=now)
    return results


def review_authoritative_shared_holds(inventory, bundles, roots, *, inventory_root, expected_inventory_hash, now):
    """Review ALL native holds from a protected, current locked snapshot.

    No issuer/signing authority is installed here. The host pins the expected
    hash from the native transaction, never from caller-provided evidence.
    """
    if not isinstance(inventory_root, bytes) or len(inventory_root) < 32 or inventory_root in roots.values():
        raise ReviewHeld("independent_inventory_root_required")
    if not isinstance(inventory, dict) or set(inventory) != {"body", "mac"} or not isinstance(inventory["body"], dict):
        raise ReviewHeld("authoritative_inventory_required")
    body = inventory["body"]
    expected = hmac.digest(inventory_root, b"paperclip-legacy-inventory-v1\0" + canonical(body), "sha256").hex()
    if not isinstance(inventory["mac"], str) or not hmac.compare_digest(inventory["mac"], expected):
        raise ReviewHeld("inventory_authentication")
    if set(body) != {"kind", "holds", "inventoryHash", "observedAt", "expiresAt"} or body["kind"] != "legacy-authoritative-hold-inventory-v1":
        raise ReviewHeld("inventory_contract")
    observed, expires = body["observedAt"], body["expiresAt"]
    if type(observed) is not int or type(expires) is not int or not now - 60_000 <= observed <= now < expires <= observed + 60_000:
        raise ReviewHeld("inventory_freshness")
    holds = body["holds"]
    if not isinstance(holds, list) or not holds or any(not isinstance(hold, dict) or set(hold) != set(BINDINGS) for hold in holds):
        raise ReviewHeld("inventory_original_hold_bindings")
    sources = [hold["source"] for hold in holds]
    if len(set(sources)) != len(sources):
        raise ReviewHeld("inventory_duplicate_hold")
    fingerprint = digest(sorted(({"source": hold["source"], "holdHash": hold["holdHash"]} for hold in holds), key=lambda value: value["source"]))
    if body["inventoryHash"] != fingerprint or expected_inventory_hash != fingerprint:
        raise ReviewHeld("inventory_native_snapshot_mismatch")
    # Review all holds conservatively. A scoped optimization needs independently
    # verified complete shared-scope closure; no caller-selected exemption exists.
    reviews = review_shared_holds(holds, bundles, roots, now=now)
    return {"inventoryHash": fingerprint, "reviews": reviews,
            "expiresAt": min(expires, *(review["expiresAt"] for review in reviews.values())),
            "operationalAcceptance": False}
