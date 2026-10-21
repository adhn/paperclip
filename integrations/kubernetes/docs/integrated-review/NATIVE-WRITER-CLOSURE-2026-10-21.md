# Native transitive writer closure — 2026-10-21

Retained-source review only. This extends [the proposed transaction port](NATIVE-TRANSACTION-PORT-2026-10-21.md)
with concrete writers hidden behind its callbacks/helpers and maintenance paths.
It does not complete an executable privilege migration or install native authority.
Strict physical-COMMIT validity remains blocked; monotonic fenced facts remain an
explicit **UNACCEPTED requirement-change proposal**. No models/checker wrappers added.

Baseline is completed `root-boundary-continuation`: exact checkpoint, full fixture
log and independent review read; 86 tests PASS in 1.946 seconds, with exact retained
inputs/containment/cleanup. Those tests are not native operational acceptance.
The new exact single-file assignment is recorded before edits in
`group-launch-continuation/OWNERSHIP.md`. No native checkout/Git/index change, test,
fixture, provider/network/live action or destructive operation performed here.
All source references below are relative to preserved `.work/paperclip-admission`.

## Queue callback closure: real callers and effects

`server/src/services/heartbeat.ts:1215–1226` injects `setRunStatus`,
`releaseIssueExecutionAndPromote` and `cancelRunInternal` into `createHeartbeatQueue`.
The apparent queue-local claim boundary therefore reaches these additional writers:

| Concrete source edge | Additional authoritative writes / boundary |
| --- | --- |
| `heartbeat.ts:1292–1361` → `heartbeat/run-lifecycle.ts` | `setRunStatus` variants mutate `heartbeat_runs`; process metadata at 556 is a transaction updating run plus a process-identity event, invalidating prior stop evidence. Retry scheduling at 2342 inserts wake/run, binds wake, updates issue and source run in a separate transaction. Interaction status at 736 and agent runtime state at 2964 are also writes. |
| `heartbeat.ts:1372–1421` → `heartbeat/run-control.ts` | Actual cancellation and issue promotion/lease release; run writes 403/941/1012, wake writes 499/664/849/1269 and lease metadata/state at 613. Process/runtime termination is an external effect, not rolled back by a database transaction. Map `.delete(run...)` is not SQL deletion. |
| Queue → `native-runtime/native-review-dispatch.ts:16–49` → `native-review-participant.ts:229–243` | Nested transaction locks issue→wake→run; helper additionally updates issue execution ownership; then run running/wake claimed together. Moving only claim dispatch's visible two updates omits the issue write. |
| Queue → `explicit-native-continuation.ts:308–322,413` | `native_run_finalizations`, `heartbeat_runs` and `issue_recovery_actions` changes bind continuation/recovery and its exact source. They are not pure eligibility reads. |
| Queue → `execution-wait.ts:39–49` | Wake update/insert records durable blocked-execution condition. Preserve source/condition identity instead of silently dropping the wait record. |
| Queue → `heartbeat-run-events.ts:56,71–148` | Allocates sequence by updating `heartbeat_runs`; inserts `heartbeat_run_events` under its own transaction. Event helper access is also run-row write authority. |
| Queue → `native-runtime/chat-attachment-reuse.ts:1480` | Updates `issue_work_products`; external-chat reuse/proof validation has an effect edge requiring separate branch review. |

Queue itself also writes outside `claimDatabase`: agent status at 599/614, early
terminal run/wake/issue cleanup at 812–890, issue/wake binding at 1215–1222,
retry/admission branches 3277–3454, blocked workspace comment/issue/wake 3649–3666,
new run/wake creation 4006–4148 and 4347–4384, and durable wake sweep claims 4484–4682.
The sole-owner port must include every one of these paths or split them into explicit
owner commands with exact journal identity. Removing optional `claimDatabase(db)`
fallback at 1597 alone does not establish ownership.

## Other production adapters can mutate the same rows

These are concrete source writers outside the preceding queue service, found by
following its imported run-dispatch/wake-queue ports and searching actual run/lease/
finalization ORM writes. Line references identify reviewed statements, not exhaustive
coverage of every conditional branch.

* `modules/run-dispatch/adapters/postgres.ts`: run updates 645/686/888/1039/1081;
  wake 707/925; issue 719/950; `connection_intent_deliveries` at 942. Queue editing,
  stale-run cancellation and delivery binding must use the native owner; retaining
  adapter database credentials leaves equivalent authority.
* `modules/wake-queue/adapters/postgres.ts`: wake/run/issue create/claim paths
  428–706; recovery fold 744–765 calls `issueService(tx).update`, inserts
  `activity_log`, updates recovery action and native finalization; later restart/
  queue mutations 921–1205 include a transaction at 1020. This is not a read-only
  queue facade. The `issueService` call at 744 is real DML hidden by helper syntax.
* `modules/wake-queue/adapters/queued-comment-postgres.ts`: comment update 52;
  issue/wake/run rewrites at 61–112; transaction at 210. Discard must serialize
  against actual claim and keep terminal discard separate from deferred/null claim.
* `modules/active-run-watchdog/adapters/postgres.ts`: transaction at 309 changes
  run/wake/issue 311/330/346, calls issue update/addComment at 360 onward, inserts
  `heartbeat_run_watchdog_decisions` at 250/397, and updates agent at 453. A
  watchdog's lack of direct provider launch does not remove its release/retry power.
* `modules/agent-lifecycle/adapters/postgres.ts:20–82`: `effects.transaction`
  updates lifecycle state/version/holds/status and revokes `agent_api_keys`; calls
  clearPrimary/recordCreation/recordStatus effects inside that transaction. Claim,
  renew, required-plugin and host/plugin completion/failure at 95–134 are separate
  owner/version CAS updates. Worker `application/worker.ts` renews and executes host/
  plugin steps; removing request-route DML while retaining this worker is incomplete.
  `adapters/deletion.ts:13–22` runs dependency deletion plus agent deletion in its
  transaction. Purge/company deletion and their cascades require their own closure.

## Native result, finalization, status and physical workspace closure

There are **two reviewed result-ingest writers**: `native-runtime/native-run-coordinator-store.ts`
transaction at 342 inserts `native_run_results` at 384 and
`native_run_finalizations` at 401, then updates run at 421;
`native-runtime/paperclip-control-plane-port.ts` transaction at 365 inserts the same
objects at 398/412 and updates run at 429. Moving just one ingest facade leaves the
other authority. Coordinator event ingest at 218–314 and finalization state changes
490–559 are additional boundaries. Control-plane run mutations 191–199 and its
transaction at 260 must move too. Exact original result/frame identity and current
opening must remain tied to accepted command, not trusted merely because a callback
arrived with matching route labels.

`native-runtime/native-run-finalizer.ts` has transactions at 214,302,856,1112,1160
plus later calls into independently transactional status commit. Direct writes
include finalization and run rows, and `issueService(tx).update` at 496.
It invokes `work-assessments.ts:48,114` (`work_assessments` inserts) and
`status-decision-committer.ts:1582` (a separate status transaction): decision insert
1926, effect inserts 2171, decision updates 2193, run/finalization/issue/interaction/
wake effects and `issueService(tx).update` at 2013. The status transaction has already
committed when finalizer resumes at 1497. Do not claim one outer rollback spans
these commits. Original intent/phase inspection and durable delivery must account
for each irreversible step and never repeat already committed effects.

`native-finalization-reconciler.ts` transaction 379 writes finalization/run and
calls issue update 484; later invokes actual finalizer at 925/983.
`native-restart-recovery.ts` transaction 509 and mutations 594–969 rewrite
finalization/run/issue disposition. `native-cancellation-request.ts:80–114` has its
own exact run cancellation transaction. `native-chat-review-presentation.ts:577`
writes run; `automatic-completion-reviews.ts:131` writes interactions.

`native-workspace-finalizer.ts` contains no direct ORM mutation, but is an effect
owner path: `withNativeWorkspaceFinalizationOwnership` wraps a callback that calls
workspace operation/environment/physical export-merge/resume/restore helpers.
`native-workspace-finalization-ownership.ts:107,162,204,226` writes recovery action/
run ownership; `native-workspace-owner-recovery.ts:24–72` has advisory transaction
plus run/recovery-action updates. `workspace-operations.ts:350–694` updates/inserts
`workspace_operations`. SQL ownership alone cannot roll back filesystem copyback,
external provider control or old writable handles. Port actual canonical physical
apply with exact durable intent and inspection; do not replace callback with a
successful permission wrapper.

## Maintenance, recovery, sessions and lease writers

`index.ts:1509` invokes actual `heartbeat.recoverNativeRunsAfterRestart` before
timers. Stale-issue sweeps at 1624/1855 and cleanup invocation 1302 are further
entrypoints. These lines describe retained source, not currently enabled timers
or live state. All current disabled-timer/held-startup restrictions remain.

`heartbeat/recovery.ts:909–913,1930` invokes native finalization reconciliation;
1116 mutates finalization; cancellation/release/promotion callbacks 1166–1293 act on
runs/leases/issues. Lease updates at 1356–1445,1533,1686,1776 support orphan-active/
pending cleanup; startup recovery also resumes instruction-copy recovery at
1920–1923. Reaper invokes orphan/cleanup sweeps at 2436–2459. `recovery/service.ts`
adds real retry transactions 2641/3229 inserting wake/run and updating recovery
claims, issue updates through `issuesSvc`, source-run updates 2029/4205/5997 and
stale issue-lock update 6240. Recovery is equivalent execution authority.

