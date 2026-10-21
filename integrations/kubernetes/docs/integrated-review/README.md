# Integrated candidate review — 2026-10-20

Current independent source delta: [operation ownership, bytes, current legacy history and authority decision](IMPLEMENTATION-DELTA.md). This extends the historical component status below; real enforcement and activation remain held.

Latest continuation: [native, stream and evidence implementation](SERVER-INTEGRATION.md).
The overlay is now 64 files with durable PostgreSQL consume/stream-use methods,
separate-role mTLS endpoint factories, stream-control and evidence adapters.
These extend the earlier source below; old hosted results do not verify the new
native code. Installation, real issuers, physical backends and byte forwarding
remain absent. Independent source work continues while dependent execution holds.

Fresh read-only [runtime API](../runtime-current-inventory-2026-10-20.md),
[runtime host](../runtime-host-inventory-2026-10-20.md) and
[physical storage](../bootstrap-review/physical-current-inventory-2026-10-20.md)
inventories bind the proposal to containerd 1.6.36/Kubernetes 1.32.13 and Longhorn
1.10.0. Review the [storage proof boundary](STORAGE-PROOF-BOUNDARY.md) and
[exact evidence/activation sequence](../bootstrap-review/evidence-activation-sequence-2026-10-20.md).
API metadata does not establish permanent retirement or stale-I/O exclusion.

This is an inactive source review, not an activation package. PR #5 stays draft.
No image publication, live migration, provider dispatch or capacity increase is
authorized. Production preparation and workload pins remain at PR #4. Both A
holds, the original shared Codex families, paused B, deferred Gemini and disabled
timers remain mandatory.

The follow-up [activation boundary inventory](ACTIVATION-BOUNDARIES.md) names the
exact source/manifests and missing authority inputs for each future change.
Review the [bounded runtime design](../runtime-retirement-design-2026-10-20.md),
[independent client component](../production-transport-storage-2026-10-20.md) and
[complete legacy evidence matrix](../bootstrap-review/operational-evidence-matrix-2026-10-20.md)
together. These add design/review preparation and client code, not installed
runtime, native endpoint, stream server or physical-storage enforcement.
The saved legacy inventory includes ten leases, beyond the two A records;
unmatched run sources can also retain occupancy. Preserve exact persisted hold
scopes rather than rewriting them into reservation policy scope arrays.

The review must distinguish three independent boundaries that must be enforced:

1. **New Pod CREATE:** the current native PostgreSQL transaction consumes a
   committed command once. Admission authenticates the API server and calls that
   transaction over pinned mutual TLS. Failed persistence or a lost response
   never returns the permit. This does not intercept kubelet runtime recreation.
2. **Runtime retirement:** an independent mandatory boundary must exclude every
   future start for the exact retired Pod UID, including stale kubelets and
   replacement sandboxes. No such boundary is installed or approved. Original
   sandbox stop, API deletion and quiet polling cannot supply this guarantee.
3. **Canonical state:** exclusive physical ownership, current independent
   high-water evidence, storage incarnation and version CAS must precede
   restoration or release. SQLite protocol fixtures cannot fence a real volume.

## Concrete authority decision

Review [the retirement contract](../pod-retirement-fence-review-2026-10-19.md)
before choosing a supported enforcement boundary. The smallest pending decision
is whether to commission a separate design/rehearsal for a mandatory runtime
start/retirement authority outside the non-root workloads. That decision would
authorize design work only, not a privileged workload, runtime socket, node
change or rollout. Until a reviewed mechanism covers every backend start and
recovery path, next-command execution, occupied-epoch adoption, native stopped
recording, state activation and release remain held.

## Review surfaces and installation gaps

