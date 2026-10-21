# Durable operation and command lifetime candidate — 2026-10-19

Draft PR #5 remains inactive. Production preparation, workload/image pins and
live capacity are unchanged. No live migration, provider dispatch, deployment,
Gemini authentication or historical-agent reconciliation is part of this work.

The native candidate adds auxiliary probe, saved-adapter-test and lifecycle
reservations without heartbeat authority. Lifecycle results are saved before
finalization and returned only after verified settlement, so retrying failed
finalization need not repeat a successful verification. The lifecycle version
and operation identity fence executable commands and result persistence.

Every SSH executable path uses a separate durable child binding: setup, profiles,
provider commands, Git bundle streams and tar streams in both directions. Epoch
changes and descendant stops use a private fixed protocol. Local clients are
settled before transport finalization; output overflow cannot report success or
return before child close. Optional transfer size diagnostics cannot compete with
an admitted stream. A missing exact stop receipt retains the reservation.

The admission lifetime owns an early exact SSH lease through restoration. State
obligations precede mutation; inline workspace baselines and recovery recipes are
saved durably. Copy-back fsyncs files/directories and retains failed staging.
Effective executable session/credential roots are recorded separately from the
configured roots. Failed or swallowed restoration errors retain capacity.
Codex credential recovery uses its existing identity/freshness merge and atomic
copy-back. Unsupported/corrupt recipes and changed targets remain held.

Host-only reconciliation fences ordinary execution, stops retained child
identities, and retries restoration without replaying provider work. Epoch
adoption requires runner acknowledgement, rotates ownership and preserves old
command bindings. Same-host operation retries can reconcile stopped finalization;
active finalizers are not replayed. The active-lifetime guard covers the entire
reconciliation, including its first stop lookup, so a concurrent sweep cannot
stop newly launched restoration children. Runner loss without a receipt is deliberately
unresolved; restart or process absence does not manufacture a historical receipt.

Same-controller stopping reservations receive at most three automatic cleanup
attempts, with 1s/5s backoff. Reentrant sweeps and active lifetimes are skipped;
uncertain and old-epoch reservations require explicit acknowledged adoption.
Exhaustion leaves the durable hold in place. Earlier wake deadlines replace later
pending wakeups. These retries never execute the original provider body.

Capacity-installed model routes serve only declared static adapter metadata;
executable detection returns null. Refresh, pool, provider and environment query
parameters cannot trigger unreserved discovery. Company/adapter checks remain in
place, and capacity-absent behavior retains dynamic discovery.

Global native preflight clears ineligible candidates before fair selection,
including retained external ineligibility. Retrying auxiliary callers have bounded
readiness; absent callers cannot indefinitely strand native work. Release nudges
the native queue; readiness expiry has a bounded wake and ordinary recovery sweeps
continue to own persistent queue progress. No expiry releases occupied capacity.

Final frozen functional source: `f660618f6f7189edc2c58107b70dff0c2fab2eed`.
All current local checks PASS:

| Check | Evidence |
| --- | --- |
| Native/database/scheduler/lifecycle/route/retry suite | 372 cases across 18 files; migration numbering/safety, DB and focused service typechecks |
| Transport/bridge/workspace/auth suite | 329 cases across 10 files; adapter-utils typecheck |
| Original isolated contracts | 18 PostgreSQL cases and 24 subprocess cases |
| Actual restricted SSH | Complete capacity-lifetime failure acceptance plus both existing admission/cancellation fixtures |
| Reconstruction/static checks | All 44 native source hashes; exact native + SSH overlays; both reapplication refusals; unchanged production inputs/pins and valid workflow YAML |

The final disposable source image is
`sha256:b88ea45b82df4212cb3e6fdc0a1a694f5d513561a47306cc6f4f684b2206005a`.
Local tests remained serial within the existing 3 GiB/2 CPU test budget. The full
server graph was reserved for hosted CI.

