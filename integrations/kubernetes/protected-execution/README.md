# Protected execution candidate: inactive development

This package and the native overlay are development candidates on draft PR #5.
They do not form a deployable rollout package. Production preparation, workload
pins, held bootstrap and live capacity are unchanged. No provider dispatch.
Keep both historical A holds and original shared Codex scope identities, B paused,
Gemini deferred, timers off and human-reviewed merges.

## Current continuation: one-use CREATE and fail-closed retirement

The current candidate adds a native `consumePodCreate` transaction and an online
mutual-TLS client. The transaction serializes against native scheduling and
cancellation, checks the exact committed command/lease/epoch/original scope set,
all shared legacy holds and a host-installed current storage attestation, then
permanently consumes one command permit. Repeated reviews, ambiguous persistence,
Pod disappearance and supervisor rollback never unconsume it. Its durable record
uses the existing immutable native request table. No new migration is needed.
A host-only native mTLS endpoint factory is implemented; its installer and
physical storage attestation remain unimplemented. The existing Kubernetes test
uses a separate **fixture** authority. New `launch_native_fixture.py` assembles
the actual webhook with the native PostgreSQL transaction over pinned mTLS;
hosted run 39449824759 passes all six actual Kubernetes/native PostgreSQL modes,
including cancellation, storage refusal, lost response, database loss and later
validation failure. Native client/journal reconstruction is exercised; actual
process restart, physical storage authority and operational acceptance remain open.

The executable admission webhook now requires pinned API-server mutual TLS and a
current consumer. Static-grant-only helper mode cannot start that service. Exact
Kubernetes v1.34.0 CREATE UID/retry evidence is tracked in the continuation report.
This covers another API Pod object; it does not fence runtime recreation for the
same UID. The older Docker fixture still deliberately characterizes its unsafe
rollback replay. Neither that broker nor fixture consume ledger may be deployed.

Sequential commands preserve one exact attempt owner/storage and require an
independent stable-retirement authority for every previous command. Missing
verification, an original-sandbox stop, changed ownership or uncertainty holds
progress. Same-epoch recovery requires an exhaustive immutable command manifest
and returns recorded state only; occupied-epoch adoption is still unsupported.
Native transport likewise refuses to record stop without a host verifier that
must durably validate/pin independent retirement history before returning.
No production verifier is installed; Kubernetes `verify_retired` always refuses.
Native inspection-only recovery and repeated spawn require the previously
accepted physical identity plus a current matching running observation. Neither
may issue a new launch. A permanent native PostgreSQL stdin claim now rechecks
the original owner/token, command/scopes/lease/epoch, exact current accepted ACK
and matching native Pod CREATE consumption before any gateway attachment. It
never expires or grants another writer after disconnect, restart or lost reply.
Recovery can inspect retained work and obtain its first writer only; existing
writer ownership stays held. The production gateway must independently enforce
and consume that exact claim. This enforcement, safe writer reacquisition and
occupied-epoch adoption remain absent.

`IndependentStorageFence` now persists canonical high-water and exact proof IDs in
a separate protected FULL-sync SQLite domain. It detects canonical-store rollback
while that current authority survives. Prospective high-water is pinned before
the canonical commit; an incomplete commit leaves current authority ahead and
holds recovery. Current physical proofs bind the exact canonical generation and
snapshot before a CAS transition; restoration requires stable retirement.
These are protocol fixtures, not physical PVC enforcement. They do not manufacture physical detach,
retirement, release or external refresh facts, and must not be restored with the
canonical store. Real PVC fencing/alias activation and authority-restore handling
remain required. `legacy_review.py` reviews separately rooted artifacts for every
original shared hold but cannot sign decisions, change lifecycle or release A.
Native append now requires a host evidence verifier bound to the complete locked
hold inventory and rechecks its shortest evidence deadline after verification.
Conservative revocation needs a complete fresh bundle and explicit operator
action approval; no emergency revocation or operational signer is installed.
The restored-clone source test additionally restores its pre-upgrade database and
files after migration/restart/divergence; final application-image/PVC rollback is
still unverified.

