# Stable Pod retirement fence — review dependency, 2026-10-19

This is a protocol proposal, not an implemented or approved authority/topology
change. Current receipts establish observations or successful stop of a pinned
sandbox; they do not establish permanent retirement of every incarnation of its
Pod UID. Keep native occupancy, canonical/attempt storage ownership and release
held until the stronger predicate below is independently verified. No live
installation, node operation, provider dispatch or historical hold change is
authorized by this document.

The [concrete 2026-10-20 design/rehearsal proposal](runtime-retirement-design-2026-10-20.md)
supersedes ambiguous barrier timing below: **T** commits deny intent and prevents
new authorization; **B** completes retirement only after every previously
forwarded effect settles and is terminated/accounted for. No retirement receipt
exists at T. A CRI-only proxy cannot guarantee no process starts after T, because
an earlier forwarded request may still execute. Mandatory effect/recovery
integration and independent retained history remain unimplemented/unapproved.

## Continuation implementation status

The current candidate adds explicit fail-closed retirement hooks to sequential
command execution and native stop recording. The original-sandbox verifier marks
`stableRetirement: false`, and Kubernetes `verify_retired` refuses unconditionally.
No approved runtime gate exists and no fixture observer is substituted for one.
These guards prevent treating the weaker receipt as release authority; they do
not implement the runtime transaction proposed below. Stale-kubelet and same-UID
replacement-sandbox execution remain unverified and capacity stays held.

## Gap in the current proof

