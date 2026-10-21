"""Executable counterexamples, NOT a release authorizer or native implementation.

Logical clock/scheduler model only. Actual PostgreSQL early-flush evidence remains
in test_authority_native_postgres.py. No PostgreSQL commit primitive is supplied.
The monotonic alternative is explicitly unaccepted proposed semantics.
"""
from dataclasses import dataclass, asdict
from itertools import combinations
import json


@dataclass(frozen=True)
class Event:
    kind: str
    tick: int


@dataclass(frozen=True)
class ExpiringTrace:
    events: tuple[Event, ...]
    expires_at: int
    owner: str

    def __post_init__(self):
        if self.owner not in ("caller", "exclusive-owner"):
            raise ValueError("unknown owner")
        if type(self.expires_at) is not int or self.expires_at < 0:
            raise ValueError("invalid expiry")
        if len(self.events) < 2:
            raise ValueError("missing commit/check")
        if any(type(e.tick) is not int or e.tick < 0 for e in self.events):
            raise ValueError("invalid logical time")
        if any(a.tick >= b.tick for a, b in zip(self.events, self.events[1:])):
            raise ValueError("events must be ordered")
        kinds = [e.kind for e in self.events]
        if kinds[-1] != "physical-commit" or kinds.count("physical-commit") != 1:
            raise ValueError("one final physical commit required")
        if any(k not in ("body-check", "early-flush-check", "final-check", "physical-commit") for k in kinds):
            raise ValueError("unknown event")
        if not any(k.endswith("check") for k in kinds):
            raise ValueError("missing check")
        if self.owner == "exclusive-owner" and "early-flush-check" in kinds:
            raise ValueError("caller flush excluded by model owner")

    @property
    def checks_pass(self):
        return all(e.tick < self.expires_at for e in self.events if e.kind.endswith("check"))

    @property
    def strict_commit_fresh(self):
        return self.events[-1].tick < self.expires_at

    @property
    def counterexample(self):
        return self.checks_pass and not self.strict_commit_fresh


def final_check_counterexamples(horizon=8):
    """Exhaust finite schedules with body<final<physical commit; no caller SQL.

    Timeouts do not constrain WAL/scheduler delay in this model. A proved commit
    primitive would need an additional invariant; none is invented here.
    """
    if type(horizon) is not int or not 3 <= horizon <= 64:
        raise ValueError("bounded horizon required")
    for body, final, commit in combinations(range(horizon), 3):
        for expiry in range(final + 1, commit + 1):
            yield ExpiringTrace((Event("body-check", body), Event("final-check", final),
                                 Event("physical-commit", commit)), expiry, "exclusive-owner")


@dataclass(frozen=True)
class ProposedFenceTrace:
    """Hypothetical ordered facts, never evidence that a real fence exists.

    Accepted retirement persists for the exact old incarnation. Reopening requires
    a new incarnation. Concurrent revoke/rotate serializes on the native fence;
    stale physical/runtime owners and restored endpoints must ALSO be excluded.
    """
    events: tuple[str, ...]

    def outcome(self):
        allowed = {"accept-retirement", "expire-observation", "revoke", "rotate", "commit", "stale-physical-write"}
        if len(self.events) != len(set(self.events)) or any(e not in allowed for e in self.events):
            raise ValueError("unique known model events required")
        accepted = False
        invalidated = False
        committed = False
        refused = False
        broken_physical_fence = False
        for event in self.events:
            if event == "accept-retirement":
                accepted = True
            elif event in ("revoke", "rotate"):
                invalidated = True
            elif event == "commit":
                committed = accepted and not invalidated
                refused = not committed
            elif event == "stale-physical-write":
                broken_physical_fence = True
        return {"model_committed": committed, "model_refused": refused,
                "physical_fence_assumption_violated": broken_physical_fence,
                "operational_acceptance": False, "proposal_accepted": False}


def main():
    early = ExpiringTrace((Event("body-check", 0), Event("early-flush-check", 1),
                           Event("physical-commit", 5)), 3, "caller")
    examples = list(final_check_counterexamples())
    print(json.dumps({"kind": "counterexample-model-only", "operational_acceptance": False,
                      "strict_release_implemented": False, "early_flush": asdict(early),
                      "early_flush_bypasses": early.counterexample,
                      "exclusive_owner_final_check_counterexamples": len(examples),
                      "first_final_check_gap": asdict(examples[0]),
                      "monotonic_alternative": "PROPOSED ONLY; requires explicit requirement review and actual fences"}, indent=2))


@dataclass(frozen=True)
class CommitBoundaryTrace:
    """Logical commit phases; not claims about an authenticated engine build.

    A review must select its irreversible boundary. Fresh WAL insertion does not
    imply fresh durable flush or visibility. A lost reply says nothing about any
    of these. Ordering here is an explicit synchronous scenario, not a universal
    PostgreSQL execution order (asynchronous commit can expose before flush).
    """
    checked_at: int
    wal_inserted_at: int
    wal_durable_at: int
    visible_at: int
    expires_at: int
    reply: str

    def __post_init__(self):
        times = (self.checked_at, self.wal_inserted_at, self.wal_durable_at,
                 self.visible_at, self.expires_at)
        if any(type(t) is not int or t < 0 for t in times):
            raise ValueError("nonnegative exact logical ticks required")
        if not (self.checked_at < self.wal_inserted_at <= self.wal_durable_at <= self.visible_at):
            raise ValueError("this model requires ordered synchronous phases")
        if self.reply not in ("success", "lost", "timeout"):
            raise ValueError("unknown reply")

    def counterexample_at(self, boundary):
        ticks = {"wal-insertion": self.wal_inserted_at,
                 "durable-wal": self.wal_durable_at, "visible": self.visible_at}
        if boundary not in ticks:
            raise ValueError("explicit reviewed boundary required")
        return self.checked_at < self.expires_at <= ticks[boundary]

    def inspection_requirement(self):
        # Even a success response does not prove freshness or exact effect identity.
        return {"exact_original_intent_required": True,
                "reply_establishes_freshness": False,
                "automatic_replay_allowed": False,
                "operational_acceptance": False}


@dataclass(frozen=True)
class CommitPartialOrderTrace:
    """Hypothetical phase times; no engine evidence or release authorizer.

    Either durability/visibility ordering is allowed after WAL insertion. This
    extends the synchronous counterexample without assuming engine compatibility.
    """
    checked_at: int
    wal_inserted_at: int
    wal_durable_at: int
    visible_at: int
    expires_at: int

    def __post_init__(self):
        times = (self.checked_at, self.wal_inserted_at, self.wal_durable_at,
                 self.visible_at, self.expires_at)
        if any(type(t) is not int or t < 0 for t in times):
            raise ValueError("nonnegative exact logical ticks required")
        if not (self.checked_at < self.wal_inserted_at <= min(self.wal_durable_at, self.visible_at)):
            raise ValueError("check and insertion must precede both completion phases")

    def describe(self):
        boundaries = {"wal-insertion": self.wal_inserted_at,
                      "durable-wal": self.wal_durable_at, "visible": self.visible_at}
        return {"kind": "counterexample-model-only",
                "visible_before_durable": self.visible_at < self.wal_durable_at,
                "fresh_check": self.checked_at < self.expires_at,
                "expired_boundaries": tuple(name for name, tick in boundaries.items()
                                            if tick >= self.expires_at),
                "reply_or_timeout_can_undo_visibility": False,
                "strict_release_implemented": False,
                "proposal_accepted": False, "operational_acceptance": False}


if __name__ == "__main__":
    main()
