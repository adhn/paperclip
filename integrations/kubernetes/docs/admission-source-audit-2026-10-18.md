# Admission source audit — 2026-10-18

## Verified baseline

Flux is Ready at homelab `316a0a4d5824cedb33fb0b6cdde37fe611253dc4`.
All four evaluation controller/runner pods are Ready with zero restarts. The
controller's actual image is
`sha256:8bd2d8ccef956c777ea6eefa2004152632e0781706031e8cd42ef89bdd7c50ca`.
At 15:22 UTC, the authenticated API reported health ok, no queued/running entries
in the latest 100 runs, B fully paused, both historical A agents manually held in
pausing, all six agent timers disabled. Codex/Claude ordinary agents remain ready;
Gemini remains paused/verifying and unauthenticated. No model dispatch or live
mutation was performed. This snapshot does not prove absence of arbitrary remote
processes; the previous remote process evidence remains October 16.

The original homelab checkout remains unchanged at `805209b`. A separate checkout
was advanced to current main. Upstream `252d9b5077f4eee98ec48225641ef1a02d824158`
was reconstructed from Git objects and both hash-guarded PR #3/#4 overlays applied.
All nine files in [source-attestation.json](../fixtures/admission/source-attestation.json)
match SHA-256 hashes read from the running controller. This attests those files,
not the entire deployed filesystem or an independently reproduced binary digest.

## Start paths and necessary guards

Paths below are upstream-relative at the attested revision. This is an inventory
of relevant entry points; adapter transports still require a final exhaustive
call-graph/negative-path check as part of integration.

| Path | Current entry | Admission integration |
| --- | --- | --- |
| Manual, assignment/comment, delegated, timer, routine and repair wakes | `heartbeat/queue.ts` `enqueueWakeup`, `startNextQueuedRunForAgent`, `claimQueuedRun` | Retain native coalescing/dependencies/budget/issue authority. Native queued records own no slot. Shared scheduler must reserve atomically with all claim variants. |
| Direct queued execution | `heartbeat.ts:1796` `executeRun` calls `claimQueuedRun` | Same atomic grant; no alternate per-agent authorization. |
| Already-running/restart execution | `heartbeat.ts`, `heartbeat/recovery.ts` | Require exact attempt/owner token; recover existing reservation without relaunching uncertain work. Native recovery paths must be explicitly excluded or guarded for the SSH-only policy. |
| Workspace/setup acquisition | `environment-runtime.ts:1203` `ensureSshWorkspaceReady` | Setup performs remote work before provider invocation, so provider-call-only admission is too late. Charge before acquisition and retain through restore. |
| Legacy provider dispatch | `heartbeat/runtime-execution.ts:789` `adapter.execute` | Recheck policy/authority and bind selected target/lease to reservation before invoking adapter. |
| Board adapter test | `routes/agents.ts:3298` | Both managed-AI and ordinary adapter test branches need probe admission before target preparation, not just around the last call. |
| Managed test and provider fallback | `agent-environment-test.ts:486,520` | Multiple tests may invoke CLI; charge one owned probe lifetime and preserve unresolved stop/state holds. |
| Lifecycle setup/resume verification | `agent-harness-verification.ts:69` | Calls adapter tests independently of heartbeat; must use the same account/runner/credential gate. Stop/inspection remains available at full capacity. |
| Saved and unsaved environment probes | `routes/environments.ts:1390,1429`, `environment-probe.ts:273` | SSH probe calls workspace preparation; it is not metadata-only. Unsaved/aliased targets need canonical trusted runner mapping or denial. |
| Device login/setup | `device-login-service.ts`, operator SSH helpers | Current supported app login is sandbox-oriented; SSH setup remains operator-side. Explicitly deny unsupported app paths and require a drained/reserved target for sanctioned operator commands. No Gemini login. |
| Runtime services/other adapters | `environment-runtime.ts:4479` driver execution and adapter registry | Audit resource scope and reject unsupported execution paths under the initial SSH policy; arbitrary runner shell descendants remain resource-bound outside controller admission. |

## Native lock order

`withAgentStartLock` is process-local and may continue after 30 seconds. It cannot
provide cross-controller capacity exclusion. Normal claims lock the issue and
then update the run. Queued-comment claims lock **issue → wake → run**. Automated
chat-control claims take the same order with NOWAIT and may additionally lock a
conversation. Enqueue paths can start from an agent lock or issue lock. Native
review claims are separate. A new scope lock inserted into only one branch can
deadlock against another or leave a bypass.

The fixture takes **scheduler → scope keys (sorted) → attempt**, with all capacity
mutations serialized by the scheduler row. Production integration must establish
**scheduler → existing native issue/wake/run order**, preserving cancellation and
recovery behavior across every path. Do not hold a transaction around SSH, provider
work, downloads or post-commit callbacks. Do not call the current full queue method
inside a long transaction: it contains post-commit lifecycle effects and recursive
promotion. Extract the claim transaction boundary and test races against the
assembled heartbeat service before enabling it.

## Remote fencing gap

`packages/adapter-utils/src/ssh.ts:1368` creates the random invocation ID inside
`createSshSpawnTarget`; PR #4 records it later through the final-invocation stop
callback. There is no controller admission attempt journal before this launch.
The existing supervisor fences cancellation for that invocation directory, but
does not reject a second launch of the same invocation or implement runner-wide
controller epochs. Database epoch changes alone therefore cannot fence delayed
old SSH starts. This does not invalidate the previously passed cancellation tests.

The new [remote fixture](../fixtures/admission/remote-fence.py) demonstrates the
required boundary: persist exact attempt binding, atomically consume launch under
a remote epoch lock, preserve pre-start tombstones, reject duplicate launches,
and compare-and-set epoch advancement. It is not installed in the transport.
Integrate within the existing subreaper before claiming remote recovery safety.

## Release boundary and rollout

The heartbeat finally block terminalizes before releasing environment leases and
performing cleanup (`heartbeat.ts:3650–3858`). Some cleanup failures are logged and
swallowed. The shared reservation must not release simply because this block exits
or because the run is terminal. It needs independently persisted process stop and
authoritative workspace/session/credential restoration success, including setup
failure and cancellation before launch. PR #4's exact lease receipt is one input.

Both historical A records must become visible unresolved occupancy before enabling
admission; do not mint receipts or silently exclude them. This may block Codex
admission until separate historical reconciliation. Maintain the explicit
evaluation-only backup exemption without claiming working backups. Rollback after
enabling requires drain/reconciliation because the previous controller bypasses
capacity reservations.

The current change is a non-deploying foundation: source evidence plus executable
database/remote-fence fixtures. Remaining work is application schema/service and
all-path integration, canonical state/account identity, receipt-based reconciliation,
fair wake/sweep, operator visibility, assembled regression tests, reviewed image
rollout and bounded serial live acceptance. No capacity increase is authorized by
these fixture results.
