# Candidate native admission database boundary

Development foundation, 2026-10-18. **Not enabled or deployable admission control.**
Production preparation, image recipes and workload digests are unchanged. Only
foundation CI explicitly calls `scripts/patch-native-admission.py`, after PR #4
source attestation and the candidate SSH overlay.

## Trusted identity and guard continuation — 2026-10-19

The candidate accepts an immutable **host-only** `trustedCapacityPolicy`. Each
binding names the physical instance/runner, actual provider account and shared
workspace/session/credential stores, and pins saved agent/environment contracts
plus approved composed workspace/project/routine environment contracts. The
candidate accepts only the three explicit CLI engines. Managed AI bindings and
provider auth/endpoint overrides are held before executable preparation. Aliases of one resource must
use one identity, including across companies. The server does not infer account
ownership from a caller string, HOME path, SSH DNS alias or copied credential.
The trusted bootstrap mapping and physical/account/state attestation remain
operational rollout inputs; no request/configuration route can install policy.

With policy, native registration derives all seven required scopes and registers
them automatically, rejecting caller scope sets. Existing drain/cooldown/revision
state is preserved; conflicting capacities require an explicit policy transition.
Mutable state scopes remain exclusive. The contract scope detects changed policy
but never replaces physical/shared resource scopes. Exact native claim and launch
journaling recheck trusted identity. Capacity denial is projected into queued run
`resultJson.executionCapacity`; grants clear that wait in the native transaction.

Creating a policy-backed service installs its guard context for that database
handle. Heartbeat, workspace preparation and environment lease acquisition check
reservation/run ownership and actual passed target snapshots before executable
setup. Effective source workspace configuration must match the host allowlist,
so task overrides cannot select another credential/session/workspace identity.
Environment probes, adapter-test target acquisition, managed tests and lifecycle
verification are guarded before setup. **These non-run operations currently hold
rather than execute:** operator probes return a capacity conflict and lifecycle
verification remains pending. A durable auxiliary-operation reservation and
all-command launch/stop journal are still required. This is a guard foundation,
not complete step-2 or all-path acceptance; do not activate it.

The ordinary raw-scope service seam remains for contract/characterization tests
only. No production caller, bootstrap configuration, image pin or live limit is
changed. The CI workflow now also attempts the entire candidate production image
and controller-local CLI guards in a separate non-publishing job after fixtures.
That source build cannot establish functional admission/recovery acceptance.

Remaining sequence: connect auxiliary operations and pre-setup command journaling;
finish native eligibility/wake/sweep progress; connect durable journal to every SSH
launch and remote epoch acknowledgement; verify stop plus workspace/session/
credential restoration before release; add assembled failure/restart tests. Keep
PR #5 draft and every existing live hold.

## Queue claim integration continuation

The candidate now connects `executionAdmission.claimTransaction` to the real
`heartbeat/queue.ts` claim branches through a host-only `HeartbeatServiceOptions`
injection. No environment variable, API, default policy, production caller,
image recipe or workload activates it. Registration remains explicit with trusted
synthetic scope sets until canonical policy resolution is implemented.

Ordinary, queued-comment, automation/chat-control and native-review claims keep
their native authority checks. Scheduler/scope locks surround only database
claim work; native issue → wake → run lock order is retained, and the prepared
agent contract plus per-agent running limit are checked under its database lock.
Candidate agent/issue/wake/run locks use NOWAIT and roll back on contention,
avoiding inversion with enqueue paths that update an agent after taking an issue.
Run status, wake claim, issue ownership and reservation commit together. A native
comment discard or committed conversation-close cancellation commits without a
capacity grant or fairness advance; null/deferred partial writes roll back.
Lifecycle notifications, logging and dispatch occur after the outer commit.

The exact prepared run must be the selected fairness candidate. A per-agent
caller cannot claim another agent's run or bypass an earlier candidate. This is
not yet a complete fair scheduler: an earlier candidate that fails external
preflight can hold later work until the native eligibility sweep revisits it.
Per-constrained-runner scheduling, bounded fair progress, visible native waits
and wake/retry coordination remain acceptance gates; do not enable from this
transaction integration alone.

Tests now exercise actual queue branches with PostgreSQL, independent-client
claims, native cancellation during scheduler contention, discard, pause,
capacity waits, rollback after native writes, stale review eligibility and
post-commit visibility. Two assembled heartbeat tests use a mocked adapter to
prove reservation-before-dispatch and retained occupancy after terminal status,
and excess-demand queueing. Affected existing queue/checkout/comment/drain
regressions run too. These are not real-provider or assembled recovery acceptance.
CI additionally runs the full server typecheck with a 6 GiB container limit;
do not repeat that graph inside the laptop's 3 GiB budget. Full production build
and the remaining all-path/failure/recovery tests are still required before any
deployment proposal.

