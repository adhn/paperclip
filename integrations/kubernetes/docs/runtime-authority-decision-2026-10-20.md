# Runtime authority decision: mandatory effect and recovery coverage

Status: **PROPOSED FOR HUMAN REVIEW; no authority selected or installed.**
The current topology cannot establish stable retirement. This package advances
the review decision and rehearsal specification only. No host installation,
privileged workload, runtime RPC, node shutdown, runtime-handler switch, pool
provisioning or live reconciliation is authorized by it.

The [host inventory](runtime-host-inventory-2026-10-20.md) and
[API inventory](runtime-current-inventory-2026-10-20.md) are saved observations,
not current-state attestations. They identify snap 8702, reported containerd
1.6.36, the configured `runc`, `kata` and `nvidia-container-runtime` handlers,
lower shim sockets and an additional daemon endpoint on think3. No new host
inspection or runtime execution was performed for this decision document.

## Smallest decision and its required deliverable

The proposed decision is to commission **one exact-build mandatory-boundary
feasibility review and deterministic protocol rehearsal**. Its outcome must be
either a named compatible implementation plus an exact proposed host/pool change
set, or a recorded failed obligation with execution still held. This is smaller
than choosing or installing a new pool/runtime. The existing dedicated-pool
concept remains conditional; a pool does not itself enforce retirement.

| Decision item | Concrete proposed disposition | Evidence still required |
| --- | --- | --- |
| Installed MicroK8s runtime | Treat snap/build/configuration identities as the review target only | Exact running executable provenance and complete start/effect/recovery call graph; file hashes alone do not establish either |
| Enforcement location | Require a boundary that cannot be bypassed by any managed start, exec, resume, restore or already-open input-write route | Named implementation and review of actual runtime effects; no CRI-only proxy or optional callback is accepted by assumption |
| Uncovered handler/daemon/route | Keep the entire affected owner/pool ineligible | Either mandatory coverage or separately reviewed non-bypassable exclusion and proof; a proposed allowlist does not disable a route |
| History and custody | Require independently retained current intent/deny history and protected issuer/verifier identities | Actual service/security placement, durable commit and recovery design; no backend or keys are selected here |
| Installation | Remain prohibited under this task | A later exact reviewed host/pool change set and explicit authorization |
| Legacy A/shared SSH routes | Preserve every original hold and Codex family | Separate current proof excluding the original routes/incarnations/writers, complete inventory and supported reconciliation; a future pool cannot prove their past retirement |

Human review can accept or reject this project boundary without accepting a
runtime safety claim. If no mandatory integration can cover the installed
runtime, report that result and retain the current holds. A VM runtime, separate
machine or power fence would require a distinct proposal and authorization.

## Required authority state machine

This is a semantic contract for review, **not an implemented wire API**. Bind
each record to the immutable native owner, original scope families, exact command
hash, cluster/pool, Pod UID, node UID and boot identity, runtime/configuration
identity, every backend alias, and physical storage contract. Unknown ownership
is occupied, never an unowned resource available for adoption.

| State / transition | Mandatory behavior | Crash, partition or lost-response result |
| --- | --- | --- |
| `HELD` → exact prospective intent | Independently commit the owner, operation ID and predecessor/current history before forwarding any dependent effect | Inspect the same operation. Never issue a fresh operation or replay its command body to discover whether it happened |
| Intent → effect authorization | Serialize authorization with current deny/revoke state at the unavoidable effect boundary; retain all queued/forwarded work | Keep pending work charged. A caller deadline or closed socket does not establish worker cancellation |
| Authorized effect → attributed result | Persist actual sandbox/container/task/process aliases and any unresolved execution or I/O | Unknown result remains occupied until independently attributed and settled |
| Any nonretired state → durable deny intent **T** | Deny further authorizations for the exact UID/owner; revoke future writes to existing streams under the same effect ordering | Return pending only. Existing accepted work remains charged and may still settle after T |
| T → completed retirement **B** | Settle or definitively exclude every accepted pre-T effect; stop all attributed execution and input-write workers; account for aliases on every possible old node/boot/runtime route | Missing endpoint, inaccessible old boot, queued effect, unknown worker or unverified alias prevents B |
| B → inspection | Return a fresh authenticated observation of the same permanent retired state against independently current history | No start, stream reacquisition or resume transition exists for this UID; missing continuity holds |

No finite TTL can safely expire an unresolved effect intent or UID tombstone.
Timeout is an availability result, not proof of cancellation or retirement.
T does not promise that a previously accepted effect cannot complete after T.
Any implementation claiming the stronger no-effect-after-T property must prove
linearization at the actual effect and completion of cancellation of every
previously accepted effect. This proposal requires the weaker explicit pending
period and the complete B barrier, without pretending a forwarding lock provides
the stronger guarantee.

Byte forwarding must have a separate exact stream/write sequence under current
authorization. A fresh open proof does not authorize all later writes. Work
already queued in a stream worker or socket at T remains part of pre-T accounting;
B cannot ignore it because the controller closed its connection. Runtime worker
quiescence and physical stale-writer exclusion remain separate obligations. A
runtime B artifact cannot attest that kernel/backend storage I/O has drained.

