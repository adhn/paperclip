# Native COMMIT semantics and transaction owner — 2026-10-21

Strict release freshness at physical COMMIT remains **BLOCKED**, and no production
release path has been enabled. This increment supplies executable counterexamples
and an explicit alternative for review, not another authorizer. Baseline is the
newest enforcement-composition handoff/checkpoint, including its actual eighteen
PostgreSQL18 tests and early-flush bypass. Exact ownership was recorded in
`.handoff-state/2026-10-21/sole-owner-continuation/OWNERSHIP.md` before edits. Only
this report and the two new `native_commit_semantics` files were edited by this
track; both dirty checkouts and every existing SQL/native file were preserved.

## Strict requirement and impossibility boundary

Let E be the release fact's expiry, V the last successful wall-clock validation,
and C the physical commit boundary. Current SQL proves only V<E and V<C. It does
not prove C<E. Even an owner that prohibits caller SQL and always runs a final
check cannot exclude scheduler/storage delay between V and C. If E is reached in
that interval, the committed effect violates strict freshness. Increasing time
margins reduces likelihood without establishing the invariant. Statement/idle
transaction deadlines are not a proved bound on physical commit; a timeout or lost
reply also cannot reverse an already committed effect.

The actual prior PG18 fixture already demonstrated the stronger caller attack:
SET CONSTRAINTS ALL IMMEDIATE flushes the release trigger, then caller delay crosses
E and COMMIT succeeds. Removing arbitrary SQL access closes that attack surface
but does not establish strict physical freshness. PREPARE is a separate prolonged
ownership hazard; startup-disabled refusal is useful and unchanged.

No authenticated PostgreSQL commit-source artifact/patch/extension or commit
primitive contract was supplied or found in the canonical workspace file inventory.
No extension was invented, upstream source compatibility inferred, or database
engine hook reviewed on the strength of an image version. A real strict primitive
review must define whether C means WAL insertion, durable local WAL flush, replica
acknowledgement, or visible commit. It must prove expiry ordering at that actual
boundary, including scheduling/I/O delay, clock discontinuity, asynchronous commit,
crash/recovery, prepared transactions, and commit-reply loss. A pre-commit callback,
post-commit observer, synchronous replication wait, or exclusive gateway alone
supplies none of that proof. No claim about a reviewed engine implementation is made.

`protected-execution/native_commit_semantics.py` uses a finite logical scheduler
to enumerate 126 counterexample schedules within eight ticks with body check,
final check, physical commit and no caller flush/delay operation. Every validation
passes; physical commit is at or after expiry. This is executable reasoning under
an explicit model, not new PostgreSQL evidence or a measured WAL-delay attack.
Its CLI always reports `strict_release_implemented=false` and operational
acceptance false. The prior actual PG fixture remains unchanged and was not rerun.

## Explicit proposed alternative, NOT accepted requirements

An alternative is a permanently fenced, monotonic retirement fact for an exact
old incarnation. Fresh artifacts and complete inventory/consent are checked when
the fact is accepted. Their observation window expiring later does not resurrect
the retired process, descriptor, endpoint, credential or session. Every later
native effect still belongs to the same protected generation/deny transaction;
the fact is not a transferable permit. Reopening is a new incarnation, never an
unretirement of the old one. Revoke/rotation must order against the same effect
transaction. Revocation after a committed effect cannot retroactively erase it:
the effect remains pre-deny owned work until settled.

This does **not** meet a requirement that the original expiring release permit
itself must be fresh at physical COMMIT. Selecting it requires explicit requirement
review and acceptance of different semantics. It is therefore not wired into SQL,
root dispatch, native lifecycle, migration or release. Existing native
`legacyHoldIsReconciled` intentionally checks freshness at `latest.createdAt` and
preserves accepted retirement until revoke/epoch/binding change. Preserve that
existing behavior; do not silently extend it to new expiring release permits.

The proposal requires actual permanent runtime/physical canonical exclusion and
independent history/current generation, including already authenticated sessions
and writable restored endpoints. SQL role fencing cannot prove those conditions.
Detached copy, local observation, signer possession and successful stop callback
are insufficient. The model explicitly flags stale physical writes as a violated
assumption even when its model-native transaction succeeds. Its result is never an
authorization or implementation of physical exclusion.