`environments.ts` lease acquisition transaction 1493 updates/reuses/inserts lease
rows 1540–1635. Metadata update 1662/1766 and orphan cleanup transaction 1720–1731
can alter trusted lease bindings; release-for-run at 1784 changes lease state.
Its existing admission exclusion is useful but is not privilege separation.
`heartbeat/run-state.ts:1531–1622` inserts/updates/deletes `agent_task_sessions`;
1631/1837 writes `agent_runtime_state`. Session and runtime-cache writers must not
retain physical canonical-session access under a native-only SQL cut.
`legacy-controller-lease.ts:27,53` renews/revokes run controller ownership; the
same callback/recovery authority cannot survive through old pools or connections.

`execution-admission-bootstrap.ts:90–162` writes legacy holds, epoch history,
bootstrap record, scheduler and occupied attempts. `execution-control-reconciliation.ts:75–229`
writes run/finalization/agent/issue; `execution-recovery-resolution.ts:201–577`
writes finalization/recovery/run/issue in several transactions. No bootstrap or
manual reconciliation bypass may remain after the main native port.

## Expanded schema cut and still-unresolved closure

In addition to the prior admission/run/wake/agent/issue/lease/finalization objects,
actual reviewed writers require decisions on these real schema objects:
`native_run_results`, `heartbeat_run_events`, `agent_task_sessions`,
`agent_runtime_state`, `issue_thread_interactions`, `issue_recovery_actions`,
`work_assessments`, `status_decisions`, `status_decision_effects`,
`workspace_operations`, `execution_workspaces`, `connection_intent_deliveries`,
`heartbeat_run_watchdog_decisions`, `issue_comments`, `issue_work_products`,
`issue_tree_holds`, `issue_tree_hold_members`, `activity_log`, `agent_api_keys`.
Names were read from actual `packages/db/src/schema` definitions. Imports alone
are not proof of writes: finalizer also reads approvals/completion contracts, so
this review does not automatically grant its owner blanket writes to those tables.

The following source edges are precisely unresolved before an executable migration:

1. `issueService.update/addComment` in `services/issues.ts` is a large shared
   transaction API. Reviewed direct effects include issues, comments and optional
   publications/work products, but complete branch closure, its injected hooks,
   cascading triggers and nested service effects remain unclosed. Explicitly assign
   its authority columns/commands; do not move a broad shared-table UPDATE grant.
2. `LifecycleEffects` in `modules/agent-lifecycle/adapters/effects.ts` exposes
   transaction/clearPrimary/recordStatus/deleteDependencies/configuration/budget/
   hire callbacks. Their installed service implementations and all plugin/deletion
   effects must be inventoried before claiming lifecycle writer exclusion.
3. Other concrete source candidates found by same-line ORM search, not fully
   audited here: `environment-runtime.ts`, `execution-capacity-lifetime.ts`,
   `legacy-execution-recovery.ts`, `legacy-workspace-restore-recovery.ts`,
   `legacy-shutdown-workspace-settlement.ts`, native `prepare-native-run.ts`,
   `native-session-executor.ts`, `paperclip-runner-tool-authority.ts`,
   `native-workspace-sync.ts`, `native-workspace-export-*`,
   `native-provider-capacity-retry.ts`, `native-safe-replacement.ts`, and
   `routes/issues.ts`. Accounting/usage/secret-redaction/trust-preset services also
   update run rows: column authority and transitive callbacks need review.
4. Search is a source review aid, not a compiler/callgraph proof. Multiline ORM,
   raw SQL, aliases, dynamic tables, DDL/migration/scripts and plugin-maintenance
   entrypoints may escape it. Hash `.update` and Map `.delete` were not counted as
   SQL. Full parser-assisted and migration-tree closure still requires assignment.
5. Retained authenticated database catalog is absent: real role/object ownership,
   inherited memberships, column/table/sequence/function/default/PUBLIC grants,
   SECURITY DEFINER/search-path reachability, triggers/rules/cascades and actual
   active pooler/maintenance/recovery sessions are unknown. No roles, session IDs,
   REVOKE targets or backend compatibility were invented and no live query made.

A migration must map each actual statement above to owner command or deliberately
nonauthoritative column projection, then remove equivalent direct writes and every
old session/endpoint/restored clone. Existing sessions survive NOLOGIN/password
rotation; SQL revocation does not retire a canonical filesystem writer. Preserve
exact original uncertain operations across every split transaction/physical effect,
current independent high-water and deny-before-later-effect order. No blanket
REVOKE or synthetic wrapper can safely stand in for the unresolved cut.

All A/original shared-family holds, paused B, disabled timers/current capacity,
draft PR5/human merges and Gemini/backup/S3/monitoring deferrals remain. Genuine
whole shared-hold reconciliation and reviewed rollout precede ten bounded serial
Codex tasks on existing B, then Claude acceptance. Operational acceptance is false.

## Owner-port continuation: resolved injected implementations and raw SQL

This additional review uses the completed group-launch-continuation baseline
(98 component cases/3.453 seconds); ownership was recorded before editing in
`owner-port-continuation/OWNERSHIP.md`. Only this report is edited by the native
agent. Native files remain read-only; no native port, test process, Git/index,
live inspection or migration is performed. The unresolved items above remain
open except for the specific source edges resolved below.

### Real shared issue update and post-commit cancellation boundary

`services/issues.ts:11049–11066` clears checkout/execution ownership on status or
assignee changes. Its actual `runUpdate` at 11068 locks the issue row, then may
call `executionWorkspaceService(...).prepareTaskWorkspaceUpdate(...,tx)` at 11083.
Run-authenticated updates additionally lock/check the run at 11123; preserving
this call-specific lock order is necessary rather than replacing it with a generic
claim order. The main issue write at 11188 is followed by these effects:

* Assignee changes cancel human-requested wakes at 11171 and expire connection
  intents through `issueThreadInteractionService(tx)` at 11237. Status-version
  changes include blocked reassertion and A→B→A assignment protection.
* Privacy-tree raw SQL at 11204 recursively updates descendant `issues`; assignment
  access grants are then ensured for each affected descendant. Description changes
  attach draft images through the transaction helper at 11200. Operator disposition
  may update `chat_conversations` at 11230.
* Terminal disposition calls `finalizeSummarySlotsForTerminalIssue`, expires pending
  interactions, then `requestNativeQuestionRunCancellation(tx,...)` at 11320.
  The returned exact run is queued as a post-commit cancellation action. External
  transaction callers without an action queue refuse at 11315. Stalled generation
  finalizes status cards; relations/labels and reused `execution_workspaces.metadata`
  may also change. Human completion archives inbox and persists activity.
* `issues.ts:11526–11537` commits its owned transaction before publication and
  `executeIssuePostCommitActions`. That actual action implementation at 269–300
  imports heartbeat and calls `heartbeat.cancelRun`; failure is logged as deferred
  recovery because the cancellation marker is already durable. It is deliberately
  not rolled back with a failed post-commit stop.

Owner cut: distinguish the exact issue mutation, durable cancellation marker,
post-commit physical stop, and eventual stop inspection/settlement. Keep the exact
original action/run/issue/status identity across reply loss and restart. Protected
old-owner cancellation/inspection must remain callable under global new-work hold;
putting this callback behind a start-only permit could strand old work. Preserve
current row/run authorization and existing stop evidence; do not infer completed
stop from committed issue terminal state. This is a reviewed edge, not proof that
the entire very large issue service or interaction/card/publication closure is done.

`addComment` is also not append-only: at 12664–12723 it can upgrade existing
`issue_comments.metadata` for external presentation and acknowledge a completion
reply; attachment binding follows. Owner commands must describe that upgrade and
its actual completion/publication effects, not grant arbitrary comment metadata
UPDATE to the old writer or treat matching prose as fresh authority.

### Lifecycle injected implementations are concrete authority

`services/agent-lifecycle.ts:16–44` installs real functions, resolving the previous
abstract `LifecycleEffects` edge:

| Installed implementation | Reviewed effect and required owner cut |
| --- | --- |
| `withAccountingTransaction`, `accounting-transaction.ts:13–23` | Locks company `FOR NO KEY UPDATE` before work/run/policy locks; commits before live activity publication. Preserve this order in the combined owner graph. Publication failure cannot undo accounting. |
| `clearPrimaryAgent`, `primary-agent.ts:29–40` | Updates `user_company_preferences`, persists activity per affected user. This is not an agent-row-only lifecycle transaction. |
| `recordResourceCreationEvent` / `recordAgentStatusEvent`, `resource-lifecycle-events.ts:5–24` | Inserts `resource_lifecycle_events`; pause/resume/termination history must remain attached to the actual status transition. |
| `deleteAgentDependencies`, `agent-deletion.ts:9–47` | Refuses held decision accounting; calls interaction cancellation; clears manager links and issue assignee/creator; deletes run events, sessions, activity (including run-subquery raw SQL), issue execution decisions/comments, runs, wakes, API keys, runtime state and permission grants. Purge is equivalent execution/history authority; an admin deletion lane cannot retain this unfenced database capability. |
| `completeAgentConfiguration`, `agent-configuration.ts:86–153` | Adapter/provider/acpxAgent/model changes delete task sessions and reset runtime state. Also clears primary selection, enforces OAuth binding, synchronizes secret bindings, writes budget policy and config revision. Configuration is a session/credential writer, not a harmless metadata projection. |
| `initializeAgentHire` / `completeAgentHireApproval`, `agent-hiring.ts:49–130` | Calls agent identity creation, writes permission grants/tool-connection installs, syncs secret bindings and initializes primary preference. Secret/budget/identity implementations remain further transitive closure, not resolved by this table. |

