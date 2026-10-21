# Disposable controller-image and PVC rehearsal

`image_pvc_clone.py` runs real application images and actual Kubernetes PVCs in
one dedicated disposable kind cluster. It is trusted fixture-host infrastructure,
not a deployable controller, broker, storage backend or operator tool. It never
loads the ambient kubeconfig. The exact old application is the reviewed published
controller digest `sha256:8bd2d8ccef956c777ea6eefa2004152632e0781706031e8cd42ef89bdd7c50ca`.
The new image must already exist locally as `paperclip-admission-candidate:latest`
from the complete hosted production build. The exact old controller and PostgreSQL
digests must already be authenticated/pulled by the trusted hosted runner before
that expensive build; CI logs out immediately afterward. The harness performs no
registry login/pull, mounts no Docker credential file and supplies no registry
token or imagePullSecret to kind/Pods. It refuses a missing/mismatched Docker
`RepoDigest`, config ID, rootfs layer identity or platform before creating kind.
Registry image bytes are tagged only to fixed disposable transport aliases
`pc-clone-old-controller:disposable` and `pc-clone-postgres:disposable` and imported
with `kind load docker-image`. The aliases do not change their rootfs/config ID.
All workload Pods use `imagePullPolicy: Never`. No `ctr images pull` occurs.

`image-bindings.json` preserves original immutable registry references and matched
RepoDigests alongside host config IDs, rootfs layer digests and transport aliases.
Each imported alias must resolve through CRI `inspecti` to its bound host config
ID. For every running/completed Pod, the observed Kubernetes imageID resolves
through CRI `inspecti`, and its exact container ID resolves through `crictl
inspect` plus that container's imageRef through `inspecti`, to the same config ID.
The imageID is allowed to be a config digest or repository manifest reference;
formatting differences never waive config identity. Full container/image
inspection and `pod-image-bindings.json` retain that chain. The harness does not
build, publish or substitute a test image.

Invoke only after the hosted production build and after all other kind/heavy test
work has finished:

```sh
python3 "$PACKAGE/protected-execution/image_pvc_clone.py" \
  --kind "$RUNNER_TEMP/kind" \
  --calico-source "$RUNNER_TEMP/calico.yaml" \
  --evidence "$RUNNER_TEMP/image-pvc-clone" \
  --candidate paperclip-admission-candidate
```

`--evidence` must name a new directory. `kind` must be the previously hash-verified
v0.30.0 binary. The official Calico v3.33.0 source must match the hash already
pinned in `kubernetes-review/network_fixture_runner.py`; the same preparer replaces
all its images with their reviewed digests. The harness refuses any existing kind
cluster. It creates only `pc-image-pvc-clone-disposable` with Kubernetes v1.34.0 at
the existing pinned kind-node digest and a loopback API, and verifies context,
Docker labels and exact server version. It deletes this cluster in `finally`,
checks that no matching kind node remains, and retains failure Pod/event/log data.
CNI privileges and host Docker/kubectl authority exist only in fixture machinery.
They are never mounted or granted to the application.

All application/database/transfer Pods remain non-root, use a read-only root,
drop capabilities, disable privilege escalation and ServiceAccount automount,
and mount only explicit synthetic PVCs. There are no provider credentials, real
backup inputs, runner services or application ingress Services. The namespace
uses restricted Pod Security, default-deny ingress/egress and only a same-namespace
controller-to-fixture-PostgreSQL TCP route. No DNS, public HTTPS, Kubernetes API or
node route is allowed. Before starting either application, a real old-image Node
probe must reach the database and fail to connect to public HTTPS, metadata,
node/API endpoints and an unauthorized database port. A controlled listening canary first has a narrowly allowed positive TCP path; after removing that temporary egress allow, the controller probe must fail to connect to the same canary. Packet tests are required;
policy objects alone never count as containment. Both images have heartbeat
timers, automatic migration, backups and telemetry disabled. Synthetic company
and agent rows are paused, with a manual hold and heartbeat disabled. The old
image's lack of admission control is therefore contained outside its process.

The dedicated node is capped at 3 GiB RAM/5 GiB including swap, two CPUs and 1024
PIDs for Kubernetes/CNI plus tests. The first node receives a `KubeletConfiguration` patch for `podPidsLimit: 256`; the harness requires the effective kubelet `/configz` value to be 256 before workload creation. Real controller boot Pods are capped at 1536 MiB with an explicit 768 MiB
V8 old-space limit; DB-connected migration/policy helpers remain 768 MiB and
PostgreSQL/tools 256 MiB. Applications and transfer steps run serially. No full source build/typecheck runs here. This fixture must
not overlap the other bounded kind/native suites.