## Actual predicates and sole-owner migration unit

Read-only inspection of the intentionally dirty native source confirms that the
small synthetic SQL schema cannot implement the current native contract. These
conditions must execute from authority-owned current rows, not caller booleans,
P-side preflight results or a callback outside the owning transaction:

| Actual source | Conditions/effects that must move together |
| --- | --- |
| `server/src/services/execution-admission.ts:29,48` | Scheduler-first epoch lock; starts-held/draining; recovery freshness or existing bounded exemption; queued state; scope policy equality; all original historical hold overlaps; unknown scopes; scope drain/notBefore/capacity over reserved/starting/stopping/uncertain; native-preflight eligibility; absent auxiliary caller isolation; project lastGrant/enqueueOrder fairness frontier. |
| `execution-admission.ts:136,158,209,294` | Exact company/run/agent/issue/project relation; prepared requested-run isolation; nested savepoint null claim rollback; persisted native claim binding and status; terminal discard commits without capacity/fairness advance; sequence and project cursor; durable owner/token; registration pending limit and immutable existing identity. |
| `heartbeat/queue.ts:948–1600` | Native review/recovery exceptions; invocation budget and agent invokability; tree pause/dependency and dispatch staleness; issue checkout/predecessor run and pending cleanup/finalization; wake identity/status and external chat recovery authorization; live queued comment filtering/cancellation; native review claim; updated agent lifecycle/version and queued run locking; issue/wake/run mutation; post-commit events only. These are additional native predicates, not covered by the SQL fixture. |
| `execution-capacity-policy.ts:107` | Active SSH environment; exact default environment and CLI adapter/engine; no alternate AI connection; immutable agent/environment fingerprints; exact trusted physical account/runner/workspace/session/credential identities and seven reservation scopes. Seven scopes never replace persisted original five-scope historical holds. |
| `execution-admission-operations.ts:140,203` | Auxiliary kind/key/environment and lifecycle operation/version; immutable cleanup contract; command hash; exact unfinished-command concurrent set; current run cancellation/status; attested non-root fenceRoot; runner epoch ACK; active SSH lease/company/run/agent and auxiliary admissionOperationId; journal and starting/restoration state update in one transaction. |
| `execution-admission-operations.ts:257–325` | Exact command stop binding; no unstopped commands; exact restoration obligation descriptors/checkpoints and successful rows; stopping state; all workspace/session/credential success; legacy launch binding refusal; lifecycle completion/version guard; lease release and attempt release together. |
| `execution-admission.ts:354,385,399` | One-use launch; exact lease/run/agent/environment/policy; queued cancel versus stopping or retained uncertainty; never-reused epoch history; takeover keeps occupied work uncertain. |
| `execution-legacy-reconciliation.ts:29,79` | Original source/fingerprint/identities/policy/scopes; accepted-fact semantics; draining/current generation; terminal run and exact lease; every shared hold across companies/agents locked; inventory hash and genuine independent evidence/approval; shortest acceptance validity; sequence/predecessor CAS; append and lost-notification lifecycle sweep. |
| `agent-execution-stop.ts:11` | All reservations and run/metadata leases; successful original reconciliation; retained lease policy; commands/restoration; terminal native states; controller owner/process identity and native/legacy startup/remote stop proof; exact finalization CAS. A false result stays occupied. |

This is a concrete migration inventory, not a claim that every transitive provider
writer has been audited. The current queue still has the explicit optional fallback
`options.executionAdmission ? ... : claimDatabase(db)` at `queue.ts:1589`; merely
installing a sidecar/checker leaves direct native authority. Current TypeScript
claim callbacks receive a transaction object; a production typed executor cannot
expose arbitrary callbacks/SQL to an untrusted controller. The actual predicate
implementation and its supporting authoritative tables must move inside that
owner's trusted module, preserving scheduler→issue→wake→run lock ordering and
existing NOWAIT contention rollback. Callers send exact typed immutable intents.
They receive committed outcome or original-intent uncertainty inspection, never a
permission to perform the effect elsewhere.

