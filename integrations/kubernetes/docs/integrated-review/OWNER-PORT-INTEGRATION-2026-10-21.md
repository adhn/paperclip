# Owner port continuation — inactive integration

Baseline: completed group-launch-continuation, selected after checkpoint timestamp
search found no newer handoff. Root plus exactly three parallel subagents, no
children; exact disjoint files recorded before edits. Root owned interfaces,
integration, all Git/index operations and serialized fixtures. Changes uncommitted.
See [native closure](NATIVE-WRITER-CLOSURE-2026-10-21.md),
[storage](CANONICAL-OWNER-2026-10-21.md) and
[runtime](RUNTIME-PROVENANCE-REQUIREMENTS-2026-10-21.md).

## Concrete local control implementation

`production/retained_stop_dispatch.py` owns an actual atomic fixed-payload stop
pipe submission through a separate `PipeEffectOwner` journal and descriptor.
Trusted construction supplies exact opaque original binding bytes, never a request
PID/path/new epoch/replacement sandbox. The request can name only operation ID
and exact original-binding digest: no route, arbitrary payload, signal, SQL or
callback. The frame carries the original bytes/digest and fixed version/action.
This control owner remains usable when a separate new-work owner is uncertain
and persistently denied. Its own uncertain submission remains held and can only
be inspected; neither a fresh ID nor restart replays the body.

PipeEffectOwner now persists an optional immutable custody binding before taking
caller descriptor custody. The stop owner uses a domain-separated digest of its
exact original bytes. Reopening with another target or generic work owner refuses;
existing unbound generic history cannot be promoted to exact-stop history. Failure
closes only private duplicates; caller descriptor remains with caller. Historical
pending, persistent deny and exact conflict semantics remain unchanged. This is
local SQLite state, not independent high-water or rollback-resistant history.

This is **stop submission, not actual runtime termination**. No trusted receiver,
authenticated endpoint, native cancellation caller or production installer is
installed. A pipe frame's enqueued status must never become native stop evidence,
lease cleanup success or retirement B. Trusted receiver must verify the full
original retained native/runtime/storage binding and own irreversible stop and
inspection. Current generic work enqueue still refuses all routes when held; no
blanket stop allowlist or bypass was added. Dedicated control custody must remain
separate when the production all-command composition is installed.

Nine actual journal/pipe tests cover held+denied work versus separate exact stop,
wrong-target refusal, post-write reply loss/restart/no replay, completed no replay,
invalid binding/caller custody, replacement/generic reopen refusal, generic and
legacy unbound history refusal, and exact maximum binary binding transport.
No process is stopped by those tests, and no such acceptance is claimed.

## Storage and process boundary changes

`capture_group` now rejects duplicate descriptor/inode roots before capture,
requires workspace/session directories and config regular file/directory, then
rechecks every root's observable metadata after the entire group scan. This catches
an earlier root's observable change during later-root capture. Three regressions
cover aliases, shape and cross-root metadata change. Structural tree-v1 validation,
retained integrity-only inspection/retry, and single-file config transport remain.
Checks cannot detect unchanged descendant mutation, hidden bind overlap or prove
coherent application capture. A trusted complete group snapshot/exclusion boundary
is still required, and provider-specific config launch remains unsupported.

Three actual child regressions add private-group refusal, each regular-file member
refusal with original bytes unchanged, and closure of an inherited high connected
socket while parent custody remains intact. Existing cwd/HOME/XDG/environment/
Git suppression/no-follow walk/all-FD-close behavior is unchanged. Descriptor-safe
child preparation remains separate from launch authority, external isolated
identity/mount placement, canonical old-writer exclusion and runtime T/B.

## Concrete reviewed owner and rollout cut

