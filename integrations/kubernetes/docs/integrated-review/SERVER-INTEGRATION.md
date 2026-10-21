# Native, stream and evidence implementation continuation

Current independent source delta: [operation ownership, bytes, current legacy history and authority decision](IMPLEMENTATION-DELTA.md). This extends the historical component status below; real enforcement and activation remain held.

Inactive source only, 2026-10-20. Production pins/preparation and all historical
holds remain unchanged. This continuation advances independent implementation;
missing runtime/storage authority blocks dependent execution, not this source work.
It extends the earlier `22b64d7` control-client review and the old verified native
`3dc1426` source. The native overlay now contains 64 files, not 60. Hosted native verification now passes on `d489129`; the image/PVC continuation
is recorded separately in HOSTED-VERIFICATION. Earlier results keep their original scope.

## Implemented source boundaries

| Component | Concrete behavior | Remaining boundary |
| --- | --- | --- |
| Native PostgreSQL journal | Reuses append-only authority history for deterministic permanent gateway ticket and stream-use IDs. Locks/revalidates exact original owner/token/command/lease/scopes, native cancellation, accepted current ACK, CREATE and pins. Independently signed fresh current proof precedes durable commit; native facts are checked again after waiting. | Real mandatory runtime/start, physical storage and independent history issuer are absent. No production bootstrap caller or listener installer. |
| Native mTLS endpoint factory | Separate pinned gateway and stream certificates control consume versus claim-stream paths; original roles can inspect historical consumption. Canonical bounded requests, fixed paths, no caller-declared identity or automatic retry. | Exact installation/network/rotation review. Factory alone does not expose a service. |
| Independent authority client | Literal-IP origin, CA/IP SAN/leaf fingerprint, copied client TLS identity, fixed verify-and-pin path, one total deadline and bounded replies; native separately authenticates signed exact challenge/owner/pin/history proof. | No physical authority server exists. It must durably remember one-use operation IDs outside native rollback, not merely sign a fresh challenge after rollback. |
| Stream control enforcer | Online native ticket consumption precedes exact typed existing-stream acquisition; distinct runtime/storage proof domains bind full command/physical/current challenge. It checks the shorter proof deadline before and after acquisition and attempts close-only cleanup of the exact late capability; cleanup failures remain occupied. | Actual existing-stream backend, byte forwarding and every-write cancellation/revocation enforcement are absent. No launch/exec/body replay mechanism is supplied. |
| Recovery inspection | Native exact ticket/requestHash returns immutable consumed/stream-claimed facts. Python labels output `inspectionOnly`; unknown/conflicting outcomes stay held. | No writer reacquisition/adoption or external-intent resolution. Historical facts cannot authorize a new stream. |
| Evidence reviewer | Protected fd-walked fixed config selects complete inventory, seven independent domain bundles, continuity and inspection roots. Exact original scope sets, fresh challenge, independent history continuity and shortest expiry must match. No signing, append or fact issuance. | Real issuers/config/key custody and protected current inventory are absent. Unsupported sources remain held. |
| Native evidence adapter | Computes existing native hold fingerprints, passes complete projected inventory and fresh challenge to a fixed isolated Python child, bounds input/output/deadline and validates exact returned native hashes/expiry. Compiles verified project source directly, bypassing timestamp-matching hostile `.pyc`. | No same-UID key mount establishes independent authority: symmetric verifier keys also permit signing. Security placement/custody and the append invocation require review. |

No SQLite, observer string or structural callback is credited as production
authority. Interface implementations in tests are synthetic; production inputs
remain absent and defaults refuse. The independent authority contract needs exact
durable prospective intent and current history, not an external success boolean.

## Verification and corrections

