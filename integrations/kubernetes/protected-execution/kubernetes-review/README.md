# Inactive Kubernetes boundary review

This directory is not referenced by Flux or a Kustomization. `render.py` is a
pure review renderer and has no Kubernetes client, Docker access or ambient
credential discovery. It refuses activation, unresolved images, unbound policy
and unknown/rebound/multiple attempt PVCs. It creates **no PVC, Secret, provider
Pod, supervisor deployment or transfer deployment**. Its workload guard has zero
replicas and `failurePolicy: Fail`; applying this output would intentionally deny
all provider creation, not implement rollout. Do not apply it to the homelab.

Run local checks with:

```
python3 -m unittest discover -s protected-execution/kubernetes-review -p 'test_*.py' -v
python3 protected-execution/kubernetes-review/render.py reviewed-inputs.json > reviewed-boundary.json
```

There is no filled production input file. Immutable published image, CA, exact
policy/config, observed retained PVC incarnation, storage class/size and source
commit are still inputs to review. The unit fixture's invalid.example image and
certificate text are deliberately synthetic and cannot supply those facts. The
renderer verifies shape/bindings, not image provenance, certificate validity or
runtime storage properties. The storage-lock ConfigMap is an inventory record;
it cannot itself fence a mount or prove Retain reclaim behavior.

## Authority diff

The supervisor receives one namespaced RoleBinding, only in execution:

| Resource | Verbs | Restriction |
| --- | --- | --- |
| Pods | create/get/list/delete | Independent fail-closed admission below |
| PVC | get | Exactly one reviewed name; adapter separately checks UID |

There is no authority to update/patch Pod metadata/finalizers, exec, attach,
port-forward, create ephemeral containers, create/delete/rebind PVCs, read
Secrets, write configuration, use nodes, impersonate or grant RBAC. The guard and
transfer ServiceAccounts receive no role binding. Guard config is immutable;
replacing config, TLS or admission registration is a separate operator action.
The independently provisioned guard-only `guard-tls` Secret must contain
`tls.crt`, `tls.key` and the independent native-grant verifier `journal.key`;
none are embedded in rendered output.
Supervisor and provider must not mount guard verifier secrets, ledger or keys.
The admission guard must independently verify the native committed-command grant
with a key unavailable to the supervisor; owner/journal annotations alone cannot
establish authorization. Never place that key in `guardConfig` or logs.

Namespaces carry restricted Pod Security admission. Admission selects the
execution namespace using `kubernetes.io/metadata.name`, not a removable custom
label. The guard rejects template drift, arbitrary service account/token,
host/network/PID privileges, extra/ephemeral containers, canonical/arbitrary
volumes, injected annotations and metadata/finalizer mutation. The API must show
a valid positive control plus forbidden workload negatives and guard-down
failure. PodSecurity does not replace exact-template enforcement.

One Pod and one PVC quota bound this review envelope. Retained evidence finalizers
mean supervisor cannot erase an uncertain/terminal incarnation; trusted operator
cleanup must first preserve independently authenticated proof and durable state.
Quota one does not establish native queue admission or scope accounting.

## Network acceptance remains held

Both control and execution namespaces default deny ingress/egress, with no allow
rules in this artifact. There is no authenticated control, callback, DNS, public
provider or API path enabled. Required positive allow routes must be reviewed
with the real CNI and observed endpoint/service behavior. A separate serial
execution policy should allow only fixed controller callback destinations,
required DNS and public TCP 443 after excluding RFC1918, loopback, link-local,
CGNAT, multicast/reserved and every observed node/Pod/Service/LAN CIDR. Block IPv6
entirely unless equivalent IPv6 exclusions are tested. DNS must not turn a
public hostname resolving to internal addresses into an exception. Kubernetes
NetworkPolicy NAT evaluation differs across implementations; policy text is not
acceptance evidence. Provider Pods cannot have API access, supervisor/control
endpoint access, attempt-to-attempt access or unrelated internal egress.

