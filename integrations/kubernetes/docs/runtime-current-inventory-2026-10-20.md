# Current runtime inventory and smallest authority decision

Read-only Kubernetes API observation, **2026-10-20 19:21 UTC**. No SSH, exec,
runtime socket, host installation, node change, provider call or live mutation.
This inventory does not release a hold or accept runtime retirement. It grounds
the [retirement design](runtime-retirement-design-2026-10-20.md) in the current
reported version rather than the earlier illustrative containerd 2.1.4 source.

The three nodes currently report **containerd 1.6.36**, kubelet **v1.32.13**,
kernel **6.8.0-142-generic** and **Ubuntu 24.04.4 LTS**. All report Ready=True.
These are node-status reports, not measured binary/build or socket attestations.
They do not establish MicroK8s patch provenance, installed runtime integration,
effective default handler, shim/runc version or a complete trusted boot history.

| Node | Kubernetes Node UID | Reported current boot ID |
| --- | --- | --- |
| think1 | `bb1d11f0-1d40-4259-b56d-19217367a676` | `fde1e433-207b-4181-88e2-55f918b4faa3` |
| think2 | `1eaed687-d35d-4b99-9dea-384243142d72` | `3fafcecd-0e03-4ee7-be76-3f88590d9193` |
| think3 | `824cef8a-9a11-4487-a487-fffde107b3b8` | `5936f38b-cacc-4a67-8cda-1d97b6c8642e` |

think1/think2 expose the `node.kubernetes.io/microk8s-controlplane` label;
think3 does not expose that label. All three omit `spec.unschedulable` and
`spec.taints` in the observed response. This does not prove a dedicated execution
pool, permanent placement, absence of other workloads or mandatory runtime gates.

## Current Paperclip Pod placement

All four Pods in `paperclip-eval` report Running with their single container
ready and zero restarts. Each omits `runtimeClassName`; the effective runtime
handler/default cannot be derived from that omission alone.

| Workload / observed Pod | Pod UID | Node |
| --- | --- | --- |
| Controller `controller-6c787fb6b-5ddnp` | `79b586b1-dd23-4710-8c0e-39b1484dd30d` | think2 |
| Claude `runner-claude-5c88c85cbc-f9px8` | `ad48f6bc-5039-48ab-be14-409369aadf54` | think1 |
| Codex `runner-codex-5f449ff969-wngdr` | `e0e1d986-d077-47c2-bfbb-cbc2e1f361d8` | think3 |
| Gemini `runner-gemini-66bb46c75f-2f2cq` | `61df228f-4ba8-4611-93db-d00594716547` | think2 |

The controller's reported pulled image remains PR #4 digest
`sha256:8bd2d8ccef956c777ea6eefa2004152632e0781706031e8cd42ef89bdd7c50ca`.
Runner image digests are retained in the projected evidence. Pod readiness and
restart counts do not establish descendant absence, agent lifecycle state,
current credentials, disabled timers or absence of a stale kubelet/runtime alias.
This task did not inspect application state or run provider commands. Both A
holds, original Codex families, B's saved pause, Gemini deferral and timer holds
remain unchanged.

## Matching upstream source: concrete audit targets

The following reads use the **v1.6.36** upstream tag matching the reported string.
They are audit targets, not evidence that the live binary is byte-identical to
that tag, that a path is reachable by a workload, or that a live bypass occurred.