`enforceBudget` still invokes `deliverBudgetEnforcement` with injectable budget
hooks; host/plugin driver implementations and secret/identity/budget/plugin effects
must be individually assigned before sole-owner claims. No blanket shared-table
write grant or successful callback adapter closes these edges.

### Actual migration-trigger and utility-session authority

Retained migration source adds concrete hidden effects that same-line ORM search
misses. These are source definitions, not evidence of installed live catalog state:

* `0173_inbox_policy_agent_cleanup.sql` installs AFTER DELETE agent cleanup which
  updates `user_inbox_agent_policies.allowed_agent_ids`. Agent purge carries this
  additional effect even though the service never names that table.
* `0227_modern_pandemic.sql:146–158` installs BEFORE status UPDATE issue-version
  mutation. Column authority must preserve the existing status-version trigger.
* `0313_private_task_access.sql:108–138` installs run scope/binding mutation;
  at 168–203, workspace source retention is a BEFORE workspace trigger, while
  AFTER issue execution-workspace assignment executes `UPDATE execution_workspaces
  SET metadata = metadata`, invoking that retention trigger. Therefore an issue
  workspace assignment reaches workspace DML transitively. At 217–236, workspace
  operations retain original task/run privacy provenance. Preserve these facts;
  dropping triggers to simplify a port would erase existing privacy behavior.
* The same 0313 migration explicitly uses top-level batch COMMIT, including run,
  issue and workspace backfills. `packages/db/src/client.ts:472–476` also treats
  0314 and 0332 as top-level statements. Its reserved utility connection at
  493–565 retains a session advisory migration lock across commits; executes raw
  SQL at 542; journals completion after statements; and can drop an invalid
  concurrent index before retry. An outer transaction cannot undo these effects.
* `0346_protected_authority.sql` immutability triggers protect pin monotonicity,
  receipt assignment and committed journal bytes. They contain no physical-COMMIT
  freshness primitive; their BEFORE timing must not be represented as strict expiry.

Owner cut: reviewed migration utility identity/session/DDL/search-path and restart
entrypoints must be excluded from ordinary execution authority and enumerated in
the real catalog/session retirement package. Retain migration file hashes/journal
and partial-completion inspection; a single success flag cannot prove a batch
rolled back. No live role/session/trigger state was queried and no executable
REVOKE or migration is proposed without that retained authenticated catalog.

### Strict validity and remaining complete-port prerequisites

No real authenticated physical-COMMIT primitive appears in these reviewed source
edges. Trigger, gateway, company/row/advisory lock, statement timestamp or timeout
cannot close a validation-to-irreversible-commit gap. Strict release validity is
still BLOCKED and monotonic fenced facts remain **UNACCEPTED** as a proposed
requirement change. The paired result-ingest writers and independently committed
finalizer/status effects described above still require separate exact phase
identities and uncertain inspection; this continuation does not collapse them.

The complete port still needs transitive issue/thread/card/publication, secret/
budget/identity/plugin, physical workspace and raw SQL/dynamic maintenance closure,
actual authenticated role/function/trigger/cascade/session catalog, and physical
legacy-writer exclusion. Preserve complete original shared-hold inventory including
unknown/run-only/unmapped sources, exact predecessor/intent identity, persistent
deny-before-later-effect order, stale refusal, global uncertainty hold and accepted
retirement semantics. No original hold or accepted retirement predicate changed.

## Writer/profile continuation: thread, publication and credential effects

Baseline is completed owner-port-continuation (113 component cases/4.057 seconds).
New exact single-file ownership is recorded before edits in
`writer-profile-continuation/OWNERSHIP.md`. The native checkout remains read-only;
this source review runs no tests, fixtures, Git/index or live/provider operations.
Source names below are relative to `.work/paperclip-admission`.

### Thread/card/publication closure and execution continuation

`issue-thread-interactions.ts:4748–4755` resolves the ownership-change callback:
UPDATE pending connection-intent interaction rows, then DELETE linked
`tool_oauth_states`. Terminal issue expiry at 4757–4848 iterates pending cards;
inside each transaction it deletes OAuth state, resolves linked tool-action and
secret-proposal rows, conditionally expires the interaction and enqueues terminal
chat publication. Concurrent card resolution rolls back that unit. Crucially,
linked tool actions are revoked before card resolution; pending/approved requests
can be revoked, but already-committed executing work remains in flight. Preserve
this distinction and its later gateway result reflection; expired card is not
physical stop or rollback evidence. The helper at 1147 also changes
`company_secret_proposals`, so this is not solely interaction-row authority.

Two small helpers now have complete directly reviewed DML:
`summary-slot-finalization.ts:23–44` marks matching generating `summary_slots`
failed on terminal issue status. `status-card-finalization.ts:33–78` changes
`status_cards` to error, clears generation claim and next evaluation, then marks
unfinished `status_card_updates` failed. They use the passed transaction; losing
these effects could leave a generation claim live, while blanket old-service
UPDATE access could recreate one. Assign exact terminal/stalled commands with
original issue/company/generation identity and the existing status predicates.

`chat-interaction-publications.ts:509–740` is the next concrete edge: terminal
resolution expires issued `chat_actions`, cancels pending/retry publications with
CAS, then RE-READS originals to distinguish racing streaming/delivery_unknown/
published states. Those potentially provider-visible states receive an exact
terminal replacement keyed `interaction-resolution:<interaction>:<endpoint>`.
Do not replace that reread with the initial pending snapshot or retry an unknown
send as a fresh publication. Nonterminal accepted/rejected continuation can insert
an `interaction_wakeup` action (666 onward), including fresh-session/workspace
refresh intent for accepted plans. Publication is therefore also a future run/
session authority edge, even if a current terminal case does not wake anything.
Actual provider delivery workers and their raw SQL/callbacks remain unclosed.

`chat-completion-delivery.ts` resolves another hidden run writer: status mutation
supersedes old `chat_completion_deliveries`, inserts new delivery in the status
transaction and records `chat_task_handoffs`. `prepareChatCompletionTurn` owns a
separate transaction locking source issue, selecting exact pending deliveries and
writing `heartbeat_runs.context_snapshot` plus target-run bindings. Comment reply
acknowledgement updates delivered state in the comment transaction, independently
of eventual run outcome. Its `deliver` worker leases due work, derives wake key
`chat-completion:<deliveryId>:<attempts>`, calls actual `heartbeat.wakeup`, then
conditionally records the returned run. Recovery checks existing durable wake
receipts before advancing attempts. Proposed owner command cut: exact delivery
claim/prepare/acknowledge plus execution-owner wake submission and inspection with
the original delivery attempt key. Preserve supersession/session-generation checks,
task-first locks and reply identity; a provider callback or terminal run cannot
stand in for already-committed reply acknowledgement. No existing delivery receipt
or current run is rewritten by this report.

### Budget stop is an actual post-commit control route

`budgets.ts:958–997` resolves the installed budget hook: it first commits accounting,
then `deliverBudgetEnforcement` reconciles lifecycle holds, rechecks exact policy/
enforcementVersion under company accounting lock, invokes `cancelWorkForScope`
outside that lock, and only then conditionally advances deliveredVersion. Hook
installation in `app.ts:685,1024`, routes and `heartbeat.ts:933` points to the real
`heartbeat/run-control.ts:1303–1313`: select cancellable scoped runs with exact
createdBefore bound, cancel each through `cancelRunInternal`, then cancel pending
wakes under `withCurrentBudgetEnforcement`. Failures retain pending version for
recovery; this at-least-once delivery contract cannot be translated into replaying
an unknown physical effect without exact owner inspection. Preserve manual pause
ownership and current policy/version checks. The protected stop lane must cover
this old-owner cancellation while new starts are held; durable spend or delivered
notification alone is not process retirement.

### Credential/identity/plugin closure includes physical custody

`agent-secret-bindings.ts:syncAgentAdapterEnvBindings` calls BOTH
`syncSecretRefsForTarget(...replaceAll:true)` and user-declaration synchronization.
The concrete `secrets.ts` writers delete/insert `company_secret_bindings` and
`user_secret_declarations`; `syncEnvBindingsForTarget:5021–5160` similarly writes
both sets on a supplied transaction or its own transaction. Claim consumption in
`setup-token-session.ts:1598–1619` conditionally updates the exact
`adapter_auth_sessions` stored-session scope. Preserve one-use scope, owner,
adapter/environment and current version; secret metadata success is not fresh
provider login/refresh or physical-session exclusion.

Normalization is also a writer: `secrets.ts:1935–2035` resolves inline schema secret
fields into `createManagedLocalSecret`. At 2091–2167 that helper reserves archived
`company_secrets`, invokes provider preparation, inserts disabled version material,
then activates secret/version in its transaction; failure invokes cleanup and
best-effort deletes. Other secret create/rotate paths invoke real provider modules
before SQL activation. Commands must own exact preparation/activation/cleanup
phases and uncertain inspection; SQL rollback is not a provider rollback.

