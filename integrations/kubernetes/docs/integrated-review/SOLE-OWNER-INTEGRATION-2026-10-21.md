# Sole-owner continuation — implementation and review

Daily use remains unaccepted. Root plus exactly three subagents, no children,
continued from enforcement-composition, the newest completed retained handoff.
Pre-edit ownership and whole-checkout hashes/status are recorded in canonical
`.handoff-state/2026-10-21/sole-owner-continuation/`. Both active checkouts were
preserved. No Git/index mutation, reset or overlay reapplication occurred.

Read [native semantics and predicate inventory](NATIVE-COMMIT-OWNER-2026-10-21.md),
[canonical owner](CANONICAL-OWNER-2026-10-21.md), and
[runtime provenance requirements](RUNTIME-PROVENANCE-REQUIREMENTS-2026-10-21.md).

## Actual effects implemented

`canonical_owner.py` implements a persistent sequential Unix socket service and
one canonical-directory owner lifetime, with lifetime flock, serialized publication,
exact immutable three-root bytes, prospective intent before preparation, whole-group
HEAD CAS, file/directory fsync, retained receipts and exact uncertain inspection.
Unresolved publication holds every new operation ID. A durable local deny shares
the publication mutex and survives restart; inspection remains available. There
is no reactivation or intent eviction API. Socket requests have SO_PEERCRED UID
checking, byte bounds and an absolute two-second I/O budget. Filesystem effects
may outlive a response budget; a lost response requires inspection, never replay.
The socket's controlled parent must permit the selected peer to reach its endpoint
without granting canonical-directory access. Same UID is not per-provider identity.

`production/owned_effect_dispatch.py` owns actual local atomic nonblocking pipe
writes. A FULL-synchronous SQLite prospective intent precedes the write; exact
operation/frame conflicts refuse, including successful replay. An ambiguous intent
commit, pipe write or completion permanently holds new effects in that owner;
pending intents hold restart. Local deny and write serialize under one mutex.
Deny commit failure holds the live owner, but cannot establish persistent completed
deny if the database write failed. Ten tests exercise actual pipe bytes and durable
SQLite state, plus explicitly injected reply/commit failures.

Trusted installation must establish exclusive writer-descriptor custody and a
private non-aliased state parent. Passing a Python FD does not revoke duplicates,
inherited writers or old owners. The fifteen route labels are exercised through
this local writer; they are NOT actual native, SSH, transfer or control call-site
integration. Deny does not retract previously queued pipe bytes and is not runtime
T or completed B. Old-owner stop/inspect must remain on a separately protected
retained control path; routing a new stop command through this held byte queue
would be wrong. No existing stop/control behavior was changed.

These are real local effect mechanisms, not installed production authorities.
The canonical representation is three bounded synthetic blobs (workspace/session/
config), not complete Git trees or real credential refresh state. It accepts bytes,
not arbitrary attempt paths. Coherent hostile capture, metadata/Git/symlink semantics,
physical mount/descriptor exclusion, independent high-water and legacy writer
retirement remain absent. Detached copies never retire original writers. Neither
local owner closes a distributed transaction across native/runtime/storage/history.

## Native and runtime blockers

The strict physical-COMMIT expiry requirement remains unchanged. The executable
model enumerates126 possible final-check→physical-commit expiry counterexamples
without caller SQL. Prior actual PostgreSQL18 early SET CONSTRAINTS bypass remains
valid evidence for unchanged SQL inputs. No real commit primitive has been reviewed;
a pre-commit trigger, exclusive gateway or timeout alone supplies no proof at WAL
commit. The report explicitly proposes monotonic permanently fenced retirement
facts as a DIFFERENT, unaccepted requirement choice. Existing accepted-retirement
semantics in native source are preserved; the proposal was not wired into release.

The native report records a concrete current queue/provider/lifecycle predicate inventory and
scheduler→issue→wake→run lock ownership. Root independently confirmed optional
queue fallback, callback transaction exposure, original historical accepted-fact
behavior and optional SSH journal/protected spawn routes. No small synthetic SQL
schema, callback validator or model was substituted for those transactions. Actual
native predicates and exclusive transaction ownership remain unimplemented because
the prerequisite strict semantics/current-generation topology is unresolved.

The retained runtime inventory remains eight files191283 bytes, identical to prior
hashes. Exact snap8702 package identity assertions plus authenticated source/build/
patch/toolchain/output mapping for containerd/shim/runc/kubelite remain missing.
Kata/NVIDIA, extra daemon/socket and surviving shim coverage or non-bypassable
exclusion also remain missing. Matching version strings/binary hashes are not
source compatibility. No speculative hook or extra validator was added.

