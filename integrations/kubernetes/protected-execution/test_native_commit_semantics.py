import unittest
from native_commit_semantics import Event, ExpiringTrace, ProposedFenceTrace, final_check_counterexamples


class NativeCommitSemanticsTests(unittest.TestCase):
    def test_caller_can_flush_then_commit_after_expiry(self):
        trace = ExpiringTrace((Event("body-check", 0), Event("early-flush-check", 1), Event("physical-commit", 5)), 3, "caller")
        self.assertTrue(trace.counterexample)

    def test_final_check_gap_exists_without_any_caller_delay(self):
        examples = list(final_check_counterexamples())
        self.assertGreater(len(examples), 0)
        self.assertTrue(all(t.counterexample for t in examples))
        self.assertTrue(all(t.owner == "exclusive-owner" for t in examples))

    def test_exact_expiry_at_commit_is_not_fresh(self):
        trace = ExpiringTrace((Event("final-check", 1), Event("physical-commit", 2)), 2, "exclusive-owner")
        self.assertTrue(trace.counterexample)

    def test_expired_check_refuses_model_effect(self):
        trace = ExpiringTrace((Event("final-check", 2), Event("physical-commit", 3)), 2, "exclusive-owner")
        self.assertFalse(trace.checks_pass)
        self.assertFalse(trace.counterexample)

    def test_owner_does_exclude_flush_but_not_physical_gap(self):
        with self.assertRaises(ValueError):
            ExpiringTrace((Event("early-flush-check", 1), Event("physical-commit", 3)), 2, "exclusive-owner")
        self.assertTrue(next(final_check_counterexamples()).counterexample)

    def test_monotonic_proposal_does_not_expire_accepted_retirement(self):
        result = ProposedFenceTrace(("accept-retirement", "expire-observation", "commit")).outcome()
        self.assertTrue(result["model_committed"])
        self.assertFalse(result["proposal_accepted"])
        self.assertFalse(result["operational_acceptance"])

    def test_revoke_or_generation_change_before_commit_refuses(self):
        for invalidation in ("revoke", "rotate"):
            result = ProposedFenceTrace(("accept-retirement", invalidation, "commit")).outcome()
            self.assertTrue(result["model_refused"])
            self.assertFalse(result["model_committed"])

    def test_inflight_before_deny_stays_accounted_as_pre_deny(self):
        result = ProposedFenceTrace(("accept-retirement", "commit", "revoke")).outcome()
        self.assertTrue(result["model_committed"])
        self.assertFalse(result["operational_acceptance"])

    def test_detached_or_sql_only_fact_does_not_prove_physical_fence(self):
        result = ProposedFenceTrace(("accept-retirement", "commit", "stale-physical-write")).outcome()
        self.assertTrue(result["physical_fence_assumption_violated"])
        self.assertFalse(result["operational_acceptance"])

    def test_unaccepted_retirement_refuses(self):
        self.assertTrue(ProposedFenceTrace(("commit",)).outcome()["model_refused"])

    def test_malformed_or_unbounded_models_refuse(self):
        for horizon in (True, -1, 2, 65):
            with self.assertRaises(ValueError):
                list(final_check_counterexamples(horizon))
        with self.assertRaises(ValueError):
            ExpiringTrace((Event("final-check", 2), Event("physical-commit", 1)), 3, "caller")
        with self.assertRaises(ValueError):
            ProposedFenceTrace(("commit", "commit")).outcome()


class CommitBoundaryTests(unittest.TestCase):
    def test_fresh_insertion_does_not_prove_durable_or_visible_freshness(self):
        from native_commit_semantics import CommitBoundaryTrace
        trace = CommitBoundaryTrace(0, 1, 3, 4, 2, "success")
        self.assertFalse(trace.counterexample_at("wal-insertion"))
        self.assertTrue(trace.counterexample_at("durable-wal"))
        self.assertTrue(trace.counterexample_at("visible"))

    def test_fresh_durability_does_not_prove_visibility_freshness(self):
        from native_commit_semantics import CommitBoundaryTrace
        trace = CommitBoundaryTrace(0, 1, 2, 4, 3, "success")
        self.assertFalse(trace.counterexample_at("durable-wal"))
        self.assertTrue(trace.counterexample_at("visible"))

    def test_reply_loss_or_timeout_never_proves_rollback_or_allows_replay(self):
        from native_commit_semantics import CommitBoundaryTrace
        for reply in ("success", "lost", "timeout"):
            trace = CommitBoundaryTrace(0, 1, 3, 4, 2, reply)
            self.assertTrue(trace.counterexample_at("durable-wal"))
            requirement = trace.inspection_requirement()
            self.assertTrue(requirement["exact_original_intent_required"])
            self.assertFalse(requirement["automatic_replay_allowed"])
            self.assertFalse(requirement["reply_establishes_freshness"])
            self.assertFalse(requirement["operational_acceptance"])

    def test_expiry_equality_and_unknown_boundary_refuse(self):
        from native_commit_semantics import CommitBoundaryTrace
        trace = CommitBoundaryTrace(0, 1, 2, 3, 2, "timeout")
        self.assertTrue(trace.counterexample_at("durable-wal"))
        with self.assertRaises(ValueError):
            trace.counterexample_at("commit")

    def test_model_does_not_silently_claim_async_order_or_accept_coercions(self):
        from native_commit_semantics import CommitBoundaryTrace
        for args in ((0, 1, 4, 2, 3, "success"), (False, 1, 2, 3, 4, "success"),
                     (0, 1, 2, 3, 4, "cancelled")):
            with self.assertRaises(ValueError):
                CommitBoundaryTrace(*args)


class CommitPartialOrderTests(unittest.TestCase):
    def test_async_visibility_does_not_make_later_durability_fresh(self):
        from native_commit_semantics import CommitPartialOrderTrace
        result = CommitPartialOrderTrace(0, 1, 5, 2, 3).describe()
        self.assertTrue(result["visible_before_durable"])
        self.assertEqual(result["expired_boundaries"], ("durable-wal",))
        self.assertTrue(result["fresh_check"])
        for key in ("strict_release_implemented", "proposal_accepted", "operational_acceptance"):
            self.assertFalse(result[key])

    def test_visible_at_expiry_cannot_be_undone_by_later_timeout(self):
        from native_commit_semantics import CommitPartialOrderTrace
        result = CommitPartialOrderTrace(0, 1, 5, 3, 3).describe()
        self.assertEqual(result["expired_boundaries"], ("durable-wal", "visible"))
        self.assertFalse(result["reply_or_timeout_can_undo_visibility"])

    def test_synchronous_and_equal_completion_phases_are_explicit(self):
        from native_commit_semantics import CommitPartialOrderTrace
        for durable, visible in ((2, 4), (4, 4)):
            result = CommitPartialOrderTrace(0, 1, durable, visible, 3).describe()
            self.assertFalse(result["visible_before_durable"])
            self.assertIn("visible", result["expired_boundaries"])

    def test_invalid_partial_orders_or_boolean_ticks_refuse(self):
        from native_commit_semantics import CommitPartialOrderTrace
        for args in ((0, 2, 1, 3, 4), (0, 2, 3, 1, 4),
                     (1, 1, 2, 3, 4), (False, 1, 2, 3, 4)):
            with self.assertRaises(ValueError):
                CommitPartialOrderTrace(*args)


if __name__ == "__main__":
    unittest.main()
