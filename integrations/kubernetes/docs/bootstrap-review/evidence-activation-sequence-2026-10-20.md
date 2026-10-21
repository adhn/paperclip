# Evidence, migration and reconciliation sequence for review

Inactive sequence proposal, 2026-10-20. This document enables no installation,
publication, migration, decision signature, append, provider work or hold release.
It builds on [the server integration review](../integrated-review/SERVER-INTEGRATION.md),
[the evidence matrix](operational-evidence-matrix-2026-10-20.md) and
[the manual migration review](legacy-manual-migration-review-2026-10-20.md).
PR #5 stays draft; both A records/original Codex families, B's pause, Gemini
deferral and disabled timers remain mandatory. No old receipt is recreated.

## Artifact dependencies and exact order

Each artifact below needs an immutable content manifest, authenticated issuer and
explicit original instance/owner/family binding. A path, fixture marker or
structural callback is insufficient. These are prerequisites, not issued real
artifacts.

| Order | Artifact/action | Required predecessor and stop condition |
| --- | --- | --- |
| 0 | Final reconstructed source, production recipe and hosted verification manifest | Exact 64 native files and protected Python source match the final tested candidate. Current source-only checks do not publish an image or install an authority. Later source changes need their affected verification. |
| 1 | Reviewed authority/placement and installer plan | Mandatory runtime effect/recovery boundary; physical sole-owner or proven backend exclusion; independently current history restore domain; credential/root mapping; separate protected reviewer/issuer custody. Missing decisions keep dependent effects held. |
| 2 | Exact reviewed release/maintenance/rollback manifest | Separately authorized immutable candidate registry pin, old PR #4 digest, original family/root mapping, namespace/DB/PVC identities, least-privilege migration executor and exact network/RBAC/admission/workload diff. No placeholder pin. |
| 3 | Independent old/new dispatch and physical writer exclusion | Enumerate old SSH/controller/keys/recovery routes and every state writer. Stop the old controller through the reviewed procedure; no automatic old restart. Unknown descendants/writers/history retain occupancy. |
| 4 | Coordinated real Paperclip-only recovery point | Under exclusion, capture the dedicated DB, files/config/keys and all workspace/session/credential roots with refresh lineage. Retain independently current launch/runtime/storage/high-water authority outside this rollback. Verify restored targets separately; no shared PostgreSQL-cluster rollback. |
| 5 | Exact candidate manual migration result | Run only the reviewed final-image packaged migration API with protected held policy and auto-apply false; independently inspect DB identity and old head first, then exact final head/upToDate. No candidate application boot before success. Lost response requires migration-ledger inspection under exclusion. |
| 6 | Candidate held boot/bootstrap result | Boot only the reviewed candidate with protected policy/external DB/manual migration setting. Record fresh held epoch, complete immutable legacy imports and unchanged native/historical facts. No granted starts or synthesized remote ACK. Restart changes epoch and invalidates previous current-epoch reconciliation applicability. |
| 7 | Complete review inventory and independent domain results | Enumerate every hold, including non-A/released/receipt-bearing records and unmatched sources. Use exact persisted scope arrays. Unsupported identities/source kinds remain blocking. Obtain route, retirement, stop, workspace, session and credential facts from approved independent authorities. |
| 8 | Explicit operator approval of the complete semantic inventory | Outside native locks, review each original hold/action and all six artifact hashes. Every operator artifact binds complete approvedInventoryHash and exact approvedDecision sequence/previousHash. No B-only filter or automatic approval renewal. |
| 9 | Protected bounded issuer/reviewer/signing coordination | Outside-lock verified bundle/operator review precedes the separate exact native decision signature/sequence/previousHash. Inside-lock fresh inventory/challenge verification remains mandatory; signing alone grants nothing. Real request channels/issuers/signing/append orchestration remain absent. |
| 10 | Supported native append, exact inspection and lifecycle sweep | Append each source through the current-epoch draining transaction and mandatory full verifier. Inspect ambiguous source/sequence/hash outcomes, preserve history, then use supported coordinator sweep. Never replay bodies, blindly advance sequence, edit lifecycle or mint receipts. |
| 11 | Complete shared-hold and operational acceptance result | All shared sources resolve independently; both A agents reach supported paused state with manual holds retained. Recheck every start/authority/state gate. No serial B work until later reviewed rollout and full shared-hold resolution. |

