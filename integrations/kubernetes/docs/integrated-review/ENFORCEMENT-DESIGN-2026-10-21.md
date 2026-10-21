# Integrated enforcement design for review

Proposed design, not approved topology or installed enforcement. Baseline7d138a4
plus the preserved uncommitted daily-use preparation. Historical native functional
source remains d489129. No live state or remote source was inspected. All original
A/shared-family holds, paused B, current capacity, disabled timers, deferred Gemini,
draft PR5 and human-reviewed merges remain. Backup/S3/monitoring stays postponed.

## Proposed implementation choice

Develop three cooperating modules with sole effect ownership. The controller
submits exact intents and observes outcomes; it cannot obtain a permit and later
perform an effect itself. Proposed placement changes require human topology review.

| Module | Proposed implementation | What rejects the design |
| --- | --- | --- |
| Runtime execution | Exact-build hooks in the actual runtime/shim start, exec, input and recovery paths; one owner for exact original execution identity | Missing immutable target source provenance, alternate handler/daemon/shim bypass, direct writable stdin, stale recovery before current history, or inability to permanently exclude old incarnations |
| Canonical group owner | Separate non-root sole canonical mount/write identity; detached provider attempt copies; immutable complete group versions and one authoritative head | Any provider/controller/cache/legacy writer retains canonical descriptors/mounts/credentials; a consumer resolves roots across different group versions; full group membership or independent high-water absent |
| Execution history/native writer | One protected transactional owner of native execution changes, exact intents, revocations and commit-time generation | Controller/provider equivalent SQL access, separate history check then native commit, restore reviving old sessions/generation, unknown outcome treated as permission to replay |

These choices are engineering candidates. Existing non-root workload rules remain;
no host socket/privilege exception or second PostgreSQL cluster is approved. Runtime
hooks require a separately reviewed host implementation. Reusing existing external
PostgreSQL is conditional on independent authority administration/restore permissions.

## One ordering contract

1. Original scope closure, native identity, full group/alias inventory and immutable
   request hash identify an operation. History retains uncertainty before submission.
   Reusing an ID inspects its exact retained outcome; it never replays a body.
2. A requested cancellation/revocation first records prospective deny. That record
   closes new dispatch at the authority but is **not runtime T**: an already admitted
   runtime input write could still occur. The caller must report pending deny and
   keep original occupancy until the effect owner resolves it.
3. **Runtime T** is the mandatory owner ordering deny against irreversible stream
   acceptance in the same owner execution sequence. All direct stream descriptors
   must be inaccessible to other identities. The owner must finish/attribute any
   already submitted write before acknowledging that order; partial or unknown pipe
   outcomes remain uncertain. A database rollback cannot retract pipe bytes.
4. Native admission/lifecycle commits order deny using their own common transactional
   fence and exact intent journal. A runtime T does not magically serialize a separate
   native transaction. Acknowledged composite deny requires exact inspection at both
   effect owners, no remaining submission channel, and durable ownership of every
   in-flight operation. If either is unavailable, composite deny stays pending.
5. **B** follows only when all pre-T effects/descendants/incarnations are accounted
   for and permanently excluded. Current history and the physical storage owner
   independently establish stale-I/O exclusion. Neither T, worker death, transport
   EOF, API deletion nor a quiet counter can substitute for B.
6. Returned attempt state is read only after required retirement. Workspace/session/
   credential outcomes remain distinct; newer credential refresh must survive. The
   canonical owner prepares all roots before one full-group head transition against
   exact predecessor and independent prospective high-water. No partial root release.
7. Native release is a new authority-owned effect, with current complete closure and
   generation checks. An earlier observation, successful frame decode, head switch or
   completion record never grants that effect.

A universal timestamp linearization across runtime pipe effects, storage activation
and PostgreSQL commits is not implemented by this contract. Every externally visible
result must name whether it is prospective, owner-denied, uncertain or fully settled.
Any design claiming a single atomic cross-domain revoke must provide the actual
common effect mechanism; callbacks and matching sequence fields do not provide one.

## Integration edits after implementation feasibility

Root owns these future shared-file changes; they are not made in this increment:

- `packages/adapter-utils/src/ssh.ts`: replace optional protected transport with a
  mandatory owned module before authentication/profile/cwd preparation; cover command,
  setup, probe, service, transfer, Git/tar, stdin, epoch, stop and recovery. Old-owner
  stop/inspection uses retained control authority without a new execution grant.
- `server/src/services/execution-capacity-lifetime.ts`: refuse absent installation;
  bind every restore/flush/auth path and original operation to the owned route.
- `protected-execution-transport.ts`, `protected-stdin-authority-client.ts`: carry
  exact command/stream identities and byte/terminal framing, bounded backpressure,
  cancellation and disconnect uncertainty. No implicit reconnect or command replay.
- `execution-admission.ts`, `execution-legacy-reconciliation.ts`,
  `agent-execution-stop.ts`: replace local history applicability with the sole typed
  native transaction implementation; preserve complete inventory, original scopes,
  cleanup receipts/manual holds and scheduler recovery semantics.
- Native schema/roles/migrations, protected policy/trust and image reconstruction:
  require a separate exact shared-source ownership assignment before edits; preserve
  the existing dirty overlay rather than resetting/reapplying it.

## Failure tests before rollout

| Failure cut | Required result |
| --- | --- |
| Lost response after intent/byte acceptance/native commit/head switch | Inspect original exact intent and actual effect journal/head; no replay, successor writer or release |
| Concurrent deny and runtime bytes/native commit | Actual effect owner decides order; accepted pre-deny uncertainty remains charged; no late post-owner-deny acceptance |
| Authority/runtime restart or stale former connection | Recover retained current history before exposure; stale generation cannot execute or commit |
| Native/canonical rollback, missing witness or unknown old node | Remain held; matching restored snapshots cannot establish independent currency |
| Held writable attempt descriptor during canonical activation | Only detached attempt data changes; no alias/hardlink/mount path reaches canonical state |
| Missing root/alias or stale credential return | Entire group remains inactive; no per-root success/release |
| Command output split, oversized frame, signal/EOF conflict or disconnect | Exact bytes and identity preserved; bounded fail-closed state; never infer runtime retirement |

Local framing and filesystem tests below verify only their concrete mechanics. They
cannot prove host hook coverage, mount isolation, independent custody or native SQL
role exclusion. SQL proposal execution is NOT RUN. Full graphs/builds and resource-
heavy fixtures remain unscheduled; changed integration needs authorized hosted checks.

## Review and activation sequence

Read [runtime design](RUNTIME-IMPLEMENTATION-DESIGN-2026-10-21.md),
[storage design](STORAGE-IMPLEMENTATION-DESIGN-2026-10-21.md) and
[native history design](HISTORY-NATIVE-TRANSACTION-DESIGN-2026-10-21.md) together.
First review their unresolved feasibility inputs and proposed authority identities.
Then implement the actual adapters, assign exact shared-source edits, and verify all
bypass/failure paths with disposable resources. Produce immutable image/policy/RBAC/
network/workload/manual-migration review artifacts only after those adapters exist.
No apply-ready activation is claimed here.

After separately authorized publication/rollout and complete real original shared-
hold reconciliation, run serial real Codex tasks on B, then Claude using the prepared
acceptance manifest. Provider success, session continuity, credential renewal,
workspace durability and disconnect/restart acceptance remain NOT RUN. Overlap waits
for measured headroom and credential safety. Postponed recovery is unresolved and
requires completion or explicit operator release-scope/risk decision, not an implied waiver.
