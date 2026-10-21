# Production control transport and storage follow-up

Inactive implementation and design for review, 2026-10-20. No endpoint, gateway
executable, runtime authority or physical-storage backend is installed. Native
source now extends `3dc1426` into a 64-file overlay with native ticket consumption,
separate-role mTLS endpoint factories and protected host adapters. New hosted
verification is required for this source; earlier full passes retain their old scope. Both historical
A holds, original shared Codex families and B's saved pause remain. No new scope
identity, backfilled receipt, provider invocation or activation is authorized.

## Implemented component and limits

`protected-execution/production/gateway.py` implements a bounded fixed-origin
mutual-TLS JSON client and the attach control sequence. Origins are explicit
literal IPs with matching certificate IP SAN, a supplied CA and client certificate;
ambient proxy, discovery, redirect, generic paths and automatic retries are absent.
TCP, TLS, headers and body share one deadline. Requests/replies are limited to
16 KiB; duplicate JSON keys and nonfinite values refuse. Errors redact peer bodies
and request details. A total-deadline timer interrupts slow response headers.

The gateway snapshots trusted instance/pool/policy/epoch/authority/history
incarnation and a current-history floor supplied by protected host configuration.
It validates request structure and the authenticated response's binding to the
requested command/invocation/physical/claim, then requires the native endpoint to
commit consumption independently. No stream opens until
the authenticated reply matches the request hash, original claim, all expected
pins and the trusted floor. The independent stream service must consume that
native ticket online before returning its exact owned handle. Cleanup closes only
the stream, including after failed retirement; it cannot release capacity, storage
or permanent ownership. Uncertain consume/open/close has no automatic retry.

This supplies inactive control and bounded byte-forwarding plumbing. Native PostgreSQL
now implements durable consume/one-use stream-claim and historical inspection
through separate-role mTLS factories. `production/stream_server.py` online-consumes
the ticket before typed exact-existing-stream acquisition. The source now forwards bounded exact stdin chunks behind an absent mandatory
every-write adapter; no provider backend, CLI, installer or exec/attach RBAC is supplied. Runtime/storage/history issuers
and the stream backend remain absent. Structural fields cannot prove physical
facts. Synthetic authorities prove protocol and transaction behavior only. Fixture SQLite, observers and nonempty callback strings remain
inadmissible production substitutes.

## Owned operations and exact byte forwarding

`production/operation_worker.py` owns one persistent adapter process inside an
inert session leader. The leader reserves the process-group identity even when
an adapter crashes; the same adapter retains acquired stream capabilities across
open/write/close. A protected caller supplies the importable factory, which builds
the native client and backend in the adapter. `OwnedStreamControl` encloses native
`claim-stream` calls as well as proof/acquire/write/close calls. Production handler
construction refuses direct synchronous `StreamControl`; explicit synthetic tests
can opt in. No request starts a replacement worker.

Request/reply frames are bounded to 64 KiB, with nonblocking exact framed send and
receive under a total deadline. Readability of a partial frame does not count as
completion. Startup, lock waits and dispatch have bounded waits (dispatch at most
three seconds); explicit cancellation is checked while waiting for I/O. Timeout,
worker crash, oversized/invalid result and uncertain outcome poison this owner,
attempt SIGKILL of the owned group, bound the leader join to 200 ms and retain
unknown external occupancy. This is a local cancellation attempt, not proof that
remote RPCs, queued effects, synchronous storage I/O or descendants outside the
owned group stopped. Deployment lifecycle containment, external supervisor death,
uninterruptible I/O, protected factory provenance and mandatory remote stop
remain review gates. Adapters must not escape the owned group or create daemons.
No failed result authorizes native release or a replacement stream.

`/v1/stdin/write` accepts exactly `{handle,receiptHash,sequence,dataHash,data}`.
`data` is canonical base64 for 1–4096 bytes; `dataHash` is their SHA-256. Sequence
starts at zero for the exact handle. Each write obtains independent runtime and
storage proofs with a new challenge and retained expiry. Before calling the
backend the stream becomes write-held; only an exact full-length, timely reply
allows the next sequence. Partial/late/lost/revoked outcomes cannot replay bytes
or continue a stream. Close-only remains allowed. Replies contain exactly
`{status:"written",receiptHash,sequence,dataHash,bytes}`. The gateway checks every
field; no old successful response grants continuing permission.

The abstract `write_exact` defaults to refusal. A production adapter must order
each byte effect atomically against current native cancellation/ownership,
runtime effect revocation and storage writer revocation. Fresh signed proofs
alone cannot serialize that effect. Native authority has not been connected to
such an atomic backend. The synthetic adapter checks plumbing; it is not a
production cancellation, runtime or storage authority. stdout/stderr/exit/signal
framing and mandatory routing of every native command remain open.