| Surface | Concrete candidate | Installation/acceptance still required |
| --- | --- | --- |
| Controller image | Exact reconstructable native overlay, mandatory held bootstrap, manual migration only; native hosted run 39449824759 passes 523 native/329 transport cases, full typechecks, SSH and six actual Kubernetes/native modes | Actual image/PVC rehearsal PASS 39466029222; registry publication is outside this task's authorization |
| Immutable policy | `../bootstrap-review/held-policy.json` preserves original instance/account/state families | Fresh physical multi-root/configuration and provider-grant attestation; no executable allow policy exists |
| Admission | Native committed one-use CREATE transaction, mTLS endpoint/client and exact workload guard | Reviewed production endpoint/authentication/network installer and physical storage attestor |
| Supervisor/provider authority | Independent non-root control and synthetic provider contracts | Runtime retirement mechanism, executable production gateway, independent verifier pins and bypass audit |
| RBAC | `../../protected-execution/kubernetes-review/render.py` gives namespaced Pod create/get/list/delete and exact PVC get | Attach/stdin production authorization needs an independently narrow design; do not broaden to generic exec/attach |
| Storage | Detached roots, CAS/quarantine and independent current-state verification interfaces | Real canonical PVC ownership/detach/alias activation, retained high-water domain and restoration backend |
| Network | Held renderer default-denies both namespaces; separate packet fixtures | Exact controller callback/API/provider/DNS routes, private-address and IPv6 exclusions on actual CNI |
| Workload | Held renderer has zero guard replicas and creates no provider/supervisor/transfer workload | Exact integrated executable images/configuration/mounts cannot be completed before the authority/storage decisions |
| Manual migration | `../bootstrap-review/legacy-manual-migration-review-2026-10-20.md`; real-image/PVC synthetic rehearsal | Fresh Paperclip-only coordinated recovery point, approved maintenance window and real restore verification |
| Legacy A | Native append-only present-day decision and supported lifecycle re-evaluation; mandatory complete-inventory verifier | Independent real artifacts for every shared hold, operational signer/verifier installation and human review |

There is deliberately no apply command or fabricated image digest. Applying the
held renderer would deny creation; it would not deploy the integrated topology.
The source diff and hash inventory are review evidence only. Test containers,
Docker brokers, kind observers and CNI installers must never enter the workload
or RBAC diff.

The [physical storage decision](../bootstrap-review/physical-storage-authority-decision-2026-10-20.md)
records concrete owner/backend alternatives and their unresolved proof obligations.
It selects no topology. Native PostgreSQL now retains a permanent one-writer
attachment claim before gateway side effects, bound to the original owner token
hash, accepted physical ACK and native CREATE. Duplicate or uncertain attachment
cannot acquire another writer. The ticket still requires an independently
enforcing production gateway; passing a ticket to a fixture is not enforcement.
The current transport's retirement callback returns a structural identifier;
the callback must independently verify and durably commit the exact native
receipt/high-water CAS before it returns. A nonempty fixture string establishes
only call ordering. The attach cleanup hook runs even after retirement failure:
a production implementation must close the stream only and retain durable stdin
ownership, storage and occupancy. No implementation of either callback is installed.

The complete [hosted verification ledger](HOSTED-VERIFICATION.md) records passing
native source 39449824759, protected/API 39458972052 and exact-image/PVC 39466029222.
The last run verifies policy-before-manual-migration controls, distinct held-epoch
application restart, coordinated database/file rollback, unchanged source and
cleanup. It uses synthetic state only and accepts no real backup/recovery target.
Import deadlines, packaged-module layout and bounded application heap were
corrected from preserved failures. Production pins and capacity remain unchanged.

## Ordered review and later acceptance

Review exact source and tests, choose the retirement authority design, then
complete gateway/storage/authentication installation and failure acceptance.
Rehearse coordinated migration/restart/rollback with the final images. Produce a
separate human-reviewed activation diff only after all dependencies have concrete
implementations and immutable image identities. The operator must review any
publication or deployment separately.

Real A reconciliation must cover the complete authoritative hold inventory and
all workspace/session/credential outcomes; no B exemption, replacement identity,
historical receipt backfill or direct lifecycle edit is permitted. Only after
reviewed rollout and full shared-hold resolution may ten bounded serial Codex
tasks on B begin, followed by Claude lifecycle/session/refresh checks. Overlap,
everyday use and real backup/recovery acceptance remain later gates.
