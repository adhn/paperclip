# Native transaction-owner port review — 2026-10-21

This is a concrete proposed port contract reviewed against retained actual source,
not an installed interface, accepted requirement change or executable migration.
Root owns shared interfaces and must integrate/review this proposal before assignment
of native edits. Current baseline is `effect-custody-continuation`: checkpoint,
independent review and exact fixture log record 71 tests PASS in 0.319 seconds;
20 owner, 15 tree, 16 pipe and 20 native model methods. Those results prove their
recorded components only. No new models, validators, source edits, tests, fixtures,
Git/index operations, network or live actions were performed for this report.
Exact sole-file ownership preceded editing in `root-boundary-continuation/OWNERSHIP.md`.

## Blocking semantic decision

Strict release validity at physical COMMIT is still unimplemented. No authenticated
engine commit primitive was found in retained artifacts. Last SQL validation,
constraint triggers, exclusive transaction ownership and timeouts cannot prove
freshness at the selected irreversible commit boundary. Read the prior
[NATIVE-COMMIT-OWNER review](NATIVE-COMMIT-OWNER-2026-10-21.md) for exact primitive
artifacts and synchronous/asynchronous phase counterexamples. The alternative is
an explicitly **UNACCEPTED proposed requirement change**: accept fresh evidence
once to establish permanent retirement of an exact old incarnation, with current
generation/revoke ordered against each later effect. This changes permit validity
at physical COMMIT and requires real permanent runtime/storage/session exclusion.
Do not install that alternative by implementing this proposed port.

Existing `legacyHoldIsReconciled` checks original accepted evidence at
`latest.createdAt`, preserving retirement until revoke/epoch/binding change. That
behavior must remain; it is not authorization to relax separate release permits.
The full release/activation unit below stays blocked pending the semantic choice,
physical topology, independent history and complete privileged-writer inventory.

## Proposed public commands and committed results

All requests carry an authenticated actor, protocol version, immutable `operationId`,
`expectedEpoch`, exact serialized intent and its content digest. The owner derives
company access from the authenticated principal, and rejects mismatching duplicate
IDs. Intent payloads contain identifiers and exact immutable effect descriptions,
never caller-supplied policy/scopes, eligible booleans, SQL, callbacks, clocks,
transaction handles, stop-success booleans or mutable paths. The following proposed
command names are not current exports. Roles distinguish controller requests,
protected runtime/storage evidence, historical review and operator recovery.

