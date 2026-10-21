# Disposable native reconciliation and restored clone

`server/src/services/execution-legacy-reconciliation.ts` in the native overlay
appends distinct present-day decisions; migration 0345 preserves historical
holds/leases/runs and makes decision rows immutable against UPDATE/DELETE.
A separate protected signer authenticates exact old ownership, original hold and
scope-family hashes, current epoch/policy, independent whole-incarnation stop,
old-route revocation, all three restoration artifacts and operator approval.
This module has no public route, signer, drain release, start grant, historical
receipt backfill or lifecycle-column writes. The supported lifecycle worker is
scheduled after commit and rechecks the exact lease; its ordinary deferred retry
and restart sweep remain in effect. Signed revocation restores occupancy.

The native test `execution-legacy-reconciliation.test.ts` runs real disposable
PostgreSQL and the supported lifecycle coordinator, using synthetic proof keys
and evidence artifacts. It tests identity/hash/scope/expiry mistakes, incomplete
restoration, unauthenticated/replayed decisions, append-only history, revocation,
shared-lease safety and pausing → paused while preserving the manual hold.
The grant predicate must check every shared hold independently.

The same test uses official pinned PostgreSQL 18 client tools for a full
Paperclip-only synthetic `pg_dump`/`pg_restore`, coordinated synthetic workspace,
session, credential and held configuration copy. It executes generated 0345 SQL
on the restored clone, injects transactional failure, retries migration, restarts
held admission, checks source isolation and restores the synthetic file checkpoint.
`Dockerfile.clone-tools` extends the cached native test image for this purpose;
set `PAPERCLIP_CLONE_PG_DUMP=/usr/local/bin/pg_dump` and
`PAPERCLIP_CLONE_PG_RESTORE=/usr/local/bin/pg_restore` when running the test.
The tool client is PostgreSQL 18.6; the synthetic embedded source is PostgreSQL 18.

This is a synthetic source-level rehearsal. It is not a restored backup of the
live Paperclip database/PVCs; it does not rehearse the old/new controller image
rollout/rollback, revoke an actual SSH route, authenticate a real node observer,
prove protected ACK plus state transfer across an application restart, resolve
external refresh writers or release either historical A hold. Those operational
and assembled-image gates remain open. Do not sign an operational decision until
all independently protected artifacts and human review exist.

## Continued disposable source rehearsal

The source fixture now takes a second full PostgreSQL checkpoint of the restored
clone before the migration attempt. After migration and held restart, it appends
one synthetic present-day decision through the supported service, destroys the
upgraded clone database, restores the pre-upgrade checkpoint, and boots the held
service again. It checks that the divergent decision disappeared, the original
lease/run/hold are byte-equivalent, the controller receives a new epoch, and
original unreconciled occupancy still prevents lifecycle completion. The source
DB is never upgraded or replaced. This strengthens database rollback coverage;
it still does not run old/new application images or real Kubernetes PVCs.

`legacy_review.py` is an offline review boundary for independently authenticated
route, incarnation retirement, whole-Pod stop, workspace, session, credential and
operator evidence. All seven roots come from protected configuration and must be
distinct. Each artifact binds one exact original hold, lease, complete scope list,
policy and epoch; the operator artifact approves the complete hash bundle.
`review_shared_holds` requires a separate bundle for every supplied original hold,
even when the holds share identical Codex scope families. Eight synthetic unit
cases cover this contract, signature/expiry/identity mistakes and immutability.
The caller must enumerate the complete original hold set from the authoritative
held snapshot; a filtered caller-supplied list cannot prove global completeness.

This reviewer neither issues evidence nor signs native decisions. It is not
installed in the production signer/native append path. Actual independent
issuers, current real A artifacts, human approval, old-route retirement and
integration remain required. A passing synthetic review sets
`operationalAcceptance: false`; it cannot release A or exempt B. Historical hold,
run, lease and receipt rows remain untouched.

Continued local verification (2026-10-19): eight offline-review Python cases PASS.
The bounded current-source native run passed 17 cases; its clone case failed at
fixture setup because the cached image did not export the client-path variables.
With `PAPERCLIP_CLONE_PG_DUMP=/usr/local/bin/pg_dump` and
`PAPERCLIP_CLONE_PG_RESTORE=/usr/local/bin/pg_restore` explicitly supplied, the
focused clone/revocation rerun passed both selected cases (16 skipped; 70.79s;
clone body 23.04s). All 18 distinct native cases therefore passed across these
runs, including the strengthened full-database checkpoint rollback. This is not
a fresh complete-suite pass. Tests used no network, 3 GiB RAM/5 GiB including
swap, two CPUs and 256 PIDs; disposable containers exited and were removed.

Final source verification on the continuation supersedes the split local result:
a fresh combined run passes all 77 affected cases across journal/transport/legacy,
including all 18 cases of this legacy file and the strengthened clone rollback.
The focused service typecheck also passes. Final evidence is in
`.handoff-state/2026-10-19/protected-current-fences/native-final*.log`. This remains
a source-level DB/files rehearsal; no controller-image or real PVC acceptance.

## Current integration hardening — 2026-10-20

Native append refuses installation without a host-only independent
`verifyEvidence` dependency. Before inserting, it locks the complete authoritative
native hold inventory, supplies its canonical source/fingerprint hash to the
verifier, checks exact returned decision/inventory hashes, and rechecks freshness
after verification. Decision MAC key possession alone is insufficient. Production
issuers/verifier remain absent; the DB test callback is explicitly synthetic.
Three new native cases cover absent/unbound verification, complete inventory with
evidence-unavailable rollback and expiry during verification. Their functional
result remains pending the root's integrated run.

The offline inventory path requires a distinct protected root and authenticated
60-second inventory pinned to the native transaction hash. Every original source
requires its own bundle. Ten legacy-review and twenty image/PVC Python contracts
pass locally; these are not real evidence or image/PVC execution acceptance.
See `docs/bootstrap-review/legacy-reconciliation-review-2026-10-20.md` and
`legacy-manual-migration-review-2026-10-20.md` for concrete review inputs and held
execution/rollback steps. No operational signer or runtime retirement authority
is supplied.

Final review interface requires `{decisionHash, inventoryHash, expiresAt}`. The
verifier's expiry is the minimum of the inventory, all independent artifacts,
operator approval and decision. Native append rechecks that safe-integer deadline
after awaiting verification, requires it within sixty seconds and no later than
the decision, then rechecks decision freshness. An expired short-lived inventory
cannot inherit a longer decision lifetime. Four additional DB cases exercise
short evidence expiry and unbounded deadlines; integrated DB verification pending.
The offline reviewer explicitly accepts conservative `revoke` with the same full
seven-artifact evidence contract. Operator approval binds `approvedAction` as well
as the exact evidence hashes; action substitution is refused. Native revocation
only appends immutable tightening history. Eleven legacy Python cases and twenty
harness cases now pass (31 total). Operational evidence/signing remains absent.