| Primary source / observed code | Required next proof |
| --- | --- |
| [CRI sandbox creation](https://github.com/containerd/containerd/blob/v1.6.36/pkg/cri/server/sandbox_run.go): `RunPodSandbox` allocates a sandbox ID, selects a handler, creates a container/task and calls `task.Start`. Its NRI invocation is conditional before that start. | Bind every accepted sandbox/handler to immutable original owner and Pod UID; order queued effects with T/B. Do not assume an optional callback is a mandatory retirement authority. |
| [CRI recovery](https://github.com/containerd/containerd/blob/v1.6.36/pkg/cri/server/restart.go): `recover`/load routines reconstruct sandboxes, containers and task status from backend/checkpoints; incomplete metadata has error/unknown paths. | Attribute retained processes and all aliases across recovery before B. Recovery loading is not itself evidence of a new start, nor does an unavailable CRI imply old shim/task processes stopped. |
| [Runtime-v2 shim](https://github.com/containerd/containerd/blob/v1.6.36/runtime/v2/shim.go): shim reconnect and task `Create`, `Start`, `Resume` and `Exec` interfaces sit below the CRI layer. | Enumerate actual daemon/shim sockets, client identities, namespaces, handlers and maintenance routes; prove none can start/resume/exec a retired owner outside the mandatory effect gate. No such live socket audit occurred. |
| [runc task service](https://github.com/containerd/containerd/blob/v1.6.36/runtime/v2/runc/task/service.go): lower-level task service includes process lifecycle and resume effects. | Identify the actual shim/OCI runtime build and enforce retirement at every applicable effect, including restore/reattachment paths; an upstream source example does not select a backend. |

Web retrieval of `pkg/cri/server/container_start.go` and
`services/tasks/local.go` at that tag returned cache misses in this session;
their code is not counted reviewed. This is a bounded source survey, not a full
call-graph or supported-integration audit. No installed NRI/hook/plugin or
available mandatory gate is inferred from an upstream import or method name.

## Smallest concrete next decision

Follow-up: the task already authorizes ordinary non-root read-only verification
through existing access. It does **not** require a new user decision merely to
read host metadata. The [completed strict-trust SSH inventory](runtime-host-inventory-2026-10-20.md)
now supplies snap revision, binary hashes and projected runtime/socket/unit facts.
The authority/topology installation decision remains separate and unapproved.

Review a **host-configuration evidence and disposable-design project for the
reported MicroK8s/containerd 1.6.36 boundary**, with these deliverables before
choosing an enforcement mechanism:

1. Independently obtain exact MicroK8s snap revision, runtime/shim/OCI binary
   hashes and configuration, service/boot ordering, effective handlers/namespaces,
   daemon/CRI/shim socket addresses and ownership, and every administrative/client
   route capable of start, resume, exec or restore. API status cannot supply these.
   The API-only phase above did not inspect hosts. The linked follow-up used
   existing trusted SSH without sudo or runtime RPC under this task's read-only
   authorization; unresolved privileged facts stay unverified rather than
   triggering installation, socket access or a new approval flow for ordinary reads.
2. Map those exact effects to one unavoidable runtime boundary and an independent
   durable history domain. Identify who can replace/disable it and how it excludes
   stale kubelets, already-forwarded calls, shim survivors, alternate handlers and
   node/boot replacement. If the installed build cannot supply such a boundary,
   record that failure; do not install a proxy and claim it closes the gap.
3. Produce the exact **proposed** host/runtime/pool change set and disposable
   proof plan for human review. A dedicated pool is not established by current
   Pod placement. Workload non-root/no-host-socket rules remain; privileged
   DaemonSets, socket groups, node shutdown or an in-place runtime replacement
   remain unauthorized. Only a separate explicit topology decision can expand it.

This decision commissions evidence/design, not installation or rollout. Keep
stable retirement unavailable until every pre-T effect is accounted for/stopped
and completed barrier B excludes all future same-UID execution under independently
retained current history. Canonical storage needs separate physical exclusion and
CAS proof. Neither current node metadata nor the passing synthetic hosted fixtures
can authorize next-command execution, restoration, adoption or capacity release.

The projected evidence is saved in the Paperclip workspace at
`.handoff-state/2026-10-20/retirement-design/runtime-current-inventory.json`.
It records node resource versions, exact reported identities and Pod/image
placement without retaining broad Pod configurations or secret contents. PR #5
stays draft; no tested source, production policy or workload pin changed.
