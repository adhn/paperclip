# Custody and native effects: concrete implementation and blocking proposal

Inactive source only. No issuer, keys, history service, trust bundle, dependency,
native transaction executor or topology is installed. Original A/shared Codex
holds, B pause, Gemini deferral and disabled timers remain. Claude owns all
backup/recovery preparation; this proposal does not edit its files or select its
backup destinations, schedules, credentials, restore procedure or acceptance.

## Implemented increment

`protected-execution/production/custody_service.py` implements the previously
abstract verify-only primitive using Ed25519 and `cryptography`. It exposes no
signing method, private-key input, caller-selected path or algorithm downgrade.
The sole trust path is `/etc/paperclip/admission/ed25519-trust.json`, read through
the existing root-owned/nonwritable, no-symlink ancestry reader. Each public key
has a handle `ed25519:` followed by SHA-256 of its raw 32 public bytes. Every
bundle entry must match that fingerprint; duplicates and malformed entries hold.
Only active entries verify. Every call reloads the bundle so installed retirement
is effective for subsequent verification on the same verifier instance.

The exact bundle is `{version:1,keys:[{handle,publicKey,status}]}`: publicKey is
64 lowercase hex characters, status is `active` or `retired`, at most 64 entries.
There is no default trust, auto-provisioning or auto-rotation. Signatures are
canonical padded Base64 of exactly 64 bytes. Messages are bounded to 2 MiB and
restricted to the existing history, prospective-inspection and ordered-effect
domains. A cryptographically invalid signature returns false; missing trust,
malformed input or unavailable crypto fails held. Dependency remains lazy and
uninstalled in production. Root's disposable host version is cryptography 46.0.5;
the verify API is documented by the [upstream Ed25519 reference](https://cryptography.io/en/50.0.2/hazmat/primitives/asymmetric/ed25519/).

`test_custody_service.py` uses real disposable asymmetric keys/signatures to test
verification, tampering, wrong signer, unknown handles, installed retirement,
strict signature framing, domain/size bounds and malformed/unavailable trust.
It mocks protected bundle acquisition; it does not prove a protected installation
or generate operational receipts. Root records the executed count/result and
hosted dependency scope. No previous native/image pass needs rerunning for this
standalone source increment. No production input changes are required by it.

This closes an actual cryptographic primitive gap only. A public bundle reader
does not establish issuer custody, bundle rollback resistance, independent current
history, complete inventory discovery or native use/revocation ordering. No code
loads this new primitive through the current native evidence bridge. Existing
HMAC-domain review remains unchanged; substituting this verifier there without
an issuer/domain migration would be incorrect. Observation/completion signatures
remain historical evidence and never authorize later effects.

## Exact proposed placement, pending topology/backend decision

Use one dedicated authority service, with its own protected service identity and
signing key, outside Paperclip controller/runner credentials and rollback domain.
Its history must live in a separately administered PostgreSQL database whose
generation/floor cannot be restored with Paperclip DB/files. Reusing the existing
CNPG infrastructure is only feasible if administrative/restore independence is
proved; a second schema or matching backup is insufficient. No new PostgreSQL
cluster or external provider is selected or authorized by this document.

The authority alone may access the non-exported signer. Controller, transport,
provider and runner identities get public verification and exact typed mTLS
request access only. A fixed protected trust bundle pins the independent service
incarnation and public fingerprint; retirement of old keys must be monotone in
an independently administered installer policy. Distribution must refuse absent,
stale or restored bundles. This component's root-owned reader cannot implement
that monotonic installation or resist root/restore-domain compromise.

Use a dedicated native database role and typed native transaction executor owned
by the authority for admission and lifecycle commits. Controller/provider roles
must lose every equivalent direct write route. The executor must implement the
existing native transaction's full predicates and original hold/scope closure,
not call a boolean reconciliation check then mutate later. This role/grant change
and all caller rewiring are prerequisite source/integration work; no grants or
database schema changes are performed here.

The service must independently obtain the exact complete original native hold
inventory using a read-only identity, preserving unsupported source holds. It
must obtain domain facts from their real runtime/storage/session/credential
authorities and separate human consent binding full inventory plus exact
sequence/previous hash. It must not sign caller facts, refresh operator approval,
trust requester omission, infer missing UUIDs, rekey scopes or invent receipts.

## Ordered protocol and required proof obligations

1. Retain complete original holds, immutable source bindings, service/native DB
   incarnation, monotone history revision and every prospective append/use intent
   before dispatch. Never initialize empty history when opening missing storage.
   Retain exact typed request/effect ID, predecessor vector, full inventory hash
   and native transaction hash. Duplicate IDs inspect exact retained state and
   never resubmit a native effect.
2. Serialize admission/lifecycle effect ownership and revocation by the complete
   shared source closure, using database-backed service ownership, not Python
   locks. Keep ownership through the native commit outcome. Record native intent
   ID and effect hash atomically in the same native transaction as its changes.
   A lost response is unresolved until exact journal inspection; it never grants
   replay, capacity release or another writer. Native transaction uniqueness must
   survive normal retries; native rollback requires independent service fencing.
3. Revoke first durably records deny intent in independent history. Block every
   new overlapping effect, settle all already submitted native transactions by
   exact journal inspection and account for authority process loss and partitions.
   An uninspectable native transaction keeps revoke unsettled and occupancy held.
   Only completed settlement may record revoked completion. Native lifecycle
   changes must obey the same ordering and existing cleanup semantics; direct
   edits and retrospective completion flags are forbidden.
4. On authority restart, acquire an exclusive backend ownership generation and
   reconcile every uncertain intent before opening use. A stale service process
   and restored native DB must be unable to commit using the old generation.
   A signed generation check before a later native effect is insufficient. The
   selected native transaction backend must atomically compare current generation
   at commit, or the physical native writer must be exclusively revoked first.
   This cross-domain fencing mechanism is unresolved and blocks implementation
   of the claimed authority, rather than being replaced with a callback.
5. Prove every native admission/lifecycle caller uses the executor and no old
   local accepted decision resurrects effects after a restore. Exercise actual
   serializable commits, cancel-before-submit, revoke-during-commit, lost replies,
   authority crash, native rollback, stale former authority connection and
   unsupported original-source occupancy. Disposable tests may establish source
   behavior only; installation/custody and operational acceptance need separate
   evidence and authorization. Coordinate recovery obligations with Claude's
   preparation; this proposal does not claim a restore rehearsal.

## Exact blocking boundaries

The linked [ordered integration review](ORDERED-AUTHORITY-INTEGRATION.md) names
`execution-legacy-reconciliation.ts:legacyHoldIsReconciled`,
`execution-admission.ts` historical-hold/claim transaction and
`agent-execution-stop.ts:reconciledLeases`. They still use local history predicates.
`production/decision_use.py:OrderedDecisionAuthority` remains a protocol;
`retained_decision_store.py` is local SQLite durability without independent
rollback exclusion. Its prospective intent does not create service custody.

Remaining decisions are: independent history administrative/restore placement;
signer/installer identities and non-exportability; complete native DB role and
all-writer exclusion; and a commit-time cross-domain generation fence that
survives service/native rollback and stale connections. These require a reviewed
topology/backend selection. No safe operational authority implementation can be
claimed before those inputs exist. The proposed PostgreSQL service is a concrete
candidate with explicit unresolved obligations, not an installed backend.

| Daily-use gate | Status | Exact next dependency |
| --- | --- | --- |
| Public signature verification | Implemented; disposable verification recorded by root | Protected bundle/dependency installation and pinned native loading |
| Real fact/consent issuer and key custody | Blocked | Selected protected placement, real domain sources, separate human consent and signer identity |
| Independently retained current history | Blocked | Selected independent admin/restore domain and monotone generations; existing local SQLite is insufficient |
| Ordered native admission/lifecycle/revoke | Blocked | Sole native writer role, mandatory caller rewiring, commit-time cross-domain fence and exact uncertain-transaction settlement |
| Operational acceptance/everyday use | Open/held | Installed reviewed authorities plus complete shared original hold resolution and remaining acceptance/recovery gates |
