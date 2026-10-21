# Bounded authority/native PostgreSQL fixture — 2026-10-21

This increment implements actual executable SQL and a root-scheduled PostgreSQL
contract harness in a synthetic disposable domain. It changes no native source,
production schema, migration, roles, credentials, image, policy, workload or hold.
The earlier `sql-review/authority-native.sql` remains entirely commented, unchanged
review material. The new fixture is not a live migration or full application.

`sql-review/authority-native-fixture.sql` implements owner/executor/untrusted roles,
locked generation fencing, independently retained exact prospective descriptors,
original hold/scope closure, bounded capacity, authoritative claims, native deny,
release-fact consumption, exact outcome inspection and atomic effect/journal
writes. Functions are owned by a non-login, non-superuser owner with fixed trusted
search paths and no PUBLIC EXECUTE. The executor has schema usage and only typed
public functions; no table writes, internal-function access, role membership or
schema CREATE. Function ownership actually follows SET ROLE during construction.
The SQL refuses a database name other than `paperclip_fixture`; that guard is a
tripwire, not an isolation proof or operational deployment safeguard.

Within the fixture's deliberately small semantics, every effect transaction
requires SERIALIZABLE isolation, the matching generation/incarnation, a generation
row lock held through COMMIT, and complete original prospective request identity.
Claim overlap derives from independently seeded hold rows; unsupported/held or
omitted original shared sources refuse. Native denial checks exact original
source, sequence, intent, predecessor and operator-approval descriptor, writes
native-denied-only plus journal, and retains existing occupied claims. It cannot
report runtime T, completed B, physical storage exclusion or settled revocation.
Release requires exact independently seeded current facts, consumes them once,
and records the authoritative occupancy effect and journal in the same transaction.
The facts' `valid_until` comparison now runs both inside the function and in
an owner-owned, initially deferred constraint trigger on the operation insert.
A normal caller that waits beyond expiry and then COMMITs gets an exception;
claim occupancy, consumed-fact marker and release journal all roll back. The
trigger helper has no executor EXECUTE grant. Exact reply-loss inspection still
reports the original prospective operation as uncertain after rollback.

**This is not a mandatory COMMIT freshness mechanism.** The executor can issue
`SET CONSTRAINTS ALL IMMEDIATE` before expiry, flush the trigger, wait, and COMMIT
an expired release. An executable expected-success attack preserves this boundary.
SQL role grants cannot forbid SET CONSTRAINTS; trigger code cannot reliably tell
whether it is running at early flush or final COMMIT. Removing direct helper
EXECUTE does not prevent the attack. Even normally deferred execution checks
before final commit completion; it cannot guarantee external facts remain true
through WAL flush, scheduling delay or the actual later runtime/storage effect.
Production must refuse activation until a sole transaction-owning gateway keeps
all caller SQL/BEGIN/SET CONSTRAINTS/PREPARE inaccessible and independently fenced
monotonic retirement/exclusion facts are safe beyond commit; bounded expiry and
timeouts alone are insufficient. The fixture remains deliberately exposed for
attack characterization, not an authoritative expiring-release permit.

All effect routines additionally refuse if server startup setting
`max_prepared_transactions` is nonzero. The actual default-zero fixture tests
PREPARE refusal after a claim and verifies no prepared transaction or committed
claim survives. Startup/admin alteration and already prepared old transactions
remain recovery/operator boundaries; executor roles cannot change this startup
setting. A separate root-scheduled fresh PG18 startup variant with
`max_prepared_transactions=1` passed the refusal check with zero claims/journal;
that configuration branch is exercised in `prepared-enabled.log`.
Generation-row locking serializes generation changes separately and does not
repair the time/external-state gap.

The separate exact inspector reports committed-exact, deny-committed or
prospective-uncertain from the original durable request and journal. It never
returns a permit, suggests replay or inserts another operation. Unknown or altered
operation descriptors refuse. H-generation advancement does not erase historical
operation ownership. No function opens missing history, inserts accepted real A
evidence or bypasses original holds.

## Execution contract and verification boundary

Root alone schedules and executes this harness after the serialized storage
fixture. It uses the cached exact PostgreSQL 18 image selected in the root
checkpoint, non-root UID 999, network-none, no published ports, tmpfs-only data
and socket paths, at most 512 MiB RAM/768 MiB including swap/one CPU/64 PIDs.
The root fixture uses synthetic trust authentication, no production credentials
or mounted production data. This does not provision an operational login.

The Python harness requires explicit `PAPERCLIP_FIXTURE_CONTAINER` matching
`paperclip-native-fixture-[a-z0-9-]+`. It creates only `paperclip_fixture` within
that root-created disposable container using `docker exec -i ... psql` and the
local Unix socket. It never creates, pulls, builds, starts or removes a container,
contacts another PostgreSQL endpoint, installs dependencies or reads provider
state. Root removes the disposable container/data after the scheduled run.
Missing explicit container skips DB tests as NOT RUN; an invalid name refuses.

Fifteen DB methods exercise actual roles/function ownership/grants; claim+journal
atomicity; missing/held/stale generations; wrong isolation; NULL payload fields;
unretained/altered descriptors; both original shared holds; unsupported source;
omitted closure; noncanonical/unknown/occupied scopes; exact duplicate handling;
original uncertainty inspection; native deny/predecessor conflicts; one-use
release facts; transaction rollback; and bounded concurrent claim/deny locking.

The lock race uses an actual executor claim transaction, an observed
`pg_stat_activity` PgSleep barrier after its effect/lock, and a second executor
deny transaction with a 750 ms lock timeout. It checks no uncommitted journal is
visible; after the first claim commits, a fresh deny transaction can commit while
the prior claim remains charged. Statement/idle timeouts, Python subprocess
limits and root-owned container cleanup bound failed fixture sessions.

