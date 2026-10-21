# Mandatory runtime retirement: bounded design for review

Status: **DESIGN ONLY; execution remains held.** The current topology cannot
guarantee stable retirement. This document implements no runtime authority,
installer, receipt issuer or topology change. It refines the
[retirement contract](pod-retirement-fence-review-2026-10-19.md), with the
[physical-storage decision](bootstrap-review/physical-storage-authority-decision-2026-10-20.md)
as a separate dependency. No privileged workaround, runtime socket delegation,
host installation or live operation is authorized.

The [concrete authority decision](runtime-authority-decision-2026-10-20.md)
now narrows the next review to an exact-build feasibility project, a mandatory
intent/effect/T/B state machine, an explicit route coverage matrix and bounded
rehearsal deliverables. It incorporates the saved snap-8702 host inventory,
configured alternate handlers, lower shim routes and think3's extra daemon.
No compatible integration or new execution pool is selected by that proposal.

## The precise decision

Review a design/rehearsal project for a **mandatory effect-level runtime boundary
with a conditional dedicated execution pool**, independently operated from Paperclip. Reject a
CRI-only proxy as sufficient proof: an already forwarded request, direct runtime
client or recovery path may act below it. A compatible runtime integration must
order every managed sandbox/container/task start against the permanent deny
history, or the project stops with stable retirement unavailable.

This is the smallest proposed authority expansion that preserves the non-root
provider/supervisor/transfer model. It is still a material node/runtime topology
change. Selecting the project does not select a runtime build or authorize its
installation. The alternative within current authorization is continued held
execution; changing to disposable VMs or power fencing needs a different review.

## Two barriers, not an ambiguous stop timestamp

Let **T** be durable deny-intent commitment for the exact Pod UID, and **B** be
completed retirement. After T, no new start authorization is accepted. A request
authorized before T may already be inside the runtime and may take effect while
retirement is pending. It remains occupied and must settle, be attributed and be
stopped before B. A timed-out request is not settled. After B, no incarnation of
that UID may execute again under the accepted authority/history.

Therefore a CRI request journal cannot alone claim "no process starts after T".
That stronger claim requires the serialization boundary at the actual runtime
effect, including recovery, not just at RPC forwarding. B requires no unresolved
pre-T effects and independently verified termination of every attributed process.
An early acknowledgement of T is a *pending fence*, never a retirement receipt.
The authority must distinguish these response types so neither native nor storage
code can turn pending acknowledgement into `stableRetirement: true`.

## Proposed authority and topology delta

| Component | Proposed authority | Explicit exclusions / incomplete implementation |
| --- | --- | --- |
| Dedicated managed execution pool | Fixed allowlisted node UIDs, immutable runtime/config identities and mandatory effect/recovery integration | No shared-node poweroff, broad cgroup sweep or unrelated workload termination; pool provisioning not approved |
| Node runtime enforcement | Reject starts without a committed exact native claim; permanently reject retired UIDs; preserve sandbox/container/task aliases across runtime recovery | No reliance on mutable labels, caller-declared managed status or only original sandbox ID; implementation/build unresolved |
| Independent retirement control | Authenticate exact stop/inspect requests; order T/B; stop only attributed owner resources; sign complete receipts | No shell, arbitrary paths, generic runtime API, attach/exec or caller-supplied stopped facts |
| Independent retained history | Durable deny/history chain and current high-water anchor outside Paperclip DB/files rollback; protected signing identity | SQLite fixture ledger, restoring two matching old snapshots and an observer's string are insufficient; operational backend unresolved |
| Native verifier | Pin authenticated current authority/history, exact ownership and completed B receipt transactionally before returning proof identity | Cannot issue a physical receipt, reset history after restore, release storage or clear legacy holds |
| Canonical storage authority | Independently exclude old writers, verify pinned B and current history before restoration/activation CAS | Runtime receipt alone supplies neither storage exclusion nor restored state correctness |