## Original foundation (historical; queue wiring superseded above)

## Implemented

The overlay adds five Drizzle tables, generated migration `0340`, schema exports,
one typed server service and its PostgreSQL contract suite. The journal retains
every existing entry and appends `0340`; snapshot retention advances from `0335`–`0339` to
`0336`–`0340`. Migration generation uses the cached compiler and drizzle-kit
directly, equivalent to the generation portion of `pnpm db:generate`, avoiding
the offline Corepack download seen during earlier work. The generated SQL only
adds the new tables, constraints and indexes. No live migration runs.

Admission metadata links native runs rather than accepting free-form operation
or project identities. Company/run lookup, registered agent/issue identity and
persisted issue/project fairness identity are checked. Host-supplied scope sets
are snapshotted and de-duplicated; **canonical scope resolution is still absent**.
Known scope keys alone do not prove that a caller selected every required scope.

A scheduler row serializes grants across database clients. Claims check drain,
backup/evaluation exemption, cooldown and shared capacity. The database-only
native claim callback runs in the same transaction, under a savepoint. A null
claim rolls back partial native writes and leaves a visible wait reason; a thrown
error rolls back the whole grant and fairness cursor. Returned/persisted native
identity must match. This callback contract is **not yet wired to the actual
heartbeat ordinary/comment/automation/native-review claim branches**. The test
callback locks and updates real native tables but is a stand-in for those branches.
Do not describe these as assembled heartbeat acceptance tests.

The reservation remains charged through setup, stopping and uncertainty, even
after the native run becomes terminal. Queued cancellation and reservation
cancellation differ; the eventual coordinator must compose native cancellation
and its post-commit effects. No release method exists: safe release requires
independent process-stop and mutable-state restoration evidence.

Before returning a launch binding, the service commits an exact company/agent/
run/attempt/epoch/environment/lease/invocation journal. It checks the active SSH
lease against the registered native run and agent. Start binding is single-use;
lost responses cannot request another launch. The database also prevents reused
invocation IDs. The service does not call SSH or supply a fence root. It must not
be used to bypass the admission required before workspace/setup execution.

Takeover records durable epoch history, fences old database writers, enters drain
and retains every occupied attempt as uncertain. Reusing any prior epoch fails.
Remote epoch fencing, reconciliation and resuming drain are not implemented by
this service; database takeover alone never proves remote ownership or stop.

## Verification and limits

`scripts/test-native-admission.sh` runs in a test image with networking disabled,
3 GiB RAM, 5 GiB including swap, two CPUs and 256 PIDs. It runs migration
numbering/safety, DB typecheck, all 19 PostgreSQL cases and a focused service
typecheck including imported database contracts. PostgreSQL support failures fail
the suite rather than skipping it. The fixture uses a temporary fully migrated
database, not the homelab database.

Cases cover independent-client contention, rollback and deferred savepoints,
sibling identity rejection, terminal/zero-limit holds, queued and admitted
cancellation, cancellation/grant race, drain/backup/cooldown waits, queue ceiling,
FK retention, company boundaries, immutable identity, exact single-use journal,
epoch takeover/reuse rejection and new-project fairness frontier.

The full server typecheck exceeded the local container memory budget (exit 137);
it is not a passing check. The focused check does not replace a full production
build/typecheck before a deployable handoff. An initial check found and corrected
a query-builder error. Initial migration generation found and corrected a
drizzle-kit BigInt-default serialization issue. An initial container-user setup
failed before running the database cases; the corrected setup uses root only to
prepare library ownership, then runs PostgreSQL/tests as `node`.

The overlay manifest checks baseline source/journal/snapshot hashes, all candidate
file hashes and the exact upstream revision before writing. Reapplying refuses
the changed baseline. Production `prepare-controller.py` never calls the overlay.

Still required: actual claim-boundary extraction and eligibility preservation,
server-owned runner/account/workspace/session/credential identity and policy
revision fencing, probe/non-heartbeat identities, all setup/verification guards,
database-to-SSH handoff, remote takeover acknowledgement, stop/restoration
verification and recovery, per-runner fairness and native wait projection,
historical occupancy import, full build and assembled/live acceptance.

Keep PR #5 draft, Gemini deferred, timers off, historical A holds untouched and B
paused. No capacity increase, receipt backfill, provider call or live mutation.
