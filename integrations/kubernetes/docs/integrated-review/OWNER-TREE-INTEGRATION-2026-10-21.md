# Owner/tree continuation integration review — 2026-10-21

Inactive source work; operational acceptance remains false. Baseline is the latest
completed sole-owner-continuation handoff, selected after local handoff search.
Root plus exactly three subagents, no children. Exact pre-edit ownership, all-file
hashes, reviews and fixture records are in canonical
`.handoff-state/2026-10-21/owner-tree-continuation/`. No reset/reapply or Git/index
mutation. Native source remains intentionally dirty and preserved.

Read the [native primitive review](NATIVE-COMMIT-OWNER-2026-10-21.md),
[canonical tree/placement report](CANONICAL-OWNER-2026-10-21.md) and
[runtime provenance requirements](RUNTIME-PROVENANCE-REQUIREMENTS-2026-10-21.md).

## Implemented effects and limits

Root strengthened `production/owned_effect_dispatch.py`: initial owner-state parent
metadata must fsync before writer custody transfers; each durable prospective intent
must be followed by parent fsync before actual atomic pipe bytes. A failed fsync
leaves the pending intent/global uncertainty hold and prevents that write. Deny
returns only after the durable deny and parent sync; failure poisons the live owner.
Private parent ownership/mode and regular/private/single-link lock validation now
refuse unsafe local setup. Four new tests cover initial custody failure, pre-write
sync failure/restart, deny sync failure/restart and a nonprivate parent.
These checks do not establish exclusion of aliased ancestors, duplicate descriptors,
legacy writers or administratively restored databases. Trusted installation must
provide those separately. The pipe still is local enqueue, neither runtime T nor B.
Queued pre-deny bytes remain occupied until the actual consumer settles them.

Storage implementation and final verification are recorded below after freeze.
Native added five logical-phase tests and an explicit primitive review checklist;
strict physical-COMMIT validity is still blocked. WAL insertion, durable flush and
visibility are distinct candidate boundaries: a review must name which irreversible
boundary the primitive protects. No synthetic schedule proves an actual engine.
Monotonic fenced-fact semantics remain an explicit unaccepted requirement proposal.
Existing accepted-retirement/native predicates were not changed.
Runtime retained-only review still lacks authenticated snap8702 package/build/source
mapping. Exact missing package assertions, attested recipes/patches/toolchains/output
mapping and all-handler coverage are in the runtime report. No inferred compatibility
or speculative hooks were added; unchanged inventory code/tests retain prior scope.

## Actual integration and concrete rollout units

Current native queue still exposes `claimTransaction(run, tx => claimDatabase(...))`
and falls back to `claimDatabase(db)` at native `queue.ts:1589–1597`. Preparation is
optional at its earlier queue branches. A complete sole transaction owner must port
the report's scheduler→issue→wake→run locks and every provider/lifecycle/reconciliation
predicate together, then remove equivalent DML/functions/role memberships and old
connections for controller/provider/maintenance/recovery writers. It cannot be
replaced with a permission callback or this pipe journal.

The next concrete source assignment depends on the reviewed strict semantic decision:
actual native queue, admission/lifecycle/legacy reconciliation, policy resolver and
stop/finalization modules plus schema-compatible owner migration. Preserve original
five-scope historical holds separately from seven reservation scopes; exact source,
fingerprint, immutable intent/sequence/predecessor, deny order and uncertain inspection
remain mandatory. No expiry observation may invalidate existing accepted retirement.

All-command integration must replace optional SSH/protected-spawn/unjournalled routes
before authentication or preparation, including setup/probe/managed service, command,
Git/tar/files/stdin, epoch and recovery. Stop/inspection for retained old owners needs
its own protected control authority; a held new-work pipe cannot be its only path.
Actual runtime irreversibility and old incarnation recovery remain blocked on exact
build provenance and physical implementation. Do not substitute local route-label
tests for these call sites.

Physical storage review must name exclusive canonical mounts/identities, detached
attempt paths and the externally enforced snapshot/freeze provider; enumerate every
old mount, writable handle, credential refresh writer, restored clone and laptop
relationship. Close inherited descriptors before provider exec using a separately
reviewed non-root deployment boundary. The root-only disposable launcher fixture
cannot be imported as a production privilege exception. Detached trees and local
flock do not retire original writers or establish independent current high-water.