Steps 2–11 describe future reviewed operational work, not actions authorized now.
A bootstrap/controller boot is not permission for a provider start. The existing
synthetic old/new image/PVC run 39466029222 remains a verified rehearsal of its
older exact source and fixture state, not proof that later functional source or
real backups/retirement/storage meet these prerequisites. Fresh final-image
rehearsal is needed when the assembled production inputs change, not merely to
repeat an unchanged old test.

## Avoid native-lock / inventory-issuer deadlock

The native append service holds advisory lock `(174510,1)`, scheduler lock and
complete native hold row locks while calling its mandatory verifier. A human,
provider refresh or an issuer that waits to acquire that same exclusive lock
must never be placed inside this callback. The bounded native child cannot
wait for a manual approval or mint its own protected snapshot.

The concrete proposed coordination is:

1. Prepare domain facts, complete semantic inventory review and human consent
   outside the append transaction. Resolve any unsupported source first through
   separate reviewed support; do not filter it out to make the verifier run.
2. The host caller prepares the exact signed source decision and invokes append.
   Native locks its current inventory and computes original hold fingerprints.
   The protected wrapper generates a fresh challenge and passes the entire
   projected inventory/native hash to the reviewer.
3. A future separately protected issuer channel receives that exact challenge and
   expected inventory identity. Its complete authenticated read-only database
   observation must not synchronously acquire the already-held append advisory
   lock or conflicting row locks. An independent complete MVCC read is a proposed
   implementation, provided source identity/query completeness and a matching
   current native inventory hash are verified. This is not implemented yet.
4. The issuer authenticates its own current history/physical evidence and
   atomically publishes bounded per-request inventory/continuity responses.
   It cannot merely echo the app's inventory as an independent observation.
   A real transport/atomic-publication mechanism is still required: the current
   file-reading bridge cannot expose an unknown fresh challenge to an issuer by
   itself. No static pre-signed file can answer every future challenge.
5. The reviewer verifies protected files, all source bundles, operator inventory
   binding and shortest expiry. Native rechecks inventory/epoch/drain/identity,
   sequence CAS and expiry at append. Timeout, changed inventory, missing issuer
   or uncertain history aborts without a decision insert. No lock is retained
   while waiting for a human to approve a changed bundle.

The signer performs its complete preflight and exact decision signature outside
the append lock, after human review. Native receives that already signed decision
before its callback runs; the later challenge-bound verification revalidates the
current same semantic inventory and exact decision. No signature is produced by
the reviewer, and a preflight signature cannot replace the fresh locked verifier.
This ordering still needs assembled implementation/proof. The independent snapshot must remain
complete/current under the native transaction boundary; a bounded outside-lock
preflight alone cannot substitute for that locked comparison. A future protocol
must define how expired preflight information aborts and restarts outside locks.

## Freshness without approval bypass

Inventory and continuity have a 60-second observation/freshness boundary; domain
and operator artifacts/decisions have at most their existing one-hour window.
The native callback returns their shortest deadline and append rechecks it.
The per-request challenge, current independent history, epoch and binding must
still match; an old matching configuration is not current authority.

The implemented bridge allows a newly authenticated inventory envelope timestamp
and fresh continuity challenge for the **same** semantic inventory while all
original bindings/policy/epoch, six domain artifact hashes, approved action, exact approvedDecision sequence/previousHash and
unexpired operator approval remain unchanged. These refreshed envelopes do not
modify operator consent. The issuer cannot extend an expired artifact/approval
by refreshing inventory, continuity or decision expiry.