The sequence is executable and fail-closed:

1. The exact old image manually migrates an empty synthetic source DB using its
   packaged DB runtime module under the shipped TSX loader, then boots to real `/api/health`. Synthetic paused
   rows and binary/session/credential marker files occupy a source PVC.
2. After stopping the old application, trusted non-root tools checkpoint a full
   custom-format PostgreSQL dump and complete source-state file archive onto a
   separate checkpoint PVC. The held policy is immutable and saved in evidence.
3. The dump and archive restore to a separate DB and separate state PVC. The new
   application must terminate with exit 1 and the exact `admission_bootstrap_schema_not_current` refusal
   before manual migration. Other errors do not satisfy this negative control.
4. The candidate's real DB module manually applies its packaged migrations and
   verifies the migration head. Its real server boots healthy with durable held
   admission, stops, then boots in a fresh Pod and new held epoch. Original
   synthetic company/agent facts remain identical.
5. The upgraded DB and a credential marker deliberately diverge. Both new-image
   Pods have stopped before the upgraded clone DB is destroyed and recreated.
   The coordinated original DB/files checkpoint is restored in full. The new
   admission table must be absent; synthetic facts and all archived files must
   match. The exact old image boots healthy on this restored clone.
6. The source database must still lack the new admission schema, source facts and
   archived source files must remain unchanged, and all four PVCs must be Bound
   to distinct PV names and exact claim UIDs. Evidence records actual PVC/PV
   objects, application Pod UIDs/image IDs, old/new images, restart epochs, logs,
   checkpoint hashes, packet targets, policy, result and cleanup.

`test_image_pvc_clone.py` contains twenty pure harness-contract tests. Their pass
checks safety/preflight/rendering contracts only. It is **not execution of this
rehearsal**, image acceptance, migration acceptance or operational acceptance.
Until the real hosted harness finishes, all actual-image/PVC results remain
pending. A harness failure is a failure; an absent candidate image, failed pull,
policy/packet failure or startup error cannot become a skipped success.

Even a successful run uses synthetic application data, provider-free markers and
kind's local-path PVC provisioner. It does not restore the live backup, prove
homelab storage/detach semantics, exercise the protected provider topology,
resolve A's holds, authenticate actual state restoration/retirement evidence,
permit paid provider calls or authorize rollout. Pod deletion here is ordinary
fixture application handoff and **not** stable provider retirement proof.
Human-reviewed integration/rollout and all broader acceptance gates remain.

Configuration audit: synthetic seed columns are present in the original schema
(`runtime_config` since migration 0001 and lifecycle columns since 0320).
Manual migration calls the image's compiled `applyPendingMigrations(url)`, whose
contract returns void, then requires `inspectMigrations(url).status` to be
`upToDate`. Mandatory production startup specifically requires external
`DATABASE_URL`, `PAPERCLIP_MIGRATION_AUTO_APPLY=false` and the protected
`PAPERCLIP_ADMISSION_POLICY_FILE`. The immutable ConfigMap key is now a single
read-only `subPath` file at `/etc/clone-policy.json`; actual image file/parent
metadata and loader acceptance must pass the preflight below. Application startup uses the shipped
`tini → docker-entrypoint.sh → node/tsx` chain as non-root, rather than replacing
the server with a synthetic health listener. PostgreSQL uses its PostgreSQL 18
data layout under `/var/lib/postgresql` on a UID/GID-999 PVC, with its writable
Unix socket in a writable `/var/run/postgresql` emptyDir; it receives no root initContainer or host mount. These are
source/configuration checks until actual hosted image startup succeeds.