Final local affected checks: 84 native journal cases plus 8 native evidence-adapter
cases pass; focused service/test typecheck passes. Nine actual loopback mTLS
authority-client cases and 41 transport cases passed in the earlier affected run
and were unchanged by the final null-token/loader corrections. These are 142
distinct cases with overlapping reruns, not a sum of every run. Python final
combined source passes 58 cases: 20 gateway/inspection, 16 stream and 22 evidence.
Seven additional native-patch guard tests cover 21 normal/`-O`/environment-optimized
subcases. A fresh actual Git checkout also reconstructs all 64 files with native
patch optimization enabled and refuses reapplication atomically.
Stream tests include actual loopback mTLS; physical authorities and stream bodies
are synthetic. Exact 64-file reconstruction and reapply refusal run in a fresh
checkout, never by resetting/reapplying the intentional dirty source checkout.

Retained failed runs are not passes. Two rollback tests initially hit the
immutable-history delete trigger; only the disposable tests changed to a
transaction-local privileged simulation of an offline old snapshot. The real
trigger/migration is unchanged. This tests refusal from independently retained
intent memory, not actual backup/restore. A nullable native token type error was
fixed with explicit null rejection and a DB test. Native verification has an
intrinsic bounded wait; its timeout releases scheduler locks without appending a
ticket, and late external commitment remains occupied. Hostile cached bytecode
was characterized with the real Python interpreter; direct source compilation
returns the protected source result instead.

Further review corrected complete operator consent: every source's authenticated
operator artifact must bind the exact full inventory hash and nonrecursive
`approvedDecision: {sequence,previousHash}`. Genuine old reconcile approval cannot
undo an intervening revoke under intact native CAS. Refreshed timestamps/challenges
alone cannot renew changed consent. These cases do not protect a rolled-back
accepted-decision database: separately retained decision/revocation history and
current authorization on every use remain an authority/integration requirement.

Native patch preflight now uses explicit checks instead of optimization-stripped
assertions. This changes reconstruction protection only, not the 64 native source
files or application output. The unchanged native/build CI source is `d489129`;
targeted component/guard follow-ups are verified separately. No old full check is
credited for changed Python or guard code.

Native local checks use one 3 GiB RAM/5 GiB including swap/two CPU/256 PID
container. Python checks use 256 MiB/512 MiB including swap/one CPU/64 PIDs,
network-none/non-root/read-only. Heavy work is serialized. Full server graphs
and production builds stay hosted. Unchanged old Kubernetes/API/CNI fixtures are
not rerun for disconnected Python code; their previous evidence is preserved.

## Remaining physical and operational obligations

Runtime effect/recovery authority still needs the proposed dedicated-pool
decision and proof. Deny intent T is not completed retirement B. Current topology
cannot prove all stale-kubelet/replacement/recovery starts excluded, so no actual
retirement receipt, canonical activation or native release can be accepted.

Storage still needs sole-owner or documented backend stale-I/O exclusion,
complete root-group CAS/activation and independent retained high-water outside
Paperclip rollback. No new scope family, B exemption or fresh empty pool is
permitted. The evidence bridge cannot manufacture old SSH route/descendant/root
facts from a future Pod gate. All ten saved leases and any additional live hold
sources need full present-day evidence and supported lifecycle handling.

The stream HTTP factory's three-second timer starts after TLS handshake. A
future installer must also bound pre-handshake accept/TLS time and concurrent
connections/threads; the handler is not a safe deployed listener on its own.
Synchronous native/backend calls are only deadline contracts today: a blocked
adapter can retain the control lock beyond the deadline. Closing the socket
does not cancel that worker. Production installation needs cancellable operation
ownership and bounded worker/lock handling; no component-enforced total backend
timeout is claimed. Native claim-stream history must strictly advance beyond
the consume revision; the equality regression is rejected before backend entry.

Exact every-command executable/bytes framing, peer/callback scopes, external
refresh coordination and current revocation at each write remain open.

Publication, live migration, topology installation, provider tasks, capacity
increase and merge are unauthorized. PR #5 stays draft. Reviewed rollout and
complete shared-hold resolution precede ten bounded serial Codex tasks on B,
then Claude lifecycle/session/refresh; Gemini, timers, overlap, everyday use and
real backup/recovery acceptance remain held.