If any source/hold fingerprint is added/removed/changed, every operator artifact
must explicitly approve the new complete inventory hash. A changed sibling's
valid new artifact set and approval cannot carry the selected source's old global
approval forward. Changed domain artifact bytes, action, identity, epoch/policy
or expiry require the applicable new explicit review; no unattended re-signing
of human approval is permitted. Review bundle changes abort the locked attempt
and return to outside-lock preparation. The bridge enforces complete inventory
and exact append-intent binding; it supplies no approval UI, signer or issuer.
Native sequence CAS does not substitute for operator consent to sequence and
previousHash. In particular, an unexpired reconcile1 approval cannot authorize
reconcile3 after explicit revoke2 merely because the hold inventory and domain
facts stayed unchanged. A fresh signature/envelope around that old operator
artifact is refused; new explicit exact-intent approval is required.

## Prospective history pins and failed local commits

Runtime start/stream consumption and canonical activation have distinct durable
intents. The independent authority must permanently consume the exact operation
ID before signing its native proof, retaining that intent outside native
rollback. A fresh challenge for the same already consumed intent is not a new
permission. Canonical state likewise pins original owner/old heads/proposed new
heads/physical incarnation before local group activation or equivalent proved
intent/commit protocol; the local commit cannot precede the durable external pin.

| Failure point | Required retained state / recovery action |
| --- | --- |
| Before independent intent commit | No acknowledgement or dependent native/storage effect. Remain held until exact authority outcome is known. |
| External intent committed, response lost or native transaction failed | Independent occupancy remains. Inspect that same operation and exact predecessor/current history; no new operation/body replay or fresh empty pool. Native rollback does not unconsume the external intent. |
| Canonical group partially activated or local result unknown | Retain full overlapping root/alias ownership and quarantine. Compare original intent/current actual heads under physical exclusion; no credential rollback over newer refresh and no success from partial callbacks. |
| Local activation committed, completion/history response lost | Retain prospective pin and exact local immutable result. Recover only a separately supported matching completion; never reset external high-water to match an old local snapshot. |
| Authority ledger/incarnation lost, rolled back or conflicting | Hold every affected original family, storage and native occupancy. No old matching DB/files/ledger pair proves that no later effect existed. |

Legacy decisions need independent retained per-source chain/intent history too.
Exact approvedDecision binds the human's intended local sequence/prior hash, but
does not itself prevent offline DB rollback to an old same-epoch chain from
making that old intent locally eligible again. Current bridge continuity binds
challenge/inventory/pins/current revision, not the exact source-chain high-water
or a permanently consumed legacy append intent. A real issuer must not sign a
fresh challenge over a forgotten revoke. The future issuer protocol/native
projection must bind exact decision intent and independently current source-chain
history, with prospective intent/uncertain-commit inspection outside rollback.
That recovery protection is not implemented or established by the 22 bridge
cases; missing real issuer inputs continue to fail held.

A compatible exact-intent inspection/reconciliation API for those external
uncertain outcomes is still missing. Native historical stream inspection and
Python tests with retained fake intent memory do not implement that API or prove
physical authority recovery. Timeouts/expiry can invalidate a proof but never
silently delete its permanent occupancy.

## Exact inspections and supported source resolution

Keep three inspection domains separate:

- `/v1/stdin/inspect` authenticates original gateway/stream roles and checks exact
  ticket/requestHash against durable native consumption. The Python helper labels
  its result `inspectionOnly`. It cannot return a new stream or prove an A
  reconciliation decision was committed.
- Python evidence `operation:"inspect"` requires a separately authenticated fresh
  observation of exact legacy source/sequence/decisionHash/current history and
  challenge. Only `committed-exact` confirms that immutable decision; unknown or
  conflicting state remains held. The observation issuer/native orchestration
  path is absent. It is not a signer or a safe-to-retry instruction.
- An external prospective runtime/storage intent needs its own independently
  current exact-operation inspection protocol. Neither native inspection above
  can erase or resolve that independent occupancy.

