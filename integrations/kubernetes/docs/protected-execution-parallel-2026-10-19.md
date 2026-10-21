# Protected execution parallel implementation — 2026-10-19

This advances draft homelab PR #5 beyond `5256cf9`. It is an inactive development
candidate, not the complete integrated rollout package or operational acceptance.
The user explicitly authorized parallel development; three agents owned Kubernetes
and networking, state/transport, and legacy reconciliation/clone rehearsal. The
primary agent integrated native journals, durable ACK pins and verification.

## Implemented

- Narrow Kubernetes adapter contract and independently keyed fail-closed webhook:
  digest/template, exact PVC identity, UID/security/volume/resource restrictions and
  signed committed-native-command grants. Real disposable RBAC and nine forbidden
  workload mutations are checked. No ambient/default kubeconfig discovery.
- Independent exact CRI StopPodSandbox receipt with durable original sandbox,
  container, Pod UID, node/runtime and storage bindings. A retained terminal Pod
  and authenticated successful stop RPC are required together. Stable whole-Pod
  retirement against stale-kubelet replacement sandboxes is not proven. Object disappearance
  is uncertainty. The privileged host observer is disposable test infrastructure;
  it is not a deployable production witness.
- Native immutable command journals, committed challenges, ACK identity/epoch CAS
  and durable sequence/hash floors from authenticated PostgreSQL receipt history.
  Optional host-installed protected transport precedes SSH authentication and covers
  direct Git/tar spawns. Missing protected transport on restart holds cleanup.
- Durable complete state contracts, immutable fsynced multi-root objects, atomic
  version CAS, quarantine and independent storage/release fence interfaces. Real
  PVC detach, ownership and canonical alias activation backends remain absent.
- Append-only present-day legacy decisions with exact immutable historical owner,
  lease, run and scope bindings, revocation and supported lifecycle re-evaluation.
  Native admission requires a separate decision for every shared hold. No real A
  decision was signed or applied and no historical receipt/state was rewritten.
- Generated migrations 0345/0346 and five latest schema snapshots. Actual synthetic
  Paperclip PostgreSQL dump/restore, coordinated files/config, interrupted/manual
  migration reapply and held source-service restart checks. This does not establish
  old/new application-image or real PVC migration/rollback acceptance.
- Inactive held boundary renderer and expanded disposable/native hosted workflows.
  No executable supervisor/provider/transfer workload or published rollout digest.

## Evidence and limits

Evidence is in `.handoff-state/2026-10-19/protected-kubernetes/` and
`protected-network-final/`. Final actual kind API fixture passes: real admission
and RBAC negatives, guard outage refusal, non-root descendant workload, observer
restart/disconnect, exact whole-Pod stop, byte-identical retained uncommitted output,
force-delete refusal and uncertainty after external removal. Its default kind CNI
is not enforcing; the separate pinned Calico packet fixture passes positive
baselines/default deny/exact callback, sibling/control/API/node negatives, fresh
Pod UID and ten denied restart samples (five while Calico was unready).
These fixtures use explicit loopback disposable clusters and synthetic tools.
Neither verifies homelab networking or production node authority.

Final bounded Python contracts passed 92 cases, including a passing attack
characterization that demonstrates the old-envelope rollback replay remains unsafe.
The rebuilt separate supervisor/provider-container fixture also passes.
The broad native snapshot passed 455/457 cases; two connection-intent continuation
fixtures exceeded the existing three-second terminal poll. Their unchanged behavior
passed a three-case isolated recheck; the final fixture uses a finite ten-second
completion poll plus actual-state diagnostics and preserves exact dispatch/claim
and drain assertions. The final full 61-case file recheck PASS (226.62 seconds). The whole broad
suite has not been rerun locally. Final 41 journal/transport cases and focused service typecheck pass.
Exact 59-file source reconstruction, atomic reapply refusal, five snapshots,
YAML/shell syntax and unchanged six production-input hashes pass. Hosted protected-execution run `39323658971` PASS. Native run `39323659151`
PASS, including: 459 native cases, 329 transport cases, full server/
adapter-utils/DB/focused typechecks, original contracts and all three actual SSH
fixtures, complete production image build, mandatory missing-policy startup
refusal and all three CLI guards. The built controller image is unpublished:
`sha256:9cd50c354306955af2cfb9c97ecdb723491326421d74df0c433d01133fd0da5b`.
This is not an integrated protected-topology image. The full
server check peaked at 6 GiB with zero OOM kills; keep it on hosted capacity. Do not
carry the old 5256cf9 hosted PASS forward to these changes.

## Remaining gates

1. Production authenticated gateway/client and independently narrow stop witness;
   mandatory executable policy injection, attestation and native CNI-health fencing.
   Prove kubelet/node retirement fencing against replacement sandboxes after stop;
   stopping the original sandbox alone is insufficient under node partition.
2. An independent *current* launch-consumption fence against a replayed old signed
   authorize envelope after supervisor ledger rollback and runtime-object removal.
   Fresh request high-water floors alone do not close that combined attack.
   Multi-command attempt ownership, occupied epoch adoption and assembled native
   callback/cancel/transfer/restart acceptance through the protected topology.
3. Actual canonical state/config attestation, external storage/release/high-water
   backends, exclusive PVC detach/handoff and UID1000 trusted transfer design.
4. Operational evidence/signing and reviewed old-runner retirement/route revocation
   for every original A/shared hold. Preserve original scope families; do not exempt B.
5. Restored-clone old/new controller-image and real PVC migration/restart/rollback.
6. Exact executable integrated image/policy/RBAC/admission/storage/network/workload
   and manual-migration diff, published immutable images and human topology review.
7. Public/DNS/IPv6/LAN/metadata and node-failure/partition checks, full provider,
   refresh, headroom, budget and recovery acceptance.

No live checks/mutations, providers, migration, publication, capacity changes or
merge were authorized/performed. Docker broker, node observer and CNI installer
must not be deployed. Preserve A historical holds/shared Codex scopes, paused B,
Gemini deferral, timers off, held capacity, draft PR #5 and human-reviewed merges.
After reviewed rollout and full shared-hold resolution: ten bounded serial Codex
tasks on B, then Claude lifecycle/session/refresh; overlap comes later.

## Concrete fence review contracts

[Current launch consumption](current-launch-fence-review-2026-10-19.md)
and [stable Pod retirement](pod-retirement-fence-review-2026-10-19.md)
describe the unresolved authority and failure boundaries. These are proposals,
not implemented fences or approval for root/privileged workloads. Atomic online
native consumption during CREATE is a candidate for new-Pod replay; stale-kubelet
same-UID sandbox replacement requires its separate runtime/retirement fence.
