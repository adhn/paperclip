import copy
import contextlib
import json
import multiprocessing
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from authority import Authority, Held, Ledger, canonical, digest, request, sign, verify_ack
from state_contract import CODEX, CLAUDE, restoration_outcomes, validate_contract


def policy():
    return {"version": 1, "instance": "synthetic-instance", "pool": "disposable-runtime", "runtimeAuthority": "synthetic-runtime",
            "templates": {"synthetic": {"image": "sha256:" + "a" * 64, "entrypoint": "/usr/local/bin/python3"}},
            "families": [{key: "original-" + key for key in "runner account workspace session credential".split()}]}


class Runtime:
    def __init__(self):
        self.starts, self.stops = 0, 0
        self.fail = False
        self.state = "running"
        self.spec = policy()

    def attest(self):
        return {"authority": self.spec["runtimeAuthority"], "configuration": digest(self.spec), "objects": []}

    def launch(self, contract, template):
        self.starts += 1
        if self.fail:
            raise TimeoutError()
        return {"pool": "disposable-runtime", "uid": "exact-pod", "container": "exact-container",
                "node": "exact-node", "storage": contract["storage"]}

    def inspect(self, physical):
        if self.fail:
            raise TimeoutError()
        return {"physical": physical, "status": self.state, "evidence": {"synthetic": True}}

    def stop_and_inspect(self, physical):
        self.stops += 1
        self.state = "confirmed_stopped"
        return self.inspect(physical)