All APIs and objects need dedicated namespaces where Kubernetes applies. Node
runtime integration is necessarily host authority; calling its client non-root
does not reduce that authority. Provider UID 1000, supervisor UID 2000 and transfer
remain non-root, without host mounts, runtime sockets, node credentials or generic
Kubernetes exec/attach. Independent operators own gate configuration/signing and
storage authority; Paperclip cannot disable either through its service account.

The runtime gate must reject unknown mappings on the managed pool, including a
request that omits or changes identifying labels. A physical execution may not
escape enforcement by selecting another runtime handler, containerd namespace,
node or API route. The scheduler/admission policy must reject placement outside
the fully attested pool; each pool node must enforce the boundary locally even
when the API server is partitioned. All approved pool members/history must be
accounted for; an unreachable possible owner prevents B. Node replacement or a
reused node name does not prove the former node/boot is retired.

The reviewed threat boundary excludes an operator with independent host root
deliberately disabling enforcement. Such an operator is a trusted authority, not
an adversary a namespaced workload can constrain. The bypass inventory must
identify exactly these administrators and recovery credentials. Undocumented
clients or privileged maintenance routes are proof failures, not assumed away.

## Required integration interface

These are semantic requirements, not an accepted new wire schema:

1. `requestRetirement` authenticates the exact native committed journal and
   immutable owner: instance, company, agent, run-or-operation, environment,
   lease, attempt, invocation and command. Bind original scope families, policy,
   pool/cluster identity, Pod UID and full physical storage/root contract hash.
   A current controller epoch can reconcile the original owner; it cannot replace
   its historical epoch or create a different logical family.
2. The authority commits T and serializes all start effects for that UID. Keep
   durable accepted intents and aliases, including backend results lost to the
   caller. Resolve every pre-T intent or keep the retirement pending. Stops are
   exact-owner and do not depend on mutable Pod status/labels alone.
3. `inspectRetirement(challenge, minimumHistory)` returns either a pending/held
   result or a separately authenticated completed-B artifact. A completed artifact
   binds T/B sequences, authority/key and history identities, all node/boot/runtime
   incarnations and resource aliases, full owner/contract digest, stop/process
   accounting evidence digest and fresh inspection challenge. Collection/signing
   must occur outside provider/supervisor authority. Time alone establishes no B.
4. Native independently checks signature/trust pin, current authority/revocation,
   history not below its retained floor, exact command and full physical binding;
   it commits the receipt/history CAS before returning a proof identifier.
   Concurrent or lost acknowledgements recover the same decision, never replay a
   provider body. A structurally valid string is not this durable commitment.
5. Storage independently checks the same exact receipt and *its own* retained
   current history before any provider-returned-state read, canonical mount or
   restore/activation. Keep workspace/session/credential outcomes distinct. A
   storage attach cleanup after failure closes streams only; ownership and native
   occupancy remain charged. Native release follows its existing full predicates.

Completed retirement is permanent for the UID. Receipt freshness establishes the
current authority/history binding; expiry does not resurrect the UID. Authority
key replacement, pool movement or history change requires independently verified
continuity. Missing continuity, ledger rollback or loss holds all affected scopes.
Do not delete tombstones on a timeout, resume, API deletion, backup retention
expiry or controller downgrade.

## Startup, recovery and in-flight failure cases

The runtime must not expose a start-capable backend until its effect gate has
validated independent current history and recovered all accepted intents. A
startup unit ordering declaration is configuration evidence only. Runtime task
reattachment/resume, shim reconnect, restart managers and alternate runtime
handlers must be audited for actual start effects. Existing unknown running
processes remain occupied; rejecting new RPCs does not retrospectively stop them.

