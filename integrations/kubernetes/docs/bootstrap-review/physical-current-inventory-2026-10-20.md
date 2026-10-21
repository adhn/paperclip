# Current physical-storage API inventory — 2026-10-20

Read-only Kubernetes API observations collected around **19:20–19:25 UTC**.
Only `kubectl get` operations were used. No exec, SSH, Secret read, mount, detach,
patch, migration, provider dispatch or workload change occurred. This inventory
narrows the backend design inputs; it establishes no physical exclusion, complete
writer inventory, open-handle retirement or storage activation authority.

Evidence is in the canonical Paperclip workspace under
`.handoff-state/2026-10-20/production-transport/physical-current-*`.
Raw selected resources retain UIDs/resourceVersions. Cluster-wide attachment and
engine listings were reduced to the four Paperclip volumes; DaemonSet and node
projections retain only relevant image/version/identity metadata. An unavailable
Setting and initial sandbox/output-limit errors are recorded separately.

## Original identities still map to the same claims

Current namespace UID is `ae7ea502-3093-40bd-b1ac-f3a703182a8d`, matching the saved
[held policy](held-policy.json). The four PVC UIDs match their saved originals.
Each current PV's claimRef UID matches its PVC; the PV's CSI volumeHandle equals
the PV name shown below, which equals the Longhorn Volume name. The UUIDs of the
PVC, PV, Longhorn Volume and attachment are distinct physical-object identities;
none is a substitute for a logical account/state family or a proven I/O fence.

| Claim / capacity | Original PVC UID | Current PV UID | Current Longhorn Volume UID | API-reported node |
| --- | --- | --- | --- | --- |
| `controller-state` / 10 GiB | `8b058100-96b3-4a77-b90a-d7dec2939f40` | `7f9ff233-55ae-4cc2-bb81-8897ea339f68` | `b9759ba7-131c-4a3d-b074-ae45f634c235` | think2 |
| `runner-codex-state` / 20 GiB | `7b9bf09b-83f3-4254-a499-ee1ff419b4b9` | `e66a44e1-4b4c-47f4-b2cd-2a4dfc57dd1c` | `6aabab2b-87c7-4850-932a-c304d6ec0bf9` | think3 |
| `runner-claude-state` / 20 GiB | `9cde2513-319c-43a5-bd46-0f387dad743f` | `74b5eb05-8ef0-4b93-b3f9-7dd5f4044a38` | `1420c8fd-23c6-480a-aaaa-ce4e4d7a127c` | think1 |
| `runner-gemini-state` / 20 GiB | `70e9b7cc-2d91-465d-83c0-74ae885ebba5` | `1e16d18c-34e6-4ac0-99f7-d7ec829c34f7` | `82da2722-0428-4dc2-baf0-ebdc3f37191e` | think2 |

For each row, exact PV/CSI/backend name is `pvc-<Original PVC UID>`.
All four claims and PVs report **Bound**, `ReadWriteOnce`, `Filesystem`,
StorageClass `longhorn`, CSI `driver.longhorn.io`, filesystem **ext4**, and PV
reclaim policy **Delete**. The deletion-protection annotations/finalizers remain
present; this document authorizes no claim/PV deletion or policy change.

The saved Codex family remains
`codex:account:ea5ef2cabd37947a43b58f074430fdf4192f65db4da0f16875dd9973e3cb1c50`
with its unchanged `/session-family` and `/credential-family` suffixes. Original
Codex, both A records and B share that family and the runner claim above. The
saved Claude family remains
`claude:account:af13771c2f5e82ec7086431173934c3487eaf75ec9cced7d154395ff321b65ba`.
Controller caches/source/copy-back paths remain part of those original state
contracts; a controller claim is not permission to create different credential
families. Exact runner/workspace strings remain byte-for-byte in held-policy.json.
This API inventory does not reattest their SSH keys, effective realpaths or auth
contents. Gemini physical continuity grants no authentication or execution approval.

## Current attachment chain and engine identities

| Claim | Kubernetes VolumeAttachment UID | Longhorn VolumeAttachment UID | Longhorn Engine UID |
| --- | --- | --- | --- |
| controller | `6843b6bc-07ac-42af-9615-12bb057a5702` | `a5e4272a-baf6-4a19-b116-a0c8dabfe12c` | `2680a819-9cce-4a9f-9027-42ad25b52f7f` |
| Codex | `edaaac1c-293a-4188-b471-8b1a2d0390fe` | `c2ba0ddb-611e-4c87-bc3f-c0fd224fa046` | `fb7c20da-2ec8-430f-b85e-762e76eaded5` |
| Claude | `cafa3c29-9872-4c79-856c-81c4df4bc71a` | `723da1b0-b1b5-4747-b7b5-9ada63e5b99a` | `12fbcc6e-924b-4397-a6d9-c90ecb491fb2` |
| Gemini | `1317276b-6395-4618-98b5-e1494d247e0b` | `62bc21a1-fa08-46ec-8bab-d853e520144f` | `0ec2376d-2cb5-4cbb-a818-72b2e90c6d41` |

