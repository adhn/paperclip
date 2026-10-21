# Exact activation boundaries for review — 2026-10-20

Current source continuation: [owned authority services and retained-intent
implementation](OWNED-AUTHORITY-SERVICES.md). Actual runtime/storage/custody/native
effect integration remains blocked/open; the historical interfaces below are not
operational authorization.

Current continuation: [ordered authority integration and precise remaining native/all-command boundaries](ORDERED-AUTHORITY-INTEGRATION.md). Earlier implementation counts below retain their historical scope.

Current independent source delta: [operation ownership, bytes, current legacy history and authority decision](IMPLEMENTATION-DELTA.md). This extends the historical component status below; real enforcement and activation remain held.

Inactive integration plan. This document authorizes no runtime installation,
publication, deployment, migration, reconciliation or dispatch. Production stays
at PR #4; PR #5 stays draft. The executable activation diff cannot be completed
until the authorities below have actual implementations and reviewed identities.
An empty deployment, fabricated digest or fixture callback would not close it.

## Concrete changes required at each surface

Paths are relative to `paperclip-evaluation/`. They identify the current source
and the required future change; they are not commands or apply-ready manifests.

| Surface / current path | Required exact activation change | Blocking input |
| --- | --- | --- |
| Controller `images/controller/admission-native/`, `scripts/prepare-controller.py`, `images/inputs.json` | Reconstruct the verified overlays in the actual production recipe; bind the complete source/recipe/dependency inputs to a separately authorized published digest. Preserve missing-policy/stale-schema refusal and manual migration. | Production recipe integration, final rebuild and immutable registry identity; publication remains unauthorized. |
| Policy `docs/bootstrap-review/held-policy.json` | Install protected held-only policy with original logical identities, complete physical multi-root/configuration bindings and independent authority pins. No allow mode is implied. | Fresh physical/backend and account/grant attestation; root/config contracts; protected installer. |
| Native admission `protected-execution/admission_webhook.py`, controller journal | Install exact API-server-authenticated webhook → pinned mTLS native transaction and complete failure policy. Enforce every command, setup, probe, transfer and lifecycle path. | Production endpoint installer/authentication, native consumption and independent physical ACK/storage verifier. |
| Gateway `protected-execution/production/` | Install the exact-command stream enforcer and native role-bound endpoint factories; durable ownership must precede stream side effects, with no uncertain body replay. Recovery inspection grants no second writer. | Client, native ticket and stream-control source are implemented/tested; production installation, byte forwarding and actual runtime/storage enforcement remain absent. |
| Runtime authority | Propose a mandatory start/effect and recovery boundary for the execution pool, separate from workloads. Retain irreversible UID tombstones and all unsettled effects. | [Runtime review](../runtime-retirement-design-2026-10-20.md): topology/authority decision and independent proof, no host/runtime install approved. |
| RBAC `protected-execution/kubernetes-review/render.py` | Render final namespaced service identities with exact verbs/resources, then prove allowed and denied routes. Provider gets no API/runtime credential. | Production gateway transport and installer design. Existing scoped Pod CRUD/PVC get does not authorize generic exec/attach or prove mandatory stream ownership. |
| Storage and transfer | Sole canonical owner or proven backend fence; original-family multi-root transaction with exact PVC/PV/backend/mount incarnation, all-writer exclusion and source-version CAS. | [Physical storage review](../bootstrap-review/physical-storage-authority-decision-2026-10-20.md): selected backend, physical exclusion and independently current high-water domain. |
| Network `network-policies.yaml` | Exact controller/native verifier, gateway, authority, DNS, callback and provider routes; deny unrelated private/metadata/IPv6 routes according to actual CNI. | Final topology and authenticated endpoint identities. Disposable CNI installers/observers are excluded. |
| Workload `workloads.yaml`, `kustomization.yaml` | Immutable images, namespace incarnations, policy/config mounts, separate UIDs and canonical/attempt mount ownership; reviewed maintenance and startup ordering. | Every authority/storage endpoint above. Held renderer is a review primitive, not the integrated workload. |
| Manual migration | Final-image policy preflight → explicit Paperclip-only migration → inspected exact migration head → held bootstrap. Old image only after coordinated compatible DB/files/config restore under external exclusion. | [Migration review](../bootstrap-review/legacy-manual-migration-review-2026-10-20.md): real coordinated checkpoint, least-privilege executor and restored-target identity. |
| Legacy decisions | Append-only supported host service and lifecycle coordinator with current full inventory, independent domain evidence and separate human-bound signer. | [Evidence matrix](../bootstrap-review/operational-evidence-matrix-2026-10-20.md). Every shared hold, not only A; unsupported source kinds remain held. |

## Shared interfaces and ordering

The native owner is immutable across command, stream, runtime and storage
interfaces: company/agent/run-or-operation/environment/lease/attempt/invocation,
original scope identities, policy/epoch/configuration, committed command hash,
physical namespace/Pod/runtime/storage incarnations and challenge. Independently
protected expected authority/history pins must precede response verification;
echoed response IDs or a nonempty callback string are not authentication.

Historical legacy holds retain their exact persisted scope set. They must not be
rewritten into the newer seven-scope reservation format. Both A records continue
to occupy the original shared Codex families, so no B exemption is possible.

The runtime transaction distinguishes durable deny intent T from completed
retirement barrier B. A request forwarded before T may take effect afterward;
it stays charged until its exact effect is settled and terminated. Only B, with
all incarnations accounted for and future starts excluded, can support a verified
retirement receipt. A proxy-only deny record is insufficient. Native recording
must verify and commit the receipt/current-history CAS before any dependent
transition proceeds.

Storage uses a separate prospective-transition high-water pin before canonical
commit, or an equivalently proved intent/commit protocol. External-ahead/local-old,
lost history, conflicting writers or uncertain mount lifetime keep occupancy.
The current history must survive Paperclip DB/files rollback independently. A
shared infrastructure service is possible; a matching restored snapshot is not
an independently current authority.

Gateway cleanup closes the exact stream only. Failed retirement, disconnect,
lost replies or incomplete restoration do not erase stdin claims, mount ownership,
native occupancy or fence history. No automatic body replay, writer reacquisition,
new family or fresh empty pool is permitted. Release still requires exact verified
retirement, independent workspace/session/credential outcomes and storage evidence
in the supported native transaction.

## Evidence and decision limits

Hosted 39449824759, 39458972052 and 39466029222 already pass their documented
source/disposable scopes. They are retained, not rerun to fill authority gaps.
In particular, synthetic physical ACKs, fixture SQLite, container observers and
local-path PVCs are excluded from operational evidence. The passing old/new
actual-image migration/restart/rollback does not establish homelab recovery or
headroom, and endpoint reconstruction is not native process restart.

The next human review is a bounded authority design decision, not an activation
approval: review mandatory runtime effect/recovery coverage and a physical owner/
high-water model. Independent component implementation can continue while those
decisions remain open; dependent execution, restoration, adoption and release stay
held. Only an assembled final implementation, reviewed rollout and complete shared
hold resolution can precede the ten-task serial Codex B stage. Claude lifecycle/
session/refresh follows; Gemini, overlap, timers and everyday-use/recovery remain
held.
