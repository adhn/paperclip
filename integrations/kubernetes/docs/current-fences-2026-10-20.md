# Current launch and retirement gates — 2026-10-20

This continues draft homelab PR #5 from `9b5a396`. Three explicitly authorized
agents owned launch/Kubernetes, transport/state, and legacy/clone work separately;
the primary agent implemented the native consume transaction/endpoint and integration.
All infrastructure is disposable. The full six-step request remains incomplete.

## Source changes

- Native `consumePodCreate` locks the current scheduler and original reservation,
  command, scopes and lease; rechecks epoch/generation, run cancellation, original
  immutable journal/grant expiry, current target, all shared legacy holds and a
  mandatory host current-storage attestor. One permanent command-derived nonce
  in the existing immutable request table consumes the permit. Exact duplicate
  reviews, new Pod/review UIDs, lost responses, failed CREATE and object loss cannot
  unconsume it. No migration is added. Native database restore is a separate held
  recovery boundary; this history must survive supervisor/runtime rollback.
- A host-only native HTTPS endpoint factory enforces client CA plus exact DER
  fingerprint, bounded POST bodies, fixed path and no-store replies. It does not
  listen or install itself. The Python mutual-TLS client has no proxy discovery,
  redirects, cached allows or retries. Webhook startup requires pinned API-server
  mutual TLS and a current consumer; static signed-grant-only helpers cannot start
  the executable service.
- Sequential commands retain the same exact original owner/storage and require
  independent stable retirement for every previous command. Missing authority,
  weaker original-sandbox stop and uncertainty hold progress. Exhaustive immutable
  same-epoch command manifests recover recorded state only: no launch or epoch adoption.
  Native protected transport requires a separate host verifier before recording stop;
  that verifier must durably verify/pin retirement history/CAS, not return a claimed ID.
- A separately protected FULL-sync SQLite storage authority retains canonical
  high-water and exact owner/storage/phase proof bindings. Canonical rollback is
  refused while this independent current history survives. Physical detach,
  storage exclusion, refresh facts and native release are never manufactured by it.
- An offline seven-root legacy reviewer checks signatures, freshness, original
  hold/lease/full scopes, operator approval of the complete evidence bundle and
  coverage of every supplied authoritative hold. It cannot sign decisions or
  mutate lifecycle. It is not installed in an operational signer; the caller must
  obtain a complete authoritative hold inventory. No real A evidence/decision was made.
- The full-schema synthetic PostgreSQL source clone rehearsal now checkpoints its
  restored pre-upgrade DB/files, migrates/restarts, appends a synthetic decision,
  destroys the upgraded clone, restores the checkpoint and verifies held restart,
  a new epoch, removal of the later decision and unchanged original historical facts.

## Verification

Final affected native run: **77 PASS** across all three files in one fresh run
(39 journal/endpoint/consumption, 20 transport, 18 legacy/clone), plus focused
journal/transport typecheck PASS. Container limits: 3 GiB RAM, 5 GiB including
swap, two CPUs, 256 PIDs, networking disabled. Logs:
`.handoff-state/2026-10-19/protected-current-fences/native-final*.log`.
The actual pinned-mTLS native endpoint is exercised against disposable PostgreSQL;
unauthenticated TLS cannot consume and duplicate authenticated POST is denied.
The earlier 36-case snapshot and setup-corrected agent runs are superseded by this
fresh affected-suite result. Full server/production graph remains hosted only.

Current native source is `afbefed`. Exact final 59-file source reconstruction,
atomic reapply refusal and matching individually mirrored files in the deliberately
dirty source tree PASS. All six production preparation/input/workload hashes are
unchanged. Frozen Python: 126 PASS; renderer: seven PASS.

Actual kind v1.34.0 tests PASS: API-server-generated PodUID replaces an attempted
caller UID; admission UID matches the persisted object; new CREATEs receive new
review/Pod UIDs. Captured grants are denied after object removal and independent
authority restart. Additional exact-version experiments PASS: later-validator
rejection leaves the launch consumed with no Pod; closing the connection after
consumption but before the allow response leaves the launch consumed and retry
denied. This experiment observed zero automatic internal webhook retransmissions;
it does not establish a universal retry rule. These Kubernetes tests use an
independent fixture SQLite consumer; native PostgreSQL consumption and mutual TLS
are separately tested. Assembling the native endpoint into the Kubernetes fixture
remains required. Evidence: `protected-launch-kind/acceptance-fixed.json` and
`protected-launch-failure-kind/{later-validator-final,dropped-response}.json`.

