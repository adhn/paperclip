# Enforcement composition and implementation gates — 2026-10-21

Inactive source work; daily use remains unaccepted. Latest baseline was the
retained enforcement-fixtures checkpoint, review HEAD7d138a4, preserved native
checkout252d9b5 with75 recorded file hashes and five intentional deletions.
Root recorded exact ownership before edits in the canonical workspace's
`.handoff-state/2026-10-21/enforcement-composition/OWNERSHIP.md`. Three agents,
no children; root owns integration, Git/index and serialized process fixtures.

Track reports: [runtime retained provenance](RUNTIME-PROVENANCE-CONTINUATION-2026-10-21.md),
[descriptor-safe storage](DESCRIPTOR-SAFE-STORAGE-2026-10-21.md),
[native PostgreSQL](NATIVE-POSTGRES-FIXTURE-2026-10-21.md).

## Concrete composition

The provider gets an independent attempt tree and a deliberately minimal descriptor
set. A dedicated canonical-owner process receives canonical directory authority;
provider children must close every other descriptor before executing provider code,
including descriptors marked inheritable or duplicated into unexpected slots.
Path permissions cannot compensate for a leaked canonical descriptor. Independent
copied inodes protect published bytes from retained attempt descriptors, while
one full-group head selects workspace, session and credential versions together
in the proposed production composition. The fixture uses synthetic workspace,
session and config bytes and separate bounded owner children per operation;
it implements no persistent owner service or real credential handling.
The new isolated storage fixture tests this composition; it does not retire any
legacy homelab mount, process, credential or canonical open file description.

Native effects belong to one protected transaction owner. Arbitrary controller
transactions must not receive an executor connection: PostgreSQL callers control
SET CONSTRAINTS and transaction duration. A deferred constraint check is useful
for normal caller delay, but is not an unconditional physical-COMMIT freshness
primitive. Even an exclusive gateway cannot guarantee wall-clock expiry at WAL
commit merely by checking immediately before it. Strict expiry requires a reviewed
commit-level primitive, or an explicit semantic change to monotonic facts whose
revocation is ordered under the same transaction fence. Neither choice is silently
accepted here. A timeout or a trigger is not a replacement for external current-fact
fencing. Prepared transactions must be disabled/refused in the disposable domain;
production two-phase policy requires independent review.

The exact runtime hook remains conditional on authenticated snap8702 source/build
mapping. Version strings and matching binary hashes identify observations, not
source compatibility. No upstream patch may be installed on that inference.
Runtime input acceptance and deny must share the actual unavoidable runtime queue;
native COMMIT and canonical head replacement do not retract previously accepted
pipe bytes. Prospective deny, native deny N, runtime deny T and completed B stay
separate, with occupancy held through partial/unknown outcomes.

## Actual native/all-command integration inventory

These are read-only findings against the preserved dirty source, not claims that
the paths were changed. Replacing them with a callback validator would leave the
same ownership gaps. No schema-incompatible fixture SQL is installed as a migration.

| Source seam | Current behavior requiring replacement | Required actual mechanism |
| --- | --- | --- |
| `packages/adapter-utils/src/ssh.ts:runSshCommand` | No journal selects `runUnjournalledSshCommand`; that prepares keys and executes profiles | Mandatory installed route owner before auth, profile, cwd or executable preparation; absent owner refuses |
| `ssh.ts:buildSshSpawnTarget` | `spawnProtected` is optional; missing method falls through to legacy key/supervisor setup | Sole owned spawn/control protocol with exact immutable payload and no equivalent direct route |
| `ssh.ts:buildSshStreamTarget`, `streamLocalFileToSsh`, `streamSshToLocalFile` | Git bundle/tar transfers own subprocesses and streams | Same unavoidable owner for exact bytes, output framing, cancellation and uncertain partial transfers |
| `ssh.ts:updateSshAdmissionEpoch`, `stopSshAdmissionCommand` | Separate protocol-only unjournalled control route | Protected retained old-owner stop/inspect, current recovery gate and permanent old-route exclusion; stop must not require a new execution grant |
| `ssh.ts:createSshCommandManagedRuntimeRunner` | Managed service spawning/cleanup uses captured journal when available | Owned service lifetime and retained stop/inspection through disconnect/restart |
| `execution-capacity-lifetime.ts:withCapacityOperation/withCapacityRun` | Current installation scopes commands and state work | Require actual route/storage/native authorities for setup/probe/restore/flush/auth and retain all uncertainty before submission |
| `execution-admission.ts:claimNext` | Scheduler lock, backup freshness/exemption, fairness, policy resolution, historical holds, capacity, requested-run isolation and native callback | Preserve every predicate and scheduler→native lock order in the sole native transaction; exact journal and generation in the same effect transaction |
| `execution-legacy-reconciliation.ts:legacyHoldIsReconciled` | Checks accepted decision against its historical `createdAt` | Current authority-owned exact use-side transaction and complete original hold closure; preserve monotonic accepted retirement until explicit revoke/epoch/binding change, refuse stale generation, and never treat an accepted record as a standalone later-effect permit |
| `execution-legacy-reconciliation.ts:append` | Local evidence verifier and local accepted-decision append, post-commit lifecycle notification | Independent custody/current inventory, exact predecessor/intent, common writer fence, shortest validity boundary and lost-notification sweep |
| `agent-execution-stop.ts:agentExecutionsHaveStopped` | Local reconciled lease set participates in lifecycle release | Exact original native authority transaction plus genuine runtime/storage settlement, preserving receipts and manual holds |

