# History continuity inspection candidate — 2026-10-21

The newer `DAILY-USE-MECHANISMS.md` continuation (functional `1695530`)
supersedes the authority-services checkpoint's source-only scope; the recovery
handoff's October 21 direction postpones backup/provider/monitoring work. This
increment preserves both A/original shared-family holds, paused B, disabled
timers, current capacity, Gemini deferral, draft PR5 and human-reviewed merges.

`production/history_continuity.py` adds a pure inspection component. It implements
no service, signer, database, checkpoint storage, hold release or native effect.
The existing SQLite store and native accepted-history predicates are unchanged.

The verifier requires separately installed history and independent current-witness
identities, different domains and key handles, a protected monotone checkpoint,
and the original durable operation descriptor. A fresh request challenge binds
the independently signed witness to the exact inspection. The witness binds the
history generation/revision, exact full snapshot digest, denial inventory digest
and operation inventory digest. History/current-witness signatures use distinct
message domains. Current-witness placement outside both native and history
administrative/restore domains is a prerequisite, not something signatures prove.
Two matching restored snapshots cannot satisfy that prerequisite.

The snapshot contains the complete retained operation records and denial records,
not only the queried row. Inspection compares every operation identity field:
operation ID, typed kind, original source, prospective intent, original request,
predecessor and transaction hashes. Unknown or missing original operations hold;
`not-recorded` is historical data and never advice to replay. Uncertain operations
cannot regress to not-recorded, terminal operations cannot reopen, and previously
retained operations cannot disappear or change identity. Denials cannot disappear
or change their source/sequence/intent/decision/order, and settlement cannot
regress. An observed revoked-settled outcome additionally requires the exact
retained settled deny intent; this is a signed historical assertion, not a new
receipt or independently measured retirement fact.

Trusted checkpoint revision/generation floors reject rollback, including when
both presented artifacts agree on an older snapshot. Same-revision changed heads
are rejected. Independent challenge/request/time/head binding rejects stale or
mismatched witnesses. Bounded JSON byte/depth/node/string checks run before
signature verification. External mutation of constructor input or the public pins
copy does not change the verifier's identity. Returned immutable records have no
current, authorization, permit or retry field. A historical completion can never
authorize another effect.

Verification: 22 pure stdlib test methods PASS in 0.161 seconds. Tests use an
explicitly synthetic exact-message verifier, no cryptographic keys, processes,
network, databases, fixtures, provider calls or operational authorities. They cover
rollback/fork, denial persistence, exact uncertain identities, retained unrelated
operations, pending/terminal outcomes, malformed input, bounded structure,
signature failure, trust separation, challenge replay and expiry. Existing
unchanged native/image/typecheck passes were not rerun or expanded in scope.

Run from the project root:

```sh
python3 -B -m unittest discover -s .work/homelab-admission/clusters/homelab/infrastructure/paperclip-evaluation/protected-execution -p test_history_continuity.py -v
```

Remaining implementation/rollout blockers are concrete:

- Install a separately administered, independently current history/witness domain
  with monotone incarnation/generation retention, retired-key denial, complete
  original-family inventory, non-exported issuer keys and real consent/facts.
  A local checkpoint, SQLite reopen, namespace split or matching backups is
  insufficient. Missing domains remain held; never implicitly bootstrap from P.
- Implement protected durable checkpoint CAS and complete original-operation
  retention. The caller must load the trusted checkpoint and its operation/denial
  inventories outside request control and outside P/H rollback. This component
  validates supplied protected state but does not establish its provenance or
  update it. Fresh unpredictable challenges and outstanding-request ownership
  require actual protected service implementation.
- Review/load the new signature domains and schemas in the real verify-only
  custody implementation. `custody_service.py` currently does **not** allow
  `paperclip-history-continuity-snapshot-v1` or
  `paperclip-history-independent-current-v1`. Its domain allowlist and dependencies
  are unchanged; this component cannot yet compose with the actual Ed25519
  primitive. Synthetic verifier tests do not close that gap.
- Connect current generation/history checks to the authority-owned native
  admission/lifecycle effect transaction and common irreversible deny boundary.
  A successful inspection and later effect have a race; no check-then-use native
  integration or caller-side cached permit is added here. Real backend cancellation,
  physical stale-writer exclusion and uncertain commit recovery remain required.
- Resolve original A/shared-family facts through the separately reviewed full
  inventory and present-day reconciliation path. No synthetic evidence here
  establishes any A fact or releases B/shared occupancy.

After implementation and isolated failure review, prepare the complete immutable
image/policy/RBAC/network/workload/manual-migration diff for human review. Any
publication/rollout needs separate authorization. Full shared-hold reconciliation
then precedes separately authorized ten-task serial Codex acceptance on existing
B, followed by Claude lifecycle/session/renewal and restart/disconnect acceptance.
This increment grants no operational acceptance and changes no live state.
