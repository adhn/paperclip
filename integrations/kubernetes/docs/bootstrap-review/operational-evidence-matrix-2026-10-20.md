# Operational reconciliation evidence matrix — 2026-10-20

Review preparation only. No evidence issuer, signer, migration executor or live
reconciliation is installed by this document. Every operational row remains
blocked or open. Historical receipts and manual lifecycle holds stay unchanged.
The supported source contracts and synthetic hosted results do not establish the
physical facts below.

## Inventory is larger than the two A records

The saved 2026-10-19 attestation contains ten leases and ten corresponding runs.
Under the current held bootstrap, every unjournalled lease becomes an immutable
legacy hold, including released leases and leases with a recorded receipt. Every
unmatched/untracked run also becomes a hold; unknown ownership gets the global
instance scope. Bootstrap retains existing holds even if native source rows later
disappear. Consequently the expected starting inventory is **not** an assertion
that only two A holds require review. Recompute the complete inventory from the
actual reviewed clone and later live transaction; the saved rows below are
historical anchors only.

| Saved original owner | Saved lease IDs requiring inventory accounting | Historical receipt/cleanup facts |
| --- | --- | --- |
| Original Codex `348d6a8a-250e-467c-aa19-cd2f3e2d8c26` | `b9c014f9-cd2b-43e2-b61c-bc5c974f6783` | No recorded termination receipt; cleanup null |
| Original A `22898651-e5f1-4566-b3d0-ae6b237f4a8c` | `5ac871df-d83c-4a1f-a16a-df6dda21be4b` | No recorded termination receipt; cleanup null |
| Repeat A `e32dca0d-7ae5-478c-a000-cc7b8d921d55` | `2085d84e-4aa7-42cf-b25d-ee02a4b66d7b` | No recorded termination receipt; cleanup null |
| B `be500ba7-65ad-4a72-8369-474eb2522274` | `6c0b1b3a-c194-4a98-ae8d-5e31d8fe648e`, `c2229026-d196-4ce6-b564-45a2cbabc3f8` | No recorded termination receipt; cleanup null |
| Same B | `21979f5a-df84-475a-9433-4efbc197b0d7`, `5c0ddb12-593b-4a44-878e-1edfb9c18fb1`, `3e89f95b-1875-441b-85b0-50b7b43a2fe4`, `7ff0f8ec-b42b-40aa-985e-697daea41dd3` | Recorded receipt present; cleanup success. Presence is retained evidence, not automatic present-day authority |
| Claude `562ed16a-c09c-4660-92d7-bba077643d7f` | `82cc3853-467e-4d2a-a00e-530658868315` | No recorded termination receipt; cleanup null |

Source: canonical workspace `.handoff-state/2026-10-19/attestation/database.json`,
`results.leases` joined to `results.runs`; no new live query. Original policy
families are in [held-policy.json](held-policy.json). Mapped legacy holds carry
exactly the persisted sorted runner/account/workspace/session/credential scopes;
these are five scope keys. The seven-scope reservation policy includes additional
scope types and must not be substituted for that persisted hold array. Sign and
verify the exact native `hold.scopes`, including global-only unknown holds.

The current append API requires `source = lease:<leaseId>` and UUID company,
agent, run, environment and lease identities. A `run:` source or unknown/null
identity cannot use that path. If the complete inventory contains one, retain its
occupancy and stop the reconciliation stage pending a separately supported,
reviewed resolution; do not invent an owner/lease, delete the row, filter it out
or relabel it as a valid lease. The conservative verifier requires a complete
bundle for **every** authoritative hold, including other providers/companies.
A shared-Codex-only optimization is not implemented or accepted.

## Independent authority and verifier installation matrix

Every domain artifact binds source, holdHash, companyId, agentId, runId, leaseId,
environmentId, exact scopes, policyHash and current epoch. Domain-specific raw
observations must be retained behind `evidenceHash`; an authenticated `verified`
string proves only that its issuer signed it. Authentication and factual authority
are separate review obligations.