**Stable retirement is unavailable under the currently approved topology.**
Admission is not on the kubelet's same-UID CRI execution path. An approved mandatory
runtime fence is absent, and no privileged proxy, raw socket access or host change
has been added. The candidate therefore keeps release/next-command gates closed.
A complete deployable integrated image/RBAC/admission/storage/network/workload diff
cannot be honestly produced until that authority and the remaining backends exist.
This is an implementation dependency, not permission to deploy a fixture witness.

## Boundaries and implemented contracts

- `authority.py`: distinct non-root supervisor, FULL-synchronous SQLite consumption,
  exact immutable invocation/owner identity, epoch history, cancellation tombstones,
  authenticated requests/replies and event sequence/hash rollback floors. The native
  verifier derives its independent durable floor from immutable accepted PostgreSQL
  receipts. Requests carry the floor before launch; repeated native preparations
  inspect the old invocation instead of authorizing the body again. The exact
  historical prefix is checked under the ledger mutation lock even when newer
  events exist. This protects fresh current-floor requests, not captured old
  envelopes: see the unresolved rollback/replay attack below. Occupied epoch
  adoption and multiple executable commands per attempt remain unsupported.
- `kubernetes_boundary.py` and `admission_webhook.py`: exact digest/template,
  non-root UID, service account, volume, resource and security settings enforced by
  a separate fail-closed HTTPS validating webhook. The native committed-command
  grant has an independent key absent from the supervisor/provider. It binds the
  command, original owner, journal, logical storage and exact PVC UID/name/image.
  `kubernetes_api.py` supplies candidate HTTPS transport for namespaced Pod
  create/get/list/delete and one fixed PVC UID/name GET. It snapshots explicit CA
  and bearer auth, accepts literal IP origins only, applies one network deadline
  and never discovers kubeconfig, retries or follows redirects. Seventeen loopback
  TLS contracts pass; actual scoped-service-account verification is wired in the
  disposable workflow. It is not installed in a production gateway and establishes
  no namespace-incarnation, native launch, retirement or physical storage authority.
- `cri_stop_witness.py`: distinct independently authenticated successful exact
  `StopPodSandbox` RPC evidence. Original sandbox/Pod/container/node/runtime pins,
  a retained deleting Pod and FULL-synchronous receipt persistence are required.
  Missing metadata without that receipt, timeout, wrong owner or runtime change
  remain uncertain. Stable whole-Pod retirement under a stale kubelet/node partition
  still needs an independent fence excluding replacement sandboxes. No Pod disappearance, deletion timestamp, process listing or
  invented cgroup metadata becomes stop proof. Wire observation times are integer
  milliseconds; control request/grant expiry is integer Unix seconds.
- `durable_state.py`, `state_contract.py`, `safe_transfer.py`: bounded detached file
  operations, complete destination schemas, immutable fsynced objects, atomic heads,
  version CAS, retained quarantine, separate restoration results, nested Claude
  projections, exclusive ownership and exact native-release/high-water interfaces.
  External storage/detach/high-water proofs must be authenticated independently.
  There is no production PVC ownership or canonical alias/mount activation backend.
- Native `protected-execution-journal.ts` / `protected-execution-transport.ts`:
  committed native command/lease checks, durable challenges and ACK pins, immutable
  signed journal grants and optional host-installed transport selection before SSH
  auth. Every direct transfer spawn uses the selected executable. Uncertain calls
  cannot fall back to old SSH; retained protected journals without the installed
  transport hold restart cleanup. There is no production gateway or installer.
- Native `execution-legacy-reconciliation.ts`, migrations 0345/0346: append-only
  reviewed present-day evidence, immutable original hold/lease/run/scope bindings,
  revocation and supported lifecycle re-evaluation. Each shared hold requires its
  own decision. Historical receipts, native run/lease facts and hold rows remain.
  An operational evidence signer and real A reconciliation are not supplied.