## Concrete rollout review path

| Review unit | Required implementation/diff before activation review |
| --- | --- |
| Native semantic decision | Proved primitive at a defined physical commit boundary, or explicit acceptance of changed monotonic-fact semantics; then port the entire native report predicate unit into the protected owner. Remove arbitrary SQL/callback transaction exposure and equivalent direct DML from controller/provider/maintenance/recovery roles. |
| Exact runtime implementation | Acquire authenticated immutable build chain; assign actual effect-owning handler/queue/daemon files, cover all command/input/control/recovery routes and old incarnations. Runtime T must order the reviewed irreversible acceptance/input boundary, not this local pipe deny. |
| Canonical placement | Provision canonical mounts exclusively to owner; review provider detached attempts/descriptor-safe launcher, complete aliases/root-group capture, refresh ownership, old writer retirement and independent current high-water. Local flock is not physical exclusion. |
| Native/all-command integration | Replace queue optional direct claim and every SSH unjournalled/protected-spawn fallback before preparation. Cover setup/probe/auth, managed lifetime, Git/tar/upload/download/stdin, epoch/retained stop and recovery. Unsupported routes refuse; stop/inspection retains old-owner authority without new execution grants. |
| Immutable rollout package | Exact image digest/build attestation, protected policy/trust roots, namespaced workloads/RBAC/network, storage ownership and explicit existing-external-PostgreSQL manual migration/held startup diff. No second permanent database. Stale sessions/endpoints/restored clones must be excluded. This complete executable package is blocked on the above, not replaced with placeholders. |
| Failure/recovery review | Rehearse actual cross-owner deny, partial accepted bytes, crash/reply loss, stale history, restored endpoints, original-intent inspection and rollback without re-enabling older writable owners. Changed full builds/typecheck graphs require separately authorized hosted capacity. |
| Historical closure | Separately authorized fresh complete inventory preserves all original five-scope hold arrays/source identities, other companies/providers and unsupported/run-only/null/unmapped/disappeared sources. Genuine permanent retirement, restoration, independent history/custody and exact human consent precede supported immutable reconciliation. Unknown remains occupied; preserve accepted retirement, sequence/predecessor and lost-notification sweep. |
| Operational acceptance | Reviewed rollout and ALL original shared-family reconciliation first; then ten bounded serial Codex tasks on existing B, then Claude coding/session/renewal/cancellation/disconnect/restart acceptance. Each task <=10min and each stage <=2h; no ambiguous retry, paid fallback, replacement identities or capacity increase. |

Publication/deployment/live migration/merge are not authorized. This is a concrete
implementation/review sequence, not an approved topology or executable activation.
Backup/S3/monitoring and Gemini remain deferred, with backup release prerequisites
unresolved rather than waived.

## Verification and review

Root serialized one cached exact Python image fixture: **34 tests PASS0.268s**
(13 canonical owner,10 pipe owner,11 native models). UID1000, network none,
read-only root,64MiB disposable tmpfs,256MiB RAM/512MiB swap-inclusive,1CPU,64PIDs,
all capabilities dropped, no host mounts/ports. Four actual os._exit crash phases,
persistent service requests, concurrent generation CAS, stale/partial refusal,
corruption, durable deny, uncertainty and exact inspection were exercised. Process
crash/fsync tests are not power-loss/disk durability or independent-history proof.
No production provider/runtime binary ran. Fixture inspect and exact source hashes
are retained; cleanup removed only the exact fixture-owned container.

An earlier agent ran ten storage subprocess tests locally before root corrected
scheduling; those results are superseded by the final contained root run. No
containers/heavy builds were run by agents. Root's initial test-file write used
a wrong relative path, so that test attempt failed import without writing a file;
the corrected final suite supersedes it.

Read-only independent runtime/native/storage reviews caught and corrected prospective
commit ambiguity, deny failure poisoning, global storage uncertainty hold, recovered
receipt directory durability and slow-request absolute deadline. Root reviewed final
changes. Existing native/SQL/descriptor fixture and production inputs remain unchanged;
prior PostgreSQL18/descriptor/hosted checks are reused ONLY for unchanged inputs.
No new PostgreSQL, full build/typecheck graph, hosted action or image pull was run.

All original A/shared-family holds remain; B paused per saved evidence, timers off,
capacity unchanged, draft PR5 and human-reviewed merges retained. Operational
acceptance is false. Concrete full native/all-command/runtime production integration,
physical legacy retirement and independent custody/current history are still blockers.