| Command / exact payload beyond common envelope | Owner action and committed result |
| --- | --- |
| `QueueRun {companyId, runId}` | Read authoritative queued run/agent/issue/policy; create or exactly match attempt, scopes and project queue entry. Return exact attempt identity and `queued` or persisted refusal. |
| `ClaimRun {companyId, runId, expectedAgentRevision, expectedRunContextHash}` | Recompute complete preflight and claim body internally. Return `waiting {reason}`, `deferred {reason}`, `terminal {runId,status,attemptId}`, or `claimed {runId,attemptId,grantOrder}`. No transaction callback and no launch permit. |
| `QueueOperation {companyId, agentId?, environmentId, kind:probe|adapter_test|lifecycle, key}` and `ClaimOperation {companyId,operationAttemptId}` | Resolve immutable policy/cleanup contract; check lifecycle key/version; same global fairness frontier. Return queued/waiting/reserved operation identity, without fabricating a heartbeat run. |
| `ExecuteCommand {companyId,attemptId,leaseId,commandBytes,commandDigest,concurrentCommandIds,restorationKind?}` | Exact command transport owned through durable intent, native binding and actual runtime acceptance; return committed effect identity/status or uncertain operation. Never return a binding for an untrusted caller to launch independently. Size/encoding/route and actual all-command protocol still require shared-interface review. |
| `CancelAttempt {companyId,attemptId}` | Serialize deny intent; queued becomes cancelled, occupied becomes stopping, uncertain remains uncertain. Return durable cancellation state; no claim of runtime stop. |
| `InspectOperation {operationId,originalIntentDigest}` | Authenticate exact original caller/intent; return persisted phase/outcome and original immutable binding, never a reusable permit. Available while starts are held/denied. |
| `RecordStopEvidence {commandId,originalBindingHash,evidenceReference}` | Protected runtime channel authenticates actual stop evidence; compare full retained binding and current command identity before marking stopped. Caller `stopped:true` is not this interface. |
| `RequireRestoration {attemptId,kind,descriptorDigest,descriptorBytes}`; `CheckpointRestoration {attemptId,obligationId,kind,expectedDescriptorDigest,newDescriptorBytes}` | Record exact obligations/checkpoints with CAS; reset that restoration kind pending. Actual canonical apply is an owner-to-owner effect, not an arbitrary callback. |
| `SettleRestoration {attemptId,obligationId,kind,effectEvidenceReference}`; `SettleAttempt {attemptId}` | Verify exact protected physical apply/inspection evidence, all commands stopped and every obligation successful; complete lifecycle result only at matching operation/version; release leases and attempt in same native transaction. |
| `AppendLegacyDecision {exactDecisionBytes,signature,independentReviewReference}` | Preserve complete locked inventory, identities, fingerprints, five-scope bindings, fresh original review, sequence/predecessor CAS and append; schedule lifecycle only after committed decision. |
| `OpenRecovery {expectedOldEpoch,nextNeverUsedEpoch,independentOpeningReference}`; `AdoptCleanup {attemptId,originalContractHash,runnerFenceEvidenceReference}` | Durable never-reused epoch, starts held, occupied work uncertain; authenticate real remote fence and original cleanup contract before changing owner/token. Old child launch bindings retain their original epoch. |

`QueryQueue`, `QueryCommands`, `QueryRestoration` and exact `InspectOperation` are
read projections only. They never clear holds. Tokens remain inside trusted owners
or authenticated owner-to-owner channels; possession is not a substitute for current
rows, accepted evidence, physical fence or operation identity. Bootstrap, policy
change/drain and finalization sweep are separate protected operator/internal commands,
not blanket controller write permissions.

Every command returns an authenticated receipt binding operation, complete intent
digest, original generation, outcome and exact affected row/effect identifiers.
A committed waiting/refusal outcome does not authorize new work. Exact retry retrieves
the same retained result; executing a fresh claim requires a separately identified
new intent after the previous result is definitively known. Uncertain never means
replay, generation replacement, optimistic release or a capacity/fairness advance.

## Source unit, authoritative predicates and lock order

Source paths below are relative to the preserved `.work/paperclip-admission`.

* `server/src/services/execution-admission.ts:29–198`: scheduler row/epoch and trusted
  database time; held/draining; recovery freshness or existing bounded exemption;
  global `(project.lastGrant, attempt.enqueueOrder)` selection; queued run state;
  exact current policy scope equality; sorted scope locks; unknown scopes; every
  overlapping original historical hold; scope drain, cooldown and occupied counts
  over reserved/starting/stopping/uncertain; eligibility; exact company/run/agent/
  issue/project relation; requested caller cannot consume a sibling/frontier grant.
  Preserve auxiliary contender handling and nested savepoint rollback for null claim.
  Persisted post-callback identity/status must still match. Terminal discard commits
  without capacity or fairness advance. Only an actual running grant increments
  scheduler sequence, project cursor and durable attempt owner/token together.
* `execution-admission.ts:209–323`: immutable registration and pending limit; policy
  never resets existing limits/drains/cooldowns; project comes from persisted issue;
  prepared registration and eligibility scheduling are internal. Replace optional
  `prepareRun(...,eligible)` trust with authoritative computation. Current projection
  writes to `heartbeat_runs.result_json` on policy/wait failures must move too.
