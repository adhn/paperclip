# Writer/profile continuation — inactive integration

Latest completed baseline owner-port-continuation, checked for newer checkpoints
before assignment. Root plus exactly three parallel subagents, no children; exact
ownership and complete source baseline recorded before edits. Root alone shared
interfaces, integration, Git/index and all fixture scheduling. Changes uncommitted.

## Actual owner export change

`canonical_owner.export_trees` now obtains its destination through the new
`production/descriptor_paths.open_directory` component: bounded canonical absolute
path, descriptor-relative O_NOFOLLOW directory traversal at every ancestor, with
intermediate descriptor cleanup on failure and close-on-exec descriptors. Existing
private/fresh/outside-canonical destination checks still run on that opened FD;
all materialization and fsync effects use the same FD. Path traversal/refusal is
before destination mutation and leaves retained canonical receipt inspectable.

Four actual filesystem regressions cover final/ancestor symlink refusal, lexical
alias refusal, name replacement after open (writes stay on the original moved
directory, never the replacement alias) and repeated failed-walk descriptor cleanup.
The rename test proves descriptor-relative physical effect placement only: later
child HOME/XDG path use still requires trusted stable names. Hidden mount/bind
aliases, writable mappings, same-UID access and surviving old writers are not
excluded by this walk. Canonical private directory/name custody remains trusted.
No production installer, identity/mount placement or launch authority was added.
Standalone `detached_exec.py` remains unchanged, preserving its isolated direct-
file invocation; it does not import the new component.

Tree-v1 structural format, historical exact inspection/retry, new-use application
gate, durable exact intents, whole-group CAS, global unresolved-intent hold,
persistent deny and accepted-retirement semantics remain unchanged.

## Genuine remaining native/profile closure

Read [native closure](NATIVE-WRITER-CLOSURE-2026-10-21.md) and
[provider storage profile review](CANONICAL-OWNER-2026-10-21.md). New actual source
edges include thread cancellation revoking linked tool actions before card expiry;
summary/status card generation state; publication CAS and reread of streaming/
unknown/published sends; independently committed completion delivery preparation,
run context binding, wake attempt and comment acknowledgement. Preserve original
phase/attempt keys and inspect unknown delivery before retry.

Budget enforcement commits accounting before policy-version checked physical
cancellation. Secret normalization has provider prepare/SQL activate/physical cleanup
phases; agent identity creation can create/chmod/link a master-key file inside a
SQL transaction. Plugin lifecycle invokes external work under operation/version/
phase, then instance-secret updates check exact lease/current state. Timeout is
not cancellation. These actual effects enlarge the proposed command cut; no
partial native port or blanket privilege migration was installed.

Generic HOME/session and XDG/config mapping cannot supply complete provider
profiles. Actual Codex CODEX_HOME provisioning intentionally excludes sessions,
sqlite/WAL and caches; host auth rename and per-account cache commit independently.
Claude also uses sibling .claude.json, separate run MCP/prompt/skills roots and
poisoned transcript deletion. ACP has distinct override fallback and no credential
copy-back. No speculative application_profiles module was created in reserved
paths. Complete provider build/lane/config semantics and coherent capture must be
reviewed against these actual writers before installing a new profile layout.

Strict physical-COMMIT primitive remains missing, and monotonic fenced facts remain
an **UNACCEPTED proposed requirement change**. Preserve accepted retirement and
complete original shared families/exact intents/predecessors/deny order/stale refusal.
Authenticated snap8702/containerd build/source artifacts remain absent; unchanged
searches were not repeated and no speculative runtime hooks were installed.

## Exact control adversity and cross-owner ordering

Three new actual pipe/journal regressions exercise full stop pipe without partial
frame, failed prospective insert before bytes, and persistent control deny/restart
with exact inspection. Unknown stop remains pending; draining capacity or changing
operation ID does not permit replay. No termination is claimed.

The full-pipe test also demonstrates that a separately constructed local work owner
has independent state. That is component isolation, NOT permission for production
work after an uncertain stop. Production must preserve global uncertainty occupancy
and coordinate cross-owner deny/settlement before any new work; no such global
composition is installed here. Exact original-owner control/inspection must remain
available while starts held; local stop enqueue is not retirement B or lease release.

## Concrete rollout remains held

Required review cut: actual native command/transaction/column ownership and removal
of equivalent old pools/endpoints; authenticated role/function/trigger/cascade/
utility-session catalog; compatible authenticated runtime create/start/exec/attach/
control/transfer/recovery effect owners; complete profile capture and physical
canonical owner placement/legacy-writer exclusion; independently current history/
high-water/custody; cross-owner intent/deny/inspection/settlement; exact immutable
image/policy/RBAC/network/storage/workload/manual-migration package using existing
external PostgreSQL. Backup prerequisite is not waived. No privilege exception,
second permanent database, live migration or deployment was introduced.

Reviewed rollout AND complete genuine original shared-hold reconciliation precede
ten bounded serial Codex tasks on existing B (<=10min/task,<=2h/stage), then Claude
coding/session/renewal/cancellation/disconnect/restart. Unknown/null/run-only/
unmapped/disappeared sources remain occupied, with no replacement or B exemption.

## Final verification

Final exact **120 PASS4.207s**:26 canonical-owner/26 tree/16 pipe-journal/20 native
semantic models/9 child exec/11 group adversarial/9 retained-stop/3 stop adversarial.
Root serialized one disposable cached-image fixture, UID1000/network-none/read-only
root/no mounts/256MiB RAM/512MiB including swap/1CPU/64PIDs/64MiB tmpfs, dropped caps/
no-new-privileges. Exit0/no OOM; removed and absence rechecked. Exact18 source hashes,
full command/log/inspection/cleanup and preservation evidence under canonical
`.handoff-state/2026-10-21/writer-profile-continuation/`. No actual provider/network/
Git/PG/runtime stop fixture, full build/typecheck graph or hosted action. Prior
verification only covers unchanged exact inputs; semantic20 remain models.

Both HEADs/all10117 native files/native dirty status unchanged; no overlay reset/
reapply/staging/commit/push. All A/original shared-family holds, paused B, timers
suppressed/current capacity, draftPR5/human merges and Gemini/backup/S3/monitoring
deferrals persist. No live inspection/mutation/provider/credentials/purchase/
publication/deployment/live migration/destructive operation/merge. Operational
acceptance remains false.