The discarded-COMMIT-reply case directs the client's output to `/dev/null` after
actual database COMMIT, then independently inspects the original operation and
checks duplicate submission does not create another claim. It models application
reply loss; it is **not** an actual network partition, database crash, uncertain
server commit timing or operational transport acceptance.

The coordinator's first actual PostgreSQL 18 run passed all fifteen DB methods
in 30.426 seconds. A test-only enhancement then added an explicit authoritative
epoch advance from 1 to 2 with the retained original epoch-1 request: the old
request must refuse and leave no claim/journal. That focused final check also
passed against actual PostgreSQL. Root verified UID999, network-none, read-only
container, tmpfs-only storage, no ports and OOMfalse, then removed the exact
PostgreSQL container; cleanup PASS. SQL implementation inputs were unchanged between
those runs; the exact scheduled fixture log/checkpoint is authoritative for final
execution and cleanup. This author ran no Docker/process/DB fixtures.
No synthetic signing key, operational A fact, acceptance receipt or runtime
retirement proof is created by fixture seed rows.

## Remaining implementation and acceptance blockers

The SQL is intentionally not compatible with the current native application
schema. Full queue/fairness/provider/lease/agent lifecycle predicates, callbacks,
all native writer call sites, source migration and role revocation are absent.
Independent inventory/fact/consent importers, protected current checkpoint CAS,
real signer custody, runtime effect queue/start/retirement and physical canonical
storage exclusion remain unimplemented. Seeded facts demonstrate SQL checks only.

A local generation row/lock cannot survive rollback of H itself or exclude a
stale writable database clone. Independent current witness W, restore/admin
separation, fail-closed opening, stale authenticated-session/credential/endpoint
exclusion and complete retained uncertainty remain required as specified in
[the transaction design](HISTORY-NATIVE-TRANSACTION-DESIGN-2026-10-21.md).
This fixture does not implement that recovery boundary, independent W/H restore,
runtime byte/deny ordering or physical fencing. Its prepared-transaction policy
is startup-disabled-only; operational recovery and admin exclusion remain absent.

Passing these tests verifies only the implemented bounded SQL domain. It cannot
release either A/shared-family hold, resume B, enable timers, expand capacity or
make Paperclip ready for valuable daily work. Preserve deferred Gemini, postponed
backup/S3/monitoring, draft PR5 and human-reviewed merges. Reviewed authority
implementation and exact activation/full shared-hold reconciliation precede
separately authorized serial real Codex/Claude acceptance.

## Composition continuation and exact native predicate mapping

Root ran the revised eighteen-method PG18 suite: **18 actual tests PASS in
40.748 seconds**, recorded in the canonical
`.handoff-state/2026-10-21/enforcement-composition/postgres.log`. The three added
methods cover ordinary delayed COMMIT rollback, an intentionally successful
early-trigger flush attack, and disabled prepared transactions. A second serialized
fresh PG18 fixture with `max_prepared_transactions=1` passed focused effect refusal
with zero claims/journal (`prepared-enabled.log`). Root checked both containers'
UID999, network-none, read-only/no published ports and OOMfalse, then removed both
exact disposable containers. This author ran no DB/container/process fixtures.
The expected-success early-flush attack remains a demonstrated production blocker,
not operational acceptance. Earlier fifteen-method results remain historical
verification and are not substituted for this revised-source run.

Read-only inspection of actual dirty native source finds these concrete missing
transaction requirements; no native source or migration was edited:

- `server/src/services/execution-admission.ts:90` onward: original historical
  closure plus draining, cooldown/notBefore and occupied states; prepared-run
  eligibility; auxiliary caller ownership; per-project fairness frontier; queued
  run/company/agent/issue/project identity; nested native claim and persisted
  lifecycle result; terminal cancellation without advancing fairness; scheduler
  sequence/project lastGrant and token/owner epoch. The small SQL claim does not
  implement these.
- `execution-admission.ts:354` `journalLaunch`: single-use reserved-to-starting
  transition; exact active SSH lease/run/company/agent binding; policy/environment
  and scope re-resolution. `cancel` preserves uncertainty while `takeover`
  records non-reusable epochs and leaves occupied work uncertain. These must move
  atomically into H rather than be checked in P and supplied as booleans.
- `execution-admission-operations.ts:306` `releaseCapacity`: stopping-state and
  workspace/session/credential restoration checks, zero unstopped commands,
  success for every restoration row, refusal of retained legacy launch binding,
  and lease/attempt release effects remain coupled; the SQL release is no replacement.
- `execution-legacy-reconciliation.ts:29,79`: exact original company/agent/run/
  environment/lease/policy/scopes and bounded evidence age, independently reviewed
  inventory and evidence freshness, immutable decision sequence/predecessor CAS.
  `legacyHoldIsReconciled` checks acceptance-time freshness at `latest.createdAt`;
  accepted retirement/restoration persists until explicit revoke or epoch/binding
  change. Preserve this monotonic semantics rather than expiring accepted facts.
  `agent-execution-stop.ts:21` additionally closes reconciled leases, reservations,
  terminal runs and remote termination evidence. All branches and all original
  shared families must survive H migration and direct-writer revocation.

The fixture preserves typed exact intents, shared hold closure, native-deny
ordering, stale generation refusal and original-operation uncertainty inspection.
This continuation adds a concrete late SQL guard and a negative capability result;
it does not claim complete native integration or relax any rollout gate.
