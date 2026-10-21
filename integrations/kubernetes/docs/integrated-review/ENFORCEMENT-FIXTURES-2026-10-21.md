# Actual isolated enforcement fixtures — 2026-10-21

Follow [the implementation design](ENFORCEMENT-DESIGN-2026-10-21.md). The root
coordinator owns resource scheduling and shared integration; three agents own
runtime provenance, storage fixture and SQL fixture files, with no children.
Exact pre-edit ownership is retained in the canonical workspace's
`.handoff-state/2026-10-21/enforcement-fixtures/OWNERSHIP.md`.

This increment tests concrete filesystem/identity and PostgreSQL mechanics.
It installs no runtime hook, production authority, role, credential, workload or
migration. The earlier SQL review file remains inert and unchanged; executable
SQL belongs only to the explicitly named disposable fixture database. The native
source stays intentionally dirty and is never reset/reapplied.

## What each result can establish

| Track | Concrete work | Scope limit |
| --- | --- | --- |
| Runtime | Hash/enumerate bounded retained local inventory and source/build inputs; distinguish historical binary/config observations from exact immutable source provenance | No live host/config/binary query, online fetch or inferred snap source compatibility. Missing provenance blocks real runtime patching. |
| Storage | Separate disposable tmpfs mounts, canonical owner UID2000 and provider UID1000; actual access-denial attempts, detached bytes and retained descriptors | Kernel UID permissions and detached inodes in a local container do not retire old homelab mounts, provide independent high water or approve sole-owner topology. An inherited canonical descriptor remains a negative attack characterization, never an exclusion proof. |
| Native authority | Actual isolated PostgreSQL18 syntax/role/effect-journal/generation/deny/replay tests | Synthetic schema lacks full native queue/lifecycle/provider semantics. Successful SQL cannot prove independent H/W placement, physical old connection/endpoint exclusion or runtime pipe ordering. |

Only root executes process/container/database fixtures. Storage precedes PostgreSQL;
each uses a cached immutable image ID, network-none/read-only root, bounded tmpfs,
RAM/swap/CPU/PIDs and exact fixture-owned names. No host canonical/credential/DB
mounts, published ports, images pulled/built or production services are used.
Contained UID setup receives only its required capability set, never privileged or
SYS_ADMIN. Disposable PostgreSQL uses non-root UID999. Synthetic trust within its
networkless container is not operational authentication or credential provisioning.

## Next integration after these fixtures

The remaining production obligations do not disappear on a local pass: exact
runtime source/build provenance and mandatory lower-handler/recovery hooks; sole
canonical physical identity/mount ownership and complete old-writer transition;
independent current history/witness and importer custody; complete native predicates,
all equivalent writer exclusion and every command/transfer/stop/recovery call site.
Those need exact shared-file assignments and implementation before activation.

The executable fixture SQL must not be copied into a migration or used as the native
admission implementation. It exists to expose real parser, permission and ordering
bugs in the proposed transaction shape. Preserve all failed attempts and corrections;
assert unknown/partial outcomes held, not operationally accepted.

Root records exact executions, failures/corrections, cleanup and unchanged-input
comparisons in the canonical enforcement-fixtures checkpoint. Unchanged prior
verification is reused only for unchanged source. No full build/typecheck graph,
hosted action, provider call, live inspection/mutation, publication, rollout, live
migration, capacity change or merge occurs.

All original A/shared-family holds, paused B, disabled timers, current capacity,
Gemini deferral, draft PR5 and human-reviewed merges remain. Backup/S3/monitoring
is postponed and unaccepted. Reviewed rollout/full real hold reconciliation precede
serial Codex B then Claude acceptance; synthetic fixture success cannot satisfy it.

## Track reports

- [Retained runtime provenance](RUNTIME-PROVENANCE-2026-10-21.md).
- [Actual contained storage isolation](STORAGE-ISOLATION-FIXTURE-2026-10-21.md).
- [Actual native PostgreSQL fixture](NATIVE-POSTGRES-FIXTURE-2026-10-21.md).

The storage fixture observed four provider path operations denied by EACCES and
old attempt-descriptor writes unable to change copied canonical bytes across the
two tmpfs mounts. It also reproduced the expected inherited canonical descriptor
attack after dropping to UID1000. This is a required rejection condition for any
production composition that leaks such a descriptor; UID separation alone is
insufficient. Storage fixture exited0 and exact named container cleanup passed.

Final root execution:15 actual PostgreSQL18 cases PASS30.426s, plus focused old
epoch1 refusal after current epoch2 PASS.13 lightweight cases PASS0.022s. Storage
actual kernel fixture PASS; both exact fixture containers cleaned. PostgreSQL was
UID999, network-none/read-only/tmpfs-only/no ports with OOMfalse. No SQL corrections
were required after actual parsing/role tests. Release-fact expiry is function-time,
not deferred COMMIT-time; that external-fact/expiry fence remains incomplete.
Native75 hashes/status, prior increment files and six production inputs unchanged.