## Exact proposed endpoint contract

The paths below are inactive source contracts. Native and stream server factories
are implemented, but bind no production listener and install no policy.
They require separate role-bound mTLS service identities, network rules and
production handler review. No bearer or capability appears in a URL. The native
service must reject a supervisor/provider certificate; the stream service must
authenticate its gateway audience and revalidate its native audience independently.

| Endpoint | Proposed request/effect |
| --- | --- |
| Native `POST /v1/stdin/consume` | `{version:1,pins,attach:{commandId,invocation,physical,stdin:"exclusive",claim:{id,bindingHash}}}`. Lock and authenticate the original native claim, original command/lease/attempt, all original reservations and holds, current epoch/policy/authority/history, cancellation, exact accepted ACK and exact native Pod CREATE consumption. Verify independently current physical ownership and runtime-start authority before consuming. Write a **new permanent unique consumption** for that existing claim in the same native transaction as the ticket and current pin. Return only after durable commit. |
| Reply | Exactly `{version:1,status:"committed",requestHash,pins,claim,ticket,historyRevision}`. `requestHash` is the SHA-256 of sorted-key compact UTF-8 JSON for the entire request. Version is integer 1; history revision is an integer at least the protected floor. The server checks its current independent domain, not a requester-controlled floor alone. Ticket is bound to original owner/token hash, command/physical/storage/journal, request hash and authenticated gateway/stream audience. |
| Stream `POST /v1/stdin/open` | `{receipt,attach:<entire native request>}`. Independently contact native authority and durably consume the exact ticket once for this stream incarnation before opening provider stdin. Compare original claim, all physical/root/current-history pins and current cancellation/start/storage authority. Duplicate or unknown/lost outcomes refuse; no cached signed receipt grants access. Native receipt validation alone is insufficient. |
| Reply | Exactly `{version:1,status:"owned",receiptHash,handle}`. The handle refers to one already-owned stream. Neither this request nor later attachment may launch/recreate a Pod, execute a body, invoke a shell or reassign stdin. |
| Stream `POST /v1/stdin/write` | Exact handle/receipt/sequence/byte-hash/base64 chunk, independently current authorization and mandatory atomic effect gate. No retry after ambiguity. See owned-operation contract above. |
| Stream `POST /v1/stdin/close` | `{handle,receiptHash}`; reply exactly `{status:"closed",receiptHash}`. Close only, never clear writer consumption, runtime tombstones, native occupancy or storage ownership. Server-side close is safe to inspect later, but the client makes no automatic retry after an uncertain close. |

Native consumption is an actual PostgreSQL transaction in existing append-only
authority history, with deterministic permanent claim/ticket/use IDs. Existing
`claimStdin` remains a permanent first writer. Distinct pinned mTLS peers enforce
gateway versus stream roles. Signed fresh independent runtime/storage/history
proof is mandatory, with bounded waits, post-wait native revalidation and expiry
checks. Missing authority configuration refuses; no real issuer/backend exists.
Test mocks cannot authorize production. Trusted current-history floors must be recovered from the
independent authority before construction; restoring static old configuration
together with the database cannot establish freshness.

Native `/v1/stdin/claim-stream` consumes the ticket once for the pinned stream
peer and incarnation. `/v1/stdin/inspect` reads exact historical consumption/use
by ticket/requestHash after a lost reply; Python marks it `inspectionOnly`, never
permission to retry, reset or reopen. Both return only after native verification.

The proposed native response is deliberately small: the endpoint must verify
and retain full independent evidence internally. A `historyRevision` integer or
TLS session does not prove that independent evidence exists. Unavailable verifier,
unknown storage incarnation, missing retirement backend, revoked service identity
or conflicting history refuses before consumption/open. No first command is
exempted from the mandatory start boundary merely because it has no predecessor.

## Every command and recovery

Native code already journals ordinary commands and direct Git bundle/tar stream
paths before transport preparation. The production installer must route **every**
one through the same mandatory control/stream services, including probe, setup,
transfer, verification and cleanup commands; no legacy SSH fallback or direct
`kubectl exec` route is permitted. This follow-up introduces no native installer,
so every-command production enforcement remains open. Exact executable/handle
grammar and stdin/stdout/stderr/exit/signal framing need a reviewed streaming
executable and peer authentication; a control handle is not a process implementation.