`agent-identity.ts:28–61` locks the parent agent, creates an Ed25519 identity only
if absent, encrypts private material through `localEncryptedProvider`, persists
`agent_identity_keys` and activity, then verifies retained public/private match.
This is not independent issuer custody and must not be repurposed as such.
`secrets/local-encrypted-provider.ts:49–94` loads or CREATES the configured master
key with mkdir/write/link/unlink and may chmod an existing file. Consequently even
identity creation inside a SQL transaction has an actual physical key-file effect
outside database rollback. Reviewed owner placement must cover that key path and
all decryptors/writers, preserve existing key identity on corruption/refusal, and
retain the backup prerequisite; a new key is not recovery of old material.

`agent-lifecycle-driver.ts:25–43` verifies plugin readiness/capability and invokes
`manager.call(...,'agentLifecycle',...,30000)` with exact operation/version/phase;
it validates the response before applying returned instance secrets. The timeout
is not stop evidence for plugin work. `agent-instance-secrets.ts:16–40` serializes
account-home secret mutation, locks the agent, checks exact lifecycle operation,
version, phase, required plugin, leaseOwner and unexpired lease, then writes secret
changes/activity. Preserve all checks in an actual owner command, not a callback
returning success. `runHost:45–55` calls real harness verification or
`heartbeat.stopInvocationsForAgents`; `onReady` resumes queued runs. Plugin worker,
harness verification, host-services and account-home physical effect closure still
need complete review and writer exclusion; this table does not claim it done.

Strict physical-COMMIT primitive remains absent; the different monotonic fenced-fact
semantics remain **UNACCEPTED**. No native owner port or partial privilege cut is
installed. All original shared-family holds, exact intent/predecessor bindings,
deny order, stale refusal, global uncertainty, accepted retirement and protected
old-owner stop/inspection requirements remain. Paused B/timers/capacity/draft PR5/
human merges/Gemini/backup/S3/monitoring holds and operational nonacceptance persist.

## Control-closure continuation: actual publication, plugin and physical writers

Baseline is completed writer-profile-continuation (120 component cases/4.207
seconds); checkpoint, review and handoff retain exact synthetic scope. Ownership
was recorded before edits in `control-closure-continuation/OWNERSHIP.md`. This
increment changes this report only; native source remains read-only. No tests,
fixtures, Git/index, network/provider or live actions occur in this review.

### Real provider publication worker owns multiple irreversible phases

`services/chat-channels/publications/worker.ts:218–343` resolves the previously
unclosed worker. `withPublicationAttemptLease` locks the exact publication, refuses
an existing Teams transfer lane, CASes state/attempt to streaming and inserts an
exact `chat_endpoint_leases` token in one transaction. Renew asserts the lease row
under lock and samples time AFTER acquiring the row; lease loss is latched. The
finally path deletes that exact lease. Neither renewal nor lease deletion proves
provider cancellation, physical COMMIT expiry or permanent old-writer exclusion.

At 703–781 a durable transport-authorization claim precedes real `postSafePublication`;
provider I/O deliberately runs without a database transaction/row lock. At 796,
Slack upload acceptance sets `providerAccepted = true` BEFORE durable receipt
callback, so a callback database failure cannot authorize an implicit re-upload.
At 839–857 generic returned success likewise marks provider acceptance before
validating a usable nonempty message ID and before receipt settlement. Receipt
transaction at 857 onward CASes the same streaming attempt to published, settles
Telegram/Slack action state, writes message links and may stage session sync and
receipt-reaction removals. A stale generation/lease/receipt failure cannot undo
the provider effect. `publications/failures.ts:55–170` keeps provider-accepted
failure delivery_unknown; failure of durable finalization leaves streaming for
stale-scan quarantine, rather than pretending rollback or replay safety.

`publications/transport.ts:postSafePublication` reaches actual thread post/edit,
streaming, Photon, voice enqueue and GitHub response-comment paths. It also loads
attachment bytes and selects provider-specific upload behavior. Slack file-only
upload intentionally avoids the SDK's two-call upload-plus-text ambiguity. Edit
fallback, multipart/stream progression, Teams transfer, Photon prewrite callback,
voice/GitHub and later receipt/session-sync workers are separate transitive effect
edges; reviewing this generic transport does not close every provider implementation.

Concrete proposed owner split: exact immutable publication/payload/attachment/
destination/runtime/attempt intent; preparation refusal before I/O; exact claimed
provider operation; provider acceptance/receipt inspection; conditional SQL result
settlement; and separately identified reaction/session/task-control follow-ups.
Retain current conversation ordering, duplicate-unknown refusal, leases, durable
authorization/action identity and all uncertain states. A lease renewal callback
or recorded authorization must not be returned to an old worker as permission to
perform provider I/O independently. No provider delivery is performed here.

### Plugin host services retain real execution and dynamic SQL access

`plugin-host-services.ts:2997–3077` exposes pause/resume through real lifecycle
commands, invoke through `heartbeat.wakeup`, and managed reconcile/reset. Availability
and company checks remain necessary but do not remove this equivalent execution
route. At 1680–1686 host `db.query/execute` forwards plugin-supplied SQL/parameters
to `pluginDatabaseService`, not to an inert fixture or provider label dispatcher.
Host HTTP fetch at 1725–1740 is real pinned-destination HTTP with AbortController;
secrets.resolve at 1744 onward reaches the real secret handler. Event emission,
workspace services and other host surfaces also require capability/intent closure.
No claim is made that a plugin lacks authority because its worker environment
omits DATABASE_URL.

`plugin-database.ts` has actual dynamic SQL authority: runtime query/execute invokes
`db.execute(bindSql(...))`; zero-parameter statements become `sql.raw`. Its parser
is custom statement splitting plus regex keyword/qualified-relation scanning,
not a complete SQL grammar or database-role boundary. The visible runtime path
uses its supplied database connection with no per-plugin SET ROLE/connection-role
switch. Qualified table checks do not establish all function/operator/view/trigger/
cast effects, inherited privileges or search-path safety. This is a concrete
closure gap, not a demonstrated exploit or a claim that a particular live role
has forbidden privileges. Authenticated catalog/function/grant artifacts remain
absent; do not convert validator success into sole-owner exclusion.

The same service `ensureNamespaceWithClient` executes CREATE SCHEMA and writes
`plugin_database_namespaces`. `applyMigrations` reads plugin package SQL, checks
hashes of already-applied migrations, acquires advisory transaction lock, executes
validated raw statements and writes `plugin_migrations`. It uses an outer
transaction if available; failure-ledger persistence may use the root db rather
than the statement transaction, while fresh-install callers may disable it.
Source/package bytes, namespace/migration state and utility connections are part
of the actual authority cut. Proposed command unit must bind immutable plugin/
manifest/package/migration hashes, expected namespace and exact statement intent;
exclude equivalent direct dynamic SQL/DDL/function authority from old services.
Do not offer arbitrary SQL as a protected execution-owner command. Existing
validators stay defense-in-depth; this review does not install new wrappers.

### RPC timeout and worker stopped status do not settle plugin effects

`plugin-worker-manager.ts:2923–2948` forks a direct child with controlled env,
stdin/stdout/stderr/IPC and detached:false. `callInternal:3349–3448` registers
invocation and route before send; timeout rejects/settles pending request and
clears invocation/execute route. That timeout does not terminate already executing
plugin/provider work. `stopInternal:3205–3262` attempts shutdown, SIGTERM, then
SIGKILL with bounded waits; `killWithSignal` targets the direct ChildProcess.
It can set local status stopped after the final wait even if childProcess remains.
This is not a verified descendant set, runtime incarnation retirement or storage
writer fence, and must not be used to clear original shared-family occupancy.
Exact protected stop/inspection and uncertain operation state must survive RPC
rejection/worker disconnect/restart. Preserve existing host-derived invocation
scope and routes, but do not equate clearing an in-memory route with settled I/O.

### Harness and account-home effects are outside run-only SQL ownership

`agent-harness-verification.ts:35–50` performs lifecycle verification within
`withCapacityOperation`, keyed by original operation/version. Its admitted path
resolves secrets and environments, checks the resolved configuration, obtains an
actual test execution context and calls managed probe or the actual adapter's
`testEnvironment`; finally it releases that target. `agent-environment-test.ts`
resolves driver test lease/agent lease without manufacturing a heartbeat run;
release at 256–271 reaches driver.releaseRunLease and environments.releaseLease.
Therefore moving heartbeat run dispatch alone leaves a real lifecycle probe and
lease/driver cleanup path. Preserve exact non-run operation identity, restoration
obligations and uncertain release inspection. A hello result cannot prove full
session/credential/workspace custody or descendant stop.

Codex physical credential paths resolve another concrete owner split:
`packages/adapters/codex-local/src/server/codex-auth-copyback.ts:80–156` reads
sandbox auth, takes host-directory merge lock, enters execution-state mutation,
stages private bytes, validates same-identity/strictly-newer merge, syncs the file,
renames onto host auth and syncs the parent. At 160 onward an additive per-account
cache write runs independently under another lock, may target a different account
slot, and failure is deliberately best-effort after host success. Preserve those
two outcomes separately; cache failure cannot mean host auth rollback or justify
replaying a completed host replacement.

