# Group launch continuation — inactive integration

Baseline is completed root-boundary-continuation, selected after newer handoff
search. Exact disjoint ownership and all-file baseline recorded before editing.
Root coordinated exactly three parallel subagents, no children; root owns shared
interfaces/integration/Git/index and serial fixture scheduling. Changes uncommitted.
Read [native writer closure](NATIVE-WRITER-CLOSURE-2026-10-21.md),
[storage](CANONICAL-OWNER-2026-10-21.md), and
[runtime](RUNTIME-PROVENANCE-REQUIREMENTS-2026-10-21.md).

## Actual implementation and tests

`production/detached_exec.py --group ABS_GROUP ABS_COMMAND ...` opens a complete
already-detached workspace/session/config directory group. It walks every absolute
path component using directory descriptors/O_NOFOLLOW, refuses noncanonical paths,
symlinked ancestors and extra/missing entries, and requires private current-owner
same-device independent root inodes. It selects workspace as actual cwd, session
as HOME and config as XDG_CONFIG_HOME. Explicit environment discards inherited
Git/SSH/provider/loader override variables, skips system Git config and sets global
Git config to /dev/null. Common nonroot/singlethread/no_new_privs/stdin-out-err/
unknown-high-FD close/exec mechanics remain. Single-dir CLI is retained with the
same ancestor-symlink refusal. All errors exit125 silently, including unsafe stderr.

The generic grouped mode deliberately refuses a single-file config root; it does
not invent Codex/Claude provider-home, credential or resume semantics. PATH/HOME/
XDG preparation alone does not complete application-root authority. Configuration
paths must remain stable through exec under trusted installer custody; descriptor
checks cannot detect hidden same-device bind aliases or retire other writers.
No canonical owner descriptor is passed to provider code. Actual grouped child
exec after canonical publish/export mutates all three detached roots and leaves
all selected canonical bytes/receipt unchanged. Export remains preparation, not a
launch permit; there is still no atomic runtime deny-to-exec ordering.

Eight new adversarial group tests exercise exact environment/root mapping,
nonprivate/symlink/missing/extra members, symlink ancestors, lexical aliases, and
actual inherited canonical-directory openat capability closure. Parent descriptor
custody remains intact. Root tests include unsupported file-config refusal and
actual whole-group mutation separation. These are real process/filesystem effects,
not route-label lookups. External isolated UID/mount placement, writable mapping/
proc/session/credential exclusion and actual runtime T/B are not tested or installed.

Storage application policy now supports narrow ordinary network clone config:
explicit http(s)/ssh remote URL, exact scoped fetch, branch remote/merge references.
It refuses local/file/ext/helper/credential/escape/unknown-option forms. No network
permission or public endpoint trust is inferred. Structural tree-v1 and integrity
recapture remain unchanged, preserving retained exact receipt inspection/retry;
new publication/export use application checks in their existing pre-intent and
pre-mutation gates. Complete root handling, coherent capture and physical exclusion
remain incomplete. Local installed primary Git environment documentation was read;
no actual Git binary/provider/network acceptance fixture was run.

## Real native owner cut and rollout dependencies

The native closure report materially expands the proposed port: queue callbacks
reach real run-control/lifecycle/continuation/event writes; production run-dispatch,
wake-queue, queued-comment and watchdog adapters hold equivalent DML; two result-
ingest facades create native results/finalizations; finalizer/status processing
spans independently committed transactions; recovery/bootstrap/control/manual-
resolution/lease/session/workspace paths retain execution/release authority.
Moving queue claim alone or replacing callbacks with validator success is unsound.
The report lists actual added schema objects, source locations and unresolved
shared issue/lifecycle/plugin/raw-SQL/catalog/session edges. Complete transitive
ownership is still not installed and no blanket REVOKE/placeholder migration exists.

Strict physical-COMMIT release validity remains blocked on an authenticated real
primitive at the chosen irreversible boundary. The different monotonic fenced-fact
proposal remains explicitly UNACCEPTED. Existing accepted-retirement semantics,
original five-scope shared closure, exact intents/predecessors, deny order, stale
refusal and uncertain inspection remain untouched. Runtime provenance has no new
artifact inputs; missing exact authenticated package/build/source acquisition
package is unchanged. No repeated search or speculative hook was used to imply
progress there; runtime independently contributed actual adversarial component tests.

Next complete the real writer/callgraph/catalog cut, trusted complete root/profile
and coherent capture, actual authenticated runtime all-command/control/transfer/
recovery ownership and storage-side exclusion, independently current history/
high-water/custody and cross-owner intent/deny/inspection/settlement. Protected
old-owner stop/inspection must remain available when new work is held. Then an
exact immutable build/image/policy/RBAC/network/storage/workload/manual-migration
diff against existing external PostgreSQL can be reviewed. No root privilege
exception, deployment broker or second permanent database is approved. Changed full
build/typecheck graphs require authorized hosted capacity.

Reviewed rollout AND complete genuine original shared-hold reconciliation precede
ten bounded serial Codex tasks on existing B (<=10min/task, <=2h/stage), then Claude
coding/session/renewal/cancellation/disconnect/restart acceptance. Unknown/null/
run-only/unmapped/disappeared sources stay occupied. No B exemption or replacement.

## Final verification and preservation

Root serialized one cached exact-image disposable fixture: **98 PASS3.453s**:
22 owner,23 tree,16 actual pipe/journal,20 native models,9 child exec,8 adversarial
group tests. Exact final source hashes, command, full output, inspection, cleanup,
review and checkpoint under canonical `.handoff-state/2026-10-21/group-launch-continuation/`.
Image sha256:1eee6fcc4d866c86dd8e32a4a1a583767ddac0d640b0fe571b2c22d233b60eee;
UID1000:1000,network-none/read-only root,no mounts/ports,dropped caps/no-new-privileges,
64MiB tmpfs,256MiB RAM/512MiB swap-inclusive/1CPU/64PIDs. Exit0/OOMfalse/exact
container removed and absence rechecked. No pull/build/full graph/typecheck/hosted
action, new PG or prior root UID-switch fixture. Reuse prior evidence only for
unchanged exact inputs.

All10117 native files/HEAD/dirty status unchanged. Six assigned existing homelab
files changed out of481;475 preserved. Three new package files: adversarial test,
native closure report and this integration report. Both HEADs unchanged. No reset/
reapply/staging/commit/push/live inspection/mutation/provider/credentials/purchase/
publication/deployment/live migration/destructive action/merge. All A/original
shared-family holds, B paused, timers disabled/current capacity,draftPR5/human
merges remain; Gemini/backup/S3/monitoring deferred, backup release prerequisite
not waived. Operational acceptance remains false.
