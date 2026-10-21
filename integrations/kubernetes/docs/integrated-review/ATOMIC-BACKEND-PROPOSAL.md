# Atomic storage and byte-effect backend: exact remaining decision

2026-10-20, source-only review. This document adds no backend, receipt, key,
listener, installation or operational acceptance. It deliberately adds no SQLite
canonical-byte substitute: committing bytes in a database cannot atomically
commit provider stdin, revoke a stale mount, or fence an old open file descriptor.
The existing `AtomicWriteBackend` and `RootGroupBackend` remain unimplemented.
The unchanged verification is reusable within its recorded scope; no new test
could establish the missing physical mechanism by substituting a fixture.

## Proposed implementation to commission

Develop the **sole protected canonical owner with detached attempt copies**,
subject to an explicit topology decision and proof of old-writer exclusion. Keep
the backend-fence alternative blocked until an exact supported Longhorn operation
and stale-I/O semantics are identified. The [existing storage review](STORAGE-PROOF-BOUNDARY.md)
establishes no such operation; this continuation makes no new backend claim.
This is a concrete proposal, not selection or installation authority.

Use one separately operated canonical service identity, with no provider access
to canonical volumes or service credentials. Canonical roots become immutable,
content-addressed group versions behind a single authoritative group-head record.
Only that service may prepare a version or switch the head. Provider attempts
receive detached copies on a different physical realization, never bind mounts,
hard links, canonical file handles, storage API credentials, or a writable alias
into canonical state. An attempt cannot modify canonical bytes even if it keeps
its attempt files open indefinitely. This property follows only after actual
mount/identity isolation and the old-writer transition are proved; detached-copy
code alone does not establish it.

Retain all original logical families and both A holds. A new canonical physical
incarnation needs an immutable old/new mapping, not a new account/session family.
The controller's copy-back/cache routes and credential refresh writers must lose
direct canonical write access too. External laptop/phone credential relationships
remain an independent unresolved exclusion dependency. Non-root ownership must
be explicit; UID 2000 gets no implicit right to rewrite UID 1000 roots.

### Canonical transaction and actual linearization point

1. An independently operated current-history service locks the original family,
   checks the complete registered overlapping root/alias membership and exact
   predecessor vector, and durably records a unique immutable prospective intent.
   Its durable transaction consumes the operation ID and advances the high water
   before any canonical switch. Proposed domain: a separately administered
   database/role in existing external PostgreSQL, outside Paperclip/canonical
   restore permissions. Database separation alone is insufficient; an operator
   must establish independent identity, restore ownership and rollback exclusion.
2. The canonical owner resolves complete physical incarnations and validates
   current runtime B and physical exclusion for every old writer. B is completed
   retirement, not deny intent T. It reads returned attempt state only after this
   boundary. Workspace, transcript and credential outcomes remain separate;
   newer credential generations cannot be replaced by stale return data.
3. Build and durably flush the entire immutable proposed group without changing
   any active path. Enumerate all parent/child aliases from the protected registry,
   including default/staged/cache roots. Reject missing, extra or divergent
   members; caller-supplied equal key sets are insufficient. Every consumer must
   resolve one group version once, rather than resolving different child roots
   before and after the switch. Cross-PVC content may be prepared independently,
   but activation is one head transition and all consumers must obey it.
4. Under the same protected owner, CAS the single full-group head from exact old
   vector to exact pinned intent/new vector and durably commit it. This is the
   proposed canonical activation linearization point. A collection of filesystem
   renames is not the transaction. Old versions remain immutable and cannot
   accept writes through stale descriptors; canonical readers cannot retain a
   writable descriptor across activation. An implementation that cannot enforce
   these properties must refuse activation.
5. Record exact completion in current history without deleting the prospective
   intent. Native release independently verifies current B, per-result restore
   evidence, exact physical incarnation, current group vector and history in its
   own ordered transaction. Neither head activation nor completion is a later
   effect permit.

Crash after prospective pin but before switch: intent-only occupancy persists.
Crash after switch before history completion: compare exact immutable intent and
physical group head under the protected owner; do not switch again. External
history ahead of restored canonical/native data, mismatched member, incomplete
switch, missing history or unknown service incarnation remains held. No recovery
path lowers high water, replays a provider body or creates a fresh writer.

## Exact-write/cancel/revoke is a separate effect mechanism

A storage head transaction cannot implement the existing stdin contract. For
`commit_write`, the irreversible effect is acceptance of exact bytes into the
owned runtime stream, including its queue. Native cancellation, runtime revoke,
storage revoke and decision revoke must share an unavoidable ordered admission
boundary with that acceptance. Reading four revisions and then writing a pipe
has a check/effect race even if the reads use serializable database transactions.
A pipe write is not rolled back by aborting a database transaction. Partial writes,
worker death and lost replies remain original-operation uncertainty.

Proposed runtime integration: the mandatory runtime owner also owns the input
queue; no controller/gateway/backend writes the provider descriptor directly.
A unique complete write intent is durably retained before submission. The runtime
owner orders exact bytes and deny commands in one durable sequence and rechecks
the original owner/current full revisions at dequeue before irreversible stream
acceptance. A revoke advances the same sequence and makes every not-yet-accepted
queued operation non-executable. Earlier accepted/uncertain effects stay charged
until completed B and independent storage exclusion. `revoke` return proves only
deny intent, never physical settlement. Queue durability does not prove that an
already submitted pipe write stopped.

