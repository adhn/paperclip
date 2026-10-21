# Current launch fence: implementation contract for review

**Inactive source candidate; runtime proposal only.** Native consume source
now exists as described below; there is no approved installation, topology
change or operational acceptance. Keep draft PR #5, held bootstrap, both A holds and original
Codex scope families, paused B, deferred Gemini and disabled timers. Non-root
workload rules remain mandatory. This document authorizes no live dispatch.

## Continuation implementation status

An inactive native `consumePodCreate` transaction, host-only pinned-mTLS endpoint
factory and Python online client now implement the one-use CREATE contract in
source. The endpoint is not installed by production bootstrap. It permanently
records consumption in the existing immutable native request history; no expiry,
failed CREATE or missing Pod permits reuse. The executable webhook refuses static
grant-only or unauthenticated API-server startup. Current storage attestation is
still a mandatory injected dependency without a physical production backend.
Actual Kubernetes fixture consumption uses an isolated SQLite authority, so it
must not be credited as assembled native/PostgreSQL admission acceptance.
The exact-version continuation evidence and remaining gaps are recorded separately.
Same-UID runtime recreation and native-history restore remain separate unresolved
gates; the stronger runtime fence below is still a proposal.

## Two different replay boundaries

A captured authorization retains its old high-water floor. After supervisor
ledger rollback and retained runtime-object removal, replay can launch another
body before the controller rejects its ACK. Prefix validation protects fresh
current-floor requests, not captured old envelopes.

Distinguish **another Kubernetes Pod object** from **another sandbox/container for
the same Pod UID**. Independently current, one-use native consumption during
validating admission is a candidate solution for the first boundary. A static
signed-grant webhook is insufficient: it validates an old grant without consuming
current authority. Preventing same-UID runtime recreation after a stale kubelet
or runtime restore is a separate node/retirement fence. It must not be inferred
from a successful Pod CREATE consume transaction.

## Candidate A: online atomic consume during Pod CREATE

The independently managed validating webhook authenticates directly to the current
native service on **every** relevant non-dry-run API CREATE. Before returning
`allowed`, consume one permit in a serialized durable native transaction. Lock and
check scheduler epoch/drain, cancellation, command journal, reservation ownership,
lease, original seven scopes, storage exclusivity/incarnation and exact approved
workload/configuration. Bind the consume to cluster/namespace incarnation,
authenticated API-server/webhook identity, AdmissionReview UID, namespace/name,
API-assigned Pod UID and normalized admitted object hash. No supervisor/provider
key can mint this result. Network partitions and uncertain transactions deny or
hold; never use a cached reusable allow decision for another CREATE.

A consumed permit cannot authorize a different review or Pod UID. For the exact
same authenticated review/object, an immutable prior decision may be returned
only after proving API-server retry semantics cannot persist a second Pod with
that decision. Otherwise deny repeats and retain the possible successful CREATE.
Creation can fail after webhook consumption, including because another validator
rejects or storage fails. **Never unconsume or issue a replacement permit merely
because CREATE failed, timed out, or the Pod is absent.** Inspect the exact bound
object through an independent API observer; unresolved persistence stays held.
Reject dry-run without consumption, generated names, alternate create-on-update/
apply routes and admission bypass until their behavior has explicit acceptance.

This can close the characterized **new-Pod-object** replay attack without a
privileged engine interceptor if all new Pod creation traverses this current
consume boundary, native history survives supervisor/runtime restoration, API
responses cannot be replayed into another CREATE and the exact object identity
binding is established. It is a candidate, not an implemented guarantee.

### UID facts checked, implementation assumptions still to prove