`codex-auth-cache.ts:343–361` holds a distinct company secret-mutation directory
lock before row locks, tracking nested ownership only while active. `selectVendCredential`
at 500–568 can independently stage/rename cached bytes onto shared-home auth;
cache entry deletion at 576–600 and whole-company cache removal at 603–610 are
additional physical writers. Locking, exact byte staging and atomic rename help
local correctness but do not prove symlink/mount alias exclusion, old-writer
retirement, coherent full-profile capture or independent high-water. Actual owner
commands need immutable source/target/account/operation identity and physical
commit/inspection for host and cache phases plus exact cleanup commands. They
must include seed/promotion/logout/deletion paths and surviving provider handles;
this source review does not change existing same-identity merge policy or install
credential custody. No credential bytes were read.

Complete provider-specific publication/reconciliation, plugin capability/host/
managed-agent/HTTP/secret effects, adapter setup/probe, account-home promotion/
cleanup and all dynamic SQL function/catalog/session paths remain unresolved.
No authenticated physical-COMMIT primitive is supplied by these mechanisms;
strict validity remains BLOCKED and monotonic fenced facts remain **UNACCEPTED**.
No partial native port is installed. Full original shared-hold closure, original
five-scope families, exact intents/predecessors, persistent deny ordering, stale
refusal, uncertain inspection and existing accepted-retirement behavior remain.
All A/B/timer/capacity/draftPR5/human-merge/Gemini/backup/S3/monitoring holds persist;
component evidence remains separate from operational acceptance.

## Effect-owner continuation: provider phases and function/session cut

Baseline is completed control-closure-continuation: exact checkpoint/review,
verification-summary and fixture log read (131 PASS/4.269 seconds; no operational
acceptance). Root selected the newest completed handoff and recorded disjoint
ownership in `effect-owner-continuation/OWNERSHIP.md` before editing. This native
increment edits only this report. Native source stays read-only; no tests, Git/
index, provider/live actions or partial privilege/transaction-owner port occur.

### Provider-specific persisted phases cannot collapse into one publication

* **Photon:** `photon/adapter.ts:465–579` binds each `send:<publication>:<part>`
  to a payload digest and independently CAS-persists prepared, uploading, uploaded,
  sending and sent. A sent message GUID returns the retained result. Uploading/
  sending refuses without the explicit retryUnknown path. Actual attachment upload
  at 509 precedes uploaded-state persistence; actual message send/edit at 548–564
  precedes sent-state persistence. Both receipt-loss windows are irreversible
  uncertainty, not absent effects. `photon/state.ts:23–43` delegates each phase to
  endpoint-scoped persistence CAS, separately from publication settlement.
  `chat-channels/imessage-photon/publications.ts:57–102,227–321` additionally checks
  current runtime generation/resource and persists reply selection and prompt
  GUID mappings. Prompt publication and each multipart attachment/text send need
  their original independent phase identities and inspection. The assertCurrent
  callback samples authorization before I/O; it supplies no strict expiry at the
  subsequent provider commit. Provider client IDs/digests aid identity and do not
  establish authenticated physical-COMMIT expiry or complete provider deduplication.
* **Teams:** `chat-teams-file-transfers.ts:737–848` separates consent-card POST,
  upload PUT and file-info POST. Each claims/checks authority, performs external
  I/O, then settles its original attempt in a later SQL transaction. At 812 the
  affirmative provider-not-attempted branch differs deliberately from recovery of
  a crashed intent. Consent/upload/file-info unknown states remain distinct;
  uploaded bytes do not mean a delivered file-info card. `bounded:718–736` aborts
  and rejects after 30 seconds; that is not proof the provider stopped. Receipt
  recording preserves an already admitted effect after policy changes while every
  next I/O needs reauthorization. Preserve that existing rule, sealed upload
  capability/context, original consent callback and projection in the same
  transfer transaction; do not turn an operator resolution into a fabricated
  file-info receipt or clear occupancy from consent alone.
* **GitHub:** `chat-github-response-comments.ts:68–116` stages the response,
  locates an exact marker/bot-owned existing comment, rechecks authority, performs
  POST/PATCH, validates receipt, rechecks authority AGAIN, then commits action and
  activity through the lease. Revocation or SQL failure after POST/PATCH cannot
  erase the remote comment. Marker discovery is reconciliation evidence, with
  its actual pagination/ownership/version constraints, rather than permission to
  send another response. Keep retained acknowledgement/final/version semantics,
  source delivery/repository/PR-vs-issue/reply identity and exact remote operation;
  `finishRun:231–266` may settle additional linked request comments independently.
* **Slack session follow-up:** `chat-slack-session-outbox.ts:36–80` stages one
  conversation action with monotonically incremented revision, runtime generation
  and credential fingerprint. `chat-channels/slack/session-status.ts:218–306`
  recomputes status from current publication/run and CAS-claims an owner token;
  provider `setSlackSessionStatus` at 314–319 precedes separate revision/token-bound
  settlement at 320–354. Its existing retry classification at 357 onward relies
  on repeatable setStatus, not duplicate-message safety. Preserve revision and
  generation checks against delayed processing overwriting a newer final/question.
  This is a separately authorized provider mutation, not merely publication SQL.

`chat-publication-reconciliation.ts:20–58` only emits optional post-durable signals;
`createCoalescedAsyncTrigger` coalesces wakes and retains one dirty follow-up.
Stopping/draining that trigger does not cancel in-flight provider effects. Periodic
recovery is still required; a lost notification must not become permission to
recreate an unknown effect. Remaining unclosed branches include actual Slack
upload internals, Telegram draft/multipart progression, voice enqueue/push and
receipt-reaction provider callbacks. This increment closes the specific reviewed
edges above, not the complete provider graph.

### Capability checks are real, but do not own resulting effects

`app.ts:997–1018` installs actual `buildHostServices` through
`createHostClientHandlers`, with the installed manifest's capabilities.
`packages/plugins/sdk/src/host-client-factory.ts:375–417,695–703` checks declared
method capability and invocation-company scope before delegation. In particular
SQL query/execute, HTTP and secret resolution have distinct read/write/outbound/
secret-ref capability requirements. `plugin-worker-manager.ts:2749–2790` dispatches
real handlers with host-derived context and sends the result only AFTER awaiting
the handler. Reply loss/disconnect can therefore follow a completed host effect;
it cannot authorize a second invocation with fresh identity. The manifest snapshot
and scoped callback checks must remain alongside actual durable effect ownership.

The host also has independent physical `localFolders.writeTextAtomic/deleteFile`
paths (`plugin-host-services.ts:1633–1655`), state set/delete, entity upsert,
subscribe/event emission and lifecycle inbox acknowledgement. An outbound HTTP
request may itself mutate its destination; pinned address/SSRF checks and abort
are not provider-effect rollback or ownership. Secret resolution can expose bytes
that a plugin then uses outside the host RPC; excluding a SQL credential from the
child does not exclude this authority. A complete cut needs plugin/manifest/package,
invocation and capability generation, exact destination/payload/reference digest,
original operation identity, durable outcome/uncertain inspection and protected
stop/inspection. Do not store secret values in an inspection journal or mistake
capability availability for independent issuer custody.

### Concrete function/session authority matrix still needed

`plugin-database.ts:170–188` rejects CREATE FUNCTION/TRIGGER, extension/language,
GRANT/REVOKE, COPY/CALL/DO and SECURITY DEFINER spellings. Runtime SELECT at
246–274 does not require a relation reference; relation scanning therefore does
not enumerate functions callable from a SELECT expression. Namespace DML at
276–301 likewise cannot establish absence of function/default/generated/index/
constraint/trigger side effects on its target. These are source-reachable
categories, not an asserted exploit or an invented live catalog. A function call
need not create a new function. Migration CREATE VIEW/ALTER/COMMENT and backfill
remain on the same supplied client (`503–504`); no per-plugin role/session switch
was found in the runtime execution path (`557–569`).

Before a privilege migration, an authenticated catalog artifact must map:

| Reachability | Exact required retained evidence / exclusion |
| --- | --- |
| Session identity | Client/pool/pooler backend roles, startup options and persistent session settings; current_user/session_user, memberships and SET ROLE reachability, active/prepared/maintenance/recovery connections. NOLOGIN or password rotation does not terminate existing sessions. |
| Function authority | Exact schema/name/signature/OID and source/extension provenance, owner, PUBLIC/default/explicit EXECUTE grants, SECURITY DEFINER/invoker, proconfig/search_path, dynamic SQL and callable dependencies. Include overloaded functions, procedures reachable indirectly, operators/casts and session-mutating functions. |
| Relation authority | Table/column/sequence ownership and inherited/default/PUBLIC grants; views/rules, triggers/cascades, defaults/generated expressions, constraints and index expressions; schema CREATE/TEMP and function-resolution paths. Include actual plugin-created migration objects. |
| Connection continuity | Every old app/plugin/utility endpoint, queued job, maintenance script, restored clone and surviving pool/session; exact exclusion/termination and inspection result before owner activation. No fabricated role names or blanket REVOKE script from source guesses. |

