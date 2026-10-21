# Ordered authority integration — inactive source review

Current source continuation: [owned authority services and retained-intent
implementation](OWNED-AUTHORITY-SERVICES.md). Actual runtime/storage/custody/native
effect integration remains blocked/open; the historical interfaces below are not
operational authorization.

This continuation implements component interfaces and a bounded synthetic runtime
rehearsal. It installs no production backend, issuer, listener or topology. The
native 64-file source remains d489129; all original scopes and holds are retained.

## Implemented stream boundary

`StreamControl._write` now requires `AtomicWriteBackend` through
`OrderedWriteAuthority`. The former integer-returning `write_exact` callback is
not a production write entry point. A protected resolver must identify the full
root group and current native/accepted-decision revisions. The controller binds
operation ID, original complete stream binding, sequence, byte hash/count and
runtime/storage revisions before commit. The backend must recheck these values
and cancellation at the actual effect; successful proof or resolver output is
not authorization. Missing resolver/backend refuses. Unknown, partial, late or
revoked writes permanently hold further writes; exact close-only remains.

The backend is abstract. The fixture adapter's old write helper exists only in
tests to exercise partial/revoked outcomes. There is no production atomic
native/runtime/storage coordinator. The owned stream process bounds local calls;
its termination cannot stop an unknown remote effect or release capacity.
Standalone root-group and decision helpers still need owned cancellable workers.

## Native integration that must precede activation

| Exact source boundary | Existing behavior | Required integration, still OPEN |
| --- | --- | --- |
| `server/src/services/execution-legacy-reconciliation.ts: legacyHoldIsReconciled` | Validates latest local immutable decision at original append time | Replace applicability boolean with mandatory ordered authority-owned native effect, complete original closure and independently current history. No cached observation or completion receipt authorizes later work. |
| `server/src/services/execution-admission.ts: historical hold loop` | Reads relevant local holds before native reservation/claim transaction | Bind complete shared closure and exact native transaction to external intent and ordered revocation. Revalidate at commit; specify lost external/native commit recovery before enabling this route. |
| `server/src/services/agent-execution-stop.ts: reconciledLeases` | Uses local legacy decision to exempt an exact lease from cleanup checks | Order actual lifecycle transition with current decision/revocation authority. Do not merely check a signed response before returning true. Preserve original receipts, manual holds and coordinator semantics. |
| `legacyReconciliationService.append` | Native advisory/scheduler lock, full inventory, evidence verifier and local decision CAS | Independently retain prospective append before native commit, then inspect exact intent after uncertain outcomes. External-ahead/local-old remains held; complete/revoke cannot lower history or replay an effect. |

The new `OrderedDecisionUse` expresses authority-owned native transaction effects,
not an operational transaction executor. It must not be plugged into a boolean
predicate or followed by an independently racing native write. No distributed
transaction/linearization protocol, issuer or protected key custody is installed.
An authority response that says completed is historical evidence only.

## All-command route closure, still OPEN

`packages/adapter-utils/src/ssh.ts` retains optional `spawnProtected` and fallback
SSH routes. Journaling before transport does not make the protected gateway
mandatory. Review every `buildSshSpawnTarget`, `buildSshStreamTarget`,
`runSshCommand` and unjournalled epoch/stop path; include direct Git bundle/tar
spawns, managed service start, setup, probes, verification, cleanup and recovery.
The final installer must make unsupported command paths refuse before preparation
and provide exact stdout/stderr/exit/signal framing as well as stdin. No production
installer or streaming executable exists in this continuation. Enabling only
normal task dispatch would leave bypasses and is prohibited by the contract.

## Runtime, storage and custody blockers

The runtime rehearsal covers every declared route/effect pair, unresolved pre-T
effects, deny intent T, completed barrier B, stale-controller recovery and original
UID permanence. Inputs are synthetic; its barrier is explicitly synthetic and
cannot be used as native or storage evidence. A complete matrix against the exact
installed runtime and an unavoidable effect/recovery mechanism remain absent.

Root-group interfaces require complete original alias groups, exact predecessor
vectors, prospective independent high-water, completed retirement and physical
exclusion before whole-group activation. Hashes and Python locks cannot establish
those physical facts. Actual adapters, current independent restore domain and
stale-open-handle/partition/recovery exclusion remain blocked.

Prospective decision inspection binds exact source, predecessor, decision,
inventory and intent. Protected public-key handles are interfaces, not real
custody. Real issuers, rotation/retired-key policy, independent append retention,
complete authoritative inventory and separately approved operator evidence remain
open. No keys or operational receipts are minted.

## Activation disposition

Images, policy, RBAC, network, workload, production preparation and manual
migration remain unchanged. Fixture brokers, observers and CNI installers must
never deploy. Existing native/image hosted results are reused only within their
unchanged source scope; new component checks do not imply operational acceptance.
Both A holds/original shared Codex families, paused B, Gemini deferral, disabled
timers, draft PR #5 and human-reviewed merges remain. No live mutation, provider
call, publication, migration, topology installation or capacity increase occurred.
