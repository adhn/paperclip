"""Offline acceptance preparation. Never dispatches or grants operational acceptance."""
import argparse
import json
import re
from datetime import datetime

ORIGINAL_AGENTS = {"codex": "be500ba7-65ad-4a72-8369-474eb2522274",
                   "claude": "562ed16a-c09c-4660-92d7-bba077643d7f"}

BUDGET = {"tasks_per_provider": 10, "task_seconds": 600, "stage_seconds": 7200}
GATES = (
    "separate_dispatch_authorization", "reviewed_rollout", "complete_shared_hold_resolution",
    "mandatory_all_command_enforcement", "physical_stale_writer_exclusion",
    "independently_current_history", "real_issuer_and_custody", "uncertain_operation_inspection",
    "reviewed_immutable_activation", "credential_scope_and_budget_review",
    "valuable_state_recovery_or_explicit_release_risk_decision",
)
# Each numbered item consumes one of the ten tasks, including fault scenarios.
SCENARIOS = (
    ("python_coding", "In the designated disposable repository create parser.py exposing parse_count(text): accept only nonempty ASCII decimal digits and return int(text); reject all other inputs with ValueError. Create test_parser.py with unittest cases for 0, 0012, empty, whitespace, negative, decimal and Unicode digits. Run python3 -m unittest -v test_parser. Record exact command/output, placement and callback."),
    ("typescript_coding", "Implement a small TypeScript function and edge cases using the selected repository's existing test command. Record command and actual passing test output; install nothing implicitly."),
    ("workspace_dirty", "Create tracked changes, an untracked file, a deletion and binary fixture in the disposable workspace. Capture exact paths/bytes/modes and Git status at runner and authoritative controller."),
    ("session_resume", "Continue the same issue using the supported adapter session. Ask for a prior-task random marker without restating it; compare session identity and file inventory; record any intentional new session."),
    ("git_delivery", "In the isolated local acceptance repository create a topic commit; verify exact parent/tree and dirty leftovers. Prepare a patch for human review; publication/push/PR requires separate authorization."),
    ("credential_renewal", "Using the approved supported renewal path, execute one post-renewal coding task. Record redacted grant lineage, effective state roots, renewal event and authoritative copy-back/reuse. Never expose tokens or manufacture expiry."),
    ("cancellation", "Start a bounded task with a foreground descendant writing a counter. Cancel through Paperclip's supported run control. Capture deny T, independent completed retirement B, exact workload/epoch, no later bytes and retained uncertainty; API cancelled alone fails."),
    ("disconnect", "During a bounded coding task use the separately reviewed scoped fault injector to interrupt only this execution transport. Inspect original operation, keep occupancy until settled, refuse duplicate dispatch, reconcile exact workspace. Do not use generic exec or network mutation."),
    ("runner_restart", "With task state checkpointed, use the separately reviewed exact-workload restart procedure. Inspect original intent before retry; compare durable workspace/session/credential state and stale-writer denial. Active process survival is not expected."),
    ("controller_restart", "Use the separately reviewed controller restart procedure with one bounded task. Reconcile durable run/callback/uncertain intent, prove no replay or extra writer, then inspect final authoritative bytes and return test agent to reviewed paused state."),
)
EVIDENCE = ("placement", "invocation", "callback", "workspace", "authority", "outcome")
SPECIAL = {
    "session_resume": ("session",), "git_delivery": ("git_tree",),
    "credential_renewal": ("renewal", "credential_lineage"),
    "cancellation": ("deny_T", "retirement_B", "stable_bytes", "original_intent"),
    "disconnect": ("original_intent", "no_replay", "settlement"),
    "runner_restart": ("original_intent", "no_replay", "stale_writer_denied", "session", "credential_lineage"),
    "controller_restart": ("original_intent", "no_replay", "settlement"),
}


def manifest():
    return {
        "schema": 1, "mode": "offline_preparation", "operational_acceptance": False,
        "budget": BUDGET, "prerequisites": list(GATES),
        "stage_order": ["codex-existing-B", "claude-existing"],
        "original_agents": ORIGINAL_AGENTS.copy(),
        "stages": [{"provider": provider, "agent": agent,
                    "tasks": [{"number": i, "scenario": name, "operator_step": step,
                               "required_evidence": list(EVIDENCE + SPECIAL.get(name, ()))}
                              for i, (name, step) in enumerate(SCENARIOS, 1)]}
                   for provider, agent in (("codex", "existing-B-no-replacement"), ("claude", "existing-Claude"))],
        "preserve": ["A/original shared-family holds until real reviewed reconciliation",
                     "B paused until separately authorized serial stage", "timers disabled",
                     "Gemini deferred", "current capacity", "draft PR5", "human-reviewed merges"],
    }


