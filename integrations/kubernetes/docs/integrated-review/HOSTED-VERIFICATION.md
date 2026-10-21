# Integrated hosted verification — 2026-10-20

## Real verify-only cryptographic primitive

[39502630633](https://github.com/adhn/homelab/actions/runs/39502630633) PASS on1695530:11 actual Ed25519 cases in0.014s. Local11 PASS in0.048s. Test-only pinned hashed wheels; bounded nonroot/offline/read-only container. New gate matrix and exact limitations: [daily-use mechanisms](DAILY-USE-MECHANISMS.md). No runtime/storage/custody/native authority installed; native64/six production inputs/dirty state unchanged. Prior164/seven guards, native and image passes reused without rerun.

## Owned authority services continuation

Functional source `69125a5` passes [39496569852](https://github.com/adhn/homelab/actions/runs/39496569852):
**164 component cases in17.420s plus seven reconstruction guards in8.633s**.
Local130 distinct affected cases pass across initial128/final11 with nine overlaps;
the final11 includes two whole-decision tests added after initial128. Local seven
guards pass in18.624s. Same pinned non-root/network-none/read-only/init container,
256MiB RAM/512MiB including swap/one CPU/64PID/32MiB tmpfs; no heavy rerun.

[Owned services and precise limitations](OWNED-AUTHORITY-SERVICES.md) adds actual
local process ownership for runtime/root/write/decision calls, complete verifier
ownership and local SQLite prospective history. Backends are synthetic; real
runtime retirement, physical storage, custody and native every-effect authority
remain blocked/open. All64 native d489129 hashes, deliberate dirty status and six
production inputs match initial evidence. Existing native39482618313 and
image39482618289 passes are reused for unchanged source/recipe only. Three agents
used disjoint files/no children/root-only Git and independently reviewed another
track. No operational acceptance, live/provider/publication/migration/topology/
capacity/merge. Only unrelated Ollama/Qdrant containers remain.


## Ordered authority boundaries continuation

Functional source `862d648` passes [39493128372](https://github.com/adhn/homelab/actions/runs/39493128372):
**133 component cases and seven optimized reconstruction guard methods**. Final
local133 PASS in 18.766 seconds uses the same pinned non-root/no-network/read-only
container with 256MiB RAM/512MiB including swap/one CPU/64PID and init. New cases
cover runtime16, write/root14 and ordered-decision12; stream increases to22.
Gateway23/evidence22/worker12/current-history12 remain in the affected assembly.

Stream writes now require exact atomic-write interfaces; no actual atomic backend
is supplied. Runtime rehearsal and history/write backends are synthetic. Native
source d489129/all64 and six production inputs remain byte-identical; existing
native39482618313/image39482618289 successes were reconfirmed and reused. No full
graph/build/Kubernetes fixture was rerun. See [integration boundaries](ORDERED-AUTHORITY-INTEGRATION.md).
Three agents used disjoint files, no children and root-only Git; all independently
reviewed another track. No real issuer/key custody, mandatory runtime enforcement,
physical stale-writer exclusion or native every-use integration is accepted.

## Owned operations, bytes and current legacy history continuation

Functional source `2a72f9e` passes hosted
[39491421658](https://github.com/adhn/homelab/actions/runs/39491421658): **89 component
cases plus seven reconstruction-guard methods**. Components comprise 23 gateway,
20 stream, 22 evidence, 12 worker and 12 current-history cases. Hosted component
runtime was 8.834 seconds; reconstruction guards took 8.359 seconds. Final local
verification passed the same 89 cases in 20.192 seconds.

Both used the pinned Python container with non-root UID/GID 2000, no network,
read-only source/root, 256 MiB RAM / 512 MiB including swap / one CPU / 64 PIDs
and a 32 MiB temporary filesystem. `--init` reaps disposable orphan processes.
Python syntax, review links, workflow YAML and whitespace checks pass. Three
development agents used disjoint ownership; root handled interfaces, integration,
evidence and all Git operations. Finished agents performed independent reviews.

The process tests include actual spawned/forked local workers, stalled native
and backend calls, exact binary chunks, partial IPC frames, send backpressure,
adapter death with a descendant and owned refusal followed by exact close-only.
Remote/runtime/storage authorities remain synthetic. History tests use a fake
public-verification interface and synthetic retained state; they do not verify
real cryptography, native restore, key custody or use/revoke ordering.

Filter-only `bd6f2f1` isolated the new tests from unchanged heavy fixtures. Native
`d489129` / all 64 files and the six production inputs remain unchanged. Original
hosted native/image results below were reconfirmed successful without rerunning.
No full graph/build or Kubernetes fixture ran locally. Detailed logs, hashes and
review diff are retained in the Paperclip workspace under
`.handoff-state/2026-10-20/authority-ownership/`.
See [the implementation delta](IMPLEMENTATION-DELTA.md) for exact remaining
boundaries. This is source verification; operational acceptance remains held.

## Native, stream and evidence continuation

Native functional source `d489129` extends the overlay to 64 files. Hosted
[39482618313](https://github.com/adhn/homelab/actions/runs/39482618313) **PASS**:
567 native cases across 24 files, 329 transport cases, full server/adapter/DB/focused
typechecks, original 18 DB/24 subprocess contracts, three actual SSH fixtures and
all six Kubernetes/native PostgreSQL modes, with cleanup. This includes durable
stream tickets, role-specific native endpoint factories, bounded independent
mTLS authority client and source-only evidence subprocess adapter. Physical
ACK/storage/history remain synthetic; no production authority is established.

Latest Python source `d528ec0` is verified by
[39485235218](https://github.com/adhn/homelab/actions/runs/39485235218) **PASS**:
58 gateway/stream/evidence cases and seven reconstruction-guard methods covering
21 interpreter subcases. This includes actual loopback mTLS, complete-inventory
and exact append-intent operator consent, bool-pin refusal and late-stream proof
expiry. Synthetic backends do not establish runtime/storage authority. Earlier
39482618270 passed 52 cases before the final approval corrections and is not
substituted for this result.

Image/PVC run [39482618289](https://github.com/adhn/homelab/actions/runs/39482618289)
on `d489129` passed the complete unpublished image build, all three CLI guards,
missing-policy startup refusal and exact migration-module checks. Its actual
image/PVC migration/restart/coordinated rollback and cleanup also **PASS**.
The synthetic result remains explicitly `productionAcceptance:false`; no real
backup/RPO/RTO, operational authority or production headroom is accepted.

The 64 native files and production recipes remain byte-identical since `d489129`.
The native patch helper subsequently changed only to preserve preflight guards
under Python optimization; normal and optimized actual-Git reconstruction yield
identical native source and refuse reapplication. The targeted guard suite covers
that helper delta. No unchanged full build is credited for changed helper/Python
source. Six production policy/preparation/workload inputs remain unchanged.

Local affected source evidence is 142 distinct native cases with overlapping
reruns, final 58 Python cases plus seven guard methods and focused typechecks.
The intentional dirty source checkout was never reset or reapplied. Full graphs
and image builds ran on hosted capacity. Runtime/physical storage inventories are
read-only metadata, not retirement or stale-I/O exclusion proofs. Real issuers,
key custody, accepted/revoked decision use-side rollback continuity, byte forwarding
and every-write revocation remain absent; activation and hold release stay blocked.

A final independent review additionally required strict stream history revision
advancement beyond consume, now corrected with an equality regression. Final
[39488354391](https://github.com/adhn/homelab/actions/runs/39488354391) on `47905d0`
**PASS**: 58 component cases plus seven guard methods. The d528ec0 pass predates
this narrow validation change. Synchronous backend deadline contracts can still
block the control lock; socket close alone does not cancel a worker. This remains
a production adapter/worker ownership requirement, not an enforced total timeout.

Earlier sections below retain their historical source and verification scope.


## Independent client follow-up

Candidate `22b64d7` adds an independent control-client component, bounded
contract workflow and authority/evidence/activation review documents. Hosted
[39472541089](https://github.com/adhn/homelab/actions/runs/39472541089) PASS:
15 synthetic/mocked client cases in a read-only, non-root, network-disabled
container capped at 256 MiB RAM / 512 MiB including swap / one CPU / 64 PIDs.
This verifies client binding/order/refusal and close-only behavior, not actual
mTLS deployment, native transaction handlers, streaming or physical authority.
No production server/installer was added; endpoint names are proposed contracts.

Filter-only `363dc1a` used `[skip ci]` before the functional push to isolate this
new check from unchanged Kubernetes/image fixtures. Native 60-file hashes,
intentional dirty source and the six production inputs remain unchanged; the
existing full-build/native/protected/image-PVC passes below are retained within
their original scopes. No full production build or runtime proof is claimed for
the disconnected new component. The final documentation checkpoint changes no
tested client source. See [the activation boundaries](ACTIVATION-BOUNDARIES.md).

PR #5 remains draft. This is source and disposable-fixture verification only.
No live verification/mutation, provider dispatch, publication, live migration,
workload pin, capacity increase or merge occurred. All historical holds remain.

## Exact source boundaries

Native functional source: `3dc1426`. Current functional review: `3dcaad6`.
All 60 native overlay hashes and all 88 tracked controller build inputs remain
identical to `3dc1426`; later changes affect API transport, disposable harnesses,
workflow acceleration and documentation. Exact reconstruction/reapply refusal,
intentional dirty-source match and six unchanged production hashes pass.

| Check | Evidence | Result and limit |
| --- | --- | --- |
| Native source | [39449824759](https://github.com/adhn/homelab/actions/runs/39449824759) | PASS: 523 native / 329 transport, full typechecks, original 18 DB / 24 subprocess contracts, three actual SSH fixtures and six actual Kubernetes→mTLS→native PostgreSQL modes |
| Final protected/API | [39458972052](https://github.com/adhn/homelab/actions/runs/39458972052) | PASS: 136 protocols, 7 renderer, 22 API and 6 retry cases; actual non-root containers, scoped bearer Pod/PVC operations, API failure modes, CNI and cleanup |
| Final image/PVC | [39466029222](https://github.com/adhn/homelab/actions/runs/39466029222) | PASS: 28 harness cases; actual old/new manual migration, policy/stale-schema controls, distinct Pod/held-epoch restart, coordinated DB+file rollback, unchanged source, four distinct PVC/PVs and cleanup |

The six native modes cover normal CREATE, cancellation-first, storage refusal,
lost allow response, database destruction and later-validator refusal. They use
synthetic physical ACK/storage attestation; endpoint/client reconstruction is not
native process restart. No stable retirement or production command execution is
accepted. Scoped HTTPS API uses fixture SQLite consumption, explicitly not native
PostgreSQL acceptance. API deletion is never retirement proof.

## Failures preserved and corrections

- Initial full image/PVC 39443590395 failed candidate kind image import at 240s,
  before app/DB/PVC acceptance. Corrected 39450806226 imported candidate in 216s,
  then failed old-source migration because the compiled DB client path was absent.
  Attempt 39458972126 verified cache/module preflight but old import timed out at
  240s, before migrations; candidate took 331s. Both controller deadlines are now
  600s, PostgreSQL 240s unchanged; no retries or cap increase. Memory pressure was
  observed with zero OOM kills; the sole cause remains unproved.
  Attempt 39462308092 passed both imports, packets and actual old-image manual
  migration, then old-source health failed with V8 heap OOM (exit134, ~380MiB
  old heap under 768 MiB Pod), not cgroup OOMKilled. The final fixture serializes
  APP_COMMAND-only1536MiB/old-space 768 MiB; other Pods and the node caps remain
  unchanged. It records effective heap configuration and failure diagnostics;
  the remaining system budget is not measured headroom.
  Final harness imports packaged `/app/packages/db/src/client.ts` through shipped
  TSX and checks required exports/completion. It does not substitute SQL/migrations.
- Protected 39454917469 failed actual StopPodSandbox with a CNI duplicate-delete
  error; no receipt was issued. Fixture-only max 3 exact retries narrowly match the
  pinned sandbox/ptp/eth0 error. Every attempt still revalidates original identity
  and requires a successful RPC plus durable receipt. Other/exhausted errors hold.
  The final actual run used one attempt with zero retries; the error/retry branch
  is unit-tested and is not claimed as a reproduced actual CNI-race success.
- Protected 39456254273 rejected valid PodList items omitting TypeMeta. Explicit
  validated-list context now permits both fields absent; standalone/partial/wrong
  types still refuse. Protected 39457553313 rejected a terminal synthetic Pod's
  positive delete; final fixture uses a bounded scheduled Running Pod with strict
  UID/resourceVersion/grace unchanged. Numeric HTTP status is the only new error
  diagnostic. No response bodies, headers, tokens or write retries are introduced.

[Kubernetes v1.34 pod deletion strategy](https://github.com/kubernetes/kubernetes/blob/v1.34.0/pkg/registry/core/pod/strategy.go#L149-L180)
normalizes terminal/unscheduled Pod deletion grace to zero; that is consistent
with the terminal fixture's refusal, whose original HTTP status was not saved.
The strict guard has not been weakened.

## Cache and cancellation accounting

Generated Python bytecode under the original broad hash can invalidate its key.
The replacement hashes tracked build inputs only plus the actual modified build
recipe. A reviewed one-time prior-cache pin requires both exact source and recipe
fingerprints; archive checksum, metadata key, loaded image ID and label must match.
It is trusted disposable Actions acceleration, not independent source attestation
or operational recovery. Startup/CLI and module checks always run.

Superseded 39449824727 was cancelled after full build/guards/cache save, never a
rehearsal pass. Redundant native 39456254296 was cancelled with cleanup PASS:
unchanged native source was already exactly verified; only an unused fixture
observer changed, covered by protected checks. Other cancelled runs are not passes.

Local final API 22, fixture retry 6, image harness 26 and legacy 11 cases pass; these
supplement rather than replace hosted execution. Full graphs remained hosted.
Three development agents used disjoint ownership and independent read-only
reviews; no grandchildren or concurrent Git index operations. No local disposable
containers remained at the last inventory.

The [review entry](README.md) records six package dispositions and unresolved
runtime retirement, physical storage, gateway, real A evidence and activation
requirements. Fixture success cannot release these holds or accept real recovery.

## Final scope and retained holds

The final result explicitly sets `productionAcceptance:false`. All four real
application boots (old source, candidate, candidate restart and old rollback)
used 1536 MiB with configured old-space 768 MiB; the helper reported V8 total heap
limit 905969664 bytes. This is configuration evidence, not parent-server RSS or
production headroom. Node 3 GiB / 5 GiB swap / 2 CPU / 1024 PIDs, migration 768 MiB and PG/tools
256MiB remain; no local budget changed. The source database/files remain intact,
and candidate rollback restored the original schema/files before old-image boot.
No real account/session/backup service or homelab recovery target was exercised.

The six-package result is source/disposable verification plus explicit blockers:
new-Pod launch consumption passes; same-UID stable retirement is blocked;
transport/CAS/recovery protocols pass but production gateway/physical storage and
writer reacquisition/adoption remain open; native present-day reconciliation is
supported/tested but all real shared-hold evidence/issuers/review remain missing;
the synthetic actual-image/PVC rehearsal passes; the exact source review diff is
prepared while executable activation remains blocked. Review the linked runtime
and physical storage decisions before implementation. No hold has been released.
