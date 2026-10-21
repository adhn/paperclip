# Trusted capacity identity and guard candidate — 2026-10-19

Intermediate implementation in draft [homelab PR #5](https://github.com/adhn/homelab/pull/5),
source `5aba882` (earlier increments `061bd3e` and `1fc728b`). This is **not complete step-2 acceptance or deployable admission
control**. Production preparation and workload/image pins remain unchanged.
No live migration, cluster/provider mutation, dispatch or runtime verification
was performed.

## Implemented

The test-only native overlay now accepts an immutable host-owned registry of
instance, physical runner, provider account and workspace/session/credential
store identities. It checks company/agent membership, saved SSH environment and
agent contract fingerprints and the approved effective source-workspace
configurations, including project/routine environment bindings. Only the three
explicit CLI engines are accepted. Managed account routing is held before its
usage probes, and effective provider auth/endpoint overrides are rejected before
execution preparation. Caller scope sets are rejected when this policy is installed.
The host registry must use the same identity for aliases of a shared physical
resource or subscription, across companies too. Establishing those physical and
account facts remains a rollout input; the candidate does not infer ownership
from a path, SSH name or copied token.

Native queue registration automatically derives and registers seven scopes:
instance, runner, account, workspace, session, credential and immutable contract.
The three mutable state scopes stay exclusive. Registration preserves existing
scope drain/cooldown/revision and refuses capacity conflicts. Claim and launch
journaling recheck policy. Waiting capacity reasons are projected into native
queued-run metadata and cleared atomically with a grant.

A policy-backed service installs its execution guard for the database handle.
Heartbeat checks reservation and native run ownership before preparation.
Workspace preparation checks actual agent/environment snapshots, selected target
and approved source configuration before executable setup; environment lease
acquisition also checks the host-selected environment snapshot. This prevents
a saved ID from authorizing a substituted target or task credential-home override.

Environment probes, adapter-test target setup, managed adapter tests and lifecycle
verification now encounter guards before executable work. **Non-run operations
are held rather than admitted yet:** probes return a capacity conflict; lifecycle
verification remains pending. No fake heartbeat rows or lifecycle-state edits
are used. A durable auxiliary-operation reservation and a journal for every setup,
probe and provider invocation must be connected before those paths may execute.
Raw-scope injection remains solely a fixture/characterization seam; there is no
production bootstrap caller or API/environment activation switch.

## Validation

Local PASS: 231 cases in the broader ten-suite group, 64 composed-contract/native
claim/assembled cases, and the final 30 policy cases plus focused service
typecheck. These runs overlap; they are not additive totals. Coverage includes
cross-company shared account/state capacity, actual probe/lifecycle entry holds,
target substitution, composed project/routine environment changes, unsupported
managed routing and an assembled trusted-policy zero-capacity queue. The final
CI [39255963255](https://github.com/adhn/homelab/actions/runs/39255963255)
**PASS** on `5aba882`: all **234 server cases**, **154 transport cases**, original
18 PostgreSQL/24 subprocess contracts, source attestation/reconstruction, migration/
DB/focused checks, full server/adapter-utils typechecks and both actual-SSH fixtures.
The separate complete evaluation production image build also **PASS**: Rust
runner, UI, SDK/server output, image export and all three controller-local CLI
guards. No image was published. Saved `ci-result.json`, `ci.log`,
`ci-fixtures.log` and `ci-production.log` are in the evidence directory.

Initial checks corrected an inconsistent synchronous registration error return
(the API now consistently rejects asynchronously), a test query using a JavaScript
array with SQL ANY rather than Drizzle inArray, and cold assembled imports
exceeding a behavior-test deadline. Imports now run in bounded
fixture setup; the guard behavior deadline remains unchanged. None
involved a live database or provider. Saved initial query failure, bounded test
scripts/logs and exact-baseline reproduction are in
`.handoff-state/2026-10-19/admission-guards/`.

Manifest/source hashes reproduce from their exact baselines; repeat application
is refused. The changed environment-runtime baseline remains attested PR #4
source. Static restricted-configuration validation, workflow YAML and diff checks
pass. The workflow builds the complete evaluation production image and checks
controller-local CLI guards after the foundation job, without publishing or
changing any workload pin. Build-stage Go GC controls bound the TypeScript 7
compiler; production runtime configuration is unchanged. The existing publishing
workflow excludes the admission branch, and this workflow has read-only repository
permissions. A source build alone cannot establish functional
admission/recovery acceptance.

## Remaining authorized work

1. Give probes and lifecycle verification durable operation ownership without
   manufacturing heartbeat runs. Guard the entire operation, including setup,
   auth staging and finalization, rather than only target acquisition.
2. Journal every executable SSH command before launch, not only the final
   provider invocation. The existing single final-invocation journal cannot be
   reused for several setup/probe commands: the supervisor consumes an attempt
   once. Preserve exact command/lease ownership and single-use remote starts.
3. Connect trusted runner roots and remote epoch acknowledgements to the durable
   host journal. Reconcile uncertain starts without replay after controller or
   SSH failure; never reinterpret an admitted run under new configuration.
4. Finish native eligibility, fair wake/sweep progress and constrained-runner
   scheduling. Earlier candidates failing external preflight can still obstruct
   later work; queued metadata alone does not fix scheduling.
5. Release capacity only after exact verified descendant stop **and** independently
   recorded workspace/session/credential restoration/cleanup. Native terminal
   state or a finally block is insufficient. Add assembled cancellation, restart,
   lost-response and partial-restoration failure coverage before acceptance.

Keep PR #5 draft, live concurrency unchanged, human-reviewed merges, Gemini
authentication deferred, timers disabled, both historical A holds untouched and B
paused. Everyday-use and recovery acceptance remain open. Saved live state was
not reverified today.

## Command and settlement inventory for the next increment

The current `ssh.ts` candidate has separate executable transports. A hook added
only to `runSshCommand` or the final provider spawn would miss the streaming
paths below. These are source findings, not implemented admission coverage.

| Path | Current transport | Required durable evidence |
| --- | --- | --- |
| Readiness, command resolution and command-managed setup | `runSshCommand`, including `ensureSshWorkspaceReady` and `createSshCommandManagedRuntimeRunner` | Each command's pre-launch binding and verified descendant stop |
| Git bundle upload/download | Private `streamLocalFileToSsh` and `streamSshToLocalFile` directly spawn SSH | Exact streaming invocation ownership, transfer completion and stop; preserve partial local files for recovery |
| Directory upload | `syncDirectoryToSsh` directly spawns local tar and SSH/remote tar | Both local and remote process settlement, plus successful staging |
| Directory restore | `syncDirectoryFromSsh` directly spawns SSH and local tar into staging | Process stop and successful manifest/merge/application; process exit alone cannot certify restoration |
| Provider turn | `buildSshSpawnTarget` supports the candidate single-use supervisor binding | Exact pre-journalled launch, final receipt and no replay after lost response |
| Credential/session finalization | Managed runtime cleanup and refresh/copy-back | Independent successful mutable-state restoration, held separately from provider stop |

The remote supervisor consumes one attempt once. Several setup/probe/provider
commands therefore cannot reuse one parent attempt binding. Each launch needs
its own durable child identity linked to the occupied reservation and exact
host-owned lease. Reconciliation must account for every child before releasing
the parent; a final provider receipt must not erase an uncertain earlier helper.
Nested setup/probes must borrow only their exact trusted parent ownership rather
than trying to acquire the same exclusive state scopes again.

Failure acceptance must cut across these boundaries: cancellation before launch,
lost launch response, disconnect during each transfer direction, controller loss
after provider completion but before restore/refresh commit, runner epoch change,
and sibling progress while one child remains uncertain. A native terminal row,
SSH client exit, lease expiry, or successful outer finally is not sufficient.
This inventory does not authorize a topology change or historical receipt backfill.