The original kindnet whole-Pod fixture does not enforce NetworkPolicy. Its
deny-all object is **not a network isolation pass**. A separate enforcing-CNI
fixture now passes the bounded matrix recorded below. Use its separate cluster with
`networking.disableDefaultCNI: true`, then install an enforcing CNI with reviewed
immutable upstream inputs. Do not replace the CNI under the whole-Pod fixture.
The official [kind configuration](https://kind.sigs.k8s.io/docs/user/configuration/)
and [Calico kind guide](https://docs.tigera.io/calico/latest/getting-started/kubernetes/kind)
describe this path; the latter currently specifies v3.33.0. Downloaded YAML hashes,
image digests, Kubernetes/CNI compatibility and bounded resource requirements
must be recorded before installation. `network_fixture_runner.py` now pins the
official v3.33.0 direct manifest by SHA-256 and all three registry image indexes;
it creates only `pc-protected-network-disposable`, refuses overlapping kind
clusters, requires explicit kubeconfig even for cleanup, caps its node at 3 GiB
RAM / 4 GiB including swap / two CPUs / 1024 PIDs, and deletes that exact cluster
afterward. It requires host Python/PyYAML (local version 6.0.3) and explicit kind
v0.30.0; neither the CNI nor its privileged RBAC is a production proposal.

Actual packet test matrix must use a synthetic unprivileged provider and prove:

* Baseline positive reachability before policy for every negative destination.
* Policy-enabled allowed DNS/callback/public HTTPS and denied DNS alternatives,
  API VIP/direct endpoint, node IP, supervisor endpoint, unrelated internal Pod,
  LAN/metadata/loopback proxy, other attempts, non-443 public egress and IPv6.
* Same denied result after new Pod creation and CNI/node restart; failure must
  hold admission rather than silently replace the CNI or broaden allow rules.
* Public DNS returning private addresses and API Service DNAT do not bypass deny.

## Whole-Pod proof and outstanding review

Independent fixture host CRI/cgroup observation is outside the provider and
supervisor identities. It is broad host test authority and cannot be deployed.
The production witness remains an architectural decision: reviewed narrowly
bound observation service or explicit independent operator/node evidence. Missing
Pod/runtime/cgroup metadata, node partition, force deletion and runtime epoch
change retain occupancy. Neither API deletion success nor finalizer/terminal
status alone proves process stop. No supervisor nodes RBAC is proposed.

The integrated package still needs deployable observer authority, independently
verified per-command grant configuration, guarded storage transfer identities,
canonical-root mounts, ownership fencing, supported legacy evidence, restored
Paperclip-only migration/restart/rollback and exact controller/supervisor/
transfer/provider image pins, policy and manual migration commands. Old runner
SSH routes and old controller credentials must be blocked in the reviewed
migration. This scaffold does not waive shared Codex A holds, paused B, deferred
Gemini, disabled timers or any rollout/provider/concurrency gate.

`../test_network_disposable.py EXPLICIT_KUBECONFIG IMMUTABLE_PYTHON_IMAGE` now
implements the first synthetic packet stage on a separately named
`pc-protected-network-disposable` cluster. It refuses existing test namespaces,
requires a loopback API and matching kind node labels, uses no default kubeconfig,
and creates only four bounded non-root synthetic Pods. Positive baselines cover
allowed, sibling and unrelated Pod IPs and a service VIP plus API direct/VIP endpoints. Actual deny-all must
block all of them; a narrowly allowed callback target/port must then succeed
while unrelated control/API routes stay denied. Each observation must stabilize
three times. The fixture additionally recreates the client with a distinct Pod
UID and restarts the isolated calico-node DaemonSet, sampling every forbidden
route around the restart before repeating recovery checks. Only exact remote
socket exit codes count as reachable/denied; exec/transport errors are uncertain.
It requests async deletion of exact fixture namespaces afterward; the enclosing
runner deletes the complete kind node and verifies absence.

## Distinct disposable CRI stop receipt

`../cri_stop_witness.py` provides a separate fixture-host proof path when the
runtime removes the cgroup before passive observation. The official
[CRI API contract](https://github.com/kubernetes/cri-api/blob/master/pkg/apis/runtime/v1/api.proto)
requires successful `StopPodSandbox` to stop sandbox processes and forcibly stop
its running containers. The helper pins the original full sandbox ID, exact Pod
UID/container membership, node/runtime incarnation and configuration in FULL
synchronous SQLite. After independent API observation of exact retained Pod
deletion, it verifies fresh sandbox/container membership, invokes only that full
sandbox's `crictl stopp`, verifies unchanged runtime and exact retained Pod again,
and commits an explicit RPC-success receipt before replying. This is an active
trusted-runtime action, not inferring termination from missing objects.

Its independently authenticated domain is `whole-pod-cri-stop-v1`; evidence type
is `exact-cri-stop-success-v1`. It never synthesizes cgroup-empty or container
status. A fresh challenge can recover an already durable successful receipt after
metadata reclamation, only while the original retained Pod and runtime still
match. A missing sandbox without the durable original success, timeout, lost
completion before receipt commit, runtime restart, extra container, wrong owner
or removed/changed Pod remains uncertain. Host fixture `node()` must raise on
nonzero return, transport failure and timeout. An initial pin alone is no stop
proof. It provides no native capacity release.

Nine focused unit cases pass, including lost ACK/restart, exact sandbox/sibling
binding and all listed uncertainty paths. Actual integration remains the separate
whole-Pod fixture's responsibility. This helper's injected broad node authority
is deliberately fixture-only: it does not solve the production observer
architecture or authorize deploying node access into the supervisor.


## Final bounded network result — 2026-10-19

Corrected final source **PASS** on pinned kind v0.30.0 / Kubernetes v1.34.0 /
Calico v3.33.0. Evidence is in the Paperclip workspace at
`.handoff-state/2026-10-19/protected-network-final/`: `actual-network.json`,
`runner.log`, `installed-pods.json`, `pins.json`, `source-hashes.json` and
`cleanup.json`. Executed fixture/runner hashes match final source.

Five stages pass: positive baseline, default deny, exact synthetic callback
allow with other routes denied, fresh distinct client UID, and CNI restart plus
recovery. Ten forbidden-route samples around restart all deny; five samples
observed Calico ready count zero. After recovery the callback connects and
sibling/unrelated Pod, control Service VIP, API VIP and direct node API routes
remain denied. All synthetic workload processes are non-root with no token.
Exact cluster cleanup passes with no matching node containers.

The previous restart run failed at fixture client deletion because default
30-second Pod grace exceeded its 20-second wait. Its API/cleanup evidence remains
in `protected-network-restart/`; no restart pass is attributed to that run. The
corrected final run explicitly uses one-second Pod/deletion grace and bounded
600-second packet execution. Policy was not broadened.

This does not establish public HTTPS/DNS/IPv6/LAN/metadata exclusions, real node
restart/partition behavior, native admission holding while CNI is unhealthy,
authenticated control/callback routes or homelab CNI acceptance. There is still no
production activation, provider dispatch or topology approval.