Native source review resolves issue-update/helper/lifecycle effects further and
finds actual migration triggers and utility-session batch commits. Issue terminal
state commits a cancellation marker before its post-commit heartbeat stop. The
protected original-owner control lane is therefore a real integration requirement,
not merely a hypothetical route. Failed post-commit stop must retain its marker
and exact action for recovery. Paired native result ingest and independently
committed finalizer/status effects still need distinct intents and phase inspection.

| Existing surface | Required concrete installation/review before activation |
| --- | --- |
| Native queue/callbacks/result/status/lifecycle/recovery/workspace services | Complete exact command/column/transaction ownership; preserve original shared holds, intent/predecessor and lock ordering; remove equivalent direct writer endpoints/pools. No partial native port is installed. |
| Native migration client and retained SQL migrations | Authenticate actual catalog/roles/PUBLIC/inherited/column/sequence/function/trigger/cascade authority and utility sessions; inspect split batch commits and retain privacy/immutability triggers. No blanket REVOKE or invented session target. |
| All command/setup/probe/service/control/stdin/transfer/recovery callers | Mandatory authenticated effect owners before any effect, separate original control availability while starts held; local pipe route coverage does not establish these call sites. |
| Runtime daemon/shim/handler/recovery entrypoints | Authenticated exact snap8702 package-to-build-to-source chain, all handlers or enforced exclusion, current history and permanent retirement. No speculative runtime hooks. |
| Canonical owner/group export/detached exec | Complete app profiles and coherent trusted capture; actual independent physical owner placement, legacy handles/mounts/writers excluded, stable detached paths and independent current high-water. |
| Immutable activation/manual migration | Exact reviewed source/image/policy/RBAC/network/storage/workload diff using existing external PostgreSQL, held startup, real backup prerequisite and recovery/rollback. No second permanent DB or privilege exception. |

Strict physical-COMMIT release validity remains absent. Triggers/gateways/timeouts
are not strict expiry primitives. Monotonic fenced facts remain an **UNACCEPTED
proposed requirement change**. Existing accepted-retirement semantics are untouched.
Real catalog and runtime authentication artifacts remain missing; unchanged searches
were not repeated. Local implementations do not close these acceptance gates.

## Verification and preservation

Root serialized two bounded disposable runs. Intermediate111 PASS4.108s preceded
legacy-history/max-binding additions. Final exact **113 PASS4.057s** comprises
22 canonical-owner,26 tree,16 existing actual pipe/journal,20 native semantic model,
9 child exec,11 adversarial group and9 retained-stop cases. Full exact command,
source hashes/log, container inspection and cleanup evidence are retained in
`.handoff-state/2026-10-21/owner-port-continuation/`. The semantic20 remain models.

Cached image sha256:1eee6fcc4d866c86dd8e32a4a1a583767ddac0d640b0fe571b2c22d233b60eee;
UID1000/network-none/read-only root/no mounts, dropped caps/no-new-privileges,
256MiB RAM/512MiB swap-inclusive/1CPU/64PIDs/64MiB tmpfs. Final exit0/no OOM,
container removed and absence rechecked. No full build/typecheck, hosted action,
actual provider/network/Git, new PG or prior UID-switch fixture was run. Unchanged
historical verification retains only its exact original input scope.

All10117 native files/HEAD/dirty status preserved; both active checkout HEADs
unchanged. Full before/after file comparison retained with explicit exclusion of
Git metadata and Python cache files. No reset/reapply/staging/commit/push or live
inspection/mutation/provider/credentials/purchase/publication/deployment/live
migration/destructive operation/merge. All A/original shared-family holds, paused
B, timers off, current capacity, draftPR5/human merges remain. Gemini/backup/S3/
monitoring deferred; backup prerequisite not waived.

Reviewed rollout AND complete genuine shared-hold reconciliation precede ten
bounded serial Codex tasks on existing B (<=10min/task,<=2h/stage), then Claude
coding/session/renewal/cancellation/disconnect/restart acceptance. Unknown/null/
run-only/unmapped/disappeared sources stay occupied. No replacement/B exemption.
Operational acceptance remains false.
