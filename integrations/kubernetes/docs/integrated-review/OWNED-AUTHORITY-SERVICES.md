# Owned authority services — inactive implementation continuation

Latest: [daily-use mechanisms, real Ed25519 verification and exact remaining blockers](DAILY-USE-MECHANISMS.md).

This package adds actual local process ownership and durable local prospective
history. It does not implement the missing distributed authority or install a
runtime, storage backend, issuer, listener, key or native execution route.
The native 64-file source remains `d489129`; production stays unchanged.

## Implemented composition

`production/runtime_owned.py` owns one persistent spawned process group. Its
protected factory constructs the synchronous backend inside that worker. The
local gate starts held, requires completed backend recovery before prospective
intents or effects, and closes before re-recovery. `execute_at_effect` belongs
to the backend itself: no callback or authorization permit is returned for a
caller to execute later. Exact allowlisted argument sets reject generic command
dispatch. Deadline or cancellation terminates the local group permanently; no
replacement worker or effect replay follows. The supplied backend still must
implement the actual unavoidable runtime boundary and retained remote ownership.

`production/owned_authority_calls.py` provides `OwnedRootGroupBackend`,
`OwnedAtomicWriteBackend` and `OwnedDecisionAuthority`. They can compose with the
existing root-group, ordered-write and ordered-decision helpers. Exact immutable
root intents survive JSON transport; exact binary bytes are hash/count checked
inside the worker, and successful write results remain intent bound. A persistent
write authority and caller-side consumed IDs prevent local duplicate writes.
They do not substitute for durable backend no-replay state across process loss.
`OwnedOrderedDecisionUse` additionally constructs the complete decision helper,
verifier and authority inside one worker, so a blocking signature verifier is
owned too. Its fixed local deadline includes queue waiting; backend signed
deadlines may outlast local termination and therefore still require retained
remote uncertainty. `OwnedDecisionAuthority` alone does not bound a caller-side
verifier.

Queue cancellation/expiry before submission leaves the active sibling call alone;
submitted failure permanently holds the owner. Recovery inspection needs separate
protected ownership of the original remote intent, never command replay.

`OperationWorker` rejects boolean/nonfinite deadlines before submission and polls
cancellation during lock admission. Its control process anchors a process group;
local worker/descendant termination is tested with actual processes. Trusted
factories must not escape that group or install daemons. External effects already
submitted by a worker remain unknown and occupied after its termination.

`production/retained_decision_store.py` implements a real SQLite retained-intent
component. Explicit provisioning records complete original holds and protected
identity pins. Ordinary open refuses missing history, wrong pins/floor, symlink,
hardlink, wrong owner/mode or detected inode replacement. Transactions serialize
revision and exact predecessor CAS. Prospective uncertainty is durable before
any native append, prevents another sequence, and survives close/reopen. A
protected coordinator may record a confirmed exact append; unknown append stays
uncertain. A prospective successor immediately makes the old record noncurrent.
Inspection is unsigned historical data, never an append/use permit, safe retry
instruction or `revoked-settled` receipt.

The store assumes a separately protected parent, sole service identity and restore
domain. Its file checks cannot secure a hostile parent or privileged replacement.
SQLite FULL sync and parent fsync establish local persistence only. They cannot
detect rollback of the disk itself, authenticate operator evidence, verify the
completeness of an independently supplied inventory, protect signing keys, or
create independently current service identity. Provisioning disposable files in
tests does not provision operational history.

## Package disposition and dependencies

| Requested package | Implemented/verified source increment | Still blocked or open |
| --- | --- | --- |
| Mandatory runtime start/effect/recovery | Owned backend lifetime and recovery gate; backend-owned effect API | Actual compatible runtime integration, all endpoints/handlers/shims, stale kubelet/recovery exclusion and permanent retirement. Current topology cannot prove B. |
| Atomic write/cancel/revoke and roots | Owned exact-write/revoke/inspection and root pin/CAS calls, local no-replay | Real common atomic effect boundary, all-command routing/output framing, physical stale-open-handle exclusion, complete root-group activation and independent high-water service. |
| Issuer/history/native use | Durable prospective local intent/CAS and exact uncertain inspection | Real evidence/consent issuer, public verifier/key custody, independently operated rollback-excluded retained domain and authority-owned native admission/lifecycle commit with ordered revocation. |
| Cancellable standalone operations | Owned adapters; actual stalled local process termination and contender isolation | Protected factory deployment, remote ownership/inspection and complete installation; passing a deadline to raw synchronous interfaces remains insufficient. |

The existing native `legacyHoldIsReconciled`, lifecycle lease applicability and
admission transaction predicates are unchanged. No observation, current flag,
successful verification or completion receipt can authorize a later effect.
Wrapping an abstract backend bounds its local call; it does not implement that
backend's authority. The underlying raw interfaces remain available for component
composition and are not safe production entry points without owned execution.

## Verification and activation review

Root records exact current test counts, source hashes and hosted result in
[HOSTED-VERIFICATION.md](HOSTED-VERIFICATION.md). Reuse unchanged native/image
passes only for unchanged `d489129` inputs. No heavy graph/build or runtime fixture
is rerun to fill these authority gaps. Tests use synthetic backends and disposable
SQLite files; real processes establish only local ownership behavior.

No production image recipe/input, policy, RBAC, network, workload, migration or
native overlay changed. The [activation boundaries](ACTIVATION-BOUNDARIES.md) and
[ordered integration requirements](ORDERED-AUTHORITY-INTEGRATION.md) remain in
force. The executable activation diff is blocked on real backends and custody.
Fixture brokers, observers and CNI installers must never deploy. Preserve draft
PR #5, historical A/shared original Codex families, paused B, deferred Gemini,
disabled timers, human-reviewed merges and all capacity/everyday-use/recovery holds.
