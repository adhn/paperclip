# Observed Longhorn backend and proof boundary

Read-only design review, 2026-10-20. No setting, attachment, node, volume or
workload was changed. Original logical families and historical occupancy remain.

The [current inventory](../bootstrap-review/physical-current-inventory-2026-10-20.md)
records Longhorn 1.10.0 v1 blockdev/ext4/RWO, original PVC identities, exact current
backend/attachment identities, three replicas, disabled revision counters and
`Delete` reclaim policies. These are observed API facts, not an independently
enforced storage barrier.

## What the matching primary documentation supports

Longhorn 1.10.0 describes revision counters as a replica-selection consistency
heuristic; even enabled counters do not guarantee consistency. With counters
disabled, recovery can select replicas using head-file timestamps and sizes.
That mechanism is not the Paperclip monotonic intent/decision/credential
high-water authority and must not be repurposed as one. Enabling it would not
establish that authority. No setting change is proposed.
[Versioned revision-counter documentation](https://longhorn.io/docs/archives/1.10.0/advanced-resources/deploy/revision_counter/).

The observed automatic Pod-deletion setting handles unexpected detach by
deleting a controller-managed Pod so its controller and Kubernetes replace it
and reattach storage. The same-version node-failure guide describes eviction,
replacement and detach/reattach behavior. These recovery paths belong in the
runtime/storage bypass audit; a desired attachment object or original Pod's
deletion cannot by itself prove every future runtime effect excluded.
[Versioned setting](https://longhorn.io/docs/archives/1.10.0/references/settings/#automatically-delete-workload-pod-when-the-volume-is-detached-unexpectedly),
[node-failure guide](https://longhorn.io/docs/archives/1.10.0/high-availability/node-failure/).

The documents explain recovery behavior. Our conclusion that they do not satisfy
the stronger Paperclip exclusion/current-history protocol is a design assessment,
not a claim that a particular live stale-writer race was exercised. Neither a
backend fence API nor safe force-detach is established by this review.

## Concrete remaining decision and evidence

| Candidate | Exact additional proof needed |
| --- | --- |
| Sole protected canonical owner, detached attempt copies | Complete old controller/cache/runner/staged writer retirement; one canonical mount owner; every copy-back and alias mutation routed through full root-group CAS; independently enforced attempt retirement before restoration. |
| Backend-enforced stale-I/O exclusion | Exact supported 1.10.0 operation/receipt that rejects old-node/open-handle/partition/recovery writes for the physical incarnation; independent current-history and negative stale-writer rehearsal. No such operation has been selected. |
| Continue held | No provider execution, restoration, activation or release. Independent source/review work can proceed without claiming an online guarantee. |

A dedicated new runtime pool cannot retire old shared-node SSH processes or
controller/runner mounts by declaration. Legacy transition needs its own reviewed
old-route, runtime and storage exclusion evidence. Preserve original identities
through any new physical realization; never create a B-only family or erase A.

The smallest review is whether to commission the sole-owner/detached-copy design
and exact old-writer transition, or demonstrate a supported backend barrier.
Neither choice authorizes installation, node intervention, forced detach or live
migration. Current non-root topology alone supplies neither guarantee. The
runtime design additionally needs exact MicroK8s/containerd 1.6.36 host/config/
socket/boot-path evidence before any effect-level mechanism can be approved.
That host boundary is separate from the successful read-only Kubernetes inventory.


## Root-group CAS and rollback-independent high water

The smallest implementable storage interface must identify the entire overlapping
original family/root/alias group. It cannot accept independent child-root
callbacks as whole-group activation. The physical tuple binds each original PVC,
volume incarnation, backend owner and attempt writer identity; a metadata-only
attachment generation or controller callback supplies no exclusion guarantee.

Before writing any canonical head, an independently protected history service
must CAS the complete predecessor vector to one immutable prospective intent:
operation ID, original family identities, old heads, proposed heads, physical
incarnations, policy/epoch and exact evidence hashes. Conflicting operation reuse,
missing members or divergent predecessors refuse. This durable intent is the
high water even before completion, so a database/config/volume rollback cannot
make the old state current. Accepted/revoked decisions share the same requirement:
every use consults independent current history; restoring an old accepted row
cannot revive a revoked decision.

An actual owner then verifies completed runtime barrier B plus backend stale-I/O
exclusion for **all** returned writers before reading their state. It validates
workspace, session and credential outcomes independently, rejects older refresh
versions and atomically activates the full group against the pinned predecessors.
A protected group-head indirection may be a design candidate only if every
reader/writer uses it and old open handles are physically excluded. Single-file
rename, per-PVC CAS, SQLite and observer callbacks are insufficient.

Inspection must distinguish at least intent-only, whole-group activated,
activation unknown/partial and externally revoked. External-ahead/local-old,
local-ahead/external-incomplete, lost replies, stale physical incarnations and
partial activation all hold occupancy. Recovery compares immutable intent to
actual physical heads; it cannot overwrite the high water, invent completion,
replay provider bodies or synthesize whole-group success from partial roots.

No physical activation API, independent service/key custody or rollback domain
is installed. Human review can commission this owner/history interface and
bounded stale-writer/partial-activation/rollback rehearsal; that decision supplies
no protection by itself and authorizes no live migration or topology change.
