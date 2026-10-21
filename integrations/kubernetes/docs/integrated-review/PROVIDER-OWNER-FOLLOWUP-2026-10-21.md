# Provider owner follow-up — 2026-10-21

Baseline: provider-cut-continuation, newest retained checkpoint checked before edits.
Exact disjoint ownership recorded in project `.handoff-state/2026-10-21/provider-owner-followup/OWNERSHIP.md`.
Root plus exactly three parallel direct subagents, no descendants; root owns shared
interfaces, integration, Git/index and fixture scheduling. Changes uncommitted.

## Actual recovery corrections

Actual PipeEffectOwner recovery previously parsed malformed attempt markers as
inspectable pending operations. It now accepts only exact canonical frames it can
write: exact shape/types, supported route, bounded operation, strict canonical
base64 with <=1024 decoded bytes, exact canonical JSON and trailing newline.
Duplicate keys, malformed payload and noncanonical frames remain global holds,
without fabricated exact operation identity. Validation never replays bytes.
Valid retained frames and prior SQL exact inspection remain unchanged.

Independent runtime review found enqueue could accept a new generation when
retained SQL state changed beneath the constructed owner. Enqueue now refuses
caller generations different from its immutable constructor-verified identity,
and holds the live owner when SQL current generation differs. A later SQL edit
back does not clear that live hold. This is no physical rollback protection or
independently current history guarantee. Deny ordering and protected original-owner
control/inspection remain unchanged. Runtime and storage independently reviewed
final source without another scoped blocker under its explicit trusted private
stable-parent/nonhostile-installer assumptions.

## Source effect closure

[Native closure](NATIVE-WRITER-CLOSURE-2026-10-21.md) records actual voice creation
with lost provider identity, best-effort cleanup, separate shared provider config,
installation-token issuance, credential lease cleanup/committed-result recovery
and adapter retirement. SQL expiry after provider duration plus grace cannot prove
accepted retirement or settle unknown creation. Exact pinned SDK package internals
are unavailable in retained source: lock selections/patches are acquisition inputs,
not proof of upload/retry/stream/media/reaction closure. No partial native port.

[Storage closure](CANONICAL-OWNER-2026-10-21.md) records actual startup Codex seeding,
credential rename before fallible logging, absent-journal direct-body execution,
and per-entry partially applied restore/manifest cleanup. Task queue holds cannot
exclude startup writers. Claude workspace restore may carry credentials and runs
outside stopped-only instruction collection. Complete provider profiles, trusted
coherent capture and physical legacy-writer exclusion remain missing. Structural
tree-v1, exact historical inspection/retry, repeated .git new-use refusal and
ordinary nested repositories remain unchanged.

[Runtime requirements](RUNTIME-PROVENANCE-REQUIREMENTS-2026-10-21.md) retain the exact
missing authenticated snap8702 assertions/trust/package/build/source/output/handler/
custody/recovery artifact list. No unchanged search, version/hash compatibility
inference, speculative hook or runtime invocation occurred. Local stop submission
proves no termination, descendant exclusion, release or permanent retirement.

## Exact verification and disposition

Root serialized one cached exact-image fixture: **143 tests PASS in4.679s**:
28 canonical-owner,29 tree,20 pipe/journal,20 native semantic models,9 child-exec,
11 group-adversarial,9 retained-stop,11 stop-adversarial,6 actual socket cases.
Two new recovery methods cover18 malformed selected/preparing marker subcases;
one new actual owner method covers SQL generation changes without reidentification.
These exercise real local files/SQLite/pipes;20 native cases remain models.
Image sha256:1eee6fcc4d866c86dd8e32a4a1a583767ddac0d640b0fe571b2c22d233b60eee,
UID1000, network-none, read-only root, no host mounts,256MiB RAM/512MiB including
swap/1CPU/64PIDs, capabilities dropped/no-new-privileges/64MiB tmpfs.
Exit0/no OOM; removed and exact-name absence rechecked. Exact19 input hashes,
command/log/inspection/cleanup and preservation comparisons retained in checkpoint.
No full build/typecheck, provider/PG/live runtime acceptance.

Strict physical-COMMIT validity remains unresolved before whole native owner port;
monotonic fenced facts remain an UNACCEPTED requirement-change proposal. Complete
provider/control/SQL catalog/session closure, physical owner/legacy exclusion,
trusted coherent profiles, independent current history/high-water/custody,
authenticated runtime provenance and immutable reviewed rollout remain blockers.
Both checkout HEADs and all10117 native files/status preserved; no reset/reapply,
staging/commit/push, live inspection/mutation, provider/credential/purchase/publication/
deployment/live migration/destructive action or merge. All A/original shared-family
holds, paused B, timers off/current capacity, draftPR5/human merges and deferred
Gemini/backup/S3/monitoring persist. Backup release prerequisite not waived.
Reviewed rollout AND complete genuine shared-hold reconciliation must precede ten
bounded serial Codex tasks on existing B (<=10min/task,<=2h/stage), then Claude
coding/session/renewal/cancellation/disconnect/restart acceptance. Neither ran.
Synthetic success is not operational acceptance; operationalAcceptance=false.