| Domain | Proposed narrow issuer responsibility | Mandatory independent verifier predicate | Missing operational implementation/evidence |
| --- | --- | --- | --- |
| Inventory | Protected native inventory adapter using the same advisory/scheduler/row lock ordering as append | Complete original source/hold fingerprint set; separately pinned inventory root and native transaction hash; no caller-filtered set | Protected bridge source below; no production snapshot issuer or protected inventory root installation |
| Route | Separately operated old-route exclusion authority | Every old controller/SSH/key/cached-launch route is excluded and cannot resume, including recovery/downgrade; exact route/key inventory | No enforceable route retirement mechanism or complete control-key inventory |
| Retirement | Reviewed mandatory runtime/physical authority covering original SSH execution | Every original and replacement incarnation permanently excluded, with independently current history; no rebranding old SSH work as protected-Pod history | Current topology cannot supply stable retirement; authority/topology decision pending |
| Stop | Independent execution-accounting authority | All original/pre-barrier descendants accounted for and stopped under exact native ownership; complete inventory, no quiet-poll inference | No complete present-day whole-incarnation observer/accounting backend |
| Workspace | Canonical storage owner/transfer verifier independent of provider | Every source/staged/copy-back root and uncommitted result restored or quarantined against exact physical ownership/version CAS | Physical owner/detach/activation backend and real root results absent |
| Session | Independent canonical state verifier | All transcript/resume and encoded-cwd roots reconciled; absence classified; resume identity and versions bound | Real effective root/resume mapping and restoration artifacts absent |
| Credential | Independent canonical credential/version authority | Every source/cache/symlink/staged writer classified; newer refresh retained; independent current high-water and external-writer relationship resolved | Laptop remains active; refresh grant relation and full writer coordination unverified |
| Operator | Protected human approval channel | Exact action plus six verified domain artifact hashes, complete inventory and decision bindings reviewed; no partial B approval | No authenticated operational approval mechanism or real approval artifact |
| Decision signer | Separate protected native-decision signing service | Only after full evidence verification; exact sequence/previousHash/current epoch/policy, bounded freshness and no generic signing endpoint | No operational signer, host-only invocation/authentication or protected key installation |

The seven evidence domains are route, retirement, stop, workspace, session,
credential and operator. Inventory and native-decision signing have distinct
additional trust boundaries. Proposed issuer responsibilities are not approved
services or topology. Distinct HMAC keys are necessary contract separation in the
current reviewer, not proof that independent operators or observations exist.
Provider, controller adapter and supervisor assertions cannot self-authorize the
missing runtime/storage facts. No fixtures, SQLite ledgers, kind observers or
structural callbacks may fill these rows in production.

## Exact append and recovery review artifacts

Before any operational append implementation can be approved, supply one review
bundle with: immutable source/image/policy identities; every issuer identity and
protected root distribution; authenticated current-history pins; authoritative
full inventory; one seven-domain bundle per source; ordered decision chains;
operator action approval; and a read-only verifier report naming each unresolved
predicate. Do not include secret credential values. Retain a content-hashed
manifest connecting raw observations to each `evidenceHash` and original owner.

Each append still revalidates complete inventory under its native transaction.
The protected inventory must be observed within 60 seconds and expire within
60 seconds of observation. Domain evidence and decisions have at most one-hour
observation validity; the host returns the shortest deadline and append requires
it to remain future, within the next 60 seconds, and no later than decision
expiry. Locks must not be held while a human reads/signs. Proposed operational
flow: prepare human review outside the transaction, capture fresh authoritative
inventory, then execute bounded verification/append; any inventory/epoch/drain/
sequence change or expiration aborts. No automatic refresh of operator approval
onto changed artifacts is permitted. This production adapter is still missing.