Kubernetes v1.35.0 upstream distinguishes AdmissionReview UID (webhook request/
response correlation) from object UID. Its generic CREATE store assigns object
system metadata before validating admission and before storage persistence;
`FillObjectMetaSystemFields` generates a UID. The handler clears incoming system
metadata and wires validating admission into that storage path. These source
facts support investigating direct Pod-UID binding at validating CREATE; they do
not prove the deployed version's retry behavior or successful persistence.
Sources: [admission API types](https://github.com/kubernetes/api/blob/v0.35.0/admission/v1/types.go),
[CREATE store](https://github.com/kubernetes/apiserver/blob/v0.35.0/pkg/registry/generic/registry/store.go),
[system metadata](https://github.com/kubernetes/apiserver/blob/v0.35.0/pkg/registry/rest/meta.go),
[CREATE handler](https://github.com/kubernetes/apiserver/blob/v0.35.0/pkg/endpoints/handlers/create.go).

The original source inspection above is v1.35.0. The continuation now verifies
server-assigned/retained UID, caller-UID replacement and distinct client CREATE
identities on actual pinned v1.34.0 with authenticated API-server TLS. See the
2026-10-20 report for exact evidence and limits; unobserved retry/failure behavior
is not inferred from those positive controls.
Pin the actual Kubernetes version and demonstrate: validating review contains the
server-assigned UID; committed Pod retains exactly that UID; caller-supplied UID
cannot select it; concurrent CREATEs and webhook/API retries cannot reuse a
consumption for a second object; failure after allow never restores permission.
AdmissionReview UID alone is not a Pod UID or a general user-request idempotency
key. Independently authenticate the API-server request; a copied JSON review is
not sufficient evidence to replay a native allow decision.

## Candidate B: stronger runtime start fence

If the required threat includes same-UID sandbox/container recreation, or if
Candidate A's exact identity/retry assumptions cannot be proved, review an
independent current runtime start barrier. It binds the native command/permit to
freshly observed Pod/sandbox/container/node/runtime/storage incarnations **before
body execution**. Native consumption and the gate's one-use start state must
survive, or independently detect, restoration. Replaying an old consume reply
cannot start a replaced gate/container. A waiting process inside the entirely
untrusted provider Pod is not this barrier. Ordinary admission does not intercept
kubelet CRI starts for an existing Pod.

The supported location and narrowly delegated authority for such a gate remain
design inputs. No root/privileged workload or fixture broker is authorized. If no
supported non-root implementation can enforce the required boundary, that rollout
gate remains held. Separately, stable whole-Pod stop must exclude replacement
sandboxes after retirement; an API deletion timestamp alone does not establish
what a partitioned kubelet has observed.

## Shared durable and failure contract

Record immutable native command/payload/configuration, original company/agent/
run-or-operation/attempt/lease/scopes, permit, consume challenge/result and exact
physical/storage bindings as those become available. Runtime identities unavailable
at CREATE are appended from an independent observer; Candidate A must not pretend
they were part of its earlier admission decision. Preserve uncertainty/history.

| Event | Required behavior |
| --- | --- |
| Old envelope or consumed permit replay | Current online consume denies a new review/Pod identity; never replay the body or substitute a replacement object. |
| Consume commits; webhook/API reply lost | Inspect the exact bound Pod/create outcome; ambiguity holds and cannot mint another grant. |
| Start succeeds; attach response lost | Reattach only to the independently observed retained incarnation. Attach has no launch permission; one stdin writer initially. |
| Cancellation races consume | Native transaction orders them. Cancel first denies; consume first requires exact independent stop and restoration. |
| Supervisor/runtime restore | Surviving current native consume history forbids another Pod-object dispatch. Same-UID runtime recreation requires its separate fence. |
| Native DB restore | Database-only consumption is insufficient. Fence old routes and verify independently retained consume history/incarnation before granting starts; otherwise held recovery. |
| Native service/API/witness partition | Deny new CREATE consumption; retain existing occupancy and inspect on recovery. No automatic body retry. |
| Node/kubelet partition | Exclude replacement sandboxes/containers for the Pod UID before declaring stable stop or releasing capacity. |
| Epoch change/adoption | No executable permit crosses epochs. Adopt occupied work only through reviewed exact dispatch/runtime/state reconciliation. |
| Multiple commands | Separate immutable journal/permit/consume identity for every setup/probe/transfer/restoration command. Parent shared-state occupancy persists; command completion is not release. |
| State divergence | Independent workspace/session/credential outcomes, version CAS and retained quarantine; never overwrite newer credentials or clear a shared hold. |

## Required acceptance before implementation can activate

Exercise duplicate/concurrent CREATEs, captured envelope/allow/consume replay,
post-allow validation/storage failure, API/webhook timeouts/retries, UID substitution,
supervisor/runtime/native-DB restore, Pod removal/recreation, same-UID sandbox
replacement, cancellation at every boundary, duplicate stdin attachment,
partitions, adoption and multiple commands. Independently count starts and verify
sibling ownership. Then rehearse assembled native callbacks, cancellation,
restoration and restart. Fixture results do not establish homelab/provider
acceptance. Production authentication, current history, enforcing admission and
network policy, storage fencing and node retirement require separate attestation
and human review.

## Assembled fixture implementation — 2026-10-20, scoped verification PASS

`protected-execution/launch_native_fixture.py` assembles the actual pinned kind
API, pinned API-server mTLS webhook, `OnlineLaunchConsumer`, production native
`protectedCreateEndpoint` and `protectedExecutionJournal.consumePodCreate` against
a fresh real PostgreSQL schema. Its new native TypeScript fixture seeds only an
internal ephemeral database; it refuses `DATABASE_URL`, an absent disposable flag
and any UID other than 2000. The native container receives no Docker socket,
kubeconfig, provider state or live database credentials. Its stdin control and
the host Docker orchestration are disposable test machinery, never deployable.

Namespace/PVC UIDs come from the actual API before native command preparation.
The immutable command grant originates in the native journal, rather than the
SQLite fixture installer. Modes cover ordinary CREATE, cancellation-before-
consume, a failing synthetic current-storage attestor and a dropped allow after
native commit. Endpoint restart retains that same PostgreSQL history. A consumed
still-valid captured grant must remain spent after object removal/retry; no
replacement permit or unconsume operation is provided.

This test deliberately uses `/bin/true` as its fixed synthetic entrypoint. It
proves no executable payload decoding, provider behavior, callbacks, independent
physical storage fencing, runtime retirement or capacity release. Its storage
attestor is a labelled boolean fixture, not a real PVC exclusion authority. Tests
are uncredited until their actual recorded run completes. Production installation,
independent storage attestation, same-UID runtime-start fencing and native-database
restore safety remain separate gates.

The native initializer now returns only its exact database-derived original owner
and fixture grant key for immutable guard configuration. It creates no command
grant until after the guard Pod is ready and a real API dry-run is positively
refused by that webhook. Only then does `prepare` call the actual native journal
once. This keeps the production 30-second expiry unchanged and prevents slow
fixture scheduling from consuming the captured grant's validity budget. Replay
uses those exact original grant bytes; no re-sign, clock override or replacement
permit is used. The `restart` control closes the HTTPS endpoint and its original DB client, then
reconstructs a fresh `createDb` connection and native journal service over the
**same live PostgreSQL database**. Results still mark native-process restart
unproved; no database restart/restore occurs in this control.

The test-only `Dockerfile.launch-native-fixture` adds the UID-2000 NSS identity
required by embedded PostgreSQL and prepares its existing library aliases. These
are build-time fixture accommodations; its runtime stays UID 2000, read-only,
without capabilities or runtime sockets. The hosted aggregate bound is 2 GiB
kind plus 768 MiB native, at most 5 GiB including swap and two CPUs. kind's nested
Kubernetes process count uses the separately documented hosted 1024-PID allowance
plus native 128 PIDs, **not** the local 256-PID test allowance. No local kind
execution is credited. Artifact uploads must exclude kubeconfig and all TLS/key
files; retain result JSON and native stderr logs only.

A fifth `database-loss` mode permanently stops/deletes only the native fixture's
own synthetic PostgreSQL via its public cleanup helper before actual API CREATE.
It records empty pre-loss consume history, keeps the HTTPS endpoint alive and
requires denied CREATE/no Pod while the original grant is still valid. It cannot
inspect nonexistent current history and explicitly reports no current-history or
recovery verification. This is a fail-closed backend-loss control, not a database
restore/restart, recoverable consume-ledger loss or operational backup proof.


The final assembled harness additionally includes `validator`: a second
independently attested native-backed webhook rejects actual CREATE while the
native PostgreSQL consume must commit. Its readiness is established in the
control namespace before grant preparation, independently of the consuming
webhook. The fault is removed and positively checked by an allowed control dry-run
before captured-grant replay. After fresh native client/journal reconstruction,
that exact still-valid grant must remain spent with no Pod persisted. Validator
invocation ordering is not assumed. No result is credited before actual hosted
execution. A bounded network-readiness poll separately tolerates Docker inspect
success before the named kind network/IP has been assigned; missing readiness
still times out and existing containers remain refused.

## Hosted completion — 2026-10-20

Run 39449824759 on native 3dc1426 passes all six actual Kubernetes→mTLS→native
PostgreSQL modes (normal, cancellation-first, storage refusal, lost response,
database loss, later-validator refusal), plus 523 native / 329 transport cases,
full typechecks and three actual SSH fixtures. Native source is unchanged through
functional review 3dcaad6. Downloaded evidence explicitly says physical storage/ACK
are synthetic, native process restart is unverified and stableRetirement=false.
Run 39458972052 separately passes the explicit scoped-bearer HTTPS API adapter;
its current consumer remains fixture SQLite. No production endpoint/attestor or
runtime retirement authority is installed. See integrated-review/HOSTED-VERIFICATION.md.
