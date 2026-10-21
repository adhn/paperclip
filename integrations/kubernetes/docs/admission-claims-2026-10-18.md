# Candidate native queue claim integration — 2026-10-18

Verified development increment, tested commit `b258587`, in [draft homelab PR #5](https://github.com/adhn/homelab/pull/5).
The immediate scope is atomic native queue claims. Production preparation,
workload/image pins and live concurrency remain unchanged. No live migration,
provider dispatch, cluster mutation or runtime re-verification was performed.

## Change

The test-only native overlay now connects the actual ordinary, queued-comment,
automation/chat-control and native-review claim branches to the reservation
transaction. A host-only heartbeat option injects the candidate service; there
is no API/environment switch, default policy, automatic scope registration or
production activation. Native preflight still owns authority, budgets,
dependencies, pause holds, staleness, responsible-user resolution and daily caps.

Only database claim work runs under the admission scheduler lock. The prepared
agent contract and per-agent running limit are rechecked under an agent lock,
then native issue → wake → run ordering is retained. These locks use NOWAIT
and rollback on contention to avoid inversion with issue-first enqueue paths. Native run, wake, issue
execution ownership and reservation commit together. Exceptions roll back the
native writes and fairness cursor. Deferred claims roll back their savepoint;
comment discard and committed conversation-close cancellation commit without
a grant or fairness advance. Events, lifecycle callbacks and dispatch follow the
outer commit. Terminal native status still does not release capacity.

The selected candidate must match the exact prepared native run/company. A
per-agent caller cannot consume a sibling's reservation or jump the fairness
frontier. This does not yet provide a complete native fair scheduler: earlier
candidates failing external preflight can hold later requests until revisited.
Fair eligibility/wake/sweep coordination, per-constrained-runner progress and
visible waits remain explicit acceptance gates before activation.

## Validation

Local final PASS: all **53** cases in the candidate queue/foundation/assembled
scheduler rerun, including the new NOWAIT contention guard and corrected native
stale-review expectation. The four additional affected characterization suites
passed **104** cases in the broader run: comment wakes (28), stale queues (61),
task-drain claim release (3), auto-checkout (12). This totals **157 distinct passing
cases**, including 21 new actual-claim/assembled scheduler cases. CI
`39156248729` passed all 47 queue/foundation cases but failed loading the assembled
suites because a fresh dependency-only image lacked compiled plugin SDK exports.
Test-only image revision `437868f` now explicitly builds the shared/plugin SDK,
eval kernel and Runner TypeScript surfaces. A clean-cache, network-disabled local
reproduction built these dependencies and passed all six assembled scheduler cases. CI `39156838749` on
`437868f` passed the full 157-case server group and dependency/migration/focused
checks. Its full server typecheck was killed with exit 137 at the 6 GiB container
limit. The pinned TypeScript 7 launcher execs a native Go compiler; the attempted
Node heap setting had no effect. CI-only revision `b258587` sets `GOMEMLIMIT=4GiB`,
`GOGC=50`, `GOMAXPROCS=2` within the same 6 GiB container and runs the typecheck
before the longer server suite. Final CI [39157600871](https://github.com/adhn/homelab/actions/runs/39157600871)
**PASS** on `b258587`: all 157 server cases, 154 existing transport cases, full
server and adapter-utils typechecks, migration/DB/focused checks, original 18
PostgreSQL/24 subprocess contracts, source reconstruction and both actual-SSH
fixtures. Saved `ci-result.json` and `ci.log` are in the local evidence directory.
No full production build or all-path recovery acceptance is claimed.
Raw evidence is `.handoff-state/2026-10-18/admission-claims/`.

The suite includes PostgreSQL tests of the actual queue branches, independent-client
contention, cancellation while waiting for the scheduler lock, native review
eligibility, zero capacity, pause during preflight, comment discard,
post-commit visibility and failure after native writes. Two assembled heartbeat
cases use a mocked adapter to verify reservation-before-dispatch, retained
terminal occupancy and capacity waits; existing checkout/comment/drain/stale
queue regressions run alongside them.

The first expanded run passed 43 cases and exposed three native-review fixture
failures: the source run lacked the contract binding required by the real
foreign key. The fixture was corrected without weakening schema constraints.
The broader run then passed 155 of 156 cases; its sole failure was a new
stale-review assertion expecting queued status, while the existing native
staleness gate correctly cancelled the run. The assertion now requires that
cancellation and no grant, preserving native behavior.
An earlier cached-image run lacked migration 0340; a later log-option parsing
failure occurred before tests. Neither involved a provider or live database.

Overlay hashes reproduce from their exact baseline and repeat application is
refused. The heartbeat baseline includes PR #4's attested lease callback change;
it is not the bare upstream heartbeat file. Static validation/diff checks pass.
Local tests remain network-disabled, non-root, 3 GiB RAM/5 GiB including swap,
two CPUs and 256 PIDs. CI now separately checks the full server graph with a
6 GiB container limit; the earlier laptop exit 137 is not reclassified as a pass.

## Remaining gates

Next is trusted canonical runner/account/workspace/session/credential identity
and policy resolution, plus setup/probe/lifecycle-verification guards. Exact
journal-to-SSH launch ownership, remote takeover acknowledgement, restoration
and stop reconciliation, safe release and restart/cancellation/failure coverage
remain open. Full production build/typechecks and assembled all-path acceptance
are required before proposing deployment. These claim tests do not establish
real-provider throughput, recovery, or supported concurrency.

Keep PR #5 draft, human-reviewed merges, historical A holds, B paused, Gemini
authentication deferred, timers disabled and everyday-use/recovery gates open.
No historical receipt backfill, direct lifecycle repair or replacement agents.
