# Effect-owner continuation — inactive integration, 2026-10-21

Baseline: completed control-closure-continuation. Newest checkpoint search preceded
ownership recording and edits. Root plus exactly three parallel subagents, no
children; root alone owned Git/index/shared integration and fixture scheduling.
All changes remain uncommitted. [Native closure](NATIVE-WRITER-CLOSURE-2026-10-21.md),
[storage closure](CANONICAL-OWNER-2026-10-21.md) and
[runtime review](RUNTIME-PROVENANCE-REQUIREMENTS-2026-10-21.md) retain exact source edges.

## Actual local effect-owner correction

Independent runtime review found failure-before-persistence holes in the actual
PipeEffectOwner: failed prospective INSERT and failed deny UPDATE poisoned the
live owner, but reopening could forget both when no SQL row survived. Root added
private filesystem barriers before these fallible SQL attempts, not a validator
wrapper or a successful effect stub.

For enqueue the exact immutable pipe frame is staged in database.attempt.pending,
file-fsynced, parent-fsynced, atomically selected as database.attempt and parent-
fsynced before INSERT. A partial preparation always holds on restart. A selected
barrier without its exact digest/enqueued SQL completion holds on restart. A
completed matching barrier permits fresh work while exact historical receipts
remain in SQL. No marker is deleted to clear uncertainty, no frame is replayed,
and missing SQL rows can still expose exact marker-only pending inspection.
Corrupt/partial markers hold globally without fabricating an operation identity.
The selected barrier is replaced only by a new prospective barrier after the
previous effect is settled; SQL retains prior exact completed operations.

Permanent database.denied is file/parent-fsynced before the deny UPDATE. Enqueue
checks its presence independently of SQL; exact inspection remains available.
Deny and enqueue remain serialized by the same owner lock. A failed deny cannot
retract already queued bytes. Before a barrier's durability succeeds no database
attempt or pipe effect is admitted; storage unable to persist any barrier cannot
provide durable acknowledgement of a new command. The live owner conservatively
holds on these failures as well. No production failover/rollback guarantee follows.

Creation uses explicit0600/O_EXCL/O_NOFOLLOW/CLOEXEC rather than ambient umask.
Runtime review caught an initial default-mode bug that would unnecessarily hold
successful reopen; root corrected it before the sole executed fixture. Runtime
and native independently reviewed final code without another scoped blocker.
These markers inherit the existing trusted private stable-parent/non-aliased
custody contract and local rollback limits. They do not exclude other physical
writers, authenticate same-UID callers, prove independent high-water or constitute
an installed runtime stop/termination/release authority.

## Actual transitive cut advanced

Photon upload/send phases and endpoint CAS, Teams consent/upload/file-info, GitHub
POST/PATCH versus later authority/receipt checks, and Slack session revision/token
follow-up commit separately. Installed plugin capability checks dispatch real host
effects; response loss can follow completed HTTP/secret/filesystem/SQL operations.
The native report now enumerates required function/operator/view/trigger/default/
search_path/grant/session/pool continuity evidence. Actual catalog authentication
is absent; no guessed REVOKE migration or partial owner port was installed.

Codex pre-run and actual probe credential vend can replace host auth independently
of later host copy-back and account-cache effects; vend lacks the latter's fsync.
Login promotion, account-home cleanup and terminal database state also split.
Full Codex session/sqlite/WAL, Claude sibling .claude.json/MCP/prompt/skills and
transcript repair, and ACP differences still prevent a complete generic profile.
No native source or canonical tree implementation/test changed this increment.
Historical structural tree-v1/exact inspection/retry and repeated .git new-use
refusal remain. No provenance search was repeated without new acquisition input.

## Concrete rollout review disposition

This is a blocked review candidate, not an executable approved installation. The
following actual cuts must be resolved together in the immutable rollout diff;
local components cannot be activated as a substitute for their missing backends.

