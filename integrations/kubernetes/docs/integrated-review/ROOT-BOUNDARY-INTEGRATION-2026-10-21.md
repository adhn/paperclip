# Root boundary continuation integration — inactive source

Latest completed baseline: effect-custody-continuation, selected after local newer
handoff search. Exact disjoint ownership and later root-only owner-integration
extension were recorded before edits. Root coordinated exactly three parallel
subagents, no children; root alone Git/index, shared interfaces and fixture scheduling.
Read [native port](NATIVE-TRANSACTION-PORT-2026-10-21.md),
[storage](CANONICAL-OWNER-2026-10-21.md) and
[runtime acquisition](RUNTIME-PROVENANCE-REQUIREMENTS-2026-10-21.md).

## Implemented mechanisms and review corrections

`production/detached_exec.py` is a real dedicated child entrypoint: nonroot/single
UID/GID and single-thread refusal; owner-private detached cwd; pipe/null inheritable
stdio only; Linux no_new_privs and private umask; default signal dispositions;
actual /proc descriptor enumeration closes all >2, including descriptors above a
lowered soft limit, before execve with explicit bounded argv/environment. CLI resets
environment to PATH/HOME/LANG. No UID switching/root exception, shell, runtime hook,
launch receipt or current-generation permission is supplied. Failure exits125
silently, including when stderr itself is a rejected canonical writable capability.
This fixes the independent review finding; CLOEXEC stdio now refuses before exec.

Eight actual subprocess regressions cover cwd/environment/umask/no_new_privs,
unknown inheritable high descriptor closure and surviving parent custody, rejected
regular stdout/stderr, CLOEXEC stdio, private directory/symlink refusal, failed exec,
and canonical publication→detached export→child write without canonical mutation.
That last test exercises real owner/file/exec mechanisms, not route-label lookup.
It is not an authorization composition: export and exec remain distinct operations,
with no runtime T/B or deny-to-exec atomicity. Same-UID parent proc, existing memory
mappings, alias descriptors/credentials and shared mounts need independent exclusion.

Storage adds a conservative Git application subset: Git external-root metadata,
internal symlinks, active hooks and unsupported config refuse. Only narrow simple
standalone core config is supported; ordinary remote/branch config may refuse.
This intentionally does NOT complete application root resolution. Ambient HOME/XDG/
Git/provider config and complete workspace/session/credential roots need actual
trusted launcher closure. Physical storage placement and trusted coherent capture
remain absent.

Root corrected compatibility during integration: structural tree-v1 validation and
materialization remain format-compatible. Canonical integrity recaptures bypass the
new application policy, so prior accepted exact receipts remain inspectable/retriable
after restart and deny. The stricter gate applies only to NEW publication (pre-intent)
and export (complete group before destination mutation). Two owner regressions prove
legacy retention and new unsafe-group refusal without poisoning. Durable intents,
whole-group CAS, global unresolved-intent hold, persistent deny and exact inspection
remain in the actual owner.

## Concrete owner port and rollout order

The new native report specifies proposed exact commands/results and actual
scheduler/scope/agent/issue/wake/run, provider/lifecycle/cleanup/reconciliation
predicates. Current lock graph is richer than scheduler→issue→wake→run: sorted
scope locks, agent NOWAIT and advisory legacy lock also matter. The actual port
must move these bodies together, remove arbitrary transaction/restoration callbacks,
optional claimDatabase fallback and equivalent direct DML/role/function/session
access. Exact tables, partial transitive closure and missing catalog role/session
artifacts are explicit. No placeholder SQL or validator-only owner was installed.

Strict physical COMMIT release validity remains blocked. A real authenticated
primitive must prove its selected irreversible boundary; alternatively the different
monotonic fenced-fact requirement needs explicit acceptance and real permanent
retirement. That alternative remains UNACCEPTED. Existing accepted-retirement
semantics and every original five-scope shared-family hold remain untouched.

Actual all-command/control/transfer/recovery integration still must replace optional
SSH protected branches and unjournalled setup/epoch/old-owner stop/transfer paths
identified in the runtime report. Protected exact old-owner control must remain
available under new-work deny. A child FD scrubber cannot replace authenticated
compatible containerd/shim/handler effect ownership, settlement of pre-deny accepted/
partial/unknown work, or independently current history/high-water. No new source
artifact became available; exact missing authenticated acquisition package is recorded.

Before activation, install reviewed external isolated provider identity/mounts and
exclusive canonical identity/PVC/endpoint, trusted coherent snapshot authority,
complete application roots, real old-writer/session/credential/restore-endpoint
retirement, independent history/custody and cross-owner intent/deny/inspection/
settlement. Only then can exact immutable image/build provenance and namespaced
policy/RBAC/network/storage/workload/manual-migration diff against existing external
PostgreSQL be complete. No deployment broker/root privilege exception is approved.
Full changed builds/typecheck graphs require authorized hosted capacity.

Reviewed rollout AND complete genuine original shared-hold reconciliation precede
ten bounded serial Codex tasks on existing B (<=10min/task, <=2h/stage), then Claude
coding/session/renewal/cancellation/disconnect/restart. Unknown/run-only/unmapped/
disappeared sources stay occupied. Synthetic success is not operational acceptance.

## Final exact verification

Root serialized three small cached-image runs; final **86 tests PASS1.946s**:
22 canonical owner,20 tree,16 actual pipe/journal,20 native models,8 child exec.
Final input hashes match source. First82/second83 runs retained for exact historical
inputs; final corrected compatibility is verified by86. Exact command/output/input
hashes/inspect/cleanup/review/checkpoint under canonical
`.handoff-state/2026-10-21/root-boundary-continuation/`.
Cached image sha256:1eee6fcc4d866c86dd8e32a4a1a583767ddac0d640b0fe571b2c22d233b60eee;
UID1000:1000,network-none,read-only root,no mounts/ports,dropped caps/no-new-privileges,
64MiB tmpfs,256MiB RAM/512MiB swap-inclusive/1CPU/64PIDs. Exit0/OOMfalse; exact
container removed and absence rechecked. No pull/build/full graph/typecheck/hosted
action, new PostgreSQL or former root UID-switch fixture. Prior results apply only
to unchanged exact inputs.

All10117 native files/HEAD/dirty status unchanged. Six assigned existing homelab
files changed out of477;471 others preserved. Four new package files (entrypoint,
its test, native port report, this integration report). Both HEADs unchanged; no
staging/commit/push/reset/reapply. No live inspection/mutation/provider calls,
credentials/purchases/publication/deployment/live migration/destructive action/merge.
All A/original shared-family holds, B paused, timers disabled/current capacity,
draft PR5/human-reviewed merges remain. Gemini authentication and backup/S3/monitoring
stay deferred; backup release prerequisite is not waived. Acceptance remains false.