The native claim callback additionally preserves agent/issue/checkout eligibility,
terminal discard behavior and budget/control-plane invariants. No generic synthetic
claim table can replace these predicates. Inventory must retain original persisted
five-scope hold arrays and include unsupported/run-only/null/unmapped and disappeared
source rows; seven reservation scopes cannot substitute. Unknown sources stay occupied.

## Reviewable rollout path

1. Supply authenticated immutable runtime build/source/patch/toolchain chain and
   map every effective handler/daemon/socket/start/exec/input/recovery path. Review
   permanent old-incarnation exclusion; kata/NVIDIA/second-daemon coverage cannot
   be inferred from runc-v2 coverage.
2. Review sole canonical owner placement, descriptor launch boundary, aliases,
   complete root group, coherent capture, account refresh and actual legacy writer
   retirement. Independent history/high-water and physical old mount/descriptor
   exclusion remain prerequisites, even after a successful detached-copy fixture.
3. Select and implement native strict commit-validity semantics and exclusive
   transactional owner in the existing external PostgreSQL architecture. Preserve
   fairness, provider cooldown, lifecycle, budget, queue, lease and callback rules.
   Exclude all old/equivalent direct DML, maintenance and migration writers;
   independently fence stale authenticated sessions/endpoints and restored clones.
4. Assign exact shared native files before editing, integrate every row above with
   real owners, and run changed focused tests. Full graphs/builds require separately
   authorized hosted capacity; previous hosted native/image checks only cover their
   unchanged hashes. Complete actual crash/reply-loss/recovery failure rehearsals.
5. Produce immutable image, policy/trust-root, namespaced RBAC/network/workload,
   complete storage ownership and explicit manual-migration/held startup diff.
   A rollback must retain intent/high-water and exclude stale owners; reapplying an
   older writable image/database/head is not a safe rollback. Human review precedes
   separately authorized publication, migration and rollout. No executable complete
   activation diff exists while these mechanisms are absent.
6. After reviewed rollout, collect full real shared-hold inventory/evidence and
   exact human approval; use supported immutable intents and uncertain inspection.
   Reconcile all original shared families, preserving original receipts/manual holds.
7. Only then run ten bounded serial Codex tasks on existing B, then ten Claude
   tasks, <=10min/task and <=2h/stage: coding/tests, uncommitted files/unpushed commits,
   session/renewal, descendant cancellation, disconnect and controller/runner restart.
   No ambiguous retries, paid fallback or increased concurrency.

All original A/shared-family holds, B paused per saved evidence, disabled timers,
current capacity, draft PR5, human-reviewed merges and Gemini deferral remain.
Backup/S3/monitoring stay deferred and unresolved for release. No live inspection,
provider calls, credentials, purchase, publication, deployment, live migration,
destructive operation or merge is authorized/performed by this increment.

## Verification

Root serialized actual PostgreSQL18 then corrected storage. All18 PostgreSQL
methods PASS40.748s, including normal delayed-COMMIT rollback and the expected
early-constraint-flush bypass. A separate fresh max_prepared_transactions=1
instance refused the effect with zero claims/journal. Both PostgreSQL containers
were UID999, network-none, read-only, tmpfs-only, no ports, OOMfalse and removed.

Actual storage PASS exit0: UID1000 provider exec could not write inherited FD200
(EBADF), reopen parent FD200 through proc, or access canonical paths; all synthetic
canonical group bytes remained unchanged after attempt mutation. Initial run failed
while creating attempt files after changing directory ownership; setup ordering
was corrected, without capability expansion. Original failure remains storage.log;
final execution remains storage-final.log. Exact fixture container auto-removed.

Final15 lightweight tests PASS (six descriptor guards, nine retained-inventory).
Runtime provenance remained unresolved after extended retained/archive/cache
search. Native75 hashes/dirty status and production six stay unchanged. Only the
three explicitly owned previous SQL/test/report files changed among prior increments.
Unchanged hosted native/image checks are reused for their exact unchanged scope;
no full build/typecheck graph or hosted run occurred. Independent runtime/native/
storage read-only reviews found no blocking scope claim after accepted-fact and
synthetic-owner wording corrections. See canonical checkpoint/logs for exact hashes
and runs. Strict commit freshness and actual mandatory native/all-command integration
remain incomplete; no source-fixture result establishes operational acceptance.