After those mechanisms exist, review an exact immutable image/build attestation,
protected policy/trust/custody, namespaced RBAC/network/workload/storage changes and
held-startup/manual migration against the existing external PostgreSQL service.
Include independently current opening/history and rollback refusal; no second
permanent database. This executable activation diff remains incomplete rather than
being replaced with placeholders. Changed full build/typecheck graphs require
separately authorized hosted capacity. Publication/deployment/migration/merge are
not authorized by this work.

Complete real original shared-hold reconciliation follows separately authorized fresh
full inventory and genuine permanent retirement/storage/session/credential artifacts,
independent custody/history and exact human consent. Unknown/run-only/null/unmapped/
disappeared source holds stay occupied. Then ten bounded serial Codex tasks on existing
B, followed by Claude coding/session/renewal/cancellation/disconnect/restart acceptance;
<=10min/task and <=2h/stage. No ambiguous replay, replacement identities, B exemption,
paid fallback or capacity increase. Synthetic success is never operational acceptance.

All A/original shared families, paused B, disabled timers/current capacity/draft PR5,
human-reviewed merges and Gemini deferral remain. Backup/S3/monitoring are deferred;
the unresolved backup release prerequisite has not been waived. No live inspection or
mutation, provider, credentials, purchase, publication, deployment, live migration,
destructive operation or merge occurred.

## Final storage scope and verification

Storage now implements real bounded directories and single-file roots, binary
contents, executable intent, standalone `.git` directory contents and a conservative
confined symlink subset. It validates/materializes both exact tree envelopes and
physical canonical trees before the existing one-HEAD selection; format is part of
the immutable intent. Whole-group CAS, global unresolved-intent hold, persistent
deny and exact recovery inspection are preserved. Detached export rechecks current
generation, deny and uncertainty, and rejects canonical descendants using descriptor
ancestors. Export is preparation only, not a journaled invocation or permission for
later provider use. Real snapshot/coherence and launch/deny integration remain absent.

The explicit trusted snapshot context spans all three roots; no implementation of
that authority is supplied. The component refuses hardlinks, xattrs/ACLs, special
inodes, Git indirection, unsafe symlinks and different-device mounts. Same-device
bind aliases, external Git configuration references and complete application/credential
root resolution remain installer/integration obligations. Mode normalization to
0600/0700 is explicit; this is not lossless POSIX transfer. Limits are 4096 entries,
32 levels and 1MiB encoded group. Scandir now stops before sorting an oversized
entry set; a lazy million-entry regression consumes only the remaining budget+1.
These limits intentionally refuse many real large projects; complete real root
handling is still unfinished. See the canonical report for exact physical placement
and legacy-writer exclusion requirements.

Final root-contained **62 tests PASS in0.369s**:20 canonical-owner,12 tree,14 actual
pipe/journal and16 native logical-model cases. Actual subprocess crash/restart,
CAS/deny/inspection, file/tree writes and pipe bytes are exercised; logical native
phases remain model-only. Root serialized three tiny cached exact-image runs; earlier
61-case passes are retained under first-run/second-run and superseded for changed
inputs. Final hashes/command/full log/inspect/cleanup are in the state directory.
Final image sha256:1eee6fcc4d866c86dd8e32a4a1a583767ddac0d640b0fe571b2c22d233b60eee,
UID1000, network-none, read-only root,64MiB disposable tmpfs,256MiB RAM/512MiB
swap-inclusive/1CPU/64PIDs/capabilities dropped, no host mounts/ports, OOMfalse.
Each exact fixture container was removed. No pull/build/full graph/typecheck/hosted
action or new PostgreSQL/kernel descriptor fixture. Prior SQL/descriptor/hosted
results apply only to unchanged exact inputs.

Independent native/runtime reviews confirmed scoped pipe durability. Native/root
storage review found and corrected the original symlink '..' escape, directory
mode normalization mismatch, export canonical-descendant access, root-first ordering,
noncanonical symlink paths and bounded directory enumeration before final verification.
All10117 pre-existing native files, HEAD and dirty status remain unchanged. Of430
pre-existing homelab files, only the nine assigned existing source/test/report files
changed; all other421 preserved, HEAD unchanged. Three new owned package files are
the tree module/test and this report. No Git/index mutation or overlay reset/reapply.