Failure acceptance verifies authenticated native callbacks, exact detached
provider/setup-descendant stop, automatic finalization recovery with one body
execution, tar/Git copy-back, held partial credential/workspace obligations,
built-in Codex auth recovery and host mode 0600, actual upload/download client
loss with preserved local data/staging, epoch acknowledgement/adoption with
original child binding and replay denial, and abrupt runner loss retaining a
missing-receipt hold that blocks a successor. Earlier fault-observation races
were repaired by keeping the required credential asset/download source unavailable
until held-state and preserved-data assertions finish; only then is recovery
enabled. The final complete fixture passes on the frozen source.

## Result and repair

Original run [39281873119](https://github.com/adhn/homelab/actions/runs/39281873119)
on functional source `f660618f6f7189edc2c58107b70dff0c2fab2eed` failed during the
full server typecheck with exit 137 and no TypeScript diagnostic. Later native/SSH
checks and production build were skipped. Resource pressure was suspected; that
original log alone does not prove an OOM kill.

CI-only commit `6b46ce445623b3dcc4c200e1c13bd013b063e50a` lowered the native Go
soft heap target from 4 GiB to 2 GiB, changed GOGC from 50 to 25, and added cgroup
memory diagnostics after the full check. The disposable production build uses the
same compiler settings. Functional source, all 44 native overlay hashes, SSH
overlay, production preparation, inputs and workload pins remain unchanged.

[Final run 39286547773](https://github.com/adhn/homelab/actions/runs/39286547773)
on `6b46ce4` **PASS**: fixture job `118174512583` and production job `118183471026`
both succeeded. Fixture logs finish at 16:49 UTC; complete image/guards at 17:11 UTC.
Earlier queued status was delayed: final logs show the fixture runner started at
16:34 UTC. The GitHub incident is historical context, not a remaining verification
blocker or proof of a run-specific cause.

| Hosted check | Final evidence |
| --- | --- |
| Full server, adapter-utils, DB and focused service typechecks | PASS |
| Native/database/scheduler/lifecycle/route/recovery regressions | 372 cases, 18 files PASS |
| Transport/bridge/workspace/auth regressions | 329 cases, 10 files PASS |
| Original contracts | 18 PostgreSQL and 24 subprocess cases PASS |
| Restricted actual SSH | All three fixtures PASS: fencing, sibling/descendant cancellation, complete durable-lifetime/failure acceptance |
| Source/migration | Baseline attestation, exact overlays and migration numbering/safety PASS |
| Complete production target | PASS, including server/UI/Rust build; no publication |
| Controller-local CLI guards | Codex, Claude and Gemini each return 126 under non-root/read-only/restricted execution |

Built Docker image ID (not a published registry manifest digest):
`sha256:439d9158bfc5ac142e6bf17954340ed6ed49fb66aa78e9e6ec1f809879c7f900`.
The build log's optional ssh2 crypto addon reports missing make and explicitly
continues successfully; no change to that optional dependency behavior was made.
Actual SSH fixtures independently pass. Complete-image operational SSH/provider
acceptance remains a later rollout gate.

The full typecheck reached the 6 GiB container memory limit (memory.peak
6,442,455,040 bytes; max events 2,929), with zero OOM events/kills. This is a passing
hosted check with memory pressure, not comfortable headroom or permission to repeat
the full graph under the laptop's 3 GiB budget.

Next: [trusted attestation and bounded capacity plan](attestation-capacity-plan-2026-10-19.md).
Source verification passes; rollout, provider-capacity and everyday-use gates stay open.

Operational attestation of physical/account/state mappings, full provider refresh
and session behavior, capacity measurements, rollout bootstrap and the broader
failure/containment/Git/backup gates remain separate holds. Keep the PR draft,
human-reviewed merges, paused B, historical A holds, deferred Gemini authentication,
live timers off, and concurrency/everyday-use/recovery unaccepted.