## Route coverage obligations on the observed installation

Every row needs an actual enforce-or-exclude proof before the boundary can be
accepted. “Exclude” requires independent enforcement and verification; it cannot
mean “the normal client does not use this route.” No such proof is supplied here.

| Observed or unresolved route | Required boundary evidence and failure behavior |
| --- | --- |
| Main MicroK8s `/var/snap/microk8s/common/run/containerd.sock` and `.ttrpc` | Cover all namespaces and applicable APIs, queued daemon work and existing clients; CRI-only denial is insufficient |
| `runc` / `io.containerd.runc.v2` and lower `/run/containerd/s/<id>` shim routes | Cover task creation/start, exec, resume, checkpoint/restore and reconnect/recovery effects as applicable to the exact build. EACCES during inventory is unknown ownership, not absence |
| Configured `kata` handler | Establish installed/usable state and actual backend, then prove mandatory coverage or independently enforced exclusion. Do not silently replace runc with a VM runtime |
| Configured `nvidia-container-runtime` handler | Establish actual BinaryName/wrapper chain and effect routes; prove coverage or independently enforced exclusion. Shared runtime type does not prove identical enforcement |
| think3 `/run/containerd/containerd.sock` and `.ttrpc` | Identify owning service, executable/configuration, namespaces, clients and recovery path; prove it cannot start or retain any managed owner outside the boundary. Root-only socket metadata is not this proof |
| Runtime maintenance, restart managers and restore tooling | Enumerate real administrators and credentials; show that ordinary boot/recovery cannot expose a start-capable backend before history/intent recovery. Uninventoried maintenance routes block acceptance |
| Operator `microk8s` configuration writers, think3 Docker membership, host root | Document the trusted administrator boundary and any independently retained audit/history access. Group membership does not prove a runtime request succeeds, but cannot be omitted from bypass review |
| Stale kubelet, old node/boot and same-UID replacement sandbox | Local enforcement must survive API isolation and retain original owner attribution across all incarnations. A new Node UID/name or successful Pod deletion cannot retire the old owner |

Bootstrap begins held. Runtime restart, gate restart, snap revision change,
handler/configuration change, node-name reuse and key rotation all require
validated lineage and current independent history before any effects. Gate and
runtime restart in either order must have no allow window. Existing unknown
tasks/shims remain charged; recovery inventory must not create authority to start
or resume them. An unavailable old node is not evidence that its kubelet/runtime
cannot later act.

The proposal does not claim protection against a trusted independent host-root
administrator deliberately disabling enforcement. That trust boundary must be
explicit in the exact change set. Provider, supervisor and transfer identities
receive no host authority, runtime sockets or privilege as a consequence.

## Independent history and cross-authority handoff

Before any allow, the authority must know a current independent history head,
retain a durable prospective intent against it and ensure effects cannot race
past current deny/revoke ordering. An old locally consistent DB/config/history
snapshot is insufficient. If independent history is ahead of local state, the
only automatic action is exact inspection and continued occupancy; it is not a
reset, new family, new empty pool or permission to rerun.

Completed B artifacts must bind T/B ordering, exact owner/command/physical
contract, all execution incarnations/aliases and current protected history.
Native must authenticate and durably commit that evidence under its own CAS
before dependent transitions. Canonical storage must separately authenticate
current history, physically exclude old writers and use root-group activation
CAS/high-water. Lost native/storage replies retain external intent/ownership.
Neither a runtime signature nor successful stream cancellation releases storage
or native capacity. See the [physical authority decision](bootstrap-review/physical-storage-authority-decision-2026-10-20.md)
and [activation sequence](bootstrap-review/evidence-activation-sequence-2026-10-20.md).

## Reviewable bounded rehearsal specification

This specification has **not been executed**. It introduces no fixture broker,
observer, installer or apply-ready manifest. Existing hosted passes remain
credited only to their original source/fixture scopes.

1. **Evidence/call-graph stage:** produce one route matrix against snap 8702 and
   the exact candidate build. Record each endpoint/client/handler, effect method,
   recovery method, mandatory gate point, administrator and independent history
   dependency. Stop on an uncovered route. This stage performs no runtime RPC.
2. **Deterministic protocol stage:** root schedules one serialized synthetic
   harness within the shared 3 GiB RAM / 5 GiB including swap / two CPU / 256 PID
   ceiling. Two owners, at most four processes each, no provider credentials or
   canonical volumes, 30-second fault deadlines and a 20-minute whole-stage
   ceiling. Control six cut points: before intent commit; after commit/before
   forwarding; after forwarding/before effect; after effect/before result commit;
   after result commit/before reply; after T/before B. At each point inject one
   lost reply or crash plus retirement/revocation. These are proposed caps, not
   measured resource sufficiency. Model results cannot establish runtime safety.
