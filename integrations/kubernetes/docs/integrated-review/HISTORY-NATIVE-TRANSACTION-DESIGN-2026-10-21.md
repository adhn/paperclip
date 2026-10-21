# Sole native writer and independent history transaction design — 2026-10-21

This is a concrete review candidate, not installed authority, topology selection,
migration or acceptance. It follows `DAILY-USE-MECHANISMS.md` and the inspection-only
`HISTORY-CONTINUITY-2026-10-21.md`. Backup/S3/monitoring work remains postponed.
Both A/original shared-family holds remain; B stays paused, timers off, Gemini
deferred, capacity unchanged, PR5 draft and merges human-reviewed.

## Transaction-domain choice

The viable candidate moves authoritative native admission/claim/occupancy and
admission-relevant lifecycle transitions into H's transaction/restore domain.
H owns the sole typed native writer. P (Paperclip's restorable application state)
gets projections and cannot authorize a runtime start, adopt writer, release
occupancy or decide hold applicability from its local restored rows. Existing
native tables/predicates cannot silently remain an alternative authority.

This resolves one precise race: the native effect, current generation comparison,
complete overlapping original hold closure, deny status, capacity and exact
operation journal commit in **one PostgreSQL transaction**, holding the same
protected generation row lock until COMMIT. A generation change/native deny uses
that lock too. An old transaction either commits first and remains accounted for,
or observes the changed generation/deny and refuses; there is no signed callback
between check and effect. Serialization failures hold the original operation for
inspection. No two-phase cross-database transaction or preflight permission is
claimed. The sole executor must own bounded BEGIN/COMMIT, statement and idle-in-
transaction deadlines: an idle/long transaction retaining this lock can prevent
native deny or epoch advancement. Timeout/disconnect does not prove the COMMIT
outcome. Stale-session termination and exact original-operation inspection remain
required; a timer cannot certify that remote effects stopped.

H may use the existing external PostgreSQL infrastructure only if ownership,
restore permissions and endpoints actually provide independence. Different schemas
alone provide no independent administrative/restore boundary. P-only logical
restore must exclude H and cannot reinstate write privileges to authority tables.
Whole-cluster/PITR restoration of H reverts its row locks, generations, journals
and roles together; **the SQL cannot distinguish that state from the original**.
H must therefore be anchored by an independently administered current witness W,
outside both P/H rollback and signing-key restore domains. This is not yet built.
No second PostgreSQL cluster is commissioned by this proposal.

The rejected smaller alternative keeps authoritative effects in P while asking H
whether a generation is current. A preflight callback, matching snapshots, remote
SELECT, foreign data read or signature cannot participate atomically in P's later
COMMIT. Restoring P can resurrect its old epoch, grants and operation journal;
a stale former executor may commit there even when H knows a higher generation.
Adding another local advisory lock does not solve that cross-domain problem.
Keeping that layout requires a separately proven exclusive physical writer/
connection fence covering every old and cloned P endpoint before effects resume.
No such fence is installed or approved, so that alternative remains blocked.

## Concrete inactive SQL surface

[authority-native.sql](../../protected-execution/sql-review/authority-native.sql)
is fully commented review text; no SQL execution or PostgreSQL validation occurred.
Its [README](../../protected-execution/sql-review/README.md) explains the grant and
missing-predicate boundary. It includes generation, scope/hold inventory,
independently approved prospective requests, authoritative claims, denial intents,
release facts and exact effect journal tables; typed SECURITY DEFINER claim,
native deny and occupancy-release routines; and a restricted execution-grant
proposal. Missing rows keep it held; no empty-history bootstrap is supplied.

All effect routines lock the same generation row in SERIALIZABLE transactions,
validate exact retained request descriptors and write effect+journal atomically.
The executor cannot insert prospective requests, holds, release facts or trusted
generations. Their independent importer remains unimplemented. Complete original
scope/alias discovery belongs to that protected inventory, not to caller arrays;
the routine compares the caller's closure with the independently retained set and
keeps unsupported source occupancy. Imported inventory itself requires actual
independent provenance and completeness review.

The broad native source change remains substantial. The current seams are
`execution-admission.ts` claim/reservation/history transactions,
`execution-legacy-reconciliation.ts:legacyHoldIsReconciled` and immutable decision
append, and `agent-execution-stop.ts:reconciledLeases`. Replace authority use of
local booleans with typed H transactions, preserving existing queue, claim,
reservation, lease, agent cleanup, callback and full shared-closure semantics.
Controller/provider roles lose equivalent direct DML and alternate writers,
including old migration jobs and maintenance credentials. Updating a P projection
is not the authoritative lifecycle transition. Old code must refuse before any
side effect if the mandatory writer is unavailable.

The SQL sketches the concrete lock/role/intent shape; it does not implement every
native predicate or lifecycle transition. It is not a schema-compatible replacement
for the current native schema; provider policy, queue fairness and all existing
application conditions remain to be integrated. It supplies no append/reconcile approval,
open-generation, evidence-import, completed revoke or recovery override function.
No SECURITY DEFINER function may accept a callback, shell body, arbitrary SQL,
boolean retirement assertion or caller-selected table. The non-login owner and
function ownership/default privilege auditing are installation prerequisites.

## Recovery and stale-writer exclusion

The SQL candidate is safe only under a separately implemented fail-closed recovery
boundary. W must retain current H incarnation/generation and restore status beyond
H administrator snapshots. Every H start, promoted endpoint, restored clone and
authority process restart stays unavailable to effect writers until reconciliation.
P application credentials never obtain the sole writer role. The executor's
credential issuance/connection route must itself be outside the restored domain;
H's own restored `phase='open'` row is insufficient.

Before any authority incarnation is reopened:

1. Independently close all effect routes and record recovery-held in W. Fence the
   old authority processes and every database endpoint/replica/clone that could
   accept their writer sessions. Merely setting NOLOGIN, changing a password or
   revoking CONNECT is insufficient for already authenticated sessions; terminate
   and independently exclude them and prevent reconnection. A split-brain server
   or old network route must not remain writable. Include prepared transactions;
   forbid them for executor roles unless a separate recovery design covers them.
2. Establish that all old accepted/uncertain operations remain retained in W/H's
   independent current record. Restore/projection repair must never lower high
   water, delete an intent, erase revocation, mint a new operation or infer absence
   from a restored journal. If H lost newer records that W cannot fully reconcile,
   stay held. W merely signing the restored H head is not reconciliation.
3. Under sole protected administration, rotate H incarnation/epoch and retired-key
   state against W's expected head; keep the H generation row recovering while
   validating complete inventories. Retire old connection credentials and session
   routes. Persist/check exact prospective opening in W before making H writable.
   The final opening protocol and crash recovery need implementation and tests;
   a crash between domains stays held, never optimistically open.
4. Only after W's exact current head, protected connection fence and H generation
   agree may the sole executor access the typed routines. Every routine still
   validates the same-transaction H generation. Unknown W availability/ownership,
   endpoint history, stale session or restore privilege means no effects.

If a restore/superuser administrator can restore H and W together, reopen an old
endpoint, reinstate stale writer sessions/grants, or bypass this maintenance gate,
there is **no SQL-only monotone fence**. An honest client cannot infer present-day
currency from those matching snapshots. This is an explicit impossibility
conditional and a release blocker, not protection this file claims to provide.
Physical routing/session exclusion and independent administrative ownership must
be implemented outside restored H state. SQL privileges do not contain a
superuser or a compromised authority owner.

## Native commits, runtime bytes and deny linearization

There is no distributed atomic commit joining PostgreSQL changes and pipe writes.
The ordering contract must name each irreversible owner:

| Boundary | Linearization and outcome |
| --- | --- |
| H prospective deny | Durable intent forbids issuing new overlapping native/start/write intents. It does not prove already issued runtime messages stopped. |
| Native deny N | H transaction COMMIT under the shared generation lock. Later overlapping native claim/lifecycle effects refuse. Earlier committed native effects remain owned and charged. |
| Runtime deny T | The sole runtime effect owner durably serializes deny with exact frame/launch acceptance in its own unavoidable queue. It stops accepting all later overlapping effects, including stale-generation submissions. H's timestamp/SQL receipt is not T. |
| Completed runtime barrier B | Actual runtime authority settles/stops every pre-T accepted or uncertain process/descendant/queued effect and excludes recovery/recreation. Silence, object deletion or a callback identifier cannot establish B. |
| Physical canonical exclusion | The selected canonical owner/storage mechanism excludes all original stale mounts/descriptors/aliases and external credential writers. B alone cannot establish this. |
| Settled revocation | Only after exact N, T, B, physical exclusion and complete retained intent inspection may the authority record settled. H prospectives and native-denied-only stay occupied. |

Global revocation invocation can overlap an earlier native commit or byte
acceptance. It must return **pending** until each affected owner has actually
committed its deny; it cannot declare H prospective time to be a universal T.
No later intent is issued after prospective deny, but an earlier in-flight message
may reach runtime before its actual T; it remains pre-T owned work. All owners
must serialize deny against their own irreversible acceptance before reporting
completion. Native N and runtime T are different instants; claiming they are one
atomic instant without a common effect owner would be false.

Runtime framing/queue design must define acceptance as the runtime owner's
irrevocable ownership of exact bytes, not a remote client check followed by an
unowned pipe write. If the API requires **physical pipe writes never occur after
T**, the runtime owner must cancel/drain pending descriptor writes before it
acknowledges T; otherwise use acceptance-order semantics and keep pre-T pending
writes charged until B. This distinction is a review decision and cannot be
hidden behind an acknowledgment. The final protocol must match the chosen
semantic at every command/frame route. No current component demonstrates it.

A PostgreSQL lock held across a callback to a pipe is rejected: the pipe survives
transaction rollback, a lost lock/session may race a late physical write, and a
restored database can resurrect the lock's generation. Callback completion or a
signed preflight never becomes effect authority. Mandatory runtime queue/worker
ownership and stale process/recovery exclusion remain separate implementation
obligations. Missing partition settlement leaves occupancy held indefinitely.

## Exact next isolated verification and rollout gates

No database, container, processes, providers or live state were inspected or run
for this workstream. No fictional SQL/concurrency/restore result is recorded. SQL remains NOT RUN
because the implementation and disposable fixture are incomplete, not because
isolated testing requires new permission.
When the coordinator schedules a bounded disposable fixture, required isolated
checks are: actual proposed SQL syntax/ownership/search-path/privilege audit; all native
predicates and call-site migration; concurrent claim/native-deny/generation rotate;
exact duplicate and altered descriptor refusal; prepared-transaction refusal;
COMMIT response loss; queued cancellation; authority death; P-only restore with H
newer; whole-H rollback with W newer; stale authenticated sessions and endpoint
clones; failed W opening CAS; unknown runtime T/B; and unsupported original holds.

Operational placement/issuer custody, W/H independent administration, physical
stale endpoint exclusion, actual native sole-writer integration, runtime queue/
retirement and canonical physical exclusion remain missing. Review those first,
then prepare the complete immutable activation/manual-migration diff for human
review. Separately authorized rollout and full present-day shared A reconciliation
must precede ten serial Codex tasks on existing B, followed by Claude coding/
session/renewal/disconnect/restart acceptance. No hold is released by this design.