The hold-inventory hash covers immutable original source/fingerprint rows; an
accepted decision is a separate append-only record. Individual successful
appends therefore do not permit ignoring still-unresolved shared sources. Keep
all start/drain gates held until the complete reviewed set resolves independently
and supported lifecycle sweep reaches the required paused states.

For ambiguous legacy append, query the exact immutable decision chain before
any retry: if committed, use supported coordinator/sweep; if unknown, hold; if
conflicting, stop for reviewed reconciliation. Never blindly increment sequence,
rewrite previousHash or replay provider work. A decision accepted in an old epoch
stays historical, while current-epoch applicability requires supported fresh
review. Current source supports exact `lease:<UUID>` sources with all original
UUID identities and terminal native run binding. `run:` sources, null/unmapped
owners and conflicting relations have no supported append resolution here. Keep
the original row and global/shared occupancy and prepare a separately reviewed
source-kind extension only if actual inventory establishes that need.

## Work that can continue while execution stays held

Source work is not stopped by the topology decision: implement the protected
per-challenge issuer/request channel and complete inventory adapter; implement
exact legacy append inspection/coordinator orchestration with no signing bypass;
add disposable assembled native→protected reviewer→append failure/restart tests;
and define/test
external exact-intent inspection before permitting uncertain-state recovery.
These still require concrete authenticated interfaces, not fixture authority
claims. Source reconstruction now uses explicit runtime checks rather than
optimization-strippable assertions; that independent source hardening is not an
operational authority or a reason to repeat unchanged runtime fixtures. No unchanged hosted check needs blind repetition.

Actual mandatory runtime enforcement/host placement and a physically enforcing
storage/high-water backend require the pending human authority/topology choices.
A gate only on new dedicated execution nodes cannot establish retirement of the
original A SSH processes, old shared-node runner UID or old mount writers. The
legacy transition must independently exclude those original physical routes and
runtimes too. Future protected-Pod evidence cannot be relabelled as historical SSH
proof. No whole-node/privileged workaround or host/runtime installation is approved.
Real key custody must separate symmetric-HMAC verification/issuing power from
untrusted/incorrectly shared UIDs; root-owned same-UID files do not create that
boundary. Real migration/installation/publication/provider stages remain held
until their exact reviewed dependencies and separate authorization exist.

## Accepted-decision resurrection after restore: unresolved use-side boundary

Exact approvedDecision consent prevents reusing an old approval with a changed
sequence/prior hash while native CAS history is intact. It does **not** protect
a restored database from resurrecting an accepted reconcile decision whose later
revoke was lost in that snapshot. This can occur without another append: current
`legacyHoldIsReconciled` reads the latest local immutable decision/hash and its
accepted-time binding; it does not independently verify a current per-source
history at each use. Changing only the signed append artifact cannot fix that
read-side resurrection. The 22 bridge cases establish neither DB-restore nor
accepted-decision rollback protection.

Real continuity must cover both the rollback-independent legacy decision chain
and **each native use of accepted reconciliation** after restore, including
admission/start claims and supported lifecycle lease interpretation. The real
issuer/backend is absent, production policy remains held and no installed
protection is claimed. Complete activation requires the following additional
protocol/source/rehearsal work; no extra source field is presented as a solution:

1. Review a separately retained authority design owning original per-source
   decision/intent history and revocation high-water outside Paperclip DB/files
   rollback. Specify security placement, issuer/verifier custody, old/current
   policy/epoch lineage and authority recovery. Retain original hold facts and
   scope families; do not overwrite old policy hashes to fit new bindings.
2. Define durable prospective append-intent and completion/inspection semantics.
   Bind the exact source/hold/scopes/action/sequence/previousHash/decision content
   to independently current history before local commit. External-ahead/local-old
   or ambiguous completion remains occupied. A fresh challenge cannot authorize
   a forgotten intent/revoke after rollback.
