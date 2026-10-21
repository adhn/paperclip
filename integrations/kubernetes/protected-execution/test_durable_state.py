"""Synthetic detached-store tests; never an operational storage attestation."""
import copy
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from authority import Held
from durable_state import DurableState, IndependentStorageFence
from state_contract import CODEX, CLAUDE, validate_contract


class FixtureFence:
    def __init__(self, owner):
        self.owner = copy.deepcopy(owner)
        self.accepted = set()
        self.pins = {}

    def verify(self, kind, owner, storages, evidence):
        if kind == "canonical-high-water":
            if owner != self.owner or storages != ["original-pvc"]:
                raise Held("wrong_canonical_pin_owner")
            previous = self.pins.get(evidence["policy"])
            if previous and (previous["incarnation"] != evidence["incarnation"] or evidence["generation"] < previous["generation"] or (evidence["generation"] == previous["generation"] and evidence["hash"] != previous["hash"])):
                raise Held("canonical_snapshot_rollback")
            self.pins[evidence["policy"]] = copy.deepcopy(evidence)
            return "fixture-independent-pin"
        if owner != self.owner or evidence != (kind, tuple(storages)) or kind not in self.accepted:
            raise Held("independent_storage_fence_missing")
        return "fixture-exact-" + kind

    def verify_current(self, kind, owner, storages, current, evidence):
        self.verify("canonical-high-water", owner, storages, current)
        return self.verify(kind, owner, storages, evidence) + "-" + current["hash"]


class DurableStateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ["TEST_ROOT"])
        self.root = Path(self.tmp.name)
        self.canonical = self.root / "canonical"
        self.canonical.mkdir(mode=0o700)
        self.store = self.root / "store"
        self.store.mkdir(mode=0o700)
        self.owner = {"company": "company", "agent": "agent", "run": "run", "lease": "lease", "attempt": "attempt",
                      "runner": "original-runner", "account": "original-account", "workspace": "original-workspace",
                      "session": "original-session", "credential": "original-credential"}
        self.contract = {"version": 1, "provider": "codex", "owner": self.owner, "configFingerprint": "config", "resumeTarget": "resume", "roots": []}
        for key, (role, kind) in CODEX.items():
            path = self.canonical / key
            if kind == "directory":
                path.mkdir(mode=0o700)
                (path / "uncommitted").write_bytes(b"\0original")
            elif kind == "file":
                path.write_bytes(b"synthetic-auth")
                path.chmod(0o600)
            else:
                path.symlink_to(self.canonical / "controller-auth")
            self.contract["roots"].append({"id": key, "role": role, "storage": "original-pvc", "path": str(path),
                                          "kind": kind, "mode": 0o700 if kind == "directory" else 0o777 if kind == "alias" else 0o600,
                                          "version": "initial-" + key, "family": self.owner[role],
                                          "aliasOf": "controller-auth" if kind == "alias" else None})
        self.fence = FixtureFence(self.owner)
        self.fence.accepted.update(("import-detached", "stage-detached", "provider-exclusive", "stable-retirement", "restore-detached", "refresh-detached"))
        self.state = self.initialize()

    def proof(self, kind):
        return kind, ("original-pvc",)

    def initialize(self):
        return DurableState.initialize(self.store, self.contract, self.owner, "config", self.fence,
                                       {r["id"]: r["path"] for r in self.contract["roots"]}, self.proof("import-detached"))

    def tearDown(self):
        self.state.close()
        self.tmp.cleanup()

    def stage(self):
        staged = self.state.stage(self.proof("stage-detached"))
        self.state.handoff(self.proof("provider-exclusive"))
        return Path(staged["attempt"])

    def restore(self):
        return self.state.restore(self.proof("stable-retirement"), self.proof("restore-detached"))

    def test_binary_all_roots_restore_and_restart(self):
        attempt = self.stage()
        (attempt / "canonical-workspace" / "uncommitted").write_bytes(b"\xffnew")
        result = self.restore()
        self.assertTrue(all(result["outcomes"].values()))
        self.assertEqual(self.state.canonical_head("canonical-workspace")["snapshot"]["files"]["uncommitted"], b"\xffnew")
        self.state.close()
        self.state = DurableState(self.store, self.contract, self.owner, "config", self.fence)
        self.assertEqual(self.restore(), result)
        self.assertEqual(self.state.db.execute("SELECT count(*) FROM occupancy").fetchone()[0], 1)

    def test_no_provider_or_detach_claim_can_restore(self):
        self.stage()
        for missing in ("stable-retirement", "restore-detached"):
            self.fence.accepted.remove(missing)
            with self.assertRaisesRegex(Held, "fence_missing"):
                self.restore()
            self.fence.accepted.add(missing)
        with self.assertRaisesRegex(Held, "fence_missing"):
            self.state.restore(True, True)

    def test_new_credential_refresh_quarantines_old_return(self):
        attempt = self.stage()
        original = self.state.canonical_head("controller-auth")["version"]
        (self.canonical / "controller-auth").write_bytes(b"newer-refresh")
        new = self.state.import_refresh("controller-auth", original, self.proof("refresh-detached"))
        (attempt / "controller-auth" / "content").write_bytes(b"older-returned-refresh")
        result = self.restore()
        self.assertEqual(result["outcomes"], {"workspace": True, "session": True, "credential": False})
        self.assertEqual(result["roots"]["controller-auth"]["outcome"], "conflict")
        self.assertEqual(self.state.canonical_head("controller-auth")["version"], new)
        self.assertEqual(self.state.canonical_head("controller-auth")["snapshot"]["files"]["content"], b"newer-refresh")
        self.assertTrue((self.store / "objects" / result["quarantine"]).exists())

    def test_partial_failure_retries_only_failed_role(self):
        attempt = self.stage()
        file = attempt / "staged-sessions" / "uncommitted"
        file.unlink()
        file.symlink_to("/etc/passwd")
        partial = self.restore()
        self.assertEqual(partial["outcomes"], {"workspace": True, "session": False, "credential": True})
        head = self.state.canonical_head("canonical-workspace")["version"]
        file.unlink()
        file.write_bytes(b"recovered")
        final = self.restore()
        self.assertTrue(all(final["outcomes"].values()))
        self.assertEqual(self.state.canonical_head("canonical-workspace")["version"], head)

    def test_crash_before_restore_commit_keeps_old_heads_and_retries(self):
        self.stage()
        original = self.state.canonical_head("controller-auth")["version"]
        with patch.object(self.state, "_write_object", side_effect=RuntimeError("crash")):
            with self.assertRaisesRegex(RuntimeError, "crash"):
                self.restore()
        self.assertEqual(self.state.inspect()["phase"], "restoring")
        self.assertEqual(self.state.canonical_head("controller-auth")["version"], original)
        self.assertTrue(all(self.restore()["outcomes"].values()))

    def test_crash_during_stage_never_replays_or_releases(self):
        with patch("durable_state.materialize", side_effect=RuntimeError("crash")):
            with self.assertRaisesRegex(RuntimeError, "crash"):
                self.state.stage(self.proof("stage-detached"))
        self.assertEqual(self.state.inspect()["phase"], "staging")
        with self.assertRaisesRegex(Held, "already_consumed"):
            self.state.stage(self.proof("stage-detached"))
        self.assertEqual(self.state.db.execute("SELECT count(*) FROM occupancy").fetchone()[0], 1)

    def test_alias_is_pinned_and_nested_roots_refused(self):
        contract = copy.deepcopy(self.contract)
        contract["roots"][-1]["path"] = contract["roots"][-2]["path"] + "/nested"
        with self.assertRaisesRegex(Held, "overlapping"):
            validate_contract(contract, self.owner, "config")
        self.state.close()
        self.state = DurableState(self.store, self.contract, self.owner, "config", self.fence)
        self.contract["roots"][0]["family"] = "minted-new-family"
        with self.assertRaisesRegex(Held, "remap"):
            DurableState(self.store, self.contract, self.owner, "config", self.fence)

    def test_tamper_immutable_bytes_without_version_change_holds(self):
        obj = self.state.db.execute("SELECT object FROM heads LIMIT 1").fetchone()[0]
        (self.store / "objects" / obj).write_bytes(b"{}")
        with self.assertRaisesRegex(Held, "corrupt"):
            self.state.stage(self.proof("stage-detached"))
        self.assertIsNone(self.state.inspect())

    def test_stale_refresh_version_cannot_overwrite(self):
        original = self.state.canonical_head("controller-auth")["version"]
        new = self.state.import_refresh("controller-auth", original, self.proof("refresh-detached"))
        with self.assertRaisesRegex(Held, "version_conflict"):
            self.state.import_refresh("controller-auth", original, self.proof("refresh-detached"))
        self.assertEqual(self.state.canonical_head("controller-auth")["version"], new)

    def test_wrong_owner_and_fingerprint_fail_closed(self):
        wrong = {**self.owner, "attempt": "other"}
        with self.assertRaisesRegex(Held, "configuration_drift"):
            DurableState(self.store, self.contract, wrong, "config", self.fence)
        with self.assertRaisesRegex(Held, "configuration_drift"):
            DurableState(self.store, self.contract, self.owner, "wrong", self.fence)
    def test_independent_canonical_pin_detects_storage_rollback(self):
        before = (self.store / "state.sqlite").read_bytes()
        self.stage()
        self.state.close()
        (self.store / "state.sqlite").write_bytes(before)
        with self.assertRaisesRegex(Held, "snapshot_rollback"):
            DurableState(self.store, self.contract, self.owner, "config", self.fence)
        # tearDown closes a closed connection safely.

    def test_native_retirement_and_next_attempt_preserve_canonical_families(self):
        self.stage()
        self.restore()
        with self.assertRaisesRegex(Held, "fence_missing"):
            self.state.retire(self.proof("native-release-consumed"))
        self.fence.accepted.add("native-release-consumed")
        self.state.retire(self.proof("native-release-consumed"))
        self.assertEqual(self.state.inspect()["phase"], "retired")
        self.assertEqual(self.state.db.execute("SELECT count(*) FROM occupancy").fetchone()[0], 0)
        self.state.close()
        owner = {**self.owner, "run": "run-2", "attempt": "attempt-2", "lease": "lease-2"}
        contract = {**self.contract, "owner": owner}
        self.fence.owner = owner
        self.state = DurableState(self.store, contract, owner, "config", self.fence)
        self.assertIsNone(self.state.inspect())
        self.assertTrue(self.state.stage(self.proof("stage-detached"))["snapshot"])
        self.assertEqual(self.state.db.execute("SELECT count(*) FROM attempts").fetchone()[0], 2)

    def test_native_retirement_cannot_clear_partial_conflict(self):
        self.stage()
        self.fence.accepted.add("native-release-consumed")
        with self.assertRaisesRegex(Held, "prerequisites"):
            self.state.retire(self.proof("native-release-consumed"))
        self.assertEqual(self.state.db.execute("SELECT count(*) FROM occupancy").fetchone()[0], 1)

    def independent_fence(self):
        root = self.root / "independent-authority"
        root.mkdir(mode=0o700)
        incarnation = IndependentStorageFence.initialize(root)
        return root, incarnation, IndependentStorageFence(root, incarnation, self.fence)

    def test_real_independent_pin_survives_authority_restart_and_rejects_store_rollback(self):
        root, incarnation, authority = self.independent_fence()
        self.state.fence = authority
        self.state._pin()
        before = (self.store / "state.sqlite").read_bytes()
        self.stage()
        self.state.close()
        authority.close()
        authority = IndependentStorageFence(root, incarnation, self.fence)
        try:
            (self.store / "state.sqlite").write_bytes(before)
            with self.assertRaisesRegex(Held, "snapshot_rollback"):
                DurableState(self.store, self.contract, self.owner, "config", authority)
        finally:
            authority.close()

    def test_real_independent_pin_rejects_equal_generation_changed_ledger(self):
        root, incarnation, authority = self.independent_fence()
        try:
            self.state.fence = authority
            self.state._pin()
            self.state.db.execute("UPDATE heads SET version='changed-without-generation'")
            with self.assertRaisesRegex(Held, "snapshot_rollback"):
                self.state.canonical_head("controller-auth")
        finally:
            authority.close()

    def test_real_independent_proof_binding_rejects_phase_or_owner_reuse(self):
        root, incarnation, authority = self.independent_fence()
        original = self.fence.verify
        self.fence.verify = lambda *args: "same-authenticated-but-reused-evidence-id"
        try:
            authority.verify("stage-detached", self.owner, ["original-pvc"], "opaque")
            authority.close()
            authority = IndependentStorageFence(root, incarnation, self.fence)
            authority.verify("stage-detached", self.owner, ["original-pvc"], "opaque")
            with self.assertRaisesRegex(Held, "proof_rebinding"):
                authority.verify("native-release-consumed", self.owner, ["original-pvc"], "opaque")
            with self.assertRaisesRegex(Held, "proof_rebinding"):
                authority.verify("stage-detached", {**self.owner, "attempt": "sibling"}, ["original-pvc"], "opaque")
        finally:
            self.fence.verify = original
            authority.close()

    def test_independent_authority_incarnation_is_pinned_and_missing_is_not_recreated(self):
        root, incarnation, authority = self.independent_fence()
        authority.close()
        with self.assertRaisesRegex(Held, "identity_mismatch"):
            IndependentStorageFence(root, "minted-incarnation", self.fence)
        (root / "fence.sqlite").unlink()
        with self.assertRaises(FileNotFoundError):
            IndependentStorageFence(root, incarnation, self.fence)

    def test_import_provenance_is_part_of_exact_canonical_high_water(self):
        self.state.db.execute("UPDATE meta SET import_proof='forged-import-provenance'")
        with self.assertRaisesRegex(Held, "snapshot_rollback"):
            self.state.inspect()

    def test_external_floor_precedes_canonical_commit_and_failed_commit_holds_restart(self):
        root, incarnation, authority = self.independent_fence()
        try:
            self.state.fence = authority
            self.state._pin()
            before = (self.store / "state.sqlite").read_bytes()
            with patch.object(self.state, "_commit_local", side_effect=RuntimeError("local_commit_lost")):
                with self.assertRaisesRegex(RuntimeError, "local_commit_lost"):
                    self.state.stage(self.proof("stage-detached"))
            # Local rollback/restoration cannot erase the already durable intent.
            self.state.close()
            (self.store / "state.sqlite").write_bytes(before)
            with self.assertRaisesRegex(Held, "snapshot_rollback"):
                DurableState(self.store, self.contract, self.owner, "config", authority)
        finally:
            authority.close()

    def test_failed_independent_pin_cannot_commit_new_canonical_heads(self):
        self.stage()
        before = self.state.canonical_head("controller-auth")["version"]
        verify = self.fence.verify
        def unavailable(kind, owner, storages, evidence):
            if kind == "canonical-high-water" and evidence["generation"] > self.fence.pins[evidence["policy"]]["generation"]:
                raise Held("independent_history_unavailable")
            return verify(kind, owner, storages, evidence)
        with patch.object(self.fence, "verify", side_effect=unavailable):
            with self.assertRaisesRegex(Held, "history_unavailable"):
                self.state.import_refresh("controller-auth", before, self.proof("refresh-detached"))
        self.assertEqual(self.state.canonical_head("controller-auth")["version"], before)

    def test_current_physical_verifier_is_mandatory_without_verify_fallback(self):
        root, incarnation, authority = self.independent_fence()
        self.fence.verify_current = None
        try:
            with self.assertRaisesRegex(Held, "current_physical_storage_authority_missing"):
                authority.verify_current("stage-detached", self.owner, ["original-pvc"],
                                         self.state._pin(), self.proof("stage-detached"))
        finally:
            authority.close()

    def test_same_physical_proof_cannot_authorize_new_canonical_generation(self):
        root, incarnation, authority = self.independent_fence()
        self.fence.verify_current = lambda *args: "replayed-current-proof"
        current = self.state._pin()
        try:
            authority.verify_current("stage-detached", self.owner, ["original-pvc"], current, "opaque")
            # Exact retry survives authority restart. A later generation may not
            # recycle the same physical receipt even for the same original owner.
            authority.close()
            authority = IndependentStorageFence(root, incarnation, self.fence)
            authority.verify_current("stage-detached", self.owner, ["original-pvc"], current, "opaque")
            later = {**current, "generation": current["generation"] + 1}
            with self.assertRaisesRegex(Held, "proof_rebinding"):
                authority.verify_current("stage-detached", self.owner, ["original-pvc"], later, "opaque")
        finally:
            authority.close()

    def test_canonical_change_during_physical_verification_fails_cas(self):
        verify = self.fence.verify_current
        def changed(*args):
            result = verify(*args)
            self.state.db.execute("UPDATE meta SET generation=generation+1")
            return result
        self.fence.verify_current = changed
        with self.assertRaisesRegex(Held, "current_storage_compare_failed"):
            self.state.stage(self.proof("stage-detached"))
        self.assertIsNone(self.state.inspect())
        self.assertEqual(self.state.db.execute("SELECT count(*) FROM occupancy").fetchone()[0], 0)

    def test_original_sandbox_stop_cannot_authorize_state_restoration(self):
        self.stage()
        self.fence.accepted.add("whole-pod-stopped")
        with self.assertRaisesRegex(Held, "fence_missing"):
            self.state.restore(self.proof("whole-pod-stopped"), self.proof("restore-detached"))
        self.assertEqual(self.state.inspect()["phase"], "provider")

    def test_claude_explicit_nested_projection_is_one_cas_unit(self):
        contract = {**self.contract, "version": 2, "provider": "claude", "roots": [],
                    "projections": {"encoded-cwd-sessions": "claude-directory"}}
        base = self.root / "claude"
        base.mkdir(mode=0o700)
        for key, (role, kind) in CLAUDE.items():
            path = base / key if key != "encoded-cwd-sessions" else base / "claude-directory" / "projects"
            if kind == "directory":
                path.mkdir(mode=0o700)
                (path / "data").write_bytes(b"session-or-workspace")
            else:
                path.write_bytes(b"synthetic-auth")
                path.chmod(0o600)
            contract["roots"].append({"id": key, "role": role, "storage": "original-pvc", "path": str(path), "kind": kind,
                                      "mode": 0o700 if kind == "directory" else 0o600, "version": "initial-" + key,
                                      "family": self.owner[role], "aliasOf": None})
        store = self.root / "claude-store"
        store.mkdir(mode=0o700)
        state = DurableState.initialize(store, contract, self.owner, "config", self.fence,
                                        {r["id"]: r["path"] for r in contract["roots"]}, self.proof("import-detached"))
        try:
            stage = state.stage(self.proof("stage-detached"))
            self.assertEqual(Path(stage["bindings"]["encoded-cwd-sessions"]), Path(stage["bindings"]["claude-directory"]) / "projects")
            state.handoff(self.proof("provider-exclusive"))
            (Path(stage["bindings"]["encoded-cwd-sessions"]) / "data").write_bytes(b"provider-change")
            previous = state.canonical_head("encoded-cwd-sessions")["version"]
            (base / "claude-directory" / "projects" / "data").write_bytes(b"newer-canonical")
            state.import_refresh("encoded-cwd-sessions", previous, self.proof("refresh-detached"))
            report = state.restore(self.proof("stable-retirement"), self.proof("restore-detached"))
            self.assertEqual(report["outcomes"], {"workspace": True, "session": False, "credential": False})
            self.assertEqual(report["roots"]["claude-directory"]["outcome"], "conflict")
            self.assertEqual(state.canonical_head("claude-directory")["snapshot"]["files"]["projects/data"], b"newer-canonical")
        finally:
            state.close()



if __name__ == "__main__":
    unittest.main(verbosity=2)