| Rollout surface | Concrete required change/evidence before activation |
| --- | --- |
| Native writer authority | Complete the linked callback/provider/plugin/probe/account graph, bind separate original intents and predecessors, establish strict physical-COMMIT validity, then install the whole sole transaction-owner port with exact authenticated catalog/session exclusion. Existing external PostgreSQL remains the database. |
| All-command/control/transfer/recovery | Replace actual launch/authentication, both SSH/tar directions, restoration, old-epoch stop and startup/reaper authority at their effect owners. Each split effect gets durable intent and exact uncertain inspection. Preserve protected exact original-owner stop/inspection while new work is held; never route recovery through a denied new-work lane. |
| Runtime identity | Supply exact snap8702 assertions/trust chain and complete authenticated build/source/output/handler mapping, plus socket/daemon/admin/old-shim/recovery custody. No version/hash inference or speculative hook. Local pipe submission is not completed runtime T/B. |
| Storage/launch | Complete adapter-lane profiles and trusted whole-group coherent capture; place the actual canonical owner behind enforced mount/identity/handle/legacy-writer exclusion and independent current high-water/history. Descriptor checks, locks and copies do not establish these facts. |
| Decision/deny continuity | Exact current issuer/verifier/custody/history and cross-owner ordered deny/settlement, including partially committed provider/auth effects. Preserve stale refusal, uncertainty occupancy and existing accepted-retirement semantics. |
| Immutable activation/manual migration | Produce complete reviewed exact source/build/image digest, policy, RBAC, network, storage, workload and migration/rollback diff after the cuts exist. No publication/deployment/migration authorized here. Prior synthetic migration evidence applies only to its unchanged exact inputs. |
| Original shared-hold reconciliation | Account for every original shared-family/five-scope hold and all null/unknown/run-only/unmapped/disappeared sources. Genuine independent artifacts and current inspection required; no receipt backfill, direct lifecycle edits, B exemption or replacement. |

Strict physical-COMMIT validity remains unresolved. Monotonic fenced-fact semantics
remain an **UNACCEPTED requirement-change proposal**. Triggers, gateways, locks,
renewal and timeout checks do not prove strict expiry. Backup release prerequisite
is not waived. No complete reviewed executable rollout or genuine shared-hold
reconciliation is claimed.

Only after reviewed rollout AND complete genuine shared-hold reconciliation may
existing B run ten bounded serial Codex tasks (<=10min each, <=2h stage), then
Claude coding/session/renewal/cancellation/disconnect/restart acceptance. This
increment ran neither stage. All A/original shared-family holds, paused B, disabled
timers/current capacity, draft PR5/human-reviewed merges and Gemini/backup/S3/
monitoring deferrals remain; operational acceptance is false.

## Exact verification

Root serialized one fixture: **137 PASS in5.094s**, exact19 source inputs.
28 canonical owner /29 tree /19 pipe-journal /20 native semantic models /9 child
exec /11 group adversarial /9 retained stop /6 stop adversarial /6 actual canonical
socket methods. The six new regressions cover failed insert across restart,
failed deny across restart, completion failure after actual write, completed
barrier reopen with fresh effect, corrupt barrier, and interrupted preparation
beside prior completion. These exercise actual local pipes/files/SQLite and restart;
20 native semantic cases remain models. Synthetic success is not operational acceptance.

Cached image sha256:1eee6fcc4d866c86dd8e32a4a1a583767ddac0d640b0fe571b2c22d233b60eee;
UID1000/network-none/read-only root/no host mounts/256MiB RAM/512MiB including swap/
1CPU/64PIDs, dropped capabilities/no-new-privileges/64MiB tmpfs. Exit0/no OOM;
removed, exact-name absence rechecked. No full build/typecheck graph/hosted action,
provider/network/Git/PG/runtime-termination fixture or live inspection/mutation.
Exact commands/logs/hashes/containment/cleanup and preservation comparisons are in
`.handoff-state/2026-10-21/effect-owner-continuation/` at project root. Both checkout
HEADs and all10117 native files/status unchanged; no reset/reapply/stage/commit/push.