The node-local kubelet patch follows the official
[kind per-node configuration contract](https://kind.sigs.k8s.io/docs/user/configuration/#kubeadm-config-patches);
checking effective `/configz` prevents a merely rendered patch from counting as
PID-limit verification.

Hosted continuation: the first real attempt (run 39334869570) passed the native,
transport, typecheck, actual-SSH, production-build and startup checks, then failed
before creating kind because the old GHCR image pull was unauthorized. That was
a registry prerequisite failure, not image/PVC acceptance. The corrected host
authentication/import path and fourteen contract tests still require a fresh real
hosted rehearsal; they are not an operational pass.

Host-disk continuation: hosted run 39339060631 passed source/build/registry checks
and initialized kind/CNI, but exhausted disk while importing the old controller.
It did not reach application/PVC acceptance. After each successful import and CRI
config-ID check, the harness now revalidates the corresponding host image's full
binding and removes only its exact source reference and fixed disposable alias
from **host** Docker. For PostgreSQL, the source `tag@digest` is canonicalized to
its exact repository digest; no floating tag is selected. Candidate source/alias
are identical and removed once. Removal uses `docker image rm --no-prune` without
force, image IDs, wildcard selection, node-image deletion or unrelated pruning.
Metadata drift, failed removal or a remaining reference fails the fixture.
`host-image-cleanup.json` records each verified import's exact removed host
references; node images remain available for subsequent Pod verification.

The workflow must export any optional exact-source compiled-image cache before
invoking this harness: host image tags deliberately disappear after import. The
harness continues to emit both `candidate-image.json` and `image-bindings.json`
before cleanup, preserving config/rootfs/registry identity after host deletion.
Seventeen pure contract cases now pass, including exact cleanup selection,
wrong-import/rebound-metadata refusal, and non-force/no-prune host-only removal.
The new disk mitigation still requires an actual hosted rehearsal; no successful
application/PVC migration/rollback is inferred from either failed attempt.

Confirmed PostgreSQL startup correction: hosted run 39344460331 reached all
image imports and host-copy cleanup, then its database exited with code 2 before
readiness. The exact official PostgreSQL 18.6 image was reproduced locally with
UID 999, read-only root, no capabilities/privilege escalation, network `none`,
tmpfs-only writable storage, 256 MiB RAM/512 MiB including swap, two CPUs and 64
PIDs. The old `unix_socket_directories=/tmp` configuration started the temporary
server there, but official `docker_process_sql` attempted the default
`/var/run/postgresql/.s.PGSQL.5432` socket and exited 2. This is observed cause,
not a conclusion drawn only from the missing readiness signal.

The fixed case keeps the default socket and adds a writable socket directory;
it completed initialization, became TCP-ready and returned `fixture|source` for
`SELECT current_user,current_database()`. The Pod now mounts a 4 MiB memory
emptyDir at `/var/run/postgresql` with existing fsGroup 999 and retains all
non-root/read-only rules. Both regression and Pod use `shared_buffers=16MB` within
the 256 MiB cap. No root initContainer, PGHOST workaround or topology change was
added. `test_postgres_socket_disposable.py --evidence NEW_DIRECTORY` executes the
negative and fixed cases serially, requires their exact outcomes and cleans only
the two uniquely named containers. It requires the exact PostgreSQL image to
already be cached; it never pulls/builds an image or mounts host paths. Local
evidence is `.handoff-state/2026-10-20/postgres-socket-reproduction/`, including
both complete logs/inspection records, result and verified cleanup.

Database readiness now checks Pod/termination state before each TCP probe, captures
its logs immediately on exit, and records the last probe/Pod on timeout. Before
kind deletion, generic exception diagnostics also collect logs for at most 16
Pods in the exact fixture namespace, capped at 100 lines/32 KiB per Pod and 12
seconds per log call. Twenty pure harness-contract cases pass, including socket
volume/security constraints and early-exit/bounded-log handling. Actual local PG
startup verification is a separate bounded pass; whole real-image/PVC acceptance
still requires the hosted fixture to complete.

## Candidate manual-policy preflight

The old-image empty synthetic source initializer and candidate manual migrator
now use distinct fixture scripts. The old published image lacks the admission
policy module; its empty source initialization remains externally contained
synthetic setup, not a guarded operational migration path. The candidate calls
its packaged `loadProductionAdmissionPolicy` with explicit database URL,
`PAPERCLIP_MIGRATION_AUTO_APPLY` and protected policy path before importing/calling
`applyPendingMigrations`. Both scripts require packaged `inspectMigrations` to
report `upToDate`; neither creates a synthetic health server.

Before candidate migration, two real candidate-image Pods must independently exit
1 with exact `admission_bootstrap_policy_required` and
`invalid_admission_bootstrap_policy` errors for missing and protected-invalid
policy. Neither policy-verified nor migration-complete marker may appear. The
clone's complete migration ledger must remain byte-identical and the admission
scheduler table absent. A different import/startup error fails the negative
control. Existing UID1000, read-only, capability-free, token-free and narrow
network/PVC restrictions remain. These actual controls await the next hosted
rehearsal; 22 pure image-harness cases pass locally (plus 11 offline legacy
cases). They do not prove an operational maintenance lock or real backup/recovery.

## Observed import timeout and retained diagnostics

Actual corrected rehearsal `39443590395` failed when the first candidate-image
`kind load docker-image` exceeded its 240-second deadline, before any application,
database or PVC acceptance. This proves an import timeout, not its cause. It
neither reproduces the PostgreSQL socket error nor establishes OOM, disk pressure
or a healthy-but-slow import.

The candidate image now has a bounded 600-second import deadline; exact old/PG
imports retain 240 seconds. Resource caps, pinned image identities and all
acceptance rules remain unchanged. Each import saves its exact source/alias,
config/rootfs binding, command/deadline, separate stdout/stderr, command duration,
result and verified CRI identity. Before node deletion, timeout/failure additionally
captures fixed read-only host disk/inode, node state/stats/cgroup memory/OOM/PID,
node disk, containerd journal and image/expected-alias inspection. Each diagnostic
command is bounded to twelve seconds. Diagnostic failure is recorded separately
and cannot make import succeed. The outer fixture cleanup remains mandatory.

A timeout always fails, even if later diagnostic inspection finds image bytes.
There is no automatic import retry or host-image removal after a timed-out import.
A successful command still requires exact bound CRI config identity before host
copy cleanup and workload use. Twenty-four pure harness cases (plus eleven
legacy-review cases) pass locally, including timeout-output retention and changed
image identity refusal. The longer deadline and diagnostic path still require
actual hosted execution; no application/PVC migration acceptance is inferred.

## Policy file mount and actual metadata preflight

Independent review of pinned Kubernetes v1.34.0 found a directory-trust mismatch:
ConfigMap setup wraps EmptyDir, whose directory setup enforces mode 0777;
fsGroup processing ORs existing permission bits, including on read-only volumes.
It does not remove existing group/other write bits. This is a source-derived
prediction, not observed metadata from the earlier image/PVC run (which failed
at import). See the exact [ConfigMap setup](https://github.com/kubernetes/kubernetes/blob/v1.34.0/pkg/volume/configmap/configmap.go#L167),
[EmptyDir permissions](https://github.com/kubernetes/kubernetes/blob/v1.34.0/pkg/volume/emptydir/empty_dir.go#L418)
and [volume ownership implementation](https://github.com/kubernetes/kubernetes/blob/v1.34.0/pkg/volume/volume_linux.go#L136).

The fixture therefore mounts only immutable `policy.json` as a read-only subPath
file at `/etc/clone-policy.json`, including the invalid-policy control. It no
longer asks the controller to trust the projected volume directory as a policy
parent. No loader check, non-root rule or file ownership requirement is weakened;
there is no root initContainer or chown step.

A dedicated real candidate-image preflight runs before candidate controller
startup or migration. Node records configured/canonical file path, actual file
UID/mode and each resolved parent UID/mode/type, and checks exact `/etc` and `/`
parents. Metadata is printed before permission rejection so failures retain the
actual observation. The existing packaged `loadProductionAdmissionPolicy` must
then accept the valid file. Candidate migration repeats metadata/loader checks;
missing and invalid policy controls retain their distinct exact errors. Evidence
is `candidate-policy-preflight.json` and each Pod's raw log. The preflight invokes
no migration API; it establishes neither maintenance exclusion nor real backup
coverage. Twenty-five pure harness cases plus eleven legacy cases pass locally
(36 total); all three inline Node scripts pass syntax checking. Actual subPath
metadata and application/image/PVC acceptance await hosted execution.

## Actual old-image migration module failure

Corrected run `39450806226` completed actual exact candidate/old/PostgreSQL image
imports (approximately 216/217/19 seconds), initialized PostgreSQL and passed the
controlled packet checks. It then failed `old-source-migrate` with the observed
`ERR_MODULE_NOT_FOUND` for `/app/packages/db/dist/client.js`. No old controller
health, candidate policy preflight/migration or PVC rollback acceptance was
reached. Saved old-Pod logs establish this specific error; import timeout and the
previous socket error are not the cause of this failure.

The pinned production recipe builds the server and copies its whole source tree;
the DB package's runtime exports point to `src/*.ts`, loaded by the image's
shipped TSX loader. The harness now imports `/app/packages/db/src/client.ts`
explicitly in both old and candidate migration scripts, verifies the actual
`applyPendingMigrations`/`inspectMigrations` function exports and emits a bound
module marker before calling them. There is no alternate-module, synthetic SQL
or schema fallback. Candidate policy validation still precedes dynamic migration
API import/calls; old initialization remains contained empty synthetic setup.
Both paths still require exact packaged migration-head inspection and completion
marker. Next hosted execution must verify the corrected module in the actual
images; source-supported path correction alone is not a migration pass.
Twenty-six image-harness plus eleven legacy contracts pass locally (37 total).

## Large-controller import deadline follow-up

Run `39458972126` passed exact compiled-image cache restoration, startup/CLI
checks and the new actual-image packaged-module preflight. Its candidate import
completed in 331.413 seconds; the old controller import hit its remaining
240-second deadline. No application/database/PVC migration phase was reached.
The prior run imported that old image in approximately 217 seconds; this does
not establish a fixed duration or the cause of the slower attempt.

Retained timeout diagnostics show the kind node running, cgroup peak
3,221,233,664 bytes, 6,200 memory-max events and zero OOM/oom-kill events;
about 14–15 GiB disk space remained. Exact old-alias inspection returned nonzero,
and cleanup verified no remaining node. These observations show memory pressure
and an incomplete image registration at inspection time; they do not prove that
pressure alone caused the deadline or that another failure was impossible.

Both exact controller-image imports now receive bounded 600-second deadlines;
PostgreSQL retains 240 seconds. All identity checks, non-root/resource caps,
no-retry/no-timeout-success behavior and diagnostics remain unchanged. The same
26 harness cases now check old/candidate 600 and PostgreSQL 240 seconds; eleven
legacy cases also pass (37 total). The next hosted run must complete actual
imports and all migration/restart/rollback assertions before this rehearsal can
be accepted. No result is inferred from the deadline change.

## Observed controller V8 heap failure and sequential hosted budget

Run `39462308092` completed both controller imports (about 244/228 seconds),
PostgreSQL initialization, controlled packet checks and actual old-source manual
migration. Old-controller startup then exited 134 with Pod reason `Error` and
V8's explicit JavaScript heap exhaustion near 380 MiB. This is the observed
failure, rather than a successful controller startup or an inferred cgroup
OOMKilled event. Candidate migration/restart/rollback acceptance was not reached.

Only manifests using the exact application `APP_COMMAND` now use a 1536 MiB Pod
limit and `NODE_OPTIONS=--max-old-space-size=768`. This includes old/new controller
boots and the exact stale-schema controller negative. Existing migration/policy
helpers remain 768 MiB, PostgreSQL/tools 256 MiB, and kind remains hard-capped at
3 GiB RAM/5 GiB including swap/two CPUs/1024 PIDs. No local test allowance or
live workload is enlarged; the saved deployment's 2 GiB controller limit is
context, not changed by this fixture correction.

At most one application (1536 MiB) and PostgreSQL (256 MiB) coexist in the fixture
namespace, leaving 1280 MiB within the node cap for control plane/CNI/cache. The
768 MiB V8 old-space limit is inside the application limit; the remaining 768 MiB
covers young/native/code/threads and its bounded tmpfs, rather than another
allocation outside the Pod. This arithmetic is an accounted ceiling, not measured
startup headroom. The unchanged kind cap remains authoritative; failure or
pressure still fails the fixture and supplies no production capacity conclusion.

Before a controller boot, all predecessor/controller/tool Pods must be removed,
leaving only the database. Before any one-shot migration/transfer/policy tool,
no application Pod may remain, including terminal predecessors. Runtime helpers
execute inside the same application Pod, adding no concurrent tool Pod. A plain
Node helper records assigned Pod limits, effective NODE_OPTIONS and actual V8
heap-size limit before health polling, without importing or calling application
or migration APIs. Its record is `<controller>-runtime-budget.json`; it describes
configuration, not the parent server's measured RSS. Boot failures retain actual
Pod logs plus fixed read-only node/cgroup/stats/disk diagnostics before cleanup.
Twenty-eight harness and eleven legacy contracts pass locally (39 total), plus
Python compilation and four inline-JavaScript syntax checks. Actual startup and
complete image/PVC migration/restart/rollback still require the next hosted run.

## Final actual-image/PVC result — 2026-10-20

[Run 39466029222](https://github.com/adhn/homelab/actions/runs/39466029222) PASS on
3dcaad6: 28 harness cases and the complete actual old/new controller-image/PVC
rehearsal. Old and candidate manual migrations, protected policy/stale-schema
controls, healthy candidate restart with distinct Pod UIDs/held epochs, coordinated
original DB/file restoration before old-image rollback, unchanged source and four
distinct PVC/PVs pass. Cleanup confirms no fixture nodes remain. All four real
application boots use the explicit bounded 1536 MiB / old-space 768 MiB configuration;
node and other Pod caps remain unchanged. This verifies that synthetic fixture,
not measured production headroom, real account restoration, backup service or the
homelab's recovery target. ProductionAcceptance remains false; all holds remain.
See ../docs/integrated-review/HOSTED-VERIFICATION.md for failures and exact scope.