This still requires a concrete protocol joining native/decision/storage changes
to that sequence. Proposal: all such mutations first retain a prospective deny in
current authority history, then synchronously commit deny in the runtime owner;
no native release or successor activation until exact deny is inspected/settled.
A native mutation that can become effective independently before this ordering
breaks the contract. The protocol must specify the cancellation linearization
point and every failure state before implementation; caller locks, signed proofs,
callbacks or receipts cannot replace it. Runtime topology and independent native
transaction integration remain prerequisites owned by the other workstreams.

The common deny linearization point is still unresolved. History deny intent T alone cannot mean “no effects ordered after deny”: a runtime dequeue may race the interval before runtime deny commitment unless it atomically serializes against that same history transaction. Keep T pending and every such byte effect occupied. The runtime/storage deny acknowledgment described here is not `OrderedDecisionUse.revoke`'s `revoked-settled` completion; only complete original-effect settlement can produce that result. Reject implementation until one precise linearization point and crash/partition state machine are specified.

## Complete transport closure obligations

Read-only source review of the intentionally dirty native checkout found these
existing routes in `packages/adapter-utils/src/ssh.ts`; no overlay was reset or
applied. Root owns any shared interface/native edits.

| Surface | Current bypass or missing mechanism | Exact closure requirement |
| --- | --- | --- |
| `buildSshSpawnTarget` | `spawnProtected` is optional; absent callback falls through to SSH authentication and supervisor setup | Protected execution policy must refuse before auth/profile/cwd preparation when mandatory owned transport is unavailable. |
| `buildSshStreamTarget` | No journal falls through to direct SSH shell transport | Transfers, Git bundle/tar, setup and recovery use mandatory operation ownership; unsupported paths refuse before archive/executable preparation. |
| `runSshCommand`, managed-service start, probes | Journaling authorizes intent but does not make runtime effects unavoidable | Full command payload and all setup/probe/start/verification/cleanup bodies bind to the same owned runtime route. |
| `stopSshAdmissionCommand` | Explicitly clears journal context and constructs the SSH stop target | Stop/old-epoch recovery needs an exact original-owner runtime control operation, not a new shell route or execution exemption. |
| stream service | Existing protocol implements bounded stdin control; no full command transport | Protected executable and framing must carry stdout, stderr, stdin, ordered exit and signal semantics; bounded backpressure/cancel cannot silently replay bodies. |

Stream frame requirements: bind every frame to original command, invocation and
stream incarnation; separate stdout/stderr channels; monotonic per-channel
sequence; explicit EOF; one terminal exit-or-signal record; bounded frame/queue
sizes; total deadline; exact duplicate/conflict policy; no reconnect replay or
stdin reassignment. Signal requests are runtime effects and require current
ordering. Existing-stream attachment must never launch or replace a process.
Output/exit observation grants no later write, launch, restore or release.

## Proof obligations and exact blockers

| Gate | Required disposable evidence after mechanism exists | Current blocker/status |
| --- | --- | --- |
| Physical stale-writer exclusion | Keep old canonical descriptors/mounts on all declared aliases; partition/restart/recovery attempts cannot modify new canonical state after exact barrier; attempt holders cannot address canonical storage | **Blocked:** sole-owner topology, legacy old-writer transition and actual mandatory runtime mechanism unselected/uninstalled. No supported Longhorn fencing API established. |
| Common byte/cancel/revoke effect | Concurrent cancel/revoke/dequeue/write with queued bytes, short writes, crash at every boundary, lost response and durable original-intent inspection; no effects ordered after deny | **Blocked:** common runtime queue/effect authority and native/decision/storage mutation ordering absent. |
| Whole root group CAS | Omitted child/alias, changed registered membership, concurrent credential refresh, cross-volume preparation, crash before/after head commit; never partial active vector | **Blocked:** actual canonical owner/head protocol and complete protected inventory absent. |
| Independent high water | Restore old Paperclip and canonical data while independent history stays newer; successor/adoption/write refuses; lost completion remains inspect-only | **Blocked:** actual independent operator, identity and rollback domain absent. Backup/recovery preparation belongs to Claude; no files in that workstream were edited. |
| All-command transport | Exact native call-site/route inventory and negative bypass tests for setup/probe/tar/Git/service/stop/recovery; output/exit/signal/backpressure tests against actual owned runtime | **Open source integration / blocked runtime:** optional SSH routes and full transport mechanism remain absent. |
| Operational acceptance | Reviewed installed identity/topology, exact held policy and complete original shared-family evidence; real authority mechanisms independently accepted | **Blocked:** no installation/activation authorized. Component passes cannot close it. |

No new Python interfaces or synthetic receipts were added. No new test execution,
provider dispatch, image publication, live inventory/mutation, topology installation,
migration, capacity increase, merge or hold release occurred in this workstream.
PR #5 remains draft; B paused, Gemini deferred and timers off.