The [Kubernetes 1.34 CRI contract](https://github.com/kubernetes/kubernetes/blob/v1.34.0/staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto)
requires successful `StopPodSandbox` to terminate sandbox processes and running
containers. Its request identifies one sandbox ID; success does not prohibit a
later sandbox or container creation for the same Pod UID. The
[kubelet runtime implementation](https://github.com/kubernetes/kubernetes/blob/v1.34.0/pkg/kubelet/kuberuntime/kuberuntime_manager.go)
contains sandbox reconciliation and creation paths. Treat stale/in-flight kubelet
work as a race to exclude; this proposal does not claim the current fixture has
demonstrated a particular replacement race.

A retained deleting Pod, terminal API status, `restartPolicy: Never`, exact
original container ID, one successful stop RPC and an empty original cgroup are
insufficient to prove the future exclusion. They also do not enumerate another
sandbox already created during the race. Kubernetes explicitly warns that
[force deletion does not confirm process termination](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_delete/).
Repeated polling or a quiet interval cannot turn these observations into a fence.

## Required independent enforcement boundary

The review candidate requires a protected gate on **every runtime start path for
managed Pod UIDs**, outside provider, controller and supervisor processes. A
reviewed runtime integration or mandatory CRI interception layer must mediate
`RunPodSandbox`, `CreateContainer` and `StartContainer`, resolve immutable
sandbox/container-to-Pod-UID mappings, and serialize them against retirement.
It must cover queued calls, runtime restart/recovery and alternate runtime clients;
a supervisor-only admission webhook does not intercept cached kubelet actions.

Provider UID 1000, supervisor UID 2000 and transfer non-root rules remain. None
receives node credentials, a host mount, raw runtime socket or generic runtime
RPC interface. The external gate's management interface accepts only a signed
exact retirement contract and inspection challenge, not shell commands, arbitrary
paths or caller-supplied claims that a process stopped. Independent signing
material and its protected ledger are absent from provider/supervisor mounts.

**No deployment mechanism is approved.** A privileged DaemonSet, the Docker test
broker, or giving a non-root process a broad runtime-socket group is not an
accepted workaround. Runtime-socket access is powerful authority regardless of
UID. Changing kubelet endpoints, installing a runtime plugin/proxy or introducing
host fencing requires a separate topology/authority review, exact bypass audit
and disposable acceptance. If that boundary cannot be provided within the
accepted rules, stable retirement remains unavailable and capacity stays held.

## Durable identity and fence state

Bind a new `pod-retirement-v1` contract to instance, immutable policy hash,
physical pool, node UID/boot/runtime incarnations, Pod UID, original namespace,
full native company/agent/run-or-operation/environment/lease/attempt/invocation,
committed command/journal hash, existing runner/account/workspace/session/
credential families and exact storage UID/incarnation. A current authenticated
controller epoch authorizes reconciliation of that original owner; it does not
rewrite the owner's historical epoch or receipt.

The independent gate records a monotonic, permanent **deny-start tombstone for
that Pod UID**. No resume, epoch update, timeout or cleanup removes it. Resume
requires separately admitted work and independently fenced storage ownership;
new Pod names/UIDs cannot create new scope families or bypass legacy occupancy.
Maintain durable sandbox/container-ID aliases, accepted in-flight start intents,
the retirement decision, stop RPC completions and gate incarnation/history hash.
Controller PostgreSQL independently pins the acknowledged history high-water.
A restored gate ledger cannot replace that pin or replay an older allow decision.

## Proposed retirement transaction

1. Native admission commits cancellation/retirement intent and its exact owner,
   command, storage and fence contract. Stop new native grants; request graceful
   exact-UID API deletion for cleanup. API deletion is not the exclusion barrier.
2. The independent gate authenticates the committed retirement authorization and
   takes the same per-UID serialization boundary as all runtime starts. Durably
   commit the deny-start tombstone **before acknowledging pending deny intent T**. Any
   already forwarded call is journalled as in-flight; wait for a determinate
   result or preserve uncertainty. Later authorizations fail before their runtime
   effect. Previously forwarded effects may still complete after T and remain
   occupied; the completed barrier B is not yet acknowledged.
3. After the barrier, independently enumerate every sandbox and container for
   the UID, including replacement sandboxes and aliases returned by prior start
   intents. Verify node/runtime incarnation and immutable ownership. Unknown or
   incompletely attributable resources retain occupancy; do not select only the
   original `physical.container` or treat missing metadata as successful cleanup.
4. Stop every enumerated exact sandbox through the independent runtime authority,
   durably record successful responses and account for all containers/processes.
   Re-enumerate only after every pre-barrier start intent has settled. Acceptance
   requires complete runtime inventory plus a reviewed kernel/process accounting
   method for this runtime version. Lost metadata or unaccounted processes require
   independent recovery evidence; no synthetic empty inventory or cgroup flag.
5. Only after all pre-T effects and aliases are independently settled/stopped,
   commit completed barrier B. Return a separately authenticated retirement receipt binding the tombstone
   sequence/history, complete incarnation set, start-intent barrier, termination
   evidence and fresh challenge. The native verifier commits its high-water CAS
   and receipt before marking the stronger retirement predicate satisfied. Lost
   acknowledgements recover this same decision; they never replay provider bodies.
6. The storage authority separately verifies no old execution can regain access,
   fences the exact storage incarnation and performs required workspace/session/
   credential restoration with version CAS and quarantine. Only the existing
   native release transaction may combine retirement and each restoration outcome.
   A stop receipt cannot itself unlock a volume, clear a hold or release capacity.

The runtime gate must remain enforced after receipt issuance, API-object removal,
controller restart and state transfer. Native revalidation must hold on authority
incarnation/history change. Resource finalizers are cleanup coordination only;
removing them never removes the runtime tombstone or permits new execution.

## Failure and rollback rules

| Event | Required result |
| --- | --- |
| Partition/API or runtime timeout | Retain occupancy and storage fence; no stop/absence inference |
| Crash before tombstone commit | No fence acknowledgement; native retirement remains pending |
| Crash after commit/before stop | Deny remains active on recovery; reconcile original in-flight intents |
| Successful stop, receipt lost | Recover durable exact receipt only after gate/history verification |
| Kubelet restart/stale queued start | Gate rejects the retired UID before any new runtime effect |
| Gate unavailable | Managed runtime starts fail closed; old active work stays accounted for |
| Runtime/node restart or unknown sandbox | Re-attest incarnation, enumerate/reconcile; do not mint a fresh empty pool |
| Gate ledger loss/rollback/history conflict | Hold all affected scopes; independent DB pin cannot be reset |
| Controller downgrade/restore | Dispatch blocked until compatible gate and native history revalidated |
| Unknown storage writer/attachment | No trusted mount or restoration/release; preserve quarantine |

Paperclip-only rollback must not roll back the external tombstone ledger.
Restoring both the native verifier database and gate ledger to matching old
snapshots does not establish safety: both anchors may have forgotten a retired
UID. Keep the current independent tombstone/history authority outside that
rollback, or leave dispatch held pending separately reviewed physical recovery
and incarnation attestation. Matching restored hashes alone cannot reopen starts.

A CRI proxy that can be bypassed by another socket/client is insufficient.
Gate startup cannot briefly expose the backend before tombstones and independent
high-water state are verified. Runtime recovery that can start containers without
passing the gate also invalidates this design and must be prevented or held.

Whole-node shutdown is not a normal fallback: it affects siblings and unrelated
homelab workloads. Power/boot fencing, if explored at all, belongs only to a
separately owned **exact disposable node** test and a new independent review.
No whole-node poweroff, node deletion, cordon or shared-node fencing is authorized
or accepted for the homelab by this proposal.

## Bounded disposable acceptance before integration

Use synthetic UID-1000 workloads and non-root control components. Inject a stale
kubelet/runtime-start client behind the proposed mandatory gate. Prove the
following with independently captured gate/runtime evidence:

* Race retirement against sandbox creation, container creation and container
  start, pausing at each pre/post-commit and pre/post-backend boundary. No new
  authorization succeeds after T; every pre-T forwarded result is settled,
  stopped/accounted for before completed barrier B. No same-UID execution can
  occur after B. A stronger no-effect-after-T claim needs effect-level ordering.
* Create multiple sandbox incarnations for the same UID and force loss of the
  original metadata/cgroup. The gate must account for all of them or stay held.
* Keep a sibling UID's descendant writing to separate storage throughout the
  retirement. Its process, callback and file bytes continue normally; no node-wide
  stop, cgroup sweep or foreign sandbox stop is permitted.
* Drop acknowledgements and restart each control component, kubelet, gate and
  runtime; replay old requests and restore old gate/controller snapshots. Unknown
  incarnations/history preserve holds; durable tombstones survive clean recovery.
* Test every raw runtime endpoint and alternate client route; bypass must be
  impossible under the reviewed node configuration. Test backend startup and gate
  outage, not only normal request handling.
* Attempt canonical mount/restoration before complete retirement and after an
  authority change; both remain blocked. Then prove independent restoration CAS,
  divergence quarantine and native release only for the exact fully proved owner.

No current test is credited for these new cases. A's historical SSH leases are
not protected Pod retirements: retain their original facts and shared Codex
families until their separate reviewed present-day physical/route/state evidence
passes supported native lifecycle re-evaluation. B stays paused; Gemini stays
deferred, timers off, live capacity held and PR #5 draft pending the full package.

## Smallest concrete decision for review — 2026-10-20

**Decision requested: authorize only a separately scoped runtime-authority design
and disposable proof project, or retain held execution.** No deployment approval
is requested or implied by the current admission candidate. Provider, transfer and
supervisor workloads remain non-root with no node credentials, host mounts or
runtime socket. Current topology alone supplies no stable-retirement authority.

The proposed smallest additional authority is an independently operated mandatory
runtime-start gate for a dedicated execution pool. Its authority is wider than
Pod CRUD: it must prevent **every** managed UID's `RunPodSandbox`,
`CreateContainer` and `StartContainer` effect, including runtime recovery and
already queued requests. It must persist irreversible deny-UID tombstones outside
controller/supervisor/canonical rollback and account for all pre-barrier effects.
A host/runtime integration is therefore a topology change even if its management
service runs under a non-root UID. No install manifests, raw socket delegation,
privileged DaemonSet or kubelet/runtime endpoint change is included in this PR.

Before approving that design project, the operator would select its ownership
boundary and supported runtime integration. The proposal must identify the exact
execution nodes/runtime build, every backend socket/client route, boot ordering,
ledger backup/restore exclusion and who can disable or replace the gate. A proxy
with an unguarded backend socket, a service that starts after runtime recovery,
or a gate that cannot account for in-flight effects is rejected. A dedicated
virtual machine/physical power boundary is a materially different topology and
requires its own explicit decision; it is not an implementation shortcut here.

The resulting project has these binary proof obligations:

| Obligation | Current evidence / required disposition |
| --- | --- |
| Every same-UID runtime incarnation crosses the start gate | Absent. API CREATE admission cannot establish this. Keep retirement false. |
| Every stale/queued start is ordered against a durable deny barrier | Absent. Original `StopPodSandbox` success covers that sandbox only. |
| Every pre-barrier sandbox/container/process is attributed and terminated | Original-sandbox fixture is narrower. Unknown aliases retain occupancy. |
| Tombstone/current-history survives restart and rejects rollback | No runtime authority exists. Matching restored DB hashes is insufficient. |
| Alternate clients, backend sockets and startup/recovery cannot bypass | No deployment boundary has been approved or audited. |
| Sibling execution remains unaffected during retirement | Earlier sibling cancellation evidence is not this new runtime proof. |
| Storage cannot reactivate before exact durable retirement is pinned | Interface fails closed; physical enforcement still requires separate proof. |

All rows must be satisfied by independent retained runtime evidence before native
stop recording, sequential execution, canonical activation or release can accept
`stableRetirement: true`. A successful actual Kubernetes-to-native CREATE test
only addresses new object consumption and cannot fill any missing row above.