* `server/src/services/heartbeat/queue.ts:948–1619`: move the complete claim flow,
  including early mention-required cancellation and issue promotion, not only
  `claimDatabase`. Preserve budget/invokability, agent/tree pause/dependency, dispatch
  staleness, issue predecessor/checkout and pending cleanup/finalization, native
  review/recovery exceptions, external-chat recovery authorization and queued live
  comment filter/discard. Current admitted claim locks current agent NOWAIT and
  rechecks full agent equality and running limit, then issue NOWAIT, wake NOWAIT,
  run NOWAIT, exact context and wake/run binding. Preserve issue→wake→run ordering
  inside comment claims and native review helpers, partial-write savepoints and
  contention-as-defer handling. `claimTransaction(run, tx => claimDatabase(tx))`
  and fallback `claimDatabase(db)` at 1589–1597 must both disappear from untrusted
  execution; owner must contain their actual implementation. Publish only after
  outer commit, using durable delivery/outbox plus sweep rather than lost callbacks.
* `execution-capacity-policy.ts`: authoritative active default SSH environment,
  CLI adapter/engine, no alternate AI connection, immutable policy fingerprint and
  physical account/runner/workspace/session/credential identities. Seven reservation
  scopes do not replace original five-scope historical holds.
* `execution-admission-operations.ts:42–128,140–325`: exact original cleanup contract;
  never rewrite child epoch during adoption; current runner/fence ACK; lifecycle
  operation/version; immutable operation identity; exact unfinished command set;
  current run cancellation/status under NOWAIT; attested non-root fenceRoot; active
  exact SSH lease/company/run/agent/environment and auxiliary operation binding;
  command insert and attempt starting/restoration state together. Current
  `mutateRestoration(input,body)` is an arbitrary callback across a physical effect:
  remove it from public ownership; its replacement needs actual storage authority,
  durable cross-owner intent/inspection and settlement, not SQL rollback claims.
* `execution-admission.ts:354–414`: preserve one-use launch binding and exact
  lease/policy checks while replacing binding-return/later-launch with actual
  effect ownership. Queued cancellation releases no occupied work; occupied stays
  stopping/uncertain. Takeover inserts never-used epoch and holds all occupied work.
* `execution-legacy-reconciliation.ts:29–134`: authenticate entire exact decision;
  current drain/epoch; source/fingerprint/company/agent/run/environment/lease/policy/
  scope equality; terminal run, exact lease and no active shared owner; advisory
  scheduler lock, exact source/run/lease and every hold across companies/agents;
  independent complete inventory hash; shortest fresh evidence validity; original
  sequence/predecessor CAS. Preserve accepted-retirement and notification sweep.
* `agent-execution-stop.ts`: all reservations, run/metadata leases, genuine original
  reconciliation, retained-lease cleanup, all command/restoration proof, native
  finalization ownership/process identity, cancelled startup/remote receipts and
  finalization CAS. This function writes finalization rows after inspecting stop
  proof: it is an authority writer, not a harmless read-only predicate.

Actual current admission locks scheduler first, then sorted scopes and the native
claim locks described above; owned operation paths lock scheduler→attempt followed
by NOWAIT agent/run where applicable, then lease/command/restoration. Legacy append
also takes advisory `(174510,1)` before scheduler. Preserve those existing relative
orders and NOWAIT rollback while designing one complete command lock graph. Do not
claim that a simplified scheduler→issue→wake→run slogan covers agent locks, scope
locks, legacy append, lifecycle and native writers outside this unit. The final
port requires their complete call graph and deadlock review before implementation.

## Whole original shared-hold closure

The owner inventory is all persisted `execution_admission_legacy_holds`, including
other companies/agents sharing account/state families. Resolve original source,
evidence/hash, immutable identity, policy and original scope arrays; retain five
original scopes even when new attempts use seven. Unknown/null/run-only/unmapped/
disappeared sources remain occupied. Exact protected evidence and human consent
must cover the whole shared closure, not two visible A rows or a B-only selection.
Current inventory hash is sorted source/hold fingerprint over every locked hold.
A new port must preserve that and make independent verifier custody/current history
real. Signature-key possession, a provider callback, no current process observed,
a detached export and local flock do not establish permanent exclusion. Complete
real reconciliation follows reviewed rollout; no report here clears any hold.