| Case | Required observable result |
| --- | --- |
| Stale kubelet requests another sandbox for the retired UID | Refused at mandatory boundary; no unaccounted runtime effect |
| Previously forwarded create/start returns after T | Original intent retained; B pending until exact result settled and stopped |
| Backend succeeded but response/metadata was lost | Independently recover exact aliases/process ownership, or stay held |
| Multiple same-UID sandboxes on one/multiple possible pool nodes | All included in the decision; unreachable/unknown ownership blocks B |
| Gate/runtime restarts in either order | No startup allow window; old work re-accounted; tombstones retained |
| Raw task API, alternate handler or direct socket is reachable | Rejected integration; no claimed stable retirement |
| Old Paperclip DB and old local gate state restored together | Independent current history denies stale authority; starts stay held |
| Receipt exists but native commit failed/lost its response | Recover exact committed receipt or stay held; no release from caller assertion |
| Runtime proof succeeds but storage detach/alias proof is absent | No canonical activation, next command, adoption or release |

## Bounded disposable rehearsal proposal

No new rehearsal was run by this design track. Existing hosted runs prove their
recorded narrower contracts; none is credited as effect-level retirement proof.
Use synthetic credentials/data only. Do not install a new runtime on a homelab
node. A separately reviewed disposable host/VM and exact runtime build are
prerequisites; kind/Docker observers alone cannot prove mandatory host enforcement.

Stage 1 is read-only design inventory: pin candidate runtime source/build/config,
all socket endpoints/clients/handlers, recovery/start call graph, host ownership,
boot dependencies, durable backend and independent history/backup ownership.
Deliver a bypass matrix. Stop here if any actual start/recovery route cannot be
guarded. Do not code a proxy and infer that the matrix has been satisfied.

Stage 2 is a deterministic protocol harness, explicitly subordinate to later
actual-runtime evidence. Use two synthetic UIDs and controlled gates at six
points: before intent commit, after commit/before forward, after forward/before
effect, after effect/before result commit, after result commit/before reply, and
retirement after T/before B. For each point inject cancellation plus one crash or
lost reply. Record the exact start/stop trace and demonstrate that incomplete
knowledge holds. The two UIDs share a runtime but no writable storage; sibling
output must continue byte-for-byte. Model success does not implement protection.

Stage 3 requires a separately approved actual-runtime disposable installation.
Exercise same-UID replacement sandboxes, multiple accepted in-flight calls,
stale runtime clients during API partition, runtime/kubelet/gate restart in both
orders, missing runtime metadata, shim/task reconnect, handler/namespace/socket
bypasses, node-name reuse and independent history rollback. Continue a sibling
descendant throughout exact retirement. Independently capture the kernel/runtime
process inventory and gate history; provider output is only a sentinel. A failed
stop or unknown alias must yield a pending hold and no native stopped commit.

Stage 4 integrates native PostgreSQL and a real independently enforcing storage
backend in disposable infrastructure. Race receipt/native commit loss, storage
CAS conflicts, endpoint/gate restart, controller-only restore and joint stale
controller/local-ledger restore against the retained current anchor. Before B or
with missing storage evidence, attempt activation and the next command: both
must refuse. After exact completed B plus all independent restoration outcomes,
prove only the native transaction releases capacity. Do not use fixture SQLite
or structural callbacks as production authority.

Local stages must fit the shared 3 GiB RAM / 5 GiB including swap / two CPU /
256 PID envelope and reserve that budget with root; actual runtime builds and
server graphs belong on separately approved hosted capacity. Propose one
serialized fixture, two synthetic owners, at most four processes per owner,
30-second fault-step deadlines and a 20-minute whole-stage ceiling. These are
proposal bounds, not measured resource sufficiency or permission for a privileged
host fixture. A cleanup failure stops the stage and retains the disposable target
for independent recovery; it never creates a receipt or triggers homelab cleanup.

## Completion and holds

The design project is complete only with a concrete compatible runtime/backend,
reviewed exact host change set, enumerated administrators/bypass routes and all
actual-runtime/history/storage proofs. If that is unavailable, record the failed
obligation and retain held execution. This document supplies none of those proofs.
All legacy SSH occupancy needs separate present-day route/incarnation/state
reconciliation: the saved inventory has ten leases plus unmatched run blockers,
not only the two A records. A new Pod UID receipt cannot backfill any historical
fact or establish exclusion of an older SSH route. Re-enumerate the complete
authoritative inventory at decision time. Both A holds and shared Codex families
remain; B stays paused, Gemini deferred,
timers off, PR #5 draft and capacity unchanged. Serial Codex/Claude acceptance
begins only after reviewed rollout and complete shared-hold resolution.