A parser or stricter validator cannot establish these exclusions. Do not expose
arbitrary SQL as a native owner command. Strict physical-COMMIT validity must be
resolved before installing the complete transaction-owner port; locks, triggers,
lease checks and timeout settings cannot close the post-check/commit gap. The
monotonic fenced-fact alternative remains an **UNACCEPTED requirement change**.
All complete original shared-family holds and five scopes, original intents/
predecessors, deny ordering, stale refusal, uncertainty and accepted-retirement
semantics remain. Protected exact original-owner stop/inspection must remain
available while new work is held. No rollout, genuine shared-hold reconciliation,
Codex/Claude stage or backup release prerequisite is accepted by this review.

## Provider-cut continuation: upload, draft, voice and reaction owners

Completed effect-owner-continuation is the baseline: handoff, checkpoint, review,
verification summary and exact fixture log read (137 PASS/5.094 seconds; local
synthetic scope). Pre-edit ownership is `provider-cut-continuation/OWNERSHIP.md`.
This increment edits this report only, with retained native source read-only and
no native port, tests, fixtures, Git/index, network/provider or live actions.

### Slack upload internals and reachable metadata-only reconciliation

`chat-sdk-runtime.ts:2517–2565` binds the receipt callback through AsyncLocalStorage
around actual Thread.post and exposes a separate receipt lookup. The retained
`patches/@chat-adapter__slack@4.39.0.patch` changes uploadFiles/postMessage, not
just a controller validator: actual `_client.files.uploadV2(uploadArgs)` precedes
file-count/unique-ID validation and awaited `onFileUploadAccepted`. Failure in
validation or callback can therefore occur after Slack acceptance. The callback
runs before the potentially delayed file-share lookup. The worker marks provider
accepted BEFORE calling `recordSlackFileUploadReceipt` (`worker.ts:796–819`).
Retain that order and the distinct missing-ID/callback-commit windows; absence of
an accepted-upload row cannot prove the upload did not happen.

The patch resolves file-share identity from completion metadata or `files.info`
reads. Every file must match its requested ID and share one exact channel/thread
message timestamp; absent/ambiguous shares refuse identity. A five-second deadline
and Promise.race bound local lookup, without retracting uploads or necessarily
terminating outstanding metadata requests. `chat-channels/slack/file-receipts.ts:143`
records exact publication/attempt, file IDs, thread, bot, runtime generation and
credential fingerprint in a separate transaction after provider acceptance.
`processPendingSlackFileUploadReceipts` claims a token, calls the runtime's
metadata-only lookup at 691, then under fresh locks settles only the matching
attempt: unknown→published at 827–847 or enriches an already-published exact row.
It records the outbound link before staging session-sync/receipt-removal effects
at 850. Missing identity schedules metadata retry; it does not re-upload.
`chat-channels.ts:879,4038` exposes this concrete reconciler to the service.

Required owner phases: upload preparation/actual upload, accepted-upload fact,
exact share inspection, publication/link settlement, independent follow-ups.
Freeze attachment bytes, exact expected IDs/count/destination and original attempt;
never turn a stale receipt or failed SQL insertion into a new upload intent.
The SDK's uploadV2 may itself perform multiple HTTP operations: the retained patch
alone is not full transitive SDK/client retry/remote-commit closure. Slack native
stream patch also tracks confirmed append prefix and stop receipt; later renderer/
iterator/endTyping failure becomes delivery_unknown rather than whole-send retry.
Those prefix observations are currently in-memory, not a complete durable per-
fragment owner journal. They require owner placement at actual append/stop effects.

### Telegram durable draft is distinct from final send and runner termination

`chat-channels/telegram/publication-drafts.ts:reserveTelegramPublicationDraft`
reserves a unique `telegram-draft-publication:<publication>:<attempt>` action and
NO CYCLE database sequence ID, with bot/chat/thread/session/runtime/credential/
text-digest bindings. Repeating that same attempt refuses; sequence gaps on rollback
must not recycle a provider-visible identity. Its `before` transaction locks and
checks publication→endpoint→connection→conversation→draft, source authorization
and credential lease, then records drafting or final_sending BEFORE adapter I/O.
The callback `handleTelegramGenerationStopped` requires authenticated callback
provenance and matching binding/runtime/text/attempt; it changes only drafting
work. A late Stop cannot undo final_sending. Keep these exact current predicates
and lock order; this is presentation stop, not provider CLI/descendant retirement.

`chat-sdk-runtime.ts:2486–2509` requires the patched durable-private-stream contract.
The retained Telegram patch calls `beforeDraft` for rich/Markdown/plain draft
requests and `beforeFinal` before final rich/text delivery; a stopped control returns
paperclipDraftStopped. Callback/control failure propagates, while actual provider
format failures may choose supported fallback. Draft/final HTTP runs AFTER the
control transaction committed; timeout/AbortSignal and a successful precheck do
not establish strict commit expiry. Preserve original draft identity, each accepted
presentation phase and final unknown result across disconnect/restart. No final
message may be retried merely because a late Stop or receipt commit failed.

Multipart is not one universal provider path. Native explicit inline splitting in
`publications/preparation.ts:61–139` applies to Slack/GitHub/Teams and atomically
updates root plus inserts uniquely keyed part publications, with transport batch/
index/count/orderKey. `publications/order.ts:16–37` preserves their deterministic
order. Telegram/Discord long text uses markdown-attachment mode in transport
rather than this inline split; Telegram media attachments and final rich/text
fallback may still reach multiple underlying SDK calls. Complete pinned SDK source,
retry behavior, each send receipt and cancellation/partial-failure branch remain
unclosed. Do not infer all-or-nothing send from one publication row.

### Voice enqueue, per-call push and playback have separate outcomes

`voice/voice-session-store.ts:444–474` returns synthetic `voice:<publication>` after
per-session transactions insert reply/cursor; progress can deliberately skip speech.
That receipt is queueing, not provider acceptance or audible playback. Recovery
`collectMissedReplies:250` selects eligible published work since that exact caller
joined, excludes previously dispatched/unknown/completed prior-call deliveries and
preserves ordered question barriers. A fresh call must not replay an unknown old
call merely because the publication remains published.

`voice/voice-reply-push.ts:29–175` persists one dispatching action per reply/part,
binding session/provider session/generation, publication, part index/count and text
digest. Completed parts are skipped; changed digests, in-flight/unknown or other
nonretry states hold. Credentials and session authority are rechecked before real
`sendCallMessage`; its receipt precedes separate completed-action/final-part
reply-delivered transaction. Receipt-commit failure retains uncertainty; a stale
30-second dispatch is marked unknown without resend. Questions are notification
only until authorized get_updates retrieves exact IDs; they remain a barrier.
`voice-session-store.ts:321–397` also commits get_updates reply delivery independently
of provider speech. Keep both definitions; neither proves the person heard audio.

`voice/speko-provider.ts:19–52,156` performs actual POST with bounded timeout/body;
network, invalid successful reply and server-error outcomes can be unknown. A
429 retry is a separate explicit classification, not blanket retry of dispatching.
`voice-session-service.ts:243–249` calls push from reconciliation, and publication
transport schedules push after enqueue. Current session inspection/end/cleanup,
inbound and report reconciliation are additional provider authorities; no complete
provider control/install closure is claimed. Required owner cut includes exact
queue transaction, per-part physical POST, retained provider acceptance, exact SQL
settlement and old-session protected stop/inspection. Playback stays unknown.

### Receipt reactions are independent provider writes with bounded retries

`chat-receipt-reactions.ts:stageReceiptReactionRemovals` stages exact original
admitted-message cleanup through run/context/comment links, including a one-shot
marker for a fast reply beating late add. It is not a generic reaction-delete
permit. `chat-channels/receipt-reactions.ts:282–452` separately claims attempt,
resolves current runtime under credential lease, performs provider add/remove,
then commits exact processing/attempt success and optional delivery diagnostics.
A success-commit failure follows real provider mutation. `460–569` classifies
already-applied Slack add, bounded unknown retry (<3), or retained failed state;
`575–582` is the real due-action recovery loop, also registered in
`chat-action-work.ts:109`. Preserve that existing provider-specific retry policy;
an ownership port cannot generalize its idempotence to arbitrary publication sends.

`chat-slack-receipts.ts:applySlackReceiptReaction` issues actual reactions.add/remove
POST under abort/body bounds. Confirmed already_reacted/no_reaction have distinct
idempotent settlement semantics; malformed/oversized/aborted replies are unknown.
`chat-github-receipt-reactions.ts:request` separately creates an installation token,
reads authenticated App/bot identity, and rechecks current authority before/after
bounded HTTP/body reads. Add validates exact bot/reaction ID. Remove reads every
bounded page, refuses duplicates/incomplete pagination/changed identity, then
DELETEs only the matched bot-owned reaction; incomplete reads never prove absence.
A post-HTTP recheck failure cannot undo token creation/add/delete. These phases,
retained GitHub receipt identity and reaction-source marker need separate durable
intent/inspection. Generic Telegram/Discord adapter add/remove also remains a
transitive SDK authority, with no source-only claim of complete physical closure.