After an ambiguous append response, query the exact immutable source/sequence/
decision hash through a reviewed host inspection path. Confirm committed state
before retry; never replay provider work or blindly advance the sequence. If
commit succeeded but lifecycle scheduling failed, the supported lifecycle sweep
must recover it, with manual holds intact. This inspection path and bounded
adapter timeout/restart acceptance remain operational work. Epoch change makes
old decisions inapplicable: generate new current evidence and review without
rewriting the accepted history or historical receipt.

The existing conservative revoke path also requires seven fresh domain artifacts
and explicit `approvedAction: revoke`; it is not an emergency path when those
artifacts are unavailable. Until a separate supported emergency-revocation design
exists, failure response is independently held dispatch/ownership, preserving
history and occupancy; it does not authorize direct SQL or lifecycle edits.

## Smallest review decisions and disposition

1. Review a separately scoped route/runtime/storage authority design and issuer
   responsibility matrix. No installation is approved; retain held execution if
   any authority cannot establish the required facts under the accepted rules.
2. Commission the protected inventory/reviewer/signer/inspection adapter design
   with exact identity roots, least privilege, deadlines and crash acceptance.
   Do not interpret this document as an authorization to sign or append.
3. Review the manual-migration executor artifact contract and coordinated restore
   domain from [the migration review](legacy-manual-migration-review-2026-10-20.md).
   Publication, maintenance window and live changes require later separate review.

**Implemented:** supported source contracts and this exact operational gap map.
**Verified:** existing source/disposable hosted gates and saved-source join only;
no unchanged expensive checks rerun. **Blocked:** real reconciliation on missing
mandatory retirement/storage/issuer authority. **Open:** protected adapter installation/acceptance,
complete current inventory, real artifacts/operator review and real recovery.
All A/B/shared-family/Gemini/timer/concurrency restrictions remain.

## Protected reviewer adapter implementation — 2026-10-20 continuation

`protected-execution/production/evidence_bridge.py` implements the read-only
host adapter around the existing seven-domain reviewer. It creates no facts,
keys, decision signature, receipt, append or live observation. Default operation
fails held because the protected installation and real artifacts do not exist.
Native integration/installer acceptance is separate; the adapter cannot resolve
the missing runtime or storage authority.

Its only configuration path is `/etc/paperclip/admission/legacy-review.json`.
Every configured file and parent is opened by descriptor without symlink
following and must be root-owned/nonwritable to group/other; no request selects a
path. Config schema is exactly `version:1`, `pins`, `roots`, `inventoryPath`,
`bundlesPath`, `continuityPath`, `inspectionPath`. Pins are `instance`,
`policyHash`, `epoch`, `authorityIncarnation`, `historyDomain`,
`historyIncarnation`, `historyFloor`. The roots mapping has all seven domain
names plus separate `inventory`, `continuity`, `inspection` paths; each root
file is exactly `{key:<64 lowercase hex characters>}` and all ten values must be
distinct. These are required operator-installed inputs, not supplied real keys.
A protected path establishes input custody, not independent physical truth.

The fixed-module stdin request is exactly `{operation:"review", decision,
holds, inventoryHash, now, challenge}`. `holds` is the full native transaction
inventory projected to existing reviewer `BINDINGS`: original source/holdHash/
company/agent/run/lease/environment/exact ordered scopes/policyHash/epoch.
Native integration computes holdHash with its existing fingerprint routine;
Python never invents or normalizes native hold scopes. The adapter compares the
complete protected binding inventory sorted by source and independently checks
the native sorted source/holdHash inventory fingerprint. Unknown/run-only/invalid
UUID identities, duplicates, mismatched policy/epoch, subsets or changed scope
order fail held. There is no seven-scope substitution.