## Independent stream-control continuation

`protected-execution/production/stream_server.py` now implements a control
enforcer and an explicit mutual-TLS HTTP handler factory; it starts no listener.
Online native PostgreSQL stream-ticket consumption must precede acquisition of
an exact existing-stream capability. Exact role certificate fingerprint,
immutable pins, command/claim/physical bindings and current history revision are
checked. Each open additionally requires separately keyed runtime-start and
storage-exclusive HMAC proofs bound to the full native consumption, fresh
challenge, pinned domain/incarnation/floor and at most 30 seconds of validity.
The verified expiry shortens the backend acquisition deadline. The two signing
keys/domains cannot be shared. No string, boolean or fixture observer is an
accepted proof shape or signature.

Native claim commitment does not eliminate a later cancel/revoke race. The real
backend must order acquisition and each eventual stdin write against current
cancellation and the mandatory runtime effect/revoke boundary. A committed ticket
or still-unexpired proof is not perpetual permission to forward bytes. This
component has no forwarding/write API, so byte-level fencing remains explicitly
unimplemented rather than inferred from control-plane ordering.

The injected existing-stream backend is an explicit typed lifecycle, with only
fresh proof retrieval, exact existing capability acquisition and close-only
cleanup. No backend, production signer, runtime integration or physical-storage
authority is supplied. No launch, exec, provider body, socket delegation or
recreation operation exists. Missing backend denies before consumption; any
uncertain later outcome retains the permanent native claim. Server memory
deduplicates attempts and caps its retained set; it never replaces native durable
one-use consumption or grants permission after restart. Lost open replies and
unknown capability acquisition remain occupied, without replay/reacquisition.

Sixteen final local cases pass, including actual disposable localhost mTLS, wrong role
fingerprint, one-use open and close-only cleanup. Their native ledger and
runtime/storage proof issuers/backend are synthetic. This verifies the control
enforcer and actual TLS transport only, and supplies none of the stable-retirement,
physical storage or operational acceptance proof above. The fixture closes its
listener and removes generated certificates; no installation or live action occurs.
Expiry deadline propagation and late exact-acquire close-only cleanup are covered
by the final affected recheck, separately exercising an elapsed shorter monotonic
proof deadline and elapsed signed wall-clock validity while caller time remains.
A sandbox restriction blocked initial loopback
socket creation; the same bounded test was explicitly approved outside that
restriction and passed. No homelab endpoint or provider was contacted.

This section records the earlier 16-case component scope. Later component and
native checks have their exact dispositions in
[hosted verification](integrated-review/HOSTED-VERIFICATION.md); this runtime
design adds no new verification of them. Synchronous backend deadlines still
require cancellable operation/worker ownership. A socket close cannot establish
that a queued acquire or write stopped, and B must account for unresolved workers
and effects. Physical storage must separately exclude late backend I/O.

## Primary-source boundaries checked

The [Kubernetes v1.34 CRI definition](https://github.com/kubernetes/kubernetes/blob/v1.34.0/staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto)
defines sandbox/container creation and starts separately and stops a sandbox by
ID. It specifies no permanent retired-Pod-UID authority. That is a source-backed
limit; the proposed T/B protocol above is our design inference, not a Kubernetes
feature.

The [containerd v2.1.4 sandbox path](https://github.com/containerd/containerd/blob/v2.1.4/internal/cri/server/sandbox_run.go)
allocates sandbox identity and invokes runtime work; its
[recovery path](https://github.com/containerd/containerd/blob/v2.1.4/internal/cri/server/restart.go)
reconstructs sandbox/container state from backend/checkpoints. These are bounded
source examples motivating a lower-level/recovery audit, not attestation of the
homelab's current version or proof that an available integration meets this design.
