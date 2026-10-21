# Effect custody continuation — inactive integration review

Baseline: newest owner-tree-continuation handoff and its exact 62-case retained
log. Changes remain uncommitted. Ownership, all-file pre-edit hashes, independent
reviews, exact fixture inputs/command/output/containment/cleanup are retained in
`.handoff-state/2026-10-21/effect-custody-continuation/` in the canonical project.
Root plus exactly three parallel subagents; no children. Root alone schedules
fixtures and owns shared interfaces/Git/index. Native source remains untouched.

## Concrete implementation

`PipeEffectOwner` now owns a private F_DUPFD_CLOEXEC duplicate. It obtains that
duplicate before fallible SQLite initialization, syncs durable parent metadata,
then closes the transferred original. Ordinary constructor failures close only
the private duplicate and leave caller custody intact. Enqueue and close use the
private descriptor, so accidental later caller-number reuse cannot redirect an
actual pipe write or cause owner close to close an unrelated caller resource.
Two regressions exercise actual kernel pipe writes, caller-number reuse, close,
CLOEXEC and failed-constructor cleanup. Existing pending-intent/global uncertainty,
deny serialization, exact inspection and generation refusal are preserved.

Trusted installation must transfer the descriptor without concurrent close/reuse.
The duplicate shares open-file-description flags. It cannot revoke deliberately
retained aliases or protect against arbitrary hostile trusted Python code. This
is local enqueue ownership, not native commit authority, runtime T/B, consumer
settlement, launcher authority or an installed all-command route. Pre-deny queued
bytes remain occupied until the genuine effect owner settles them.

Storage adds pread capture without changing caller offsets and detects observable
inode substitution/content/metadata changes before accepting a captured tree.
See [storage report](CANONICAL-OWNER-2026-10-21.md). Trusted coherent whole-group
capture remains an absent authority. Complete application roots, descriptor-safe
production launcher, physical old-writer exclusion and independent history remain
blocked. Native semantics and exact runtime provenance remain blocked as recorded
in [native](NATIVE-COMMIT-OWNER-2026-10-21.md) and
[runtime](RUNTIME-PROVENANCE-REQUIREMENTS-2026-10-21.md) reports.

## Actual integration units and reviewed rollout path

The following names actual source ownership that must change together. None is
represented as completed by local pipe tests, static route labels or validators.

1. Decide strict expiry with a reviewed real physical-COMMIT primitive, or review
   and explicitly accept the different monotonic fenced-fact requirement. The
   latter is still UNACCEPTED. Preserve accepted-retirement semantics meanwhile.
   Port complete scheduler/issue/wake/run and provider/lifecycle predicates into
   one trusted transaction owner; remove queue.ts:1589–1597 optional callback/
   `claimDatabase(db)` fallback and old DML/session authority in the same reviewed
   migration unit. Match original shared-hold closure and exact immutable intents,
   predecessor CAS, deny order, stale refusal and uncertain inspection.
2. Replace actual transport branches, not route metadata: adapter-utils/src/ssh.ts
   runUnjournalledSshCommand/runSshCommand fallback around1415; optional
   spawnProtected branch1519 and legacy authentication1528; epoch control1481;
   unjournalled stop1552; retained stop1605; stream transfers/tar/stdin and their
   call sites. New-work refusal must precede authentication/setup. Protected exact
   old-owner control/inspection must remain usable while new work is held. Do not
   globally disable stop behind a new-work deny or let cleanup imply retirement.
   Runtime source/build authentication must precede compatible real irreversible
   input ownership and all-handler/recovery changes; lower task/shim/admin and
   old boot paths need owned deny/settlement, not a successful socket reply.
3. Resolve actual workspace/session/config/credential/Git external references as
   a complete root group. Put canonical storage under a dedicated non-root
   authority identity; give provider attempts detached independent storage only.
   Integrate launch/deny with child descriptor closure before exec on every setup,
   probe, transfer and recovery path. Independently retire every old writable
   descriptor/mount/mmap/refresh client/restored endpoint for original families.
   A private directory/flock/detached copy does not prove this physical exclusion.
4. Review independently current history/high-water and custody, restored-clone
   refusal, pre-deny accepted/partial/unknown work settlement and cross-owner
   failure recovery. Local durable ledgers cannot become their own rollback floor.
5. Produce exact immutable image/build attestation and namespaced policy/RBAC/
   network/workload/storage diff, held startup and manual migration against the
   existing external PostgreSQL. Preserve non-root rules; no fixture broker/root
   launcher privilege exception. Full builds/typecheck graphs need separately
   authorized hosted capacity. This activation artifact is incomplete today; no
   placeholder topology, speculative runtime hook or installation is supplied.
6. Only after reviewed rollout and complete genuine shared-hold reconciliation,
   run ten bounded serial Codex tasks on existing B (<=10min/task, <=2h/stage),
   then Claude coding/session/renewal/cancellation/disconnect/restart acceptance.
   Unknown, run-only, disappeared and unmapped holds stay occupied. No replacement
   identity/B exemption, capacity increase or ambiguous replay.

No live inspection/mutation, provider calls, credentials, purchases, publication,
deployment, live migration, destructive operation or merge. All original A/shared
family holds, paused B, disabled timers/current capacity, draft PR5 and human merge
review remain. Gemini authentication and backup/S3/monitoring remain deferred;
the backup release prerequisite is not waived. Operational acceptance remains false.

## Final exact verification and preservation

Root ran 71 tests PASS in0.319s:20 canonical owner,15 tree,16 actual pipe/journal,
20 native logical models. Input hashes match final source. Cached exact image
sha256:1eee6fcc4d866c86dd8e32a4a1a583767ddac0d640b0fe571b2c22d233b60eee;
UID1000:1000, network-none, read-only root, no host mounts/ports, dropped caps,
no-new-privileges,64MiB tmpfs,256MiB RAM/512MiB swap-inclusive/1CPU/64PIDs.
Exit0, OOMfalse; exact container removed and absence rechecked. One serialized
fixture only. No pull/build/full graph/typecheck/hosted action. Existing SQL and
kernel descriptor fixtures were not rerun; no changed-input reuse is claimed.

All10117 native files plus HEAD and dirty status unchanged. Nine assigned existing
homelab files changed out of476 pre-existing files;467 others preserved. One new
integration report. Both HEADs unchanged; no Git/index mutation or overlay reset/
reapply. Three agents independently reviewed private FD custody; root/native
reviewed storage capture. Reviews establish only the documented local scope.