3. Define independently authenticated current **use authorization** for complete
   original shared-hold closure, not only an append signature. It must compare
   each locally accepted source decision with the independent latest action,
   sequence/hash, current history and revocation state at the authorization
   boundary. Unknown, older, conflicting or unavailable history leaves native
   occupancy and lifecycle interpretation held. A cached local accepted fact or
   a new epoch/family cannot bypass this comparison.
4. Integrate that reviewed protocol into `legacyHoldIsReconciled` and every
   admission/lifecycle/use caller with bounded issuer waits and the established
   native lock ordering. The remote authorization/effect ordering against
   revocation must be proved; adding a short TTL or an opaque continuity string
   alone is insufficient. Runtime/storage gates remain independently required.
5. Add disposable assembled restore rehearsals with independently retained
   history: reconcile1 then revoke2; restore an accepted-reconcile1 native
   snapshot while external revoke2 remains; call admission and lifecycle use
   paths **without another append** and require holds/no side effects. Also
   restore pre1 state and attempt old intent replay, lose local commit/remote
   acknowledgement, restart/restore each side, change authority incarnation and
   remove history. No source rekey, receipt recreation, generic observer or
   reset of external memory is allowed. Synthetic rehearsals must keep their
   authority/evidence limits explicit and cannot accept real recovery targets.

Source protocol and fail-closed caller integration can progress independently of
physical installation, once their exact interfaces are reviewed. Selecting and
operating the separately retained real authority/security boundary remains a
review decision and deployment prerequisite. No hold release, migration or
provider stage follows from this proposal.

## Concrete next decision: independent legacy authority placement and use ordering

Review one separately retained legacy decision authority that owns the complete
original source inventory, prospective append-intent state and latest accepted/
revoked source chains. Its data, incarnation and revocation high-water must be
excluded from Paperclip DB/files restore; its signing identity must be inaccessible
to controller/provider/transport users. Select the actual protected public-key
verifier and custody/rotation mechanism. No authority/backend/placement is selected
or installed by this proposal. If the permitted topology cannot supply it, retain
all shared holds and review the smallest authority/topology decision; do not use
fixture memory/SQLite, callbacks or a restored copy of the same database.

The new `production/decision_history.py` interface provides a concrete observation
request/verification boundary for that review: complete exact original holds,
local immutable decision references, purpose, fresh challenge, request hash and
protected expected history/key pins. The issuer must independently reject omitted
sources and old/uncertain intent history. Its response must name every latest
source decision rather than merely a global revision. No result is a permit.
The native source-only evidence loader and `legacyHoldIsReconciled` are unchanged,
so use-side restore protection remains OPEN. The new module is not installed by
the current image/native bridge merely because its source exists.

The smallest next native interface review must settle two separate operations:

1. **Prospective append:** reserve the exact full decision/consent/inventory and
   immutable original source chain against independent latest history before
   local CAS. Permanently retain the intent and its uncertain/completed outcome;
   inspect exact intent/decision after lost replies before any retry. A decision
   signer accepts only verified seven-domain/operator evidence and this exact
   reservation, never arbitrary bytes. Local rollback cannot reuse an old intent,
   forget a revoke, move a sequence backwards or silently mint a new family.
2. **Every use:** compare the complete accepted local closure with independently
   current source history at admission/start and lifecycle interpretation, then
   bind actual use to an externally enforced order against revoke. Define the
   linearization boundary and how already committed effects remain charged.
   A response TTL/observation is insufficient. Preserve the native lock ordering;
   do not hold locks during human review or create a synchronous issuer query
   that reacquires those locks. Missing history/guard/backend remains held.

Only after both interfaces are integrated should disposable assembled native
rehearsal test reconcile1→revoke2→restore native reconcile1 with independent
revoke2 retained, invoking admission/lifecycle directly without append. Also test
external-ahead reconcile3, pre1 restore/old intent reuse, partial/unknown commit,
issuer outage, key/incarnation rotation/loss, restored authority and revocation
racing actual use. The current 12 synthetic verifier cases prepare comparisons;
they do not complete these assembled or real recovery gates.