class AuthorityTest(unittest.TestCase):
    def setUp(self):
        # Secure parent under the checkout, not shared /tmp (rejected by module).
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("TEST_ROOT", Path(__file__).resolve().parent))
        self.root = Path(self.temp.name)
        self.policy = policy()
        Ledger.initialize(self.root, self.policy)
        con = sqlite3.connect(self.root / "ledger.sqlite")
        self.incarnation = con.execute("SELECT incarnation FROM meta").fetchone()[0]
        con.close()
        self.request_key, self.ack_key = b"r" * 32, b"a" * 32
        self.runtime = Runtime()
        self.ledger = Ledger(self.root, self.policy, self.incarnation)
        self.authority = Authority(self.ledger, self.policy, self.request_key, self.ack_key, self.runtime)
        self.pin = {"instance": self.policy["instance"], "policy": digest(self.policy), "pool": self.policy["pool"],
                    "incarnation": self.incarnation, "generation": 0, "epoch": None}
        self.epoch = self.call("acknowledgeEpoch", {"expectedGeneration": 0, "epoch": "epoch-1"})

    def tearDown(self):
        self.ledger.db.close()
        self.temp.cleanup()

    def call(self, op, value):
        sent = request(self.request_key, op, value)
        sent["body"]["highWater"] = self.pin.get("ledgerWatermark", {"sequence": 0, "hash": digest([])})
        sent["mac"] = sign(self.request_key, "request", sent["body"])
        reply = self.authority.call(sent)
        self.pin = verify_ack(self.ack_key, reply, sent, self.pin)
        return reply["body"]["result"]

    def contract(self):
        owner = {key: "exact-" + key for key in "company agent nativeId environment lease attempt".split()}
        owner.update(self.policy["families"][0], nativeKind="run")
        argv = ["-c", "print('synthetic')"]
        return {"version": 1, "instance": self.policy["instance"], "policy": digest(self.policy), "epoch": "epoch-1",
                "generation": 1, "owner": owner, "invocation": "exact-invocation", "commandHash": digest(argv),
                "journalHash": digest({"committed": "synthetic-db-row"}), "storage": "exact-storage", "template": "synthetic", "argv": argv}

    def test_fresh_controller_floor_rejects_same_epoch_ledger_rollback(self):
        snapshot = sqlite3.connect(":memory:")
        try:
            self.ledger.db.backup(snapshot)
            self.call("authorizeInvocation", self.contract())
            snapshot.backup(self.ledger.db)
            with self.assertRaisesRegex(Held, "high_water_rollback"):
                self.call("authorizeInvocation", self.contract())
            self.assertEqual(self.runtime.starts, 1)
        finally:
            snapshot.close()

    def test_same_sequence_changed_event_hash_is_refused_before_launch(self):
        self.ledger.db.execute("UPDATE events SET body='tampered' WHERE seq=1")
        self.ledger.db.commit()
        with self.assertRaisesRegex(Held, "high_water_rollback"):
            self.call("authorizeInvocation", self.contract())
        self.assertEqual(self.runtime.starts, 0)

    def test_changed_historical_prefix_is_refused_even_after_more_events(self):
        floor = copy.deepcopy(self.pin["ledgerWatermark"])
        self.ledger.db.execute("UPDATE events SET body='tampered' WHERE seq=1")
        self.ledger.event("later", {"cannot_hide_changed_prefix": True})
        self.ledger.db.commit()
        self.assertGreater(self.ledger.watermark()["sequence"], floor["sequence"])
        with self.assertRaisesRegex(Held, "high_water_rollback"):
            self.call("authorizeInvocation", self.contract())
        self.assertEqual(self.runtime.starts, 0)

    def test_known_limitation_old_valid_envelope_relaunches_after_storage_and_runtime_loss(self):
        """Attack characterization, NOT a passing replay-protection assertion.

        The latest native floor stops a fresh request, but a still-valid captured
        old envelope carries its old floor. An independent current consumption
        fence outside this rollback domain is required before deployment.
        """
        snapshot = sqlite3.connect(":memory:")
        retained = {}
        original_launch = self.runtime.launch
        def launch(contract, template):
            invocation = contract["invocation"]
            if invocation in retained:
                raise Held("retained_runtime_name_already_exists")
            physical = original_launch(contract, template)
            physical["uid"] += "-" + str(self.runtime.starts)
            physical["container"] += "-" + str(self.runtime.starts)
            retained[invocation] = physical
            return physical
        self.runtime.launch = launch
        try:
            self.ledger.db.backup(snapshot)
            sent = request(self.request_key, "authorizeInvocation", self.contract())
            sent["body"]["highWater"] = copy.deepcopy(self.pin["ledgerWatermark"])
            sent["mac"] = sign(self.request_key, "request", sent["body"])
            first = self.authority.call(sent)
            self.pin = verify_ack(self.ack_key, first, sent, self.pin)
            self.assertEqual(self.runtime.starts, 1)
            retained.clear()  # independent runtime object loss/force removal
            snapshot.backup(self.ledger.db)  # original incarnation/epoch restored
            replay = self.authority.call(sent)  # same authenticated unexpired bytes
            self.assertEqual(self.runtime.starts, 2)  # documents unresolved attack
            self.assertNotEqual(first["body"]["result"]["physical"], replay["body"]["result"]["physical"])
            with self.assertRaisesRegex(Held, "high_water_rollback"):
                verify_ack(self.ack_key, replay, sent, self.pin)
            # Rejected ACK is too late: the second runtime side effect happened.
        finally:
            snapshot.close()

    def test_lost_ack_is_exact_cas_idempotent(self):
        self.assertEqual(self.call("acknowledgeEpoch", {"expectedGeneration": 0, "epoch": "epoch-1"}), self.epoch)
        self.assertEqual(self.ledger.meta()["generation"], 1)

    def test_unknown_runtime_objects_block_ack(self):
        self.runtime.attest = lambda: {"authority": self.policy["runtimeAuthority"], "configuration": digest(self.policy), "objects": ["unknown-pod"]}
        with self.assertRaisesRegex(Held, "attested"):
            self.call("acknowledgeEpoch", {"expectedGeneration": 1, "epoch": "epoch-2"})

    def test_wrong_runtime_authority_blocks_ack(self):
        self.runtime.attest = lambda: {"authority": "wrong-daemon", "configuration": digest(self.policy), "objects": []}
        with self.assertRaisesRegex(Held, "attested"):
            self.call("acknowledgeEpoch", {"expectedGeneration": 1, "epoch": "epoch-2"})

    def test_epoch_aba_refused(self):
        self.call("acknowledgeEpoch", {"expectedGeneration": 1, "epoch": "epoch-2"})
        with self.assertRaisesRegex(Held, "epoch_reuse"):
            self.call("acknowledgeEpoch", {"expectedGeneration": 2, "epoch": "epoch-1"})

    def test_stale_expected_epoch_refused(self):
        with self.assertRaisesRegex(Held, "epoch_compare_failed"):
            self.call("acknowledgeEpoch", {"expectedGeneration": 0, "epoch": "epoch-2"})

    def test_bad_request_mac(self):
        sent = request(b"z" * 32, "acknowledgeEpoch", {"expectedGeneration": 1, "epoch": "epoch-2"})
        with self.assertRaisesRegex(Held, "authentication"):
            self.authority.call(sent)

    def test_expired_request(self):
        sent = request(self.request_key, "inspect", self.contract())
        sent["body"]["expires"] = 1
        sent["mac"] = sign(self.request_key, "request", sent["body"])
        with self.assertRaisesRegex(Held, "expired"):
            self.authority.call(sent)

    def test_provider_cannot_mint_ack(self):
        sent = request(self.request_key, "acknowledgeEpoch", {"expectedGeneration": 0, "epoch": "epoch-1"})
        reply = self.authority.call(sent)
        reply["mac"] = sign(b"p" * 32, "ack", reply["body"])
        with self.assertRaisesRegex(Held, "authentication"):
            verify_ack(self.ack_key, reply, sent, self.pin)

    def test_ack_challenge_replay(self):
        value = {"expectedGeneration": 0, "epoch": "epoch-1"}
        sent = request(self.request_key, "acknowledgeEpoch", value)
        reply = self.authority.call(sent)
        with self.assertRaisesRegex(Held, "challenge"):
            verify_ack(self.ack_key, reply, request(self.request_key, "acknowledgeEpoch", value), self.pin)

    def test_ack_wrong_physical_pool_or_ledger(self):
        for field in ("pool", "incarnation", "policy", "instance"):
            with self.subTest(field=field):
                sent = request(self.request_key, "acknowledgeEpoch", {"expectedGeneration": 0, "epoch": "epoch-1"})
                reply = self.authority.call(sent)
                with self.assertRaisesRegex(Held, "identity"):
                    verify_ack(self.ack_key, reply, sent, {**self.pin, field: "wrong"})

    def test_controller_pin_detects_snapshot_rollback(self):
        sent = request(self.request_key, "acknowledgeEpoch", {"expectedGeneration": 0, "epoch": "epoch-1"})
        reply = self.authority.call(sent)
        with self.assertRaisesRegex(Held, "rollback"):
            verify_ack(self.ack_key, reply, sent, {**self.pin, "generation": 2, "epoch": "epoch-2"})

    def test_duplicate_launch_never_replays_body(self):
        first = self.call("authorizeInvocation", self.contract())
        self.assertEqual(first, self.call("authorizeInvocation", self.contract()))
        self.assertEqual(self.runtime.starts, 1)

    def test_two_supervisors_cannot_claim_two_attempts(self):
        context = multiprocessing.get_context("fork")
        barrier, output = context.Barrier(2), context.Queue()

        def claimant(index):
            ledger = Ledger(self.root, self.policy, self.incarnation)
            runtime = Runtime()
            authority = Authority(ledger, self.policy, self.request_key, self.ack_key, runtime)
            contract = self.contract()
            contract["owner"]["attempt"] = "attempt-" + str(index)
            contract["invocation"] = "invocation-" + str(index)
            barrier.wait(timeout=5)
            try:
                result = authority.call(request(self.request_key, "authorizeInvocation", contract))["body"]["result"]["status"]
            except Held:
                result = "held"
            finally:
                ledger.db.close()
            output.put((result, runtime.starts))

        processes = [context.Process(target=claimant, args=(index,)) for index in range(2)]
        for process in processes:
            process.start()
        for process in processes:
            process.join(timeout=10)
            self.assertEqual(process.exitcode, 0)
        results = [output.get(timeout=1) for _ in processes]
        self.assertEqual(sorted(result[0] for result in results), ["held", "started"])
        self.assertEqual(sum(result[1] for result in results), 1)
        output.close()

    def test_ambiguous_launch_stays_consumed_after_restart(self):
        self.runtime.fail = True
        self.assertEqual(self.call("authorizeInvocation", self.contract())["status"], "uncertain")
        self.ledger.db.close()
        self.ledger = Ledger(self.root, self.policy, self.incarnation)
        self.authority = Authority(self.ledger, self.policy, self.request_key, self.ack_key, self.runtime)
        self.runtime.fail = False
        self.assertEqual(self.call("authorizeInvocation", self.contract())["status"], "uncertain")
        self.assertEqual(self.runtime.starts, 1)

    def test_crash_after_consumption_before_launch_does_not_replay(self):
        self.runtime.launch = lambda *args: (_ for _ in ()).throw(KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):
            self.call("authorizeInvocation", self.contract())
        self.assertEqual(self.call("authorizeInvocation", self.contract())["status"], "consumed")

    def test_cancellation_between_consumption_and_launch_prevents_start(self):
        original = self.ledger.transaction
        count = 0

        @contextlib.contextmanager
        def interleaved():
            nonlocal count
            count += 1
            current = count
            with original():
                yield
            if current == 1:
                result = self.call("stopAndInspect", self.contract())
                self.assertEqual(result["status"], "stop_requested")
                self.assertTrue(result["occupied"])

        self.ledger.transaction = interleaved
        result = self.call("authorizeInvocation", self.contract())
        self.assertEqual(result["status"], "stop_requested")
        self.assertEqual(self.runtime.starts, 0)

    def test_crash_with_unrecorded_physical_never_fabricates_stop(self):
        self.runtime.fail = True
        self.call("authorizeInvocation", self.contract())
        result = self.call("stopAndInspect", self.contract())
        self.assertEqual(result["status"], "stop_requested")
        self.assertIsNone(result["physical"])
        self.assertTrue(result["occupied"])

    def test_native_cancel_before_remote_consumption_fences_delayed_authorize(self):
        cancelled = self.call("stopAndInspect", self.contract())
        self.assertEqual(cancelled["status"], "stop_requested")
        self.assertIsNone(cancelled["physical"])
        self.assertTrue(cancelled["occupied"])
        self.ledger.db.close()
        self.ledger = Ledger(self.root, self.policy, self.incarnation)
        self.authority = Authority(self.ledger, self.policy, self.request_key, self.ack_key, self.runtime)
        self.assertEqual(self.call("authorizeInvocation", self.contract())["status"], "stop_requested")
        self.assertEqual(self.runtime.starts, 0)

    def test_cancel_unknown_sibling_cannot_bypass_global_occupancy(self):
        self.call("authorizeInvocation", self.contract())
        other = self.contract()
        other["owner"]["attempt"] = "sibling-attempt"
        other["invocation"] = "sibling-invocation"
        with self.assertRaisesRegex(Held, "occupancy"):
            self.call("stopAndInspect", other)
        self.assertEqual(self.runtime.stops, 0)

    def test_wrong_owner_or_lease_cannot_stop(self):
        self.call("authorizeInvocation", self.contract())
        for field in "company agent nativeId environment lease attempt".split():
            contract = self.contract()
            contract["owner"][field] = "sibling"
            with self.subTest(field=field), self.assertRaises(Held):
                self.call("stopAndInspect", contract)
        self.assertEqual(self.runtime.stops, 0)

    def test_scope_keys_cannot_be_minted_for_new_pods(self):
        for field in "runner account workspace session credential".split():
            contract = self.contract()
            contract["owner"][field] = "new-pod-family"
            with self.subTest(field=field), self.assertRaisesRegex(Held, "scope_family"):
                self.call("authorizeInvocation", contract)

    def test_changed_command_same_invocation_refused(self):
        self.call("authorizeInvocation", self.contract())
        contract = self.contract()
        contract["argv"] = ["different"]
        contract["commandHash"] = digest(contract["argv"])
        with self.assertRaisesRegex(Held, "identity_conflict"):
            self.call("authorizeInvocation", contract)

    def test_native_journal_command_binding(self):
        contract = self.contract()
        contract["argv"].append("changed")
        with self.assertRaisesRegex(Held, "command_hash"):
            self.call("authorizeInvocation", contract)

    def test_global_occupancy_remains_after_confirmed_stop(self):
        self.call("authorizeInvocation", self.contract())
        result = self.call("stopAndInspect", self.contract())
        self.assertEqual(result["status"], "stopped")
        self.assertTrue(result["occupied"])
        other = self.contract()
        other["invocation"] = "next"
        other["owner"]["attempt"] = "next"
        with self.assertRaisesRegex(Held, "occupancy"):
            self.call("authorizeInvocation", other)

    def next_contract(self):
        return {**self.contract(), "invocation": "second-invocation", "journalHash": digest({"committed": "second-command"})}

    def recovery(self, contracts):
        first = self.contract()
        return {key: first[key] for key in ("version", "instance", "policy", "epoch", "generation", "owner", "storage")} | {
            "commands": sorted([{"invocation": contract["invocation"], "contractHash": digest(contract)} for contract in contracts], key=lambda item: item["invocation"])}

    def test_same_epoch_recovery_after_restart_never_replays_or_attests_fresh_stop(self):
        self.call("authorizeInvocation", self.contract())
        self.ledger.db.close()
        self.ledger = Ledger(self.root, self.policy, self.incarnation)
        self.authority = Authority(self.ledger, self.policy, self.request_key, self.ack_key, self.runtime)
        result = self.call("recoverAttempt", self.recovery([self.contract()]))
        self.assertEqual(result["status"], "recovered")
        self.assertTrue(result["occupied"])
        self.assertTrue(result["recordedOnly"])
        self.assertEqual(result["commands"][0]["status"], "started")
        self.assertEqual(self.runtime.starts, 1)
        self.assertEqual(self.runtime.stops, 0)

    def test_recovery_manifest_must_be_exhaustive_exact_original_owner(self):
        self.call("authorizeInvocation", self.contract())
        valid = self.recovery([self.contract()])
        for changed in ({**valid, "commands": []},
                        {**valid, "commands": [{"invocation": "unknown", "contractHash": digest(self.contract())}]},
                        {**valid, "commands": valid["commands"] * 2},
                        {**valid, "owner": {**valid["owner"], "lease": "sibling"}},
                        {**valid, "storage": "replacement-storage"},
                        {**valid, "epoch": "new-epoch"}):
            with self.subTest(changed=changed), self.assertRaises(Held):
                self.call("recoverAttempt", changed)
        self.assertEqual(self.runtime.starts, 1)

    def test_multi_command_waits_for_stable_retirement_authority(self):
        self.call("authorizeInvocation", self.contract())
        with self.assertRaisesRegex(Held, "not_stably_retired"):
            self.call("authorizeInvocation", self.next_contract())
        self.call("stopAndInspect", self.contract())
        with self.assertRaisesRegex(Held, "retirement_authority_missing"):
            self.call("authorizeInvocation", self.next_contract())
        self.assertEqual(self.runtime.starts, 1)

    def test_exact_multi_command_restart_preserves_all_prior_ownership(self):
        class SyntheticRetirementVerifier:
            def verify(inner, contract, physical, observation):
                self.assertEqual(contract, self.contract())
                self.assertEqual(observation["physical"], physical)
                return "synthetic-independent-stable-retirement-proof"
        self.authority.retirement_verifier = SyntheticRetirementVerifier()
        self.call("authorizeInvocation", self.contract())
        self.call("stopAndInspect", self.contract())
        second = self.next_contract()
        self.assertEqual(self.call("authorizeInvocation", second)["status"], "started")
        self.assertEqual(self.runtime.starts, 2)
        self.ledger.db.close()
        self.ledger = Ledger(self.root, self.policy, self.incarnation)
        self.authority = Authority(self.ledger, self.policy, self.request_key, self.ack_key, self.runtime)
        self.assertEqual(self.call("authorizeInvocation", second)["status"], "started")
        self.assertEqual(self.runtime.starts, 2)
        with self.assertRaisesRegex(Held, "incomplete_recovery_manifest"):
            self.call("recoverAttempt", self.recovery([second]))
        recovered = self.call("recoverAttempt", self.recovery([self.contract(), second]))
        self.assertEqual(len(recovered["commands"]), 2)
        self.assertEqual(self.runtime.starts, 2)
        self.assertEqual(self.call("inspect", self.contract())["physical"], self.call("inspect", second)["physical"])
        self.assertEqual(self.ledger.db.execute("SELECT count(*) FROM commands").fetchone()[0], 2)
        self.assertEqual(self.ledger.db.execute("SELECT count(*) FROM attempts").fetchone()[0], 1)

    def test_stable_retirement_verifier_failure_or_false_claim_cannot_launch(self):
        self.call("authorizeInvocation", self.contract())
        self.call("stopAndInspect", self.contract())
        class InvalidVerifier:
            def verify(inner, *args):
                return True  # caller boolean is not an authenticated proof ID
        self.authority.retirement_verifier = InvalidVerifier()
        with self.assertRaisesRegex(Held, "invalid_identity"):
            self.call("authorizeInvocation", self.next_contract())
        self.assertEqual(self.runtime.starts, 1)
        self.assertEqual(self.ledger.db.execute("SELECT count(*) FROM commands").fetchone()[0], 1)

    def test_stop_disconnect_is_uncertain(self):
        self.call("authorizeInvocation", self.contract())
        self.runtime.fail = True
        result = self.call("stopAndInspect", self.contract())
        self.assertEqual(result["status"], "uncertain")
        self.assertTrue(result["occupied"])

    def test_wrong_physical_observation_is_uncertain(self):
        self.call("authorizeInvocation", self.contract())
        self.runtime.inspect = lambda physical: {"physical": {**physical, "uid": "sibling"}, "status": "confirmed_stopped", "evidence": {}}
        self.assertEqual(self.call("inspect", self.contract())["status"], "uncertain")

    def test_occupied_epoch_cannot_takeover(self):
        self.call("authorizeInvocation", self.contract())
        with self.assertRaisesRegex(Held, "occupied"):
            self.call("acknowledgeEpoch", {"expectedGeneration": 1, "epoch": "epoch-2"})

    def test_old_epoch_cannot_launch_or_stop(self):
        self.call("acknowledgeEpoch", {"expectedGeneration": 1, "epoch": "epoch-2"})
        for operation in ("authorizeInvocation", "inspect", "stopAndInspect"):
            with self.subTest(operation=operation), self.assertRaisesRegex(Held, "stale"):
                self.call(operation, self.contract())

    def test_missing_ledger_is_not_reinitialized(self):
        with tempfile.TemporaryDirectory(dir=self.root) as empty:
            with self.assertRaises(FileNotFoundError):
                Ledger(empty, self.policy, self.incarnation)

    def test_policy_drift_refuses_restart(self):
        with self.assertRaisesRegex(Held, "identity"):
            Ledger(self.root, {**self.policy, "pool": "other"}, self.incarnation)

    def test_world_writable_ledger_refuses_restart(self):
        (self.root / "ledger.sqlite").chmod(0o666)
        with self.assertRaisesRegex(Held, "unprotected"):
            Ledger(self.root, self.policy, self.incarnation)

    def test_symlink_ledger_refuses_restart(self):
        target = self.root / "ledger.saved"
        (self.root / "ledger.sqlite").rename(target)
        (self.root / "ledger.sqlite").symlink_to(target)
        with self.assertRaisesRegex(Held, "unprotected"):
            Ledger(self.root, self.policy, self.incarnation)

    def test_untrusted_command_does_not_run_in_authority(self):
        contract = self.contract()
        contract["argv"] = ["$(touch /authority-compromised)", "`id`", "; rm -rf /"]
        contract["commandHash"] = digest(contract["argv"])
        self.call("authorizeInvocation", contract)
        self.assertEqual(self.runtime.starts, 1)

    def state_contract(self, provider="codex"):
        roots = []
        for name, (role, kind) in (CODEX if provider == "codex" else CLAUDE).items():
            roots.append({"id": name, "role": role, "storage": "original-storage", "path": "/canonical/" + name,
                "kind": kind, "mode": 0o600 if kind == "file" else 0o700 if kind == "directory" else 0o777,
                "version": "source-v1", "family": "original-" + role,
                "aliasOf": "controller-auth" if kind == "alias" else None})
        return {"version": 1, "provider": provider, "owner": self.contract()["owner"],
                "configFingerprint": "approved-config", "resumeTarget": "exact-transcript", "roots": roots}

    def test_all_codex_and_claude_roots_are_required(self):
        for provider in ("codex", "claude"):
            contract = self.state_contract(provider)
            self.assertEqual(validate_contract(contract, self.contract()["owner"], "approved-config"), digest(contract))
            for index in range(len(contract["roots"])):
                missing = copy.deepcopy(contract)
                missing["roots"].pop(index)
                with self.assertRaisesRegex(Held, "incomplete"):
                    validate_contract(missing, self.contract()["owner"], "approved-config")

    def test_state_root_traversal_and_family_remap_refused(self):
        for field, value in (("path", "/safe/../other"), ("path", "relative"), ("mode", 0o666), ("family", "new-pod")):
            contract = self.state_contract()
            contract["roots"][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(Held):
                validate_contract(contract, self.contract()["owner"], "approved-config")

    def test_state_config_drift_refused(self):
        with self.assertRaisesRegex(Held, "drift"):
            validate_contract(self.state_contract(), self.contract()["owner"], "other-config")

    def test_workspace_success_does_not_imply_credential_restoration(self):
        contract = self.state_contract()
        results = {root["id"]: {"snapshot": "snapshot", "sourceVersion": root["version"], "outcome": "restored", "preservedCopy": None}
                   for root in contract["roots"]}
        results["staged-auth"].update(outcome="conflict", preservedCopy="quarantine/exact-attempt")
        self.assertEqual(restoration_outcomes(contract, "snapshot", results), {"workspace": True, "session": True, "credential": False})
        results["staged-auth"]["sourceVersion"] = "newer-refresh"
        with self.assertRaisesRegex(Held, "version"):
            restoration_outcomes(contract, "snapshot", results)

    def test_missing_or_divergent_state_is_held_and_preserved(self):
        contract = self.state_contract()
        with self.assertRaisesRegex(Held, "missing"):
            restoration_outcomes(contract, "snapshot", {})
        results = {root["id"]: {"snapshot": "snapshot", "sourceVersion": root["version"], "outcome": "uncertain", "preservedCopy": None}
                   for root in contract["roots"]}
        with self.assertRaisesRegex(Held, "identity"):
            restoration_outcomes(contract, "snapshot", results)


if __name__ == "__main__":
    unittest.main(verbosity=2)