The sole-owner installation requires an explicit native file assignment, complete
schema-compatible migration, current trusted policy import and lifecycle/queue
ownership design after the strict semantics decision. Application/provider roles
must lose equivalent DML/functions, membership and alternate connections. Include
bootstrap, notification sweeps, callbacks, cancellation/finalization, migration,
maintenance and recovery writers; current old credentials/sessions/endpoints must
be physically excluded, not just NOLOGIN. P projections cannot become alternate
authority. H rollback requires independent W/current opening and retained exact
uncertain operations, rather than recreated generations or optimistic retries.
No full native implementation is safe to substitute before these boundaries are
resolved; no native source edits or schema-incompatible migration were made here.

## Verification and next concrete review

Eleven lightweight unittest methods PASS in 0.002 seconds, covering caller flush,
exclusive-owner final-check gap, equality-at-expiry, expired check refusal, explicit
proposal labeling, accepted retirement surviving observation expiry, pre-commit
revoke/rotate refusal, accounted pre-deny commit, broken physical fence, missing
accepted retirement and bounded malformed-model refusal. CLI completed and emitted
126 counterexamples; no subprocess, database, container, hosted build/typecheck or
provider fixture was scheduled by this track. These are model tests only. Root
records exact file hashes and independent integrated review/combined verification.

Review must choose a proved physical-commit primitive retaining strict expiry, or
explicitly accept the monotonic-fenced alternative with its full permanent-fence
requirements. Until then strict release remains held. Independently continue
runtime provenance and canonical ownership. Root's all-command dispatch must not
label this model or synthetic SQL as a production native backend. Once the native
semantic and topology choice is reviewed, assign actual transaction/queue/lifecycle
files and port the whole unit above with direct-role refusal and adversarial
uncertainty/recovery tests before activation review.

No A/original shared-family hold is released. B remains paused, timers disabled,
capacity unchanged, draft PR5/human merges preserved. Gemini and backup/S3/monitoring
remain deferred. No live inspection/mutation, provider, credential, purchase,
publication, deployment, migration, destructive operation, Git/index operation or
merge occurred. Synthetic success is not operational acceptance. Reviewed rollout
and complete real shared-hold reconciliation must precede ten bounded serial Codex
tasks on existing B, then Claude coding/session/renewal/cancellation/disconnect/
restart acceptance.

## Owner/tree continuation: commit-boundary review artifact

The newer completed baseline is `sole-owner-continuation` and its checkpoint,
fixture log and exact-input inventory, rather than the enforcement-composition
baseline cited in the historical sections above. The current disjoint assignment
is recorded in `owner-tree-continuation/OWNERSHIP.md`. No newer completed handoff
was located in the requested 2026-10-21 evaluation/state inventory. Retained report
and handoff searches still supply no authenticated engine source or reviewed
commit primitive. No network or live inspection was performed.

Five additional model tests distinguish WAL insertion, durable WAL and visibility.
An insertion that precedes expiry can still flush after expiry; durable WAL before
expiry can still become visible after expiry. The synchronous ordering modeled is
explicit, and asynchronous visibility-before-flush schedules are refused rather
than silently presented as engine evidence. Success/lost/timeout replies never
prove freshness, authorize a replay, or replace exact original-intent inspection.
This adds counterexamples/review precision only. It does not introduce an execution
validator or an alternative effect owner. Root executes and records verification;
these five tests have not been run by this track.

A concrete strict-primitive review must retain the following artifact set before
implementation can rely on it:

1. Exact immutable engine build-to-source/patch/toolchain mapping and its configured
   commit modes. An image label or version string is insufficient.
2. A selected irreversible boundary and an actual mechanism that couples expiry
   to that boundary. Define crash/recovery and replica behavior separately from
   client reply. If expiry precedes durability after WAL insertion, specify how an
   abort remains possible; a post-commit error cannot undo the committed effect.
3. Scheduler/storage/clock failure analysis that proves the boundary invariant,
   including unbounded pause, clock adjustment, prepared transactions, early
   constraint flush, async commit, crash/restart and lost acknowledgements.
4. Exact prospective intent and effect-journal inspection behavior for every
   uncertain phase. No new identifier, sequence advance or optimistic retry is
   permitted when the original outcome is unknown.
5. Privilege/session/endpoints exclusion covering every native, maintenance and
   recovery writer, followed by the complete native predicate migration unit
   above. Exclusive transaction ownership remains necessary but insufficient.

