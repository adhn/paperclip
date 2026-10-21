"""Pure synthetic schema tests; these results never qualify operationally."""
import copy
import unittest
from datetime import datetime, timedelta, timezone
from daily_use_acceptance import ORIGINAL_AGENTS, EVIDENCE, GATES, SCENARIOS, SPECIAL, manifest, validate


def record():
    return {"kind": "real-observation", "artifact": "fixture-reference", "sha256": "a"*64,
            "observer": "fixture-observer", "reviewer": "fixture-reviewer"}


def fixture():
    # Deliberately forged labels test structure only, never real evidence.
    report = {"schema": 1, "synthetic": False, "operational_acceptance": False,
              "original_agents": ORIGINAL_AGENTS.copy(),
              "prerequisites": {gate: record() for gate in GATES}, "stages": []}
    base = datetime(2026, 10, 22, tzinfo=timezone.utc)
    for i, provider in enumerate(("codex", "claude")):
        start = base + timedelta(hours=i)
        stage = {"provider": provider, "agent_identity": report["original_agents"][provider],
                 "start": start.isoformat(), "end": (start+timedelta(minutes=50)).isoformat(), "tasks": []}
        for n, (scenario, _) in enumerate(SCENARIOS, 1):
            a = start + timedelta(minutes=4*(n-1))
            stage["tasks"].append({"number": n, "scenario": scenario, "run_id": f"{provider}-{n}",
                                  "start": a.isoformat(), "end": (a+timedelta(minutes=3)).isoformat(),
                                  "result": "pass", "synthetic": False,
                                  "evidence": {key: record() for key in EVIDENCE + SPECIAL.get(scenario, ())}})
        report["stages"].append(stage)
    return report


class AcceptanceTest(unittest.TestCase):
    def test_manifest_never_grants_acceptance(self):
        m = manifest()
        self.assertFalse(m["operational_acceptance"])
        self.assertEqual(m["budget"]["tasks_per_provider"], 10)
        self.assertEqual(len(m["stages"][0]["tasks"]), 10)

    def test_shape_only_accepts_complete_fixture(self):
        self.assertEqual(validate(fixture()), [])

    def test_missing_synthetic_failed_and_short_records_rejected(self):
        for field, value in (("prerequisites", {}), ("synthetic", True),
                             ("operational_acceptance", True), ("stages", []),
                             ("original_agents", [])):
            r = fixture()
            r[field] = value
            self.assertTrue(validate(r), field)
        self.assertTrue(validate(None))

    def test_missing_every_special_fact_rejected(self):
        for stage in fixture()["stages"]:
            for n, (scenario, _) in enumerate(SCENARIOS):
                for key in SPECIAL.get(scenario, ()):
                    r = fixture()
                    del r["stages"][0]["tasks"][n]["evidence"][key]
                    self.assertTrue(validate(r), key)

    def test_serial_order_identity_and_duplicate_run_rejected(self):
        for change in ("order", "identity", "duplicate", "overlap", "count"):
            r = fixture()
            if change == "order":
                r["stages"].reverse()
            elif change == "identity":
                r["stages"][0]["agent_identity"] = "replacement"
            elif change == "duplicate":
                r["stages"][1]["tasks"][0]["run_id"] = "codex-1"
            elif change == "overlap":
                r["stages"][1]["start"] = r["stages"][0]["start"]
            else:
                r["stages"][0]["tasks"].pop()
            self.assertTrue(validate(r), change)

    def test_budgets_and_aware_timestamps(self):
        for value in ("2026-10-22T00:11:00+00:00", "2026-10-22T00:03:00", "bad"):
            r = fixture()
            r["stages"][0]["tasks"][0]["end"] = value
            self.assertTrue(validate(r))
        r = fixture()
        r["stages"][1]["end"] = "2026-10-22T04:00:00+00:00"
        self.assertTrue(validate(r))

    def test_artifact_required_and_synthetic_evidence_rejected(self):
        for change in ("kind", "sha256", "reviewer", "artifact"):
            r = fixture()
            r["stages"][0]["tasks"][0]["evidence"]["placement"][change] = ""
            self.assertTrue(validate(r), change)

    def test_boolean_counters_and_numeric_hash_rejected(self):
        for field in ("schema", "number", "sha256"):
            r = fixture()
            if field == "schema":
                r["schema"] = True
            elif field == "number":
                r["stages"][0]["tasks"][0]["number"] = True
            else:
                r["prerequisites"][GATES[0]]["sha256"] = int("1"*64)
            self.assertTrue(validate(r), field)

    def test_task_failure_and_nonobjects_fail_closed(self):
        for value in (None, {}, {"result": "fail"}):
            r = fixture()
            r["stages"][0]["tasks"][0] = copy.deepcopy(value)
            self.assertTrue(validate(r))
        r = fixture()
        r["stages"][0] = None
        self.assertTrue(validate(r))


if __name__ == "__main__":
    unittest.main()