A separately authenticated continuity envelope must bind the exact fresh native
64-hex challenge, native inventory hash, configured authority/history identities
and current history revision at least the protected floor. Its body has exactly
`kind:"legacy-authority-continuity-v1"`, `pins`, `historyRevision`, `challenge`,
`inventoryHash`, `observedAt`, `expiresAt`; authentication is HMAC-SHA256 over
`paperclip-legacy-bridge-v1` + NUL + `continuity` + NUL + canonical JSON body.
The per-challenge issuer does not exist yet. Restoring an old configuration/file
set cannot answer a fresh challenge; it must never be treated as a new current
history authority. Continuity and inventory are at most 60 seconds old with at
most 60-second observation lifetime. Supplied native time must also match the
host wall clock within one second; final expiry remains rechecked by native
append. Clock/issuer unavailability keeps starts and decisions held.

All seven authenticated artifacts for every authoritative hold, exact operator
action and complete bundle remain mandatory through the existing reviewer.
Success returns exactly `decisionHash`, `inventoryHash`, `expiresAt`, `challenge`,
`operationalAcceptance:false`. The deadline is the shortest independent evidence,
inventory, decision and continuity deadline. One successful review does not
authorize a signature or append by this process.

Read-only inspection accepts exactly `{operation:"inspect", source, sequence,
decisionHash, now, challenge}` and requires a separate authenticated inspection
artifact binding the exact requested decision/current pins/fresh challenge and
current history. Its body has exactly `kind:"legacy-decision-inspection-v1"`,
`pins`, `historyRevision`, `source`, `sequence`, `decisionHash`, `status`,
`challenge`, `observedAt`, `expiresAt`, with the same bridge HMAC prefix and
`inspection` domain. Only `status:"committed-exact"` returns that read-only
confirmation plus exact source/sequence/hash/challenge/expiry and
`operationalAcceptance:false`. Missing, unknown, not-found or conflicting
observations remain held. There is no safe-to-retry permission, signature,
sequence advancement, provider replay or lifecycle edit. The independent
inspection issuer and native inspection integration still need implementation.

Inputs/files are bounded to 2 MiB, 256 holds, depth 32, 50,000 values, safe
integers and exact field sets; duplicate JSON keys, nonfinite/fractional numbers
and oversized strings refuse. The native caller must enforce aggregate process
time/output bounds and a fixed protected interpreter/module tree with no shell,
ambient paths or provider environment. Main returns only redacted held errors.
Synthetic tests supply test-only protected-file mocks and authenticated fake
observations; they establish adapter behavior, never any original A fact.

The existing reviewer uses symmetric HMACs. A process that can read a verification
root can also mint that domain's MAC: protected root-owned files alone do not
prove independent issuer custody. A Python child under the controller's UID is
process isolation only and cannot manufacture a separate trusted-host boundary.
No operational key mounting/distribution is approved by this component. The
installer review must establish a separately protected reviewer/issuer trust
boundary (or separately design public-key verification) and demonstrate that
controller/provider/transport identities cannot issue each other's facts. All
per-challenge continuity and inspection issuance remains external and absent.

## Supported loader and remaining integration boundaries

`python -m production.evidence_bridge` is a development entry point, not the
supported protected native loader. The native `legacyEvidenceBridge` wrapper
validates root-owned/nonwritable interpreter/module ancestry and compiles only
the two verified `legacy_review.py` and `production/evidence_bridge.py` source
files directly in isolated Python. It ignores project import caches/package
initializers; `-B` alone would prevent writes but still permit reading existing
bytecode. This source-only loader behavior is verified separately from real
artifact issuance or independent key custody. Source files and trusted interpreter
still need the reviewed protected installation and immutable image/source pins.

The per-request continuity challenge is generated by the native wrapper, so an
old static file bundle cannot satisfy it. A real issuer/request channel must
receive that exact challenge and current native inventory binding, obtain its
own current authority evidence and atomically publish an authenticated response
before the bounded callback ends. The current adapter supplies none of that
issuance/channel machinery. The independent complete-inventory snapshot issuer
must also bind the exact transaction inventory without attempting to acquire the
same exclusive append lock synchronously and deadlocking the callback. Its
read-only database identity, complete query scope, current snapshot semantics,
challenge transport, atomic publication and outage behavior need implementation
and assembled verification. Domain artifact custody and human approval cannot be
replaced with a caller-generated snapshot or an automatic fresh signature.

