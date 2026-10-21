# Runtime host evidence and remaining design decision

**Read-only host inspection completed, 2026-10-20 19:46:33–19:46:36 UTC.**
Existing `andam@think1/think2/think3` access succeeded with BatchMode,
StrictHostKeyChecking, five-second connection timeout and one connection attempt.
No new SSH trust/key, sudo, runtime socket RPC/dial, node action or installation.
The user already authorized verification/design; ordinary non-root reads did not
need an additional authority decision. The initial sandbox mapped local SSH
configuration ownership to UID 65534, so OpenSSH refused before connection; the
same fixed probe ran successfully after the required tool sandbox escalation.

This closes several unknown *inventory inputs* in
[the API-only report](runtime-current-inventory-2026-10-20.md), not the mandatory
runtime retirement proof. Both A holds, original shared Codex families, B's saved
pause, Gemini deferral, disabled timers and draft PR #5 remain unchanged. No
application state or provider command was inspected by this probe.

## Exact observed common runtime installation

All three `/snap/microk8s/current` and `/var/snap/microk8s/current` paths resolve
to revision **8702**. Host boot IDs match the earlier Kubernetes API observations.
The following regular binaries are root:root, mode 0755 and byte-identical across
all three nodes. Hashes identify the read files; they do not prove the running
process executable, source provenance or that every alternate runtime uses them.

| Snap-relative binary | SHA-256 on all three hosts |
| --- | --- |
| `bin/containerd` | `bd0fd5702c6d7776a61378d0141c7e94dc7af31d577cf681c175091bacc1f6b9` |
| `bin/containerd-shim-runc-v2` | `0e586186966ea7bcf15eb4d6e95df3da912c3abeb3e203d91e7dde384c37cf91` |
| `bin/runc` | `1520fcac7a104f61332fc009467bd5ad7a61ff88439d1a1293c072ea787fa936` |
| `kubelite` | `7e84248e4548225d06be25e12fc80fc41acd85171cf721ea8644db3a73f09533` |

The fixed `/snap/microk8s/current/kubelet` candidate is absent (ENOENT); a
separate kubelet executable was not silently substituted. API status reports
containerd 1.6.36/kubelet v1.32.13; these file hashes now anchor the corresponding
snap installation for the bounded source/design review. No binary was invoked.

## Projected arguments and generated TOML

All three containerd argument files have hash
`afbaff65729df499959156dd483352ccc4fa9ce374ef51e1ee1ae62eb479ace6`.
Only the following whitelisted values were retained, without shell expansion:

| Argument | Observed value |
| --- | --- |
| Containerd `--address` | `${SNAP_COMMON}/run/containerd.sock` |
| Containerd `--config` | `${SNAP_DATA}/args/containerd.toml` |
| Containerd `--root` | `${SNAP_COMMON}/var/lib/containerd` |
| Containerd `--state` | `${SNAP_COMMON}/run/containerd` |
| Kubelet `--container-runtime-endpoint` | `${SNAP_COMMON}/run/containerd.sock` |
| Kubelet `--root-dir` | `${SNAP_COMMON}/var/lib/kubelet` |

The generated `args/containerd.toml` is identical across hosts, SHA-256
`1cf3b7650334656134ec292152c098fcd2477ae926fc843b5d0b3973f5bb638a`.
Its retained fields show TOML version 2, CRI default runtime `runc`, snapshotter
`overlayfs`, default runtime type `io.containerd.runc.v2`, plus configured
`kata` (`io.containerd.kata.v2`, BinaryName `kata-runtime`) and
`nvidia-container-runtime` (`io.containerd.runc.v2`, corresponding BinaryName).
Configuration is not proof that either alternative binary/handler is installed,
usable or selected by a running Pod. Empty default runtime options do not prove
absence of system-level wrappers or independently mandatory enforcement.

The common template hash is
`275a3a72145f344f18578c6656697d76a806dbc38b02e411eb17abdc8f126bab`;
runtime/snapshotter variables in the template remain unexpanded in the evidence.
The fixed `common/args/containerd.toml` candidate is absent. Kubelet argument
hash differs on think3; the whitelisted endpoint/root fields agree. No raw
argument file, registry/auth configuration, environment, tokens, kubeconfigs or
private keys were output or retained.