Recovery is inspection only: reconnect to the original owner/journal/physical
history without provider body replay. Existing or uncertain writer claims cannot
be reassigned after timeout, gateway restart, connection loss or an epoch change.
This component implements no reacquisition/adoption. Implemented read-only native
inspection preserves original consumption and writer records; it gives no fresh grant.
Unknown stream state remains occupied. Never replace an unknown old writer with
a fresh claim or a different account/state family.

Runtime retirement distinguishes deny-intent **T** from completed barrier **B**.
Pre-T forwarded starts can still take effect after T; no stop/restoration/release
accepts a mere tombstone ACK. B must account for and stop every pre-barrier effect
and exclude later starts across stale kubelets, replacement sandboxes and recovery.
The full completed-B receipt binds original owner/run-or-operation/lease/attempt/
invocation/command/journal, full original scope-family/root contract, every node/
boot/runtime and sandbox/container/task alias, T/B sequence, stop accounting,
authority/key/history identity/current floor and fresh challenge. Native verifies
and commits its exact receipt/history CAS before reporting stopped. Physical
storage verifies its independent current floor separately. Neither backend exists
under the approved topology; dependent execution/restoration/adoption/release stays held.

## Canonical physical transaction

See [the physical-storage decision](bootstrap-review/physical-storage-authority-decision-2026-10-20.md)
for the full unchanged-family/multi-root inventory and alternatives. The next
review should choose whether to commission the sole-owner/detached-copy model
or require independently documented backend fencing, without approving deployment.
Neither PVC access modes, API object absence nor a file hash proves stale-I/O exclusion.

For a selected backend, one immutable operation covers the complete overlapping
alias/root group, not independently replaceable credential children. At minimum:

1. Read the independent current-history domain and exact physical/root incarnations.
   Lock the original family occupancy and reject any held, divergent or missing member.
2. Pin an immutable prospective transition `(original owner, old group heads,
   proposed new heads, physical incarnation, policy/epoch, operation ID)` in the
   separately protected history domain **before** canonical activation. The history
   domain refuses a duplicate operation with different bytes or predecessor.
3. Enforce physical exclusion and completed runtime barrier B for every returned
   attempt writer before reading returned state. Validate workspace, session and
   credential outcomes independently; never overwrite a newer refresh version.
4. CAS and activate the entire affected alias/projection group against the expected
   original heads under sole-owner enforcement; durably journal the exact result.
   Record the matching external completion without deleting the prospective pin.
5. Native release consumes exact runtime/restoration/storage evidence and current
   pin in its existing transaction. Command success alone grants no release.

External-ahead/local-old, local-committed/lost-completion, partial root activation,
unknown backend state or lost response all retain occupancy. Inspection compares
immutable intent and actual heads; it cannot rerun provider code, reset the high
water or synthesize a successful whole-group activation from partial callbacks.
Atomic rename of a single file is insufficient for cross-PVC/root groups. A chosen
backend must explain a protected pointer/head protocol or prove atomic activation;
otherwise the design remains blocked. No storage backend or independent history
domain was selected or implemented here.

## Verification and next implementation boundary

Affected Python suites cover client, stream and evidence contracts. Native and
stream tests use actual loopback mTLS/PostgreSQL with synthetic physical authorities.
The native authority HTTPS adapter pins CA, IP SAN and leaf identity with a total
deadline and no retry. Native cases cover competing one-use claims, cancellation,
proof changes, timeout lock release and historical inspection. Privileged
disposable old-snapshot simulation does not provide a history deletion API or
prove real restore. The evidence bridge reads protected authenticated artifacts,
never issues facts/signs/appends; its native adapter uses isolated source-only
Python execution to exclude hostile project bytecode.

Remaining work includes mandatory routing of every command through byte forwarding
and an actual current-write cancellation backend, real runtime/storage/history issuers/backends and exact-intent
recovery. Real authority/key custody and native append invocation remain reviewed
integration dependencies. Keep all dependent execution held. Real backup/
restore, refresh safety, provider budgets and operational capacity remain separate.


Affected local verification for this tranche: 20 stream contracts plus 12 worker
contracts, including assembled Attachment → persistent owned control → synthetic
backend exact bytes; synchronous native/backend stalls; explicit cancel; stopped
reader/send backpressure; incomplete reply frames; adapter crash with surviving
descendant; oversized results and permanent no-replay poisoning. Disposable
loopback TLS required sandbox socket permission. Initial intermediate failures
were corrected before the final worker run. Completed application refusals preserve the same
owned adapter for exact close-only; IPC/deadline/worker failure poisons the owner
and leaves external close status unknown. These checks do not rerun unchanged
native/full-server/image gates and do not establish operational acceptance.