The next missing cut is concrete: exact pinned SDK upload/stream/media/reaction
HTTP and retry internals, all credential/token and provider control cleanup phases,
actual catalog/session/legacy exclusion, physical authority placement and strict
COMMIT validity. No validator/model wrapper supplies effect ownership. Strict
physical-COMMIT remains unresolved; monotonic semantics remain **UNACCEPTED**.
Complete original shared-family/five-scope holds, exact intents/predecessors,
deny ordering, stale refusal, uncertainty and accepted retirement are unchanged.
Protected exact old-owner inspection/stop remains available; no local submission
or provider presentation stop proves runtime termination/release. All paused-B,
timer/capacity/draftPR5/human-merge/Gemini/backup/S3/monitoring holds persist.

## Provider-owner follow-up: creation, cleanup and credential continuity

Baseline: completed provider-cut-continuation, checkpoint timestamp
2026-10-21T00:23:07.095764+00:00. Exact fixture/summary/cleanup retain 140 PASS/4.177s,
exit0/no OOM/removed/absence checked; unchanged-input local evidence is not provider
acceptance. Assignment before editing: provider-owner-followup/OWNERSHIP.md.
Only this report changes; no native source/Git/index/tests/fixtures/network/live
operations. No partial native owner port or requirement change is installed.

### Actual call creation exposes a distinct lost-identity cleanup window

`voice/voice-session-service.ts:88–131` reserves the original session, CAS-claims
reserved→creating, resolves fingerprint-bound credentials and authorizes in SQL
before actual browser/phone creation. Its provider response precedes the separate
providerSessionId/connecting UPDATE at116. If that UPDATE fails, exact provider
end at120 swallows errors without retaining the provider ID in a separate durable
cleanup record. Lost creation replies/crashes can likewise leave no provider ID.
The request carries original session ID metadata, but this path supplies no
lookup-by-binding reconciliation. Metadata is not proven provider deduplication.
The existing guard at88 correctly avoids blind recreation of an existing attempt.
Preserve it, exact original session/caller/issue/generation/credential fingerprint,
request digest and separate creation/cleanup identities. Post-create authorization
failure at130 cannot erase the already created call either.

`closeProviderOnce:141–165` separately commits ending/activity, performs end, then
inspects the exact provider session if needed before committing ended versus
cleanup_pending. `speko-provider.ts:171–178` treats ending as an unconfirmed request
receipt; already_ended alone confirms. Preserve this distinction. Its process-local
closingSessions Map coalesces calls but does not provide durable cross-process
ownership or restart inspection.

`voice-session-service.ts:202–240` eventually marks missing-provider-ID sessions
expired/endedAt after **session.expiresAt plus120 seconds**. The source explicitly
relies on provider maximum duration. No authenticated provider duration enforcement,
clock or teardown artifact is available. Under accepted retirement semantics this
SQL/time observation must not manufacture a stop receipt or release unknown
occupancy. Retain the original uncertain creation and inspect/retire it through
actual authority. This identifies a concrete integration blocker, not an assertion
that the provider's duration limit fails.

`voice/speko-provider.ts:50–75,112–135` also mutates shared tools, voice defaults,
phone routing and webhook/signing-secret configuration via separate POST/PATCH.
Each needs original intent, exact request/provider identity, independently committed
outcome and cleanup inspection; session SQL cannot roll those effects back.

### Token issuance, credential lease and adapter retirement remain separate

`chat-github-client.ts:173–224` resolves vaulted App secrets, signs JWT and POSTs
repository-scoped installation-token issuance. Acceptance precedes response parsing
and the caller's subsequent effect. This helper returns token bytes without a
separate durable issuance outcome or explicit revocation. Its generic retry error
cannot authorize owner-level replay of uncertain issuance. Keep safe exact binding,
digest/expiry and protected original-owner inspection/revocation requirements;
never journal token bytes or invent provider revocation evidence.
`chat-github-receipt-reactions.ts:134–224` deliberately owns bounded token exchange
because Octokit's internal exchange drops the outer AbortSignal. Preserve that
actual transport distinction rather than assuming SDK-wide cancellation.

`chat-credential-mutation-lease.ts:34–87,104–148,181–225` independently acquires,
reclaims by expiry, renews token-bound SQL and finally deletes its own token.
It also permits explicit committed-result recovery after lease loss. Preserve that
callback: generic failure/retry would erase a real committed mutation. Timer stop,
renewal completion and lease deletion neither revoke disclosed secrets nor cancel
HTTP. Old pools/plugin-held credentials/pending requests need physical exclusion.

`chat-sdk-runtime.ts:3129–3155` retires synchronously, joins initialization/Gateway,
closes Photon and awaits chat.shutdown. Its registry at3198–3260 retains failed
retirement and serializes replacement before successor installation. Preserve these
useful local invariants. Underlying SDK socket/request cleanup, token revocation
and durable retirement across process loss still need actual owner evidence.

### Exact missing pinned source inputs, without compatibility inference

The retained checkout has patches/lock declarations but no installed
node_modules/.pnpm source tree. No dependency install or network acquisition was
performed. `pnpm-lock.yaml:9819–9894` selects patched Discord/Slack/Telegram
adapters4.39.0, shared/chat4.39.0, Slack web-api7.19.0/socket-mode2.0.7,
Discord.js14.27.0 and GitHub auth-app8.3.1/rest22.0.1. These are acquisition inputs,
not authenticated runtime identity or compatibility proof. Complete package bytes,
exact applied patches/build mapping and transitive REST/HTTP dependencies remain
needed for uploadV2 subrequests, retry/rate-limit queues, stream append/stop,
Telegram media/reactions and Discord REST/disconnect closure. Patches alone cannot
establish no hidden retry or an all-or-nothing provider commit.

The earlier authenticated SQL function/operator/default/catalog/session matrix
remains required; no parser or validator substitutes for physical authority.
Strict physical-COMMIT validity remains unresolved before installing the complete
native transaction-owner port. Monotonic fenced facts remain **UNACCEPTED**.
Separate intents/exact predecessors/committed outcomes, inspection/uncertainty,
deny ordering/stale refusal and accepted retirement remain unchanged. Protected
exact original-owner stop/inspection remains available while new work is held.
No local pipe submission proves termination/release. Original shared-family/five-
scope holds, paused B, disabled timers/current capacity, draftPR5/human merges,
Gemini/backup/S3/monitoring and rollout/shared-hold reconciliation gates persist.

## Recovery-owner continuation: real receiver cleanup and SQL trigger closure

Baseline is provider-owner-followup, checkpoint2026-10-21T00:27:48.143118+00:00.
Read exact checkpoint/review and fixture tail:143 PASS/4.679s, removed/absence
confirmation. These are retained exact-input local results, not new tests or
provider acceptance. Ownership was recorded before editing in
recovery-owner-continuation/OWNERSHIP.md. Only this report changes; no native/Git/
index/test/fixture/network/live action or repeated unavailable-SDK search occurs.

### A failed receiver shutdown currently still releases its lease

`chat-channels/runtime/ownership.ts:76–117` sets stopping, stops renewal and removes
its local ownership-map entry, then catches/logs a failed runtime.removeEndpoint
and **still deletes the lease row**. Its comment that the listener stopped before
release is therefore stronger than the actual error branch. The registry's
retiringEndpoints correctly preserves failed shutdown, but another server can
acquire the deleted row. `acquireDiscordGatewayOwnership:302–365` also reclaims an
expired row solely by time. Those database outcomes do not establish that the
old Gateway/Photon receiver physically stopped. This helper serves both providers
through receiverLeaseKey, despite Discord-named types.

`chat-channels.ts:1137–1146` has another concrete initialization-failure edge:
removeEndpoint errors are swallowed, then stopDiscordGatewayOwnership(...,false)
releases without attempting the runtime again. Source-level callback context
checks may refuse later admissions, but are not physical socket retirement or
proof that previously admitted callbacks/effects finished. Already in-flight
callbacks must keep their own exact original effect identity and settlement.

An owner integration must retain unknown receiver occupancy and protected exact
original stop/inspection after shutdown failure; lease release needs separately
proved retirement. Merely removing the catch is insufficient: expiry reclaim
still needs physical fencing/retirement, and renewer failures cannot manufacture
that proof. Keep exact old context/token/generation/fingerprint until inspected;
never install a successor because cleanup logged an error. Root was sent this
concrete source defect. No partial native patch or invented retirement receipt
was installed.

The ordinary service shutdown at `chat-channels.ts:4042–4078` correctly awaits
runtime.shutdown before releasing its snapshotted lease rows. Preserve that
ordering. Promise.allSettled of other background/stop tasks retains no individual
durable failure result by itself; process shutdown cannot become a settlement
receipt for every admitted provider action.

### Credential retirement is binding removal, secret cleanup, then provider state

`chat-channels/credentials.ts:265–388` creates fresh encrypted secrets separately,
then transactionally switches bindings/refs under fingerprint and lease checks.
On acknowledgement failure it deletes only secrets proven unbound; unreadable
binding evidence intentionally leaks safely. Retired-secret removal occurs later
through allSettled and warning. Preserve this correct uncertainty distinction and
each individual secret identity; an all-success rotation projection cannot stand
for complete cleanup. `clearCredentials:394–438` likewise commits binding removal
before individually attempted secret removal. Neither path revokes provider-side
bot tokens or already disclosed credential bytes.