## Exact privilege/session migration unit, not executable SQL

The concrete table cut begins with actual schema names from
`packages/db/src/schema/execution_admission.ts`:
`execution_admission_epochs`, `execution_admission_scheduler`,
`execution_admission_scopes`, `execution_admission_projects`,
`execution_admission_attempts`, `execution_admission_commands`,
`execution_admission_runner_epochs`, `execution_admission_restorations`,
`execution_admission_legacy_holds`, `execution_admission_bootstraps`,
`execution_admission_legacy_decisions`, `execution_protected_authority_pins`,
`execution_protected_authority_requests`, `execution_protected_command_journals`.
The same cut must include authoritative columns/effects in `heartbeat_runs`,
`agents`, `issues`, `agent_wakeup_requests`, `environment_leases`,
`native_run_finalizations` and transitive native review/chat/issue-execution/
finalization tables actually touched by the moved helpers. This is explicitly
not a complete transitive table list; final catalog/writer closure is unresolved.
Leaving a broad UPDATE grant on these shared tables defeats column ownership.

The reviewed manual migration must enumerate actual database owner, app/controller,
provider, migration, maintenance, recovery, LOGIN roles and inherited memberships
from authorized retained catalog artifacts; none are invented or queried live here.
For each concrete role/object, include REVOKE INSERT/UPDATE/DELETE/TRUNCATE and
sequence/DDL/function authority, inherited SET ROLE and SECURITY DEFINER reachability;
transfer object/sequence ownership to the protected owner; forbid CREATE in trusted
search paths; revoke PUBLIC/default future grants. Retain only explicit read
projections and narrow nonauthoritative columns where necessary. Do not revoke
unrelated application functionality without moving its real writer first.

Ordered migration: held startup and preserved full inventory/uncertain intents;
exact schema/owner binary/policy/history import; all writer callsites moved; direct
roles/functions/memberships fenced; old sessions terminated through a separately
reviewed action and old endpoints/credentials/restored clones physically excluded;
new owner opens only against independent current high-water and exact generation.
NOLOGIN/password rotation/revoked connect do not kill existing authenticated sessions.
Poolers, maintenance connections and writable restore endpoints need explicit
retirement evidence. The owner cannot verify itself by trusting its own restored
SQL rows. Held rollback preserves exact uncertainty and independent opening refusal;
never restore old privileges or mint a replacement generation to regain availability.

An executable migration cannot yet name real roles, a complete transitive table/
function list, session retirement identities or physical exclusion mechanism. This
report exposes those exact missing inputs rather than supplying placeholder SQL
and claiming an exclusive owner exists. No migration is authorized or performed.

## Independent work and blocked implementation units

Root can use this contract to assign a complete source port and adversarial tests:
no callback/SQL fallback; identical predicate outcomes; null partial-write rollback;
terminal discard without grant; global fairness; original shared closure; deny/claim
and lifecycle races; stale/ABA rejection; lost commit reply inspection; old-role
write/session refusal; restore opening refusal; actual command/canonical effect
custody. Full changed build/typecheck graphs need authorized hosted capacity.

The actual release owner, physical-COMMIT guarantee/replacement semantic selection,
real runtime provenance/fence, coherent canonical capture/placement, independent
history/custody, cross-owner settlement and executable migration remain blocked.
No checker wrapper can replace them. Preserve all A/original shared-family holds,
paused B, disabled timers/current capacity, draft PR5 and human merges, deferred
Gemini/backup/S3/monitoring. Reviewed rollout plus complete real shared-hold
reconciliation precede ten bounded serial Codex tasks on existing B, then Claude
coding/session/renewal/cancellation/disconnect/restart. Operational acceptance is false.
