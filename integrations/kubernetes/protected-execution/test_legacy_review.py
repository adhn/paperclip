import copy
import hmac
import unittest
from legacy_review import BINDINGS, DOMAINS, ReviewHeld, canonical, digest, review_legacy_decision, review_shared_holds, review_authoritative_shared_holds


class LegacyReviewTests(unittest.TestCase):
    def setUp(self):
        self.now = 1_800_000_000_000
        self.roots = {key: digest(key).encode() for key in DOMAINS}
        self.decision, self.artifacts = self.bundle("original-A")

    def sign(self, domain, body):
        return {"body": body, "mac": hmac.digest(self.roots[domain], b"paperclip-legacy-review-v1\0" + domain.encode() + b"\0" + canonical(body), "sha256").hex()}

    def bundle(self, lease):
        d = {"kind": "present-day-legacy-reconciliation-v1", "action": "reconcile", "source": "lease:" + lease,
             "leaseId": lease, "holdHash": digest(lease), "companyId": "original-company", "agentId": lease,
             "runId": "run-" + lease, "environmentId": "original-environment", "scopes": ["original-codex-account", "original-codex-credential"],
             "epoch": "current-epoch", "policyHash": digest("held-policy"), "restoration": {}}
        artifacts = {}
        for domain in DOMAINS:
            body = {key: copy.deepcopy(d[key]) for key in BINDINGS}
            body.update(kind="legacy-" + domain + "-evidence-v1", outcome="verified", evidenceHash=digest("synthetic-" + domain), observedAt=self.now - 100, expiresAt=self.now + 1000)
            if domain == "operator":
                body["approvedArtifacts"] = {key: digest(value["body"]) for key, value in artifacts.items()}
                body["approvedAction"] = d["action"]
            artifacts[domain] = self.sign(domain, body)
            field = {"route": "routeRevocationHash", "retirement": "retiredIncarnationHash", "stop": "wholePodStopHash", "operator": "operatorApprovalHash"}.get(domain)
            if field: d[field] = digest(body)
            else: d["restoration"][domain] = digest(body)
        return d, artifacts

    def review(self, d=None, a=None):
        return review_legacy_decision(d or self.decision, a or self.artifacts, self.roots, now=self.now)

    def test_complete_review_produces_no_operational_acceptance(self):
        result = self.review()
        self.assertFalse(result["operationalAcceptance"])
        self.assertEqual(set(result["artifacts"]), set(DOMAINS))

    def test_each_independent_artifact_required(self):
        for domain in DOMAINS:
            with self.subTest(domain=domain):
                a = copy.deepcopy(self.artifacts); del a[domain]
                with self.assertRaisesRegex(ReviewHeld, "complete_evidence"): self.review(a=a)

    def test_provider_cannot_forge_stop_or_operator(self):
        for domain in DOMAINS:
            with self.subTest(domain=domain):
                a = copy.deepcopy(self.artifacts); a[domain]["mac"] = "0" * 64
                with self.assertRaisesRegex(ReviewHeld, "authentication"): self.review(a=a)

    def test_shared_family_evidence_does_not_cover_sibling_hold(self):
        other, artifacts = self.bundle("replacement-A")
        with self.assertRaisesRegex(ReviewHeld, "original_hold_binding"):
            self.review(a=artifacts)
        hold = {key: self.decision[key] for key in BINDINGS}
        sibling = {key: other[key] for key in BINDINGS}
        with self.assertRaisesRegex(ReviewHeld, "every_original_shared_hold"):
            review_shared_holds([hold, sibling], {hold["source"]: {"decision": self.decision, "artifacts": self.artifacts}}, self.roots, now=self.now)
        self.assertEqual(len(review_shared_holds([hold, sibling], {
            hold["source"]: {"decision": self.decision, "artifacts": self.artifacts},
            sibling["source"]: {"decision": other, "artifacts": artifacts}}, self.roots, now=self.now)), 2)

    def test_expired_future_and_unverified_evidence_held(self):
        for change in ({"expiresAt": self.now}, {"observedAt": self.now + 1}, {"outcome": "unknown"}, {"observedAt": True}):
            with self.subTest(change=change):
                a = copy.deepcopy(self.artifacts); body = a["stop"]["body"]; body.update(change); a["stop"] = self.sign("stop", body)
                with self.assertRaises(ReviewHeld): self.review(a=a)

    def test_operator_must_approve_exact_complete_bundle(self):
        a = copy.deepcopy(self.artifacts); d = copy.deepcopy(self.decision)
        body = a["operator"]["body"]; body["approvedArtifacts"]["stop"] = digest("another-stop")
        a["operator"] = self.sign("operator", body); d["operatorApprovalHash"] = digest(body)
        with self.assertRaisesRegex(ReviewHeld, "operator_bundle_binding"): self.review(d=d, a=a)

    def test_independent_roots_and_original_scopes_required(self):
        roots = {key: b"x" * 32 for key in DOMAINS}
        with self.assertRaisesRegex(ReviewHeld, "independent_roots"):
            review_legacy_decision(self.decision, self.artifacts, roots, now=self.now)
        d = copy.deepcopy(self.decision); d["scopes"] *= 2
        with self.assertRaisesRegex(ReviewHeld, "exact_scopes"): self.review(d=d)

    def test_review_does_not_mutate_historical_bundle(self):
        original = copy.deepcopy((self.decision, self.artifacts))
        self.review()
        self.assertEqual(original, (self.decision, self.artifacts))

    def test_review_returns_shortest_artifact_expiry_and_conservative_revoke(self):
        d = copy.deepcopy(self.decision); a = copy.deepcopy(self.artifacts)
        a["stop"]["body"]["expiresAt"] = self.now + 100
        a["stop"] = self.sign("stop", a["stop"]["body"])
        d["wholePodStopHash"] = digest(a["stop"]["body"])
        a["operator"]["body"]["approvedArtifacts"]["stop"] = d["wholePodStopHash"]
        a["operator"] = self.sign("operator", a["operator"]["body"])
        d["operatorApprovalHash"] = digest(a["operator"]["body"])
        self.assertEqual(self.review(d=d, a=a)["expiresAt"], self.now + 100)
        d["action"] = "revoke"
        with self.assertRaisesRegex(ReviewHeld, "operator_bundle_binding"): self.review(d=d, a=a)
        a["operator"]["body"]["approvedAction"] = "revoke"
        a["operator"] = self.sign("operator", a["operator"]["body"])
        d["operatorApprovalHash"] = digest(a["operator"]["body"])
        before = copy.deepcopy((d, a))
        result = self.review(d=d, a=a)
        self.assertEqual(result["decisionHash"], digest(d))
        self.assertFalse(result["operationalAcceptance"])
        self.assertEqual(before, (d, a))
        del a["stop"]
        with self.assertRaisesRegex(ReviewHeld, "complete_evidence"): self.review(d=d, a=a)

    def test_authoritative_inventory_rejects_filtered_or_untrusted_snapshot(self):
        hold = {key: self.decision[key] for key in BINDINGS}
        bundles = {hold["source"]: {"decision": self.decision, "artifacts": self.artifacts}}
        fingerprint = digest([{"source": hold["source"], "holdHash": hold["holdHash"]}])
        root = b"independent-inventory-root-0000000000000"
        body = {"kind": "legacy-authoritative-hold-inventory-v1", "holds": [hold], "inventoryHash": fingerprint,
                "observedAt": self.now - 1, "expiresAt": self.now + 1000}
        def signed(value):
            return {"body": value, "mac": hmac.digest(root, b"paperclip-legacy-inventory-v1\0" + canonical(value), "sha256").hex()}
        def review(value=body, **kwargs):
            return review_authoritative_shared_holds(signed(value), bundles, self.roots,
                inventory_root=root, expected_inventory_hash=kwargs.get("expected", fingerprint), now=self.now)
        self.assertFalse(review()["operationalAcceptance"])
        self.assertEqual(review()["expiresAt"], self.now + 1000)
        with self.assertRaisesRegex(ReviewHeld, "inventory_native_snapshot_mismatch"): review(expected=digest("full-original-set"))
        for change in ({"expiresAt": self.now}, {"observedAt": True}, {"observedAt": self.now - 60001}):
            value = copy.deepcopy(body); value.update(change)
            with self.assertRaisesRegex(ReviewHeld, "inventory_freshness"): review(value)
        with self.assertRaisesRegex(ReviewHeld, "independent_inventory_root"):
            review_authoritative_shared_holds(signed(body), bundles, self.roots,
                inventory_root=self.roots["route"], expected_inventory_hash=fingerprint, now=self.now)
        forged = signed(body); forged["mac"] = "0" * 64
        with self.assertRaisesRegex(ReviewHeld, "inventory_authentication"):
            review_authoritative_shared_holds(forged, bundles, self.roots,
                inventory_root=root, expected_inventory_hash=fingerprint, now=self.now)

    def test_authenticated_inventory_still_requires_every_original_shared_bundle(self):
        other, artifacts = self.bundle("replacement-A")
        holds = [{key: decision[key] for key in BINDINGS} for decision in (self.decision, other)]
        fingerprint = digest(sorted(({"source": hold["source"], "holdHash": hold["holdHash"]} for hold in holds), key=lambda value: value["source"]))
        root = b"independent-inventory-root-0000000000000"
        body = {"kind": "legacy-authoritative-hold-inventory-v1", "holds": holds, "inventoryHash": fingerprint,
                "observedAt": self.now - 1, "expiresAt": self.now + 1000}
        inventory = {"body": body, "mac": hmac.digest(root, b"paperclip-legacy-inventory-v1\0" + canonical(body), "sha256").hex()}
        bundles = {self.decision["source"]: {"decision": self.decision, "artifacts": self.artifacts}}
        with self.assertRaisesRegex(ReviewHeld, "every_original_shared_hold"):
            review_authoritative_shared_holds(inventory, bundles, self.roots,
                inventory_root=root, expected_inventory_hash=fingerprint, now=self.now)
        bundles[other["source"]] = {"decision": other, "artifacts": artifacts}
        self.assertEqual(len(review_authoritative_shared_holds(inventory, bundles, self.roots,
            inventory_root=root, expected_inventory_hash=fingerprint, now=self.now)["reviews"]), 2)


if __name__ == "__main__": unittest.main()