def instant(value):
    if not isinstance(value, str):
        raise ValueError("timestamp must be text")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("timestamp needs timezone")
    return result


def validate(report):
    """Check record shape/order only. References are never authenticated by this tool."""
    errors = []
    seen_runs = set()
    def need(condition, message):
        if not condition:
            errors.append(message)
    def evidence(value, label):
        valid = isinstance(value, dict) and value.get("kind") == "real-observation"
        need(valid, label + ": real-observation required")
        if isinstance(value, dict):
            for key in ("artifact", "observer", "reviewer"):
                need(isinstance(value.get(key), str) and bool(value[key].strip()), label + ": missing " + key)
            need(isinstance(value.get("sha256"), str) and bool(re.fullmatch(r"[0-9a-f]{64}", value["sha256"])), label + ": invalid sha256")
    if not isinstance(report, dict):
        return ["report must be an object"]
    need(type(report.get("schema")) is int and report["schema"] == 1, "schema must be 1")
    need(report.get("synthetic") is False, "synthetic results cannot qualify")
    need(report.get("operational_acceptance") is False, "collector cannot grant operational acceptance")
    gates = report.get("prerequisites", {})
    for gate in GATES:
        evidence(gates.get(gate) if isinstance(gates, dict) else None, "prerequisite " + gate)
    agents = report.get("original_agents", {})
    if not isinstance(agents, dict):
        agents = {}
    need(agents == ORIGINAL_AGENTS, "saved original B and Claude identities required")
    stages = report.get("stages")
    if not isinstance(stages, list) or len(stages) != 2:
        return errors + ["exactly Codex then Claude stages required"]
    previous_end = None
    for index, stage in enumerate(stages):
        if not isinstance(stage, dict):
            errors.append("stage must be an object")
            continue
        provider = ("codex", "claude")[index]
        need(stage.get("provider") == provider, "wrong provider order")
        need(stage.get("agent_identity") == agents.get(provider)
             and bool(stage.get("agent_identity")), "original agent identity required: " + provider)
        try:
            start, end = instant(stage["start"]), instant(stage["end"])
            need(0 <= (end-start).total_seconds() <= 7200, "stage exceeds two hours")
            need(previous_end is None or start >= previous_end, "stages must be serial")
            previous_end = end
        except (KeyError, ValueError, TypeError):
            errors.append("invalid stage timestamps")
            start = end = None
        tasks = stage.get("tasks")
        if not isinstance(tasks, list) or len(tasks) != 10:
            errors.append("exactly ten tasks required: " + provider)
            continue
        task_end = start
        for number, (task, (scenario, _)) in enumerate(zip(tasks, SCENARIOS), 1):
            label = f"{provider}/{number}/{scenario}"
            if not isinstance(task, dict):
                errors.append(label + ": task must be object")
                continue
            need(type(task.get("number")) is int and task["number"] == number and task.get("scenario") == scenario, label + ": scenario/order mismatch")
            run = task.get("run_id")
            need(isinstance(run, str) and bool(run) and run not in seen_runs, label + ": unique run_id required")
            if isinstance(run, str):
                seen_runs.add(run)
            need(task.get("result") == "pass" and task.get("synthetic") is False, label + ": real passing result required")
            try:
                a, b = instant(task["start"]), instant(task["end"])
                need(0 <= (b-a).total_seconds() <= 600, label + ": task exceeds ten minutes")
                need(start is not None and start <= a <= b <= end, label + ": outside stage")
                need(task_end is not None and a >= task_end, label + ": tasks overlap")
                task_end = b
            except (KeyError, ValueError, TypeError):
                errors.append(label + ": invalid timestamps")
            records = task.get("evidence", {})
            for key in EVIDENCE + SPECIAL.get(scenario, ()):
                evidence(records.get(key) if isinstance(records, dict) else None, label + "/" + key)
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("manifest", "validate"))
    parser.add_argument("report", nargs="?")
    args = parser.parse_args()
    if args.command == "manifest":
        print(json.dumps(manifest(), indent=2))
        return 0
    if not args.report:
        parser.error("validate requires a JSON report")
    try:
        with open(args.report, encoding="utf-8") as source:
            errors = validate(json.load(source))
    except (OSError, ValueError) as exc:
        errors = [str(exc)]
    print(json.dumps({"record_structure_valid": not errors, "operational_acceptance": False,
                      "independent_artifact_review_required": True, "errors": errors}, indent=2))
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