The native append caller/signer remains absent. It needs a protected fixed-target
invocation surface binding Paperclip DB identity, current policy/epoch/drain,
complete inventory, decision sequence/previousHash and separate native-decision
signature after full operator review. It must never expose a generic signing
endpoint, direct lifecycle edit or filtered B-only append. The current Python
`inspect` operation requires a separate signed legacy-decision observation;
stream-ticket `/v1/stdin/inspect` confirms consumption history only and cannot
confirm an A reconciliation decision. Native integration for exact legacy
source/sequence/hash inspection, ambiguous commit recovery and coordinator sweep
acceptance remains open.

The saved ten lease sources can use the existing supported append boundary only
after their real complete binding/evidence requirements pass. If fresh inventory
finds `run:` sources, null/unmapped identities or conflicting native relations,
retain the original rows and global/shared occupancy. A separately reviewed
source-kind resolution API would be required; no synthetic lease, inferred UUID,
row rewrite, scope rekey or inventory omission is allowed. Do not broaden the
lease-only schema speculatively to fit unknown facts. Assembled acceptance must
prove both complete supported-source reconciliation and unchanged occupancy for
unsupported sources before any operational use is considered.

## Complete operator inventory binding — implemented correction

The protected bridge now requires every authoritative hold's authenticated
operator artifact to include `approvedInventoryHash` equal to the exact current
native sorted source/holdHash inventory fingerprint. Per-source approval alone
cannot be combined with a changed sibling inventory. Existing domain MAC,
explicit action and six-artifact hash checks still run; `legacy_review.py` is
unchanged. Missing/wrong full-inventory approval fails held before append.

A fresh inventory timestamp/expiry and per-request continuity challenge can be
issued without reapproving only when the semantic inventory hash, original
bindings, epoch/policy, six domain hashes, exact approvedDecision intent and
existing unexpired operator action approval are unchanged. Changing any of those facts requires new explicit
operator consent and its authenticated artifact; the adapter never signs or
refreshes approval. The earlier twenty-case synthetic evidence run passes, including a
changed sibling with valid refreshed sibling evidence that still cannot reuse
the selected source's old full-inventory approval. See
[evidence activation sequencing](evidence-activation-sequence-2026-10-20.md).

## Exact append-intent approval — implemented correction

Every original hold's authenticated operator body must additionally include
`approvedDecision:{sequence,previousHash}` matching that source bundle's exact
native decision intent. The object has exactly those two fields; sequence is a
positive safe integer and previousHash is null or the exact prior decision hash.
This nonrecursive intent can be approved before the final operator artifact hash
is placed in the signed decision. It supplements full `approvedInventoryHash`,
explicit action, original bindings and all six domain hashes.

Native sequence CAS alone orders decisions but does not express renewed human
consent. The hold inventory excludes decision-chain rows, so an unexpired old
reconcile approval could previously be reused in a newly enveloped reconcile3
after explicit revoke2 while the same original hold inventory remained. The new
bridge refuses that changed intent for every source; revocation cannot be undone
by refreshing a decision envelope around old human approval. New explicit exact
intent approval is required even when all domain facts/inventory are unchanged.
No old approval/artifact/receipt is rewritten by this correction.

The targeted synthetic regression first demonstrated acceptance of the stale
reconcile approval before the fix (`ReviewHeld not raised`), then the complete
22-case evidence suite passed with the fix. It models separately authenticated
reconcile1/revoke2/reconcile3 intent without a real signature issuer, database
append or lifecycle mutation. `legacy_review.py` and native schemas are unchanged;
the protected bridge enforces this additional approval requirement.

## Restore limit of operator-intent binding

