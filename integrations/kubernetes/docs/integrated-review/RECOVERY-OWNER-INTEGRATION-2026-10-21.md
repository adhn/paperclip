# Recovery owner continuation — 2026-10-21

Baseline provider-owner-followup was newest retained checkpoint. Exactly three
parallel direct agents, no descendants. Disjoint ownership/full checkout snapshot
recorded before edits. Root owns shared interfaces/integration/Git/index/fixtures.
Uncommitted only, no reset/reapply or live actions.

## Actual deny durability ordering

An interrupted deny can leave a marker inode whose file fsync failed. Previously,
retry skipped file fsync because the path existed, proceeding directly to parent
sync and fallible SQL. Existing markers are now opened NOFOLLOW/NONBLOCK/CLOEXEC,
validated private owned regular single-link, and inode-fsynced before parent sync
and SQL. Failed inode sync retains the live hold and prevents SQL access. Exact
prior inspection and protected original-owner control semantics remain unchanged.
This repairs the marker-before-SQL invariant. A successful FULL-synchronous SQL
deny UPDATE already independently stores denied state; do not claim every old
successful retry could lose overall denial. No physical rollback protection or
runtime retirement follows. Invalid special/aliased markers remain conservative
holds, without following symlink targets, blocking on FIFO or touching SQL.

Runtime and native independently read final code without a scoped blocker under
the declared trusted stable private-parent/nonhostile installer/custody contract.
Two new actual regression methods cover repeated marker inode-sync failure, later
success ordering/restart, and four special/aliased/nonprivate marker cases. No
successful model or wrapper substitutes for effect ownership.

## Remaining actual transitive authority

[Native closure](NATIVE-WRITER-CLOSURE-2026-10-21.md) now identifies Gateway cleanup
that catches failed endpoint shutdown then releases its lease, plus initialization
cleanup bypass. Unknown old receiver occupancy cannot become retired on lease
release/expiry; removing a catch alone supplies no physical fencing. Credential
binding removal, retired-secret cleanup, tombstone/vault deletion and provider
revocation remain distinct. Concrete migration triggers reach hidden tables and
read privacy/provenance relations; installed catalog/function/session evidence is
still absent. Exact pinned SDK package source remains missing. No partial native
port or guessed REVOKE installed; strict physical-COMMIT remains unresolved and
monotonic fenced facts remain an UNACCEPTED requirement-change proposal.

[Storage closure](CANONICAL-OWNER-2026-10-21.md) now follows ACP cache eviction before
resource close, swallowed idle-close errors, late resume/handshake cleanup, cancel
versus persistent-state discard, and finalization bookkeeping despite step errors.
Cache absence/finalized disposition prove no provider termination or restored
coherence. Imported acpx store implementation remains unavailable; retained patch
save calls cannot establish its entire layout/deletion/recovery. Existing Codex
sessions/sqlite/WAL/auth/cache/startup and Claude sibling config/MCP/prompt/skills/
probe/transcript requirements persist. Workspace restore can carry credentials and
runs outside stopped-only instruction collection. No complete profile, trusted
capture or physical old-writer exclusion installed. Historical tree-v1 inspection/
retry and repeated-.git new-use refusal/ordinary nested repos unchanged.

[Runtime provenance](RUNTIME-PROVENANCE-REQUIREMENTS-2026-10-21.md) preserves exact
missing snap8702 assertions/trust/package/build/source/output/handler/custody/
recovery artifacts; no unchanged searches, hash/version inference or speculative
hooks. Local pipe submission proves no termination, release or retirement.

## Exact verification and preserved gates

One root-serialized exact cached-image fixture: **145 PASS in4.467s**,19 exact inputs:
28 canonical owner/29 tree/21 pipe-journal/20 native semantic models/9 child-exec/
11 group-adversarial/9 retained-stop/12 stop-adversarial/6 actual socket methods.
Image sha256:1eee6fcc4d866c86dd8e32a4a1a583767ddac0d640b0fe571b2c22d233b60eee;
UID1000/network-none/read-only/no host mounts/256MiB RAM/512MiB swap-inclusive/
1CPU/64PIDs/capabilities dropped/no-new-privileges/64MiB tmpfs. Exit0/no OOM,
removed/absence rechecked. Exact command/log/hashes/inspection/cleanup retained in
project `.handoff-state/2026-10-21/recovery-owner-continuation/`.
Both HEADs/all10117 native files/status preserved. No stage/commit/push/reset/reapply,
full build/typecheck, provider/credential/live inspection/mutation/publication/
deployment/migration/destructive action/merge. Tests remain local synthetic evidence.

Complete native/provider/SQL/catalog/session cut, strict COMMIT, authenticated
runtime provenance, coherent profiles/physical exclusion, independent current
history/custody and immutable reviewed rollout remain blockers. All A/original
shared-family holds, paused B, timers disabled/current capacity, draftPR5/human
merges and Gemini/backup/S3/monitoring deferrals persist. Backup release prerequisite
not waived. Reviewed rollout AND complete genuine shared-hold reconciliation must
precede ten bounded serial existing-B Codex tasks (<=10min/task,<=2h/stage), then
Claude coding/session/renewal/cancellation/disconnect/restart acceptance. Neither
stage ran. Synthetic success is not operational acceptance.