These args, template and generated config files are root:microk8s mode **0660**
(GID 1001). The operator's existing SSH process belongs to `microk8s` on every
node; think3 additionally reports `docker` membership. These operator/group
writers belong in the trusted-host-administrator threat boundary. This does not
grant their authority to provider, transfer or supervisor workloads.

## Runtime socket metadata without connections

Only `/proc/net/unix` paths containing `containerd` and their filesystem metadata
were read. Repeated connection entries are retained in the raw projected
evidence; unique path counts below are a snapshot, not a complete writer/client
or Pod ownership inventory. No socket was opened for a runtime request.

| Host | Main MicroK8s socket | MicroK8s `.ttrpc` | Other observed daemon socket paths | Unique paths / stat denied |
| --- | --- | --- | --- | --- |
| think1 | root:microk8s 0660 | root:root 0660 | none in this projection beyond shim paths | 31 / 29 |
| think2 | root:microk8s 0660 | root:root 0660 | none in this projection beyond shim paths | 31 / 29 |
| think3 | root:root 0660 | root:root 0660 | `/run/containerd/containerd.sock` and `.ttrpc`, root:root 0660 | 38 / 34 |

The main MicroK8s path is
`/var/snap/microk8s/common/run/containerd.sock`. Many
`/run/containerd/s/<opaque-id>` shim socket paths appear on every node, but
non-root stat returns EACCES. Do not interpret those denials as absence of shim
clients, ownership or effects. The extra think3 daemon sockets are a concrete
inventory item for any bypass audit; their owning service/runtime and relationship
to MicroK8s are not established by this read. Metadata/group membership alone
does not prove a runtime RPC would succeed, and no capability was tested.

## Selected unit ordering

Both `snap.microk8s.daemon-containerd.service` and
`snap.microk8s.daemon-kubelite.service` report active/running on every node.
Containerd's selected `Before` set includes kubelite; kubelite's `After` set
includes containerd. Their selected `Requires` sets include the snap mount and
ordinary system units. The selected unit User/Group properties are empty.

These observations establish configured ordering only. The probe did not output
ExecStart, environment or drop-in contents; it did not enumerate every host
service, effective process credentials, restore manager, startup hook or possible
runtime client. Therefore it cannot prove a start-capable backend is unavailable
before a retirement gate verifies retained history, nor that such a gate exists.

## Concrete remaining authority/topology question

The question has narrowed from "which runtime is installed?" to:

**Can a reviewed mandatory effect/recovery integration cover this snap-8702
containerd/runc-v2 installation, every configured handler and lower shim route,
with independent retained deny/history state, or must execution remain held?**

The decision package must specifically account for the group-writable runtime
configuration, root/operator administrative routes, the alternate handlers, the
extra think3 daemon, shim paths whose ownership remains unverified, queued
pre-T effects and service startup/recovery. CRI-only interception at the observed
main socket cannot by itself prove that lower task/shim or alternate-daemon
effects are covered. A TOML field or unit ordering edge supplies no retirement
authority. Configured alternative handlers are audit obligations, not permission
to switch topology or adopt a VM runtime.

Further ordinary read-only verification through existing access can continue
within the task. Unknown privileged ownership/process/runtime facts remain
unverified; no sudo, runtime RPC or access expansion is implied. The mandatory
mechanism, independent current-history backend and exact proposed pool/host
changes still need concrete design and human review. Node installation,
socket delegation, privileged workload, shared-node power fence or rollout remain
unauthorized. Missing proof keeps completed retirement B false and retains native
occupancy, storage and every shared historical hold.

Projected evidence and the exact read-only probe are in the Paperclip workspace:
`.handoff-state/2026-10-20/retirement-design/runtime-host-{think1,think2,think3}.json`
and `runtime-host-probe.py`. Hashes and limitations are in
`runtime-host-checkpoint.json`. No tested source, Git index, image, policy,
workload pin, capacity, lifecycle fact or historical receipt changed.