Hosted protected run **39333417595 PASS** on `1cb575b`: bounded Python/non-root
containers, renderer, actual Kubernetes CREATE and failure injection, original
sandbox stop and enforcing-CNI packet checks. Full server typecheck on the same
candidate passes using TypeScript 7's supported `--singleThreaded` flag within
hosted limits. Two earlier full checks reached the 6 GiB cgroup cap and failed
with OOM137; reducing Go scheduling/heap targets alone was insufficient.
Candidate `071e59a` passed 477 native and 329 transport cases, original contracts,
all typechecks/actual SSH fixtures, the complete production image build and all
startup/CLI guards in run `39334869570`. The overall run FAILED at image/PVC
setup: anonymous pull of the exact old GHCR digest was unauthorized, before
creating any kind node or PVC. This is not clone acceptance. A read-only host
registry-pull repair and credential-free kind image import are being prepared. Protected run **39334869794 PASS** on the same candidate.
The measured earlier same-source single-thread check peaked at 5,128,183,808 bytes
with zero OOM kills; keep the full graph hosted.

Candidate `071e59a` adds a hosted-only exact old/new image and real PVC rehearsal.
Fourteen final pure harness tests pass. The first actual attempt failed registry
setup before creating infrastructure; no migration/restart/rollback acceptance
is claimed. Corrected candidate `5cf30b6` uses a read-only authenticated host
pull before building, immediate logout, fixed fixture-only aliases and complete
registry/config/rootfs-to-running-CRI identity checks, with no registry credential
inside kind or Pods. The ephemeral server build uses the same supported
`--singleThreaded` mode as the successful full check; all 59 native overlay hashes
are unchanged. Hosted run `39339060631` is pending verification. The harness uses
synthetic paused facts, explicit disposable loopback kubeconfig, pinned v1.34.0
and CNI, real packet checks, non-root workloads, mandatory held policy/manual
migrations, and coordinated database/files checkpoint rollback. It cannot prove
provider stable retirement or real backup recoverability.

Initial hosted protected run `39331050497` passed bounded Python, renderer and
actual separate non-root container fixtures, then failed mutual-TLS Kubernetes
setup. The kubeadm v1beta4 patch was silently ignored by kind's v1beta3 config:
the API server had no client certificate, and the guard correctly denied it.
The repaired runner uses the exact supported patch format and asserts the actual
API-server manifest flag/mount. No weakening of mutual TLS was used.

## Remaining gates, by requested step

| Step | Current limit |
| --- | --- |
| 1 | Current native consume and authenticated endpoint/client exist in source. Actual Kubernetes fixture uses an independent **fixture SQLite authority**, not the native PostgreSQL transaction. Production installer, storage attestor and assembled Kubernetes→native acceptance remain absent. Actual lost-response and later-validator failure injection pass. No internal retransmission was observed in that exact experiment. Storage-backend failure and assembled Kubernetes-to-native operation still require acceptance. |
| 2 | **Not implemented:** no approved independent runtime-start/retirement boundary exists on every stale-kubelet/same-UID sandbox path. Original-sandbox verification returns `stableRetirement: false`; Kubernetes `verify_retired` always refuses. Admission does not intercept cached CRI starts. No privileged proxy, raw runtime socket or host topology workaround was added. |
| 3 | Source contracts advance multi-command ownership and same-epoch recorded recovery. Occupied-epoch adoption, production gateway/attach/stdin ownership, complete assembled callbacks/transfers/restart, physical canonical PVC ownership/detach/alias activation and current external storage/release history remain open. |
| 4 | Native append-only decisions/lifecycle reevaluation remain available, but complete independently issued real A route/retirement/stop/state artifacts, operational reviewer/signer integration and human review are absent. Every shared hold stays charged; B is not exempt. |
| 5 | Source-level actual DB/files rollback passes. Exact old/new controller-image and real Kubernetes PVC migration/restart/rollback is **not** rehearsed. Prior/final hosted controller images are unpublished and do not assemble the protected topology. |
| 6 | There is no honest complete executable activation diff until the runtime authority and remaining backends are implemented/reviewed. The held renderer remains an inactive boundary inventory, with zero guard replicas and default-deny networking; it is not the integrated supervisor/provider/transfer/policy/storage/manual-migration package. |

The old Docker adapter attack characterization intentionally still demonstrates
unsafe replay when its own history/runtime are both lost. New CREATE fencing must
not be generalized to that fixture or same-UID runtime recreation. Test passes
are source verification, not operational, provider, capacity or recovery acceptance.

No live verification/mutation, provider call, live migration, image publication,
workload pin, capacity increase or merge. Keep PR #5 draft, both historical A holds
and original shared Codex families, B paused per saved evidence, Gemini deferred,
timers off and human-reviewed merges. No source overlay was reset/reapplied in
`.work/paperclip-admission`; only individually reviewed owned files were mirrored.
Docker broker, kind observer and CNI installer must never be deployed. After
reviewed rollout and full shared-hold resolution, ten bounded serial Codex tasks
on B precede Claude lifecycle/session/refresh; overlap follows later.