If review instead chooses monotonic facts, its proposed requirement change must
name the exact old incarnation and original shared-family closure; preserve
original persisted five-scope holds; define accepted-retirement persistence;
separate fresh evidence acceptance from later effect validity; order current
generation/revoke against the effect; retain all pre-deny work through settlement;
and specify physical retired-writer/session/endpoint/restored-clone exclusion.
It must explicitly replace the old permit-at-physical-COMMIT condition, not imply
that a SQL lock satisfies it. No such requirement change has been accepted. Native
accepted-retirement behavior, deny ordering, stale refusal and uncertainty holds
remain unchanged. Full native queue/lifecycle/provider port is still held on this
prerequisite and actual protected current-generation topology; no synthetic schema
or narrowed predicate list was substituted.

## Effect-custody continuation: explicit unresolved choice and port sequence

The completed owner/tree handoff, its exact 62-case/0.369s verification log,
inspection/cleanup evidence and integrated review are the baseline. The current
assignment is `effect-custody-continuation/OWNERSHIP.md`. Retained-file search
still finds no authenticated engine commit primitive/source/patch contract.
The `postgres@3.4.9` and `embedded-postgres@18.1.0-beta.16` patches in native
source are dependency patches, not proof of physical commit expiry. No engine
implementation is reviewed or inferred from them. Strict release validity stays
blocked; the monotonic alternative remains explicitly UNACCEPTED.

Four new partial-order model cases permit visibility before durable WAL as well
as the prior synchronous ordering. They show visibility while the selected durable
boundary later expires, equality-at-visible expiry, and inability of a later timeout
to undo visible effects. Invalid phase orders and boolean ticks refuse. Results
always label model-only, strict implementation false, proposal accepted false and
operational acceptance false. This addresses the prior model's deliberately excluded
async schedules; it supplies no additional engine evidence, effect authority or
freshness validator. Root schedules exact verification; this track ran no tests.

Actual source reread confirms the concrete port sequence below. This is a reviewed
implementation dependency inventory, not permission to execute a migration:

1. Resolve the strict requirement with the authenticated primitive artifact set
   above, or obtain explicit review accepting a replacement requirement. The
   replacement must state that acceptance-time evidence freshness does not expire
   permanent retirement of an exact old incarnation. It must explicitly replace
   permit freshness at physical COMMIT, with all physical permanence obligations.
   Existing `legacyHoldIsReconciled` uses `latest.createdAt` intentionally; keep it.
2. Move trusted current policy resolution, scheduler locking and complete native
   claim body into the same owner before exposing typed intent transport. Current
   `claimNext` accepts `claimNative(tx, run)` and queue `claimTransaction` accepts a
   transaction callback. An outside callback is not a production ownership port.
   Preserve the early mention-required terminal cleanup branch as well as later
   issue/wake/run claim paths and post-commit-only publication. Removing only the
   optional fallback would miss those earlier effects and restart paths.
3. Move auxiliary command/start/stop/restoration/lifecycle finalization, cancellation,
   recovery and legacy append into that trusted owner. Legacy append currently
   locks scheduler, exact hold/run/lease and all cross-company/agent holds; it
   authenticates the exact decision and inventory, checks shortest validity, then
   sequence/predecessor CAS. Preserve every step and the lost-notification sweep.
   Seven reservation scopes cannot replace original persisted five-scope holds or
   erase unknown, null, run-only, unmapped and disappeared historical sources.
4. Couple each immutable original intent to the actual effect transaction and
   exact inspection journal. Unknown outcome keeps its identifier and occupied
   accounting; deny/rotation must serialize before later effect ownership, while
   pre-deny work remains charged through settlement. A reply timeout, projection,
   detached copy, pipe enqueue or route tag cannot establish native completion.
5. Only after every production writer uses that owner, remove equivalent DML,
   callable functions/role memberships and alternate database access, including
   maintenance/recovery, old authenticated sessions and restored endpoints. Review
   exact schema migration and native source assignment before changing either.
   A socket service or SQL NOLOGIN alone does not exclude retained authority.

No dirty native source, accepted-retirement semantics, shared holds or live state
changed. No Git/index operation, test fixture, provider call, runtime/cluster query,
publication, migration or deployment was performed by this track. The complete
native predicate/sole transaction port remains incomplete and is not replaced by
these models. All user holds and rollout/real-reconciliation-before-B/Claude order
recorded above remain unchanged.