3. **Actual-runtime stage:** prepare a separate exact disposable host/VM plan
   only after implementation selection. Installation/execution is outside this
   task. Its proof matrix must include every route above, delayed same-UID
   sandbox replacement, stale kubelet during API partition, queued exec/resume,
   shim survival/reconnect, daemon/gate restart in both orders, node/boot reuse,
   and controller plus local-ledger rollback while independent deny history stays
   current. Whole-node fencing of shared nodes is excluded.
4. **Native/storage stage:** only after real independently enforcing runtime and
   storage backends exist in separately approved disposable infrastructure,
   race B/native CAS loss and root-group activation/rollback conflicts. Missing B,
   storage exclusion, history continuity or any restoration outcome must deny
   both next-command execution and capacity release.

Each stage emits immutable input identities, a chronological intent/effect/T/B
trace, worker termination observations, exact resource aliases, history heads,
expected/observed refusals and cleanup disposition. Require no post-B execution
or write, no falsely completed B while a cut point is unresolved, no stale
history allow, no scope rekey and byte-identical sibling sentinel output. An
independent actual-runtime process observer is evidence collection only; it is
never the retirement authority and must never deploy to the homelab. A failed
cleanup stops the stage, retains its occupied disposable target and records the
failure without issuing any receipt or sweeping unrelated resources.

## Disposition

**Implemented:** this decision specification and its linked design clarification.
**Verified:** consistency review against the saved host/API inventory and existing
T/B, storage and activation contracts; no executable runtime verification.
**Blocked:** compatible mandatory effect/recovery implementation, independent
history/key custody, complete route proof and any host/pool installation.
**Open:** actual-runtime and assembled physical-storage rehearsals, real backup/
recovery acceptance and full legacy shared-route reconciliation.

Both historical A holds and original Codex families remain unchanged; B remains
paused per saved evidence, Gemini deferred and timers off. PR #5 stays draft.
No serial B task, Claude check, overlap or capacity expansion follows from this
package. The ten bounded serial Codex tasks begin only after reviewed rollout
and complete shared-hold resolution; Claude lifecycle/session/refresh follows.

## Source-only protocol continuation

`protected-execution/production/runtime_boundary.py` now supplies the explicit
`MandatoryRuntimeAuthority` interface for recovery before backend exposure,
prospective intent commitment, authorization at the actual effect, exact intent
inspection, ordered revocation and completed-retirement inspection. Every default
method raises a held result. No implementation is selected, instantiated or
installed, and no real receipt is issued. A method override cannot establish that
a route is mandatory. Actual backend atomicity, independently durable history,
key custody, physical inventory and unavoidable runtime integration remain blocked.

The same module includes an explicitly named `RuntimeBoundaryRehearsal`, separate
from the unavailable authority interface. It is a deterministic in-memory model,
not an adapter or runtime. It requires the full synthetic route/effect cross
product (including lower shims, alternate handlers, maintenance, recovery and
individual writes), retains exact immutable owner/UID/original-scope bindings,
and distinguishes unaccepted intentions from accepted unresolved work. T denies
future acceptance; accepted pre-T effects can settle afterward and remain charged
until exact alias/worker termination. B requires every intent settled or denied
before acceptance, every attributed alias stopped and the full supplied
incarnation set. The only barrier output is marked `synthetic-runtime-barrier`,
which is not a native/storage retirement artifact.

Restart begins held and requires an exact snapshot match with the independently
retained *model* object plus all known incarnations. A stale joint controller/local
snapshot cannot overwrite that object. A second model instance with an outdated
revision is held until exact recovery; no command body is replayed. This models
history ordering but provides no durable store, independent verifier, protected
keys or real rollback resistance. Caller-supplied route and alias facts are
synthetic inputs and cannot establish mandatory coverage, actual worker death or
physical stale-I/O exclusion. Unknown effects have no expiry/release transition.

The affected unittest module covers six crash/lost-reply cut points, a separately
attributed unchanged sibling, every missing route/effect pair, post-T settlement,
per-write ordering, unknown workers, lost/incomplete incarnation inventory,
rollback, permanent UID tombstones, exact inspection, alias collisions and
bounded occupancy. The model uses two owners, at most 64 retained effects and at
most four aliases per effect; it creates no processes, sockets or filesystem
state. Root schedules the serialized affected test within the shared 3 GiB RAM /
5 GiB including swap / two CPU / 256 PID envelope. Execution evidence belongs in
the integrated verification report; this source addition alone is not a test pass.

**Implemented:** refusing mandatory-backend interface and bounded deterministic
protocol rehearsal. **Verified:** only the affected synthetic test result when
recorded by root. **Blocked:** actual mandatory runtime implementation, real
intent/history/key custody and stable retirement. **Open:** exact-build call-graph
proof, actual-runtime fault rehearsal and native/storage operational integration.
The earlier real-runtime rehearsal remains unexecuted. All legacy A/shared-family,
B, Gemini, timer, draft-PR and broader acceptance holds above remain unchanged.
