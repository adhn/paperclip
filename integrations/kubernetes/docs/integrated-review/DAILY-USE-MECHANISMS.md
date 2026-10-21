# Daily-use mechanism disposition — 2026-10-20

Functional source `1695530` follows recorded draft head `d72b6ef`. Root verified
remote branch and draft PR, exact native64 hashes, deliberate dirty status and six
production inputs before edits. Native remains `d489129`. No overlay reset/reapply.

## Concrete change and verification scope

The [custody proposal](CUSTODY-NATIVE-PROPOSAL.md) accompanies a real verify-only
Ed25519 primitive. Public fingerprint handles, fixed protected bundle, strict
Base64/domain/size bounds and per-call installed-key retirement are implemented.
Eleven new disposable cases PASS locally in 0.048s, including actual signature
verification through CurrentHistoryVerifier and correctly signed retained revoke
rejection. Bundle reads are mocked; disposable signing keys do not establish
protected installation, real issuer facts or operational custody. No signer exists.

Execution was serialized: pinned Python image, non-root/read-only/network-none,
256MiB RAM/512MiB including swap/one CPU/64PIDs,64MiB tmpfs. Hashed test-only
cryptography46.0.5/cffi2.0.0/pycparser3.0 wheels are installed into disposable tmpfs.
Initial noexec tmpfs import failed; preserved log records that failure. Explicit
exec tmpfs permits loading the compiled crypto extension; corrected run passes.
No production dependency/image input changed. New bounded crypto workflow avoids
rerunning unchanged native/image/component suites. Existing hosted39496569852
164 cases/seven guards and native39482618313/image39482618289 remain successful
and are reused only within unchanged scopes. [Hosted39502630633](https://github.com/adhn/homelab/actions/runs/39502630633) PASS on1695530:11 cryptographic cases in0.014s. No other workflow ran for this increment.

All three development agents had explicit disjoint files/no children. Root owns
interfaces/integration/Git/index/handoffs. Finished agents independently reviewed;
one review found an unresolved common deny linearization ambiguity, now explicit
in [atomic backend proposal](ATOMIC-BACKEND-PROPOSAL.md). It is a protocol blocker,
not a completed distributed transaction. No synthetic runtime/storage replacement
or passing test was added to stand in for a missing physical mechanism.

## Daily-use gates and exact dependencies

| Gate | Implemented / verified source | Status and exact next dependency |
| --- | --- | --- |
| Mandatory runtime start/effect/recovery and stable retirement | Prior owned worker/recovery gate and protocol models verified; no actual runtime backend | **BLOCKED:** [exact-build proposal](RUNTIME-ENFORCEMENT-PROPOSAL.md); obtain snap8702 runtime/shim provenance, compatible hooks covering alternate handlers/second daemon/recovery, mandatory history before exposure. No installation authorized. |
| All-command transport and route closure | Optional protected transport/stdin control verified previously | **OPEN:** mandatory native installer and fallback refusal before setup, every transfer/probe/service/epoch/stop/recovery route, actual stdout/stderr/exit/signal framing and runtime queue. Current exact source call sites are in runtime/storage proposals. |
| Atomic bytes/cancel/revoke | Prior owned exact-write helper/local replay defense verified | **BLOCKED:** one actual common irreversible acceptance/deny linearization and failure-state protocol across native/runtime/storage/decision. Prospective history T alone cannot exclude intervening bytes; queued/accepted uncertainty stays occupied. |
| Physical stale-writer exclusion | No actual storage backend | **BLOCKED:** review sole protected canonical owner/detached-copy topology and prove old-descriptor/mount/external credential-writer exclusion, or identify a supported backend physical fence. Longhorn API/labels/locks are not that proof. |
| Whole-root CAS and independent high water | Prior protocol/local intent store verified | **BLOCKED:** complete protected alias registry, immutable full-group/head CAS, sole canonical writer, independently administered current generation/restore domain; crash and stale-history proof in atomic proposal. |
| Public-key verification | Actual Ed25519 primitive and11 disposable cryptographic cases | **IMPLEMENTED / VERIFIED source only:** dependency/bundle/native loading uninstalled; no installed authority or operational acceptance. |
| Fact/consent issuer, signer and protected custody | No real issuer/signer; existing HMAC bridge unchanged | **BLOCKED:** exact separate operator/issuer/installer identities, real complete inventory/domain evidence, separate exact human consent, non-exported signer and monotone trust distribution. |
| Independent accepted/revoked history | Local SQLite prospective persistence verified previously | **BLOCKED:** independent PostgreSQL administrative/restore placement and monotone service generations; two matching restored snapshots cannot supply this. Coordinate backup ownership with Claude. |
| Native admission/lifecycle effect/revocation | Existing local predicates unchanged | **BLOCKED:** sole typed native writer role/all callers, commit-time cross-domain generation fencing, native intent journal atomic with effect and exact uncertain outcome inspection. Observation/completion never permits later effects. |
| Historical A/shared-family reconciliation | Supported source review only; no new real facts | **BLOCKED:** all original shared holds/complete supported and unsupported source inventory, real retirement/storage/session/credential evidence and exact consent through authority-owned native transaction. No B exemption. |
| Integrated activation/manual migration | Existing source/image/disposable rehearsal passes reused | **BLOCKED:** completed mechanisms above, separately reviewed immutable image/policy/RBAC/network/workload/manual-migration diff and authorized publication/rollout. Fixture brokers/observers/CNI installers excluded. |
| Serial provider daily coding/session/refresh/Git delivery | Saved prior B lifecycle/simple copy-back passes only | **OPEN / HELD:** reviewed rollout/full shared-hold resolution, then ten bounded serial Codex B tasks, then Claude lifecycle/session/refresh; complete workspace/Git delivery and recovery acceptance still required. No provider dispatch here. |
| Containment/failure recovery/capacity/overlap | Prior disposable source evidence only; no measured operational headroom | **OPEN / HELD:** installed final enforcement, actual outage/restart/containment and provider refresh/budget proof; no expansion authorized. |
| Backup/restore, Telegram, external heartbeat and freshness admission | Existing spec only; no new operational acceptance | **OPEN, reserved to Claude:** exact file agreement pending in local CLAUDE-BACKUP-COORDINATION.md; independent keys/destinations, usable DB/files checkpoint, isolated restore, alerts and measured <=1h RPO/<=4h RTO. Codex edited no backup/recovery preparation files. |
| Gemini and timers | Deferred/off | **HELD:** preserve explicit Gemini deferral and disabled timers. No automatic enablement follows any test. |

The proposal files specify feasible candidates and rejection conditions; they do
not resolve topology selection. Current authorization permits this source work,
not host/topology installation, live verification/mutation, provider dispatch,
image publication, live migration, capacity increase or merge. Both original A
holds/shared Codex families remain, B paused per saved evidence, PR5 draft and
human-reviewed merges. Everyday use remains unaccepted.