Each Kubernetes attachment reports `attached:true`. Each matching Longhorn
attachment has one matching `csi-attacher` ticket with `satisfied:true` and the
same node. Each engine is named `<PV name>-e-0`, reports `running`, and exposes
`/dev/longhorn/<PV name>` in its status. Volume status reports `attached`,
`healthy`, the same current node and one Running workload reference. These are
controller-reported API facts; they do not enumerate actual mounts/open handles,
runtime descendants, stale nodes, previous sandboxes or all old I/O paths.

All four engines report three `RW` replicas in their API replicaModeMap.
Volume specifications show dataEngine `v1`, frontend `blockdev`, accessMode
`rwo`, three replicas, `revisionCounterDisabled:true`, `encrypted:false`,
`migratable:false`, `disableFrontend:false`, `dataLocality:disabled` and
`staleReplicaTimeout:30`. `lastBackup` and `lastBackupAt` are empty on all four
Volume objects. Empty fields do not prove absence of every external backup;
they supply no verified recovery point or recovery coverage.

## Exact versions and relevant configured recovery behavior

- Longhorn CSIDriver annotation reports **v1.10.0**, commit
  `22af8fe21683753eb380348eb512a17ee87473a9`; `attachRequired:true`,
  `requiresRepublish:false`, `fsGroupPolicy:ReadWriteOnceWithFSType`.
- Manager, CSI plugin, current engine, configured default engine and instance
  manager image tags are **v1.10.0**. The EngineImage object `ei-26bab25d`
  reports deployed/ready on think1/2/3, version v1.10.0, engine commit
  `2cd745e5b8de776e678f06c688b82bd2866a984f`, controller API 5/minimum 4,
  CLI API 10/minimum 8 and data format 1. These are API/config version reports;
  actual binary/image digest attestation is not established by image tags alone.
- CSI registrar image is `v2.14.0-20250826`; liveness image is
  `v2.16.0-20250826`. The CSI registration path is under
  `/var/snap/microk8s/common/var/lib/kubelet/plugins/driver.longhorn.io/`.
- The `longhorn` StorageClass UID is `ee232454-c528-41a2-88c6-6de1c7f1da51`,
  reclaim `Delete`, binding `Immediate`, expansion allowed, three replicas,
  ext4, dataEngine v1 and revision counter disabled.
- Relevant Setting values: `node-down-pod-deletion-policy=do-nothing`,
  `node-drain-policy=block-if-contains-last-replica`,
  `auto-delete-pod-when-volume-detached-unexpectedly=true`, and
  `engine-replica-timeout={"v1":"8","v2":"8"}`. No unit or fencing guarantee
  is inferred from the timeout string. A queried `automatic-salvage` name was
  NotFound; no automatic-salvage default is inferred.
- Node API reports containerd **1.6.36** and kubelet **v1.32.13** on all three
  nodes. Node/boot UIDs are retained in `physical-current-nodes.txt`; the boot
  IDs distinguish current reported incarnations, not direct runtime verification.

## Smallest remaining backend decision and proof obligations

The available API metadata identifies **Longhorn v1.10.0 / v1 blockdev / ext4 /
RWO** as the concrete review target. It does not identify an authenticated
stale-I/O fencing operation. Select no online backend on the strength of these
status fields. The next bounded review should commission one of:

1. A sole protected canonical owner with detached attempt copies, proving every
   old controller/cache/runner writer excluded and enforcing the complete alias/
   multi-root CAS group; or
2. A documented Longhorn-v1/backend reservation/barrier mechanism, with exact
   version/source semantics and negative stale-writer tests covering partition,
   restart, open I/O, force-detach, remount and automatic replacement behavior.

No such operation or guarantee was tested or asserted. `ReadWriteOnce`, satisfied
attachment tickets, `attached:true`, replica `RW`, deletion or absence of an API
object cannot substitute for that proof. Automatic Pod replacement after an
unexpected detach is an additional runtime-start/recovery path the eventual
mandatory boundary must account for; this inventory does not establish its
exact runtime effects.

Both alternatives still require the separately reviewed completed runtime barrier
B (not only deny-intent T), current independent history/restore-domain identity,
all effective roots/configuration/aliases, independent credential-refresh lineage,
atomic whole-group activation and verified native release. None was installed or
accepted here. Keep historical/shared holds, saved B pause, Gemini deferral,
disabled timers and capacity gates; this read-only task did not query or change
native lifecycle state. Real backup/recovery and measured headroom remain open.