`secrets.ts:3378–3435` is the actual transitive removal owner: acquire account-home
secret mutation lock, reread current secret, persist deleted tombstone, invoke
provider.deleteOrArchive, then delete companySecrets. These phases are not one
outer transaction. Provider-config disabled/coming_soon skips deleteOrArchive;
provider not_found is separately accepted. The local-encrypted provider's cleanup
is intentionally a no-op because material is database-held. Do not project that
local no-op onto remote vault providers or provider-account revocation. Complete
cut must own encrypted material/version/cascade handling, key custody and any
external vault mutation, retaining exact unknown outcomes and binding inspection.

### Actual migration functions add hidden write and read dependencies

Retained migration source now concretely identifies these function/trigger edges,
without claiming authenticated installed catalog state:

| Definition | Hidden dependency requiring the native authority cut |
| --- | --- |
| `0173_inbox_policy_agent_cleanup.sql:3–22` | Agent AFTER DELETE calls remove_deleted_agent_from_inbox_policy_allowlists, updating user_inbox_agent_policies. Agent deletion is not confined to the agent table. |
| `0227_modern_pandemic.sql:146–160` | paperclip_bump_issue_status_version modifies NEW.status_version on issue status change; preserve the trigger-derived predecessor/version semantics. |
| `0277_uneven_lady_deathstrike.sql:18–35` | ai_connection_defaults INSERT/UPDATE calls sync_ai_provider_default and writes ai_provider_defaults. INSERT preserves an unavailable existing default; UPDATE explicitly replaces it. Do not collapse those semantics. |
| `0313_private_task_access.sql:108–140` | set_heartbeat_run_scope_kind reads issues and fixes run privacy/task binding on run INSERT/selected UPDATE. A run update requires this relation-read dependency and immutable privacy behavior. |
| `0313_private_task_access.sql:168–204` | Issue workspace binding triggers UPDATE execution_workspaces; its BEFORE trigger reads issues and accumulates privacy provenance. This is a real transitive write even though the SQL assigns metadata=metadata. |
| `0313_private_task_access.sql:217–237` | Workspace-operation trigger retains both original issue and run provenance in metadata. Porting visible ORM values alone loses historical privacy authority. |
| `0345_legacy_present_day_decisions.sql:14–21`; `0346_protected_authority.sql:34–62` | Append-only decisions, protected pin revision/generation and single receipt transition are enforced by triggers. These preserve local predicates; they are not independent high-water or strict physical-COMMIT expiry. |

These definitions do not declare SECURITY DEFINER or pinned search_path and use
unqualified names; exact installed function owner/grants/search-path/schema CREATE/
TEMP/overloads/operator dependencies and old sessions still require authenticated
catalog evidence. Source omission does not prove live defaults or safe resolution.
No guessed grants/revokes/session IDs or arbitrary-SQL owner command were added.
Strict physical-COMMIT remains unresolved; monotonic alternative **UNACCEPTED**.
Original intents/predecessors, independently committed outcomes, uncertainty,
deny order/stale refusal/accepted retirement and protected exact stop/inspection
remain. All original shared-family holds, paused B, timers/capacity, draftPR5/human
merges, rollout/shared-hold reconciliation and deferred backup prerequisite persist.

## Owner-custody follow-up: callback completion and consumed OAuth attempts

Baseline recovery-owner-continuation exact fixture145 PASS/4.467s and independent
review read. New pre-edit assignment: owner-custody-followup/OWNERSHIP.md. This
increment changes only this report; no native source/tests/Git/index/fixtures,
network/provider/live actions or repeat unavailable-SDK searches. Prior synthetic
results remain limited to unchanged exact inputs.

### Successful stream close does not join already-admitted Photon work

`photon/receiver.ts:43–68` launches subscription-reader tasks with void and catches
their final rejection; those tasks are not retained for join. `request:69–85`
retains the serialized catch-up Promise in running. However `close:183–190` stops
the timer and closes streams without awaiting running or the subscription tasks.
A catch-up currently inside `await admit(event)` at164 or a checkpoint callback
can therefore still be awaiting SQL when close returns. Its preceding assertOwned
is an admission check, not a drain barrier for that already admitted operation.

`chat-sdk-runtime.ts:3141–3143` then awaits chat.shutdown, whose Photon adapter
`photon/adapter.ts:137–143` retires auth, closes recovery transport and awaits the
gRPC client. Neither this source nor receiver close joins an application callback
already beyond transport I/O. Thus even successful socket/client closure does not
prove callback settlement. Preserve exact original event/sequence, durable delivery
and checkpoint outcomes, unknown occupancy and protected inspection; no successor
may infer complete old-owner settlement merely from close resolving. An installed
owner must explicitly track/join admitted tasks without callback-self deadlocks,
retain failures for exact recovery, and separately prove physical retirement.
This is a concrete source integration gap, not evidence a live callback escaped.

### Native Discord command presentation commits independently of command SQL

`chat-sdk-runtime.ts:738–772` reserves a same-process interaction ID and performs
private deferReply BEFORE database/service work. A failed defer is conservatively
not replayed. `831–872` awaits the actual slash handler, which may already commit,
then performs separate editReply. Its failure is deliberately unknown with no
callback replay. Same-process attempted-map dedupe is not retained across restart;
service durable receipt dedupe remains independently required. Keep the initial
acknowledgement, command mutation and final private reply as three effect identities
with original interaction/command/destination/predecessor bindings. Never store
interaction tokens or raw provider interaction objects in the journal, and never
retry the command because its final private presentation was lost.

Webhook ingress at `chat-sdk-runtime.ts:2408–2480` uses Promise.race against an
absolute response deadline. Returning503 does not cancel initialization, SDK
waitUntil work or callbacks already running. The preserved durable event-ledger
identity must reconcile later completion and provider redelivery; a timeout is not
an absent-effect proof or permission to create a replacement admission identity.

### Slack consumed OAuth state can outlive a failed secret projection

`connectors/slack/setup/service.ts:90–134` deletes/claims toolOauthStates before
actual oauth.v2.access. Provider token issuance then precedes identity/scope checks,
manager-grant rechecks and saveSecrets. Any validation or SQL/lease failure follows
possible provider acceptance; catch records a generic installation failure under
the prior status, while the OAuth state is already consumed. Do not interpret that
projection as unattempted issuance. Preserve original state/request/app/workspace/
actor/session binding, exact exchange intent and safe token metadata/uncertainty;
no token bytes or authorization code in inspection history. A fresh installation
is a new effect requiring independent policy, not replay recovery of the old one.
No explicit provider-token revocation was established on this path.

`chat-slack-registration-cleanup.ts:8–21` separately deletes manager OAuth states,
marks removed, deletes install OAuth states, removes each vaulted secret, then
clears secretIds. A mid-loop exception leaves partial cleanup and retained IDs;
these are inspectable original identities, not proof that every secret remains or
that the provider app was deleted. Cleanup removes local registration authority;
it does not call provider app deletion/token revocation. `registration.ts:134`
close only joins the avatar pool. Do not treat registration-service close as
provider teardown or settlement of OAuth/configuration effects.

### Dedicated pools survive a caller facade cut

`packages/db/src/client.ts:257–289` retains a private factory per Db which creates
an additional physical one-connection pool with the SAME URL/credentials and
workspace-finalization application_name. The helper ends that dedicated client
in finally; app-name isolation is observability, not role isolation. Complete
legacy-session exclusion must cover factory creation, active dedicated clients,
utility clients, pooler/prepared state and their end outcomes, alongside the main
pool. `plugin-database.ts:557–569` still runs validated plugin SQL directly on its
supplied Db; there is no per-plugin role/session switch in that path. Source-level
function/trigger definitions and a validator do not authenticate actual role,
search_path/function EXECUTE/object ownership or surviving-session exclusion.

Strict physical-COMMIT validity remains unresolved; monotonic fenced-fact semantics
remain **UNACCEPTED**. No partial native transaction-owner port installed. Exact
intents/predecessors, independently committed outcomes, inspection/uncertainty,
ordered deny/stale refusal/accepted retirement remain. Original protected stop/
inspection remains available while new work is held. All original shared-family
holds, paused B, timers/current capacity, draftPR5/human merges and deferred Gemini/
backup/S3/monitoring gates persist, including backup release prerequisite and
reviewed rollout AND complete genuine shared-hold reconciliation before B stages.

Cross-track source confirmation: `ai-connections.ts:1023–1115` refreshQuotaCredential
locks current grant/secret, checks active runs, prepares encrypted storage, then
POSTs a single-use refresh token under its own60s deadline. Successful replacement
parsing precedes recovery.write and later secret rotation/SQL commit. Preserving
exchange lifetime beyond the dashboard timeout and retrying only save work after
savingReplacement are useful existing rules. But `quota-credential-recovery.ts:35–39`
prepare writes/deletes a generic storage probe, not the exact prospective exchange
identity. Lost HTTP reply, JSON failure or encrypted journal failure after token
consumption can leave no replacement record; absent recovery file does not prove
unattempted exchange. A native owner needs exact safe grant/secret/base-digest and
exchange intent BEFORE HTTP, retained unknown outcome across restart, protected
inspection and no automatic repeat of the consumed input. Token bytes belong only
in the encrypted result, never inspection metadata. Local probe/fsync cannot
supply a provider consume primitive or strict physical-COMMIT expiry. Storage
agent owns the detailed physical root/alias/capture inventory; no native patch or
provider interaction occurred.
