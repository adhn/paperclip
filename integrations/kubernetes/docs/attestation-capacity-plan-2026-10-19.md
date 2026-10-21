# Trusted attestation and bounded provider-capacity plan

Status: planning only. No live inspection, policy bootstrap, migration, dispatch or
capacity change is authorized by this document. PR #5 stays draft. This follows
the inactive step-2 candidate and supplements concurrency-admission-design.md.
Hosted source verification is a prerequisite, not operational acceptance.

## 1. Produce a trusted binding inventory

Use an operator-owned, dated evidence manifest tied to controller/runner image
digests, source overlay hashes, CLI versions and policy revision. Reverify saved
runtime state first: timers off, B paused, both A holds intact, no active runs or
remote descendants. Do not rerun dispatch helpers during inventory. Read only
sanitized metadata; keep credentials and decrypted environment values out of logs.

| Binding | Required evidence | Failure behavior |
| --- | --- | --- |
| Instance | Controller UID/digest, PostgreSQL database identity and single-controller ownership epoch | Unknown or competing owner blocks bootstrap |
| Runner | Environment aliases -> Service endpoints -> pod UID/runner incarnation; pinned SSH host-key fingerprint, effective UID, mounts/PVC UIDs and supervisor fence root | Aliases of the same physical resource share one runner key; changed incarnation requires reconciliation |
| Account | Provider, opaque operator-owned account reference, supported subscription/login mode and credential owner; confirm through supported account metadata without recording tokens | Unknown identity or billing mode blocks admission; no API fallback |
| Workspace | Authoritative controller and remote paths, realpath/symlink resolution, storage/filesystem identity, checkout/branch ownership and allowed workspace configuration fingerprints | Shared underlying writable state shares one exclusive scope |
| Session | Effective CLI session root and identity, HOME/config precedence, resume target and copy-back destination | Alias/collision/unknown precedence blocks execution |
| Credential | Effective source/staged/recovered roots, ownership/modes, refresh writer and recovery recipe; all copies of one refresh identity share a scope | Exclusive whole-lifetime credential ownership until real refresh concurrency is proven |
| Contract | company/agent/environment IDs, explicit CLI engine, exact agent/environment/workspace fingerprints; attested fence/session/credential roots | Drift blocks new starts and retains existing immutable contracts for cleanup |

Compare the inventory directly with TrustedCapacityBinding and its seven scope
keys (instance, runner, account, workspace, session, credential, contract). Do not
mint different account/credential keys just to permit overlap. An environment-only
probe also needs an unambiguous policy owner; shared environments require an
explicit reviewed ownership approach. A shared runner UID remains one trust domain;
separate directories do not prove security isolation from sibling code.

Store public identifiers, fingerprints and sanitized path mappings in reviewable
Git evidence; keep secret references/private account evidence in operator storage.
Record verifier, collection time, source and expiry/drift triggers for each binding.
No attestation passes solely because configured paths look different.

## 2. Review bootstrap and rollback before live installation

The candidate currently requires explicit host injection. Design production
bootstrap separately: immutable operator policy loading, schema/migration ordering,
remote epoch acknowledgement, old-owner fencing and conservative initial limits.
Start runner/account limits at one; mutable-state limits stay one. Keep Gemini
unconfigured/disabled for execution while authentication is deferred.

Inventory unresolved legacy occupancy before enabling admission. Both historical A
records remain explicit holds, with affected scopes blocked; this plan provides no
historical reconciliation, synthetic receipt, lifecycle edit or replacement agent.
Use existing B only for the first serial acceptance after a human-reviewed rollout.
Document backup/evaluation exemption explicitly without claiming backup health.

Prove restart with occupied reservations, supported adoption and rollback against
disposable state first. An older controller must never run against outstanding
admission work: drain, verify stop/restoration and reconcile before rollback.
Review a concrete image digest, migration/policy diff, recovery instructions and
baseline telemetry before a human-reviewed merge. No bootstrap implementation or
merge is included in this planning task.

## 3. Prepare bounded live tests, then review each stage

Instrumentation must measure occupancy through setup, stopping and restoration,
not just provider execution. Collect five-second samples of CPU/throttling,
memory/peak/OOM, PIDs, ephemeral/PVC space, controller responsiveness, database
pressure, native wait reasons, grant order, exact invocation/lease receipts and
independent workspace/session/credential outcomes. Missing metrics block sizing.
Freeze workload, serial latency baseline, available node headroom and provider
usage budget before dispatch. Proposed envelope: ten minutes per task, thirty
minutes per stage, finite retries, no automatic replay after an ambiguous start.

| Stage | Envelope and prerequisites | Exit evidence |
| --- | --- | --- |
| Serial Codex | After reviewed rollout/attestation, existing B, one active slot and at most two bounded tasks, queued serially | Native wait/grant, callback and copy-back, exact cancellation -> pause -> resume; no probe bypass; limits restored and B paused |
| Serial Claude | Separate reviewed task after account/session/refresh mapping; one active slot | Real cancellation/descendant receipts, state recovery, refresh/session continuity; ordinary hello is insufficient |
| Mixed provider | Only after both serial gates; proposed global cap two, Codex one + Claude one, max four queued | Aggregate cap, independent account/state holds, sibling completion and fair progress; requires approved participant plan |
| Same-provider overlap | Proposed two Codex runs/two projects, max four queued; requires approved existing participants AND proven concurrent credential/refresh model | Real overlap, independent sessions/workspaces/callbacks, exact sibling-safe cancellation and restoration; otherwise remain serialized |
| Larger roster | Twenty-four configured identities in synthetic fixtures first; real active cap stays at the last measured accepted value | Queue fairness/overload without excess starts; no inference of dozens of active runs |

Do not force refresh using corrupted/expired credentials or duplicate authenticated
writable homes. Observe supported renewal safely, including changed credential
copy-back and restart/session reuse. If renewal cannot be demonstrated, mark that
gate open and keep the credential lock exclusive even if a runner has spare CPU.
Provider quota is an observed limit, not a promise derived from subscription price.

Stop a stage for cap overshoot, duplicate body, wrong callback/state target,
credential divergence, missing stop certainty, OOM/eviction or unexpected billing
mode. Use exact supported stop; retain reservations if stop/restoration is unknown.
Require at least 20% measured memory/PID/disk margin at peak and stop/callback
responsiveness within the frozen baseline bounds. On 429/auth failure, hold the
account with bounded cooldown; no login loop, paid fallback or repeated batch.

Record start/end state, all identities/digests/policy revision, task/usage budget,
maximum measured overlap, grant/wait trace and resource peaks. End drained with
B paused, timers off and no unexpected processes. Any unresolved observation
retains its scope hold. Human review precedes the next capacity stage. Gemini,
historical A reconciliation, containment/Git delivery, everyday use and full
backup/restore acceptance remain separate open gates.