The 22-case consent correction proves exact append-intent binding with intact
native CAS. It does not protect restored accepted/revoked decision history.
`legacyHoldIsReconciled` currently uses the latest local accepted decision; a
snapshot restored before revoke2 could resurrect reconcile1 without any new
append. Real continuity must retain original per-source decision/revocation
history independently and authenticate each native use of accepted facts after
restore. A stronger signed append artifact alone cannot protect that use path.
No real current issuer/backend is installed and all operational starts remain
held. The [sequence proposal](evidence-activation-sequence-2026-10-20.md) lists
concrete authority protocol, all-caller integration and assembled restore
rehearsals needed before any rollback-safety claim. No added placeholder field,
SQLite observer or matching restored hash is credited as implemented protection.

## Independent accepted/revoked history verification component

`protected-execution/production/decision_history.py` adds a fail-closed **read-only
protocol component**, with 12 targeted synthetic cases in
`test_decision_history.py`. No production issuer, transport, key custody, ledger,
signer or native use-side protection is installed. The existing protected bridge
JSON contract/source-only native loader remains unchanged; it does not load this
new module or acquire stronger continuity by its presence.

`build_use_request` requires one locally accepted decision reference for every
original hold supplied by the trusted native full-inventory boundary. Its sorted
closure binds each exact original `BINDINGS` row and
`{source,holdHash,sequence,decisionHash}`. It preserves historical policy, epoch
and ordered scopes rather than overwriting them with current policy or new
reservation scopes. Unsupported run-only/null-identity sources refuse. The
independent issuer must discover and compare the complete inventory itself;
validating a well-formed requester subset cannot establish completeness.

`CurrentHistoryIssuer.observe` defines the absent request-channel responsibility:
retain current per-source accepted/revoked decisions and prospective/uncertain
intents outside Paperclip database/files rollback. `ProtectedSignatureVerifier`
is a verify-only interface taking a protected public-verification key handle,
canonical domain-separated message and signature. It exposes no raw secret/MAC,
signing method or caller-selected key/path. Actual algorithm/library, protected
public-key distribution, retired-key denial, issuer signing-key custody and
security placement remain unselected. Constructor pins must come from protected
installation, never response echoes. Distinct file paths or UIDs alone cannot
prove the required custody. Absent pins/verifier and unavailable verification
fail held; tests use fake signature identity matching, not cryptographic evidence.

The response is bound to the exact request digest (fresh native challenge,
current-use purpose, complete semantic closure and time), pinned independent
history incarnation and minimum revision. Each independently latest source must
be `committed-exact/reconcile` at the exact local accepted sequence/hash/hold.
A retained revoke, external-ahead decision, conflict, unknown/prospective intent,
missing/duplicate source, incomplete closure, changed authority/key identity or
expired response refuses. `intentHash` records the issuer's retained latest
intent reference; it is structurally validated, not compared against a separate
local append-intent record. This component does not reserve/consume append
intents or resolve uncertain local/external commits.

Success returns only `CurrentHistoryObservation(request_hash,history_revision,
expires_at)`. It has no authorization flag, reusable permit or effect callback.
It **cannot** make `legacyHoldIsReconciled` safe on its own: native per-use
integration and a mandatory independently ordered use/revocation boundary remain
absent. An unchanged request can be verified twice as an observation; no replay
consumption is claimed. A short TTL or fresh signature does not prevent a revoke
between observation and effect. Runtime/storage authorities remain independently
required. The protocol has no synchronous backend invocation; any future issuer
transport needs cancellable owned operations/workers and bounded parsing/output,
not only socket timeouts.

The targeted tests hold restored local reconcile1 against retained revoke2 for
both admission/lifecycle purpose bindings **without another append**, plus
external-ahead history, uncertain intents, sibling omission and cryptographic
interface failure. They test only verifier behavior with synthetic retained
state. They are not actual native admission/lifecycle restore rehearsals,
cryptographic acceptance, independent storage recovery or operational A evidence.
No unchanged hosted/native/image suite was repeated for this independent module.