The native overlay preserves exact source reconstruction over the existing SSH
candidate; never reset or blindly reapply it to `.work/paperclip-admission`.

## Disposable verification

The dedicated workflow runs bounded UID-2000 Python tests, the separate UID-1000
provider/container fixture and actual disposable Kubernetes tests. `test_disposable.py`
uses a trusted host Docker broker. `test_kubernetes_disposable.py` uses an explicit
loopback-only named kind cluster, independent webhook, real RBAC/API negatives,
exact node/runtime stop evidence, retained descendant bytes and conservative loss.
`test_network_disposable.py` plus `kubernetes-review/network_fixture_runner.py`
use a different named kind cluster with pinned official Calico to test packets.
They never discover the default kubeconfig or connect to the homelab.

**The Docker broker, kind node/CRI observer and CNI installer are trusted fixture
host infrastructure. Do not deploy them.** Supervisor/provider test workloads are
non-root; privileged kind/CNI internals exist only inside disposable test nodes.
An enforcing-CNI fixture pass is not homelab network acceptance.

`Dockerfile.disposable` is test-only. `Dockerfile.clone-tools` extends a supplied
candidate test image with pinned PostgreSQL client tools for the actual synthetic
Paperclip schema/files/config dump/restore rehearsal. See `CLONE-REHEARSAL.md`.
Neither is an integrated production image or published deployment digest.

## Legacy runtime rollback replay and the separate current CREATE boundary

A still-valid captured signed authorization carries its original, older rollback
floor. If the supervisor ledger is restored to before consumption AND the retained
runtime object is removed, replaying those exact old bytes can launch a second
body before the controller rejects its divergent ACK. Repeated native preparation
uses inspection, but cannot prevent replay at the authenticated control endpoint.
`test_known_limitation_old_valid_envelope_relaunches_after_storage_and_runtime_loss`
is an explicit synthetic attack characterization: its passing result demonstrates
the limitation, not successful containment. No deployable same-epoch rollback or
replayed-envelope protection is accepted. An independently current durable
nonce/consumption fence outside the restored ledger, or an equivalent reviewed
online native launch fence, is required before rollout. The legacy fixture wire
protocol also accepts requests without a high-water field and supplies no such
guarantee. Runtime-name retention adds a barrier only while that object survives.

## Remaining before a complete executable review package

1. Installed production authenticated gateway and independently narrow node/stop
   witness; mandatory policy injection and full guard/configuration attestation.
2. Multi-command attempt ownership, recoverable epoch adoption and assembled native
   callback/cancel/transfer/restart acceptance through the protected topology.
3. Actual canonical root/config attestation, durable external state high-water and
   native-release backends, real PVC ownership/detach/alias activation. Transfer can
   use UID 1000 in a separate trusted Pod with exclusive mounts; UID 2000 cannot
   silently chown provider-owned files. The final storage design needs review.
4. Reviewed original runner retirement/old-route revocation and independently
   verified state/stop evidence for every original A/shared hold. No live release.
5. Restored-clone old/new application-image and real PVC migration/restart/rollback,
   beyond the synthetic full-schema source-service rehearsal.
6. Integrated published digests and exact executable policy/RBAC/admission/storage/
   network/workload/manual-migration diff. `kubernetes-review/` renders only an
   inactive held boundary, with no executable supervisor/transfer/provider workload.
7. Full homelab network/failure/recovery/provider/headroom/budget/refresh acceptance.

The CRI contract is primary runtime documentation:
[StopPodSandbox](https://github.com/kubernetes/cri-api/blob/master/pkg/apis/runtime/v1/api.proto).
Kubernetes [forced Pod deletion](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#forced-pod-termination)
is not termination confirmation. After reviewed rollout and complete shared-hold
resolution, ten bounded serial Codex tasks on B precede Claude lifecycle/session/
refresh checks. Overlap remains later.
