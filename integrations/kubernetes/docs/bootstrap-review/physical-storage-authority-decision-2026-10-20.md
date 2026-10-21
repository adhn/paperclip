# Physical canonical storage authority: decision for review

Proposal only. No storage topology, authority installation, live inspection,
provider dispatch or hold release is authorized. Non-root workload rules remain.
This document uses the saved 2026-10-19 attestation and held policy; observations
must be reverified before any future rollout. No executable policy is minted.

## Smallest decision

Commission a bounded design and disposable rehearsal for **one** independently
protected canonical-storage owner and its exact physical exclusion backend.
Select the model only after the storage/CSI facts below are available. The design
must demonstrate that providers cannot mount or overwrite canonical state; every
transition binds the original owner, exact physical storage incarnation, complete
root contract and current monotonic history. Missing physical or runtime evidence
keeps the transition held. Choosing a model does not approve deployment, a node
change, privileged workload, runtime socket, extra database cluster or new scope
families.

The existing external PostgreSQL choice remains. Any proposed durable history
service must explain how its current authority survives a Paperclip-only
DB/files/PVC rollback. A second PostgreSQL cluster is not proposed or required.

## Saved physical and logical anchors

The saved cluster/namespace identities and full logical families are in
`held-policy.json` and `docs/evaluation/trusted-attestation-2026-10-19.md` in the
Paperclip workspace. The controller PVC UID is
`8b058100-96b3-4a77-b90a-d7dec2939f40`; Codex runner PVC UID is
`7b9bf09b-83f3-4254-a499-ee1ff419b4b9`; Claude runner PVC UID is
`9cde2513-319c-43a5-bd46-0f387dad743f`. Saved volumes are Longhorn ext4; all four
PV reclaim policies are `Delete`. These are historical observations, not proof
of current ownership or an authorization to delete/rebind claims. Gemini's saved
physical mapping establishes no authenticated credential/state contract.

Keep the original instance, runner, account, workspace, session and credential
family strings byte-for-byte through any migration. New claim names, Pod UIDs,
mount aliases, snapshots or transfer paths are new **physical incarnations**, not
new logical account/state families. Both A holds and B share the original Codex
families; B cannot get a distinct key to bypass them. An immutable migration
record must link old and new physical realizations to the same original families
and retained historical run/lease facts.

The root contract must cover every independently restored destination, rather
than treating a runner PVC as the entire state unit:

| State | Saved roots that require an explicit owner/version mapping |
| --- | --- |
| Codex credential | Controller `/paperclip/.codex/auth.json`, company `codex-home/auth.json` fixed alias, company auth-cache copy, runner `/home/node/.codex/auth.json`, every effective staged `.../.paperclip-runtime/codex/home/auth.json` |
| Codex session | Every staged `.../codex/home/sessions` transcript and exact native resume target; absent canonical/default-home stores must be classified, never silently invented as existing evidence |
| Workspace | Controller isolated-workspace source/copy-back root and its exact remote `/home/node/workspaces/.paperclip-runtime/runs/<run>/workspace` realization, including uncommitted/unpushed work |
| Claude state | Both `/home/node/.claude` and `/home/node/.claude.json`, `.claude/.credentials.json`, encoded-cwd transcripts and any staged/restored copies |
| Fixed aliases/projections | Exact symlink target and containing storage; nested roots share one physical/version CAS unit so a parent-tree replacement cannot bypass a child credential conflict |

The candidate schema names nine Codex and six Claude root roles. Those schemas
are validation requirements, not accepted realpath mappings. Effective roots,
mode/ownership, storage UID/incarnation, configuration fingerprint and resume
identity remain inputs. No credential contents are needed for this review.
External laptop/phone account consumption and refresh writers remain outside a
cluster-only file lock; preserve credential exclusivity until their relationship
is independently resolved.

## Concrete models for design comparison

| Candidate model | Narrow authority and non-root placement | Proof still required before it can be selected |
| --- | --- | --- |
| Sole canonical owner with detached attempt copies | A trusted non-root storage/transfer service is the only workload allowed to mount/write canonical roots. Disposable provider Pods receive only isolated attempt copies. Host-controlled API/RBAC/admission admits exact transfer/provider configurations; no provider receives storage-controller credentials. A UID-1000 trusted transfer Pod can preserve existing UID-1000 file ownership; supervisor UID 2000 receives no silent chown authority. | Prove every old canonical mount/writer excluded, all controller caches/copy-back writers use the owner, untrusted attempt writers cannot reach canonical bytes, transfer mount lifetime is enforced, and physical attempt retirement precedes restoration. A path or namespace label alone is not this boundary. |
| Backend-enforced exact-incarnation reservations | A separately protected service uses a documented storage/backend fencing mechanism that rejects stale access to the exact volume incarnation. Non-root workloads receive only bounded operation capabilities; generic CSI/storage credentials remain outside them. Canonical activation and release use backend acknowledgement plus current history CAS. | Identify a supported backend operation and evidence that old node/mount/open-I/O paths cannot regain writes after its barrier, including partition/restart/force-detach. A PVC access-mode field, attachment object deletion or read-only mount declaration is insufficient without that proof. No such Longhorn/CSI mechanism is asserted here. |
| Continue held/offline preparation | Preserve current families and holds; develop contracts, reviewer and clone fixtures without enabling any canonical transition or provider launch. | This offers no online ownership guarantee and cannot satisfy rollout. It is the safe remaining state if neither enforcement model can meet the accepted non-root/topology constraints. |

These are review alternatives, not approved implementations. Existing runtime
retirement is an independent dependency in both online models. Even a storage
backend that prevents future writes does not itself prove provider/descendant
termination or safe credential reuse. Conversely, stopping one sandbox does not
prove exclusive storage access or correct restoration.

## Required transaction and authenticated evidence

One protected authority owns the complete storage set for the original family.
Each immutable operation binds company/agent/run-or-operation/environment/lease/
attempt/invocation, original seven scopes, policy/epoch/config hash, canonical
incarnation/generation/hash, every physical volume/attachment/mount incarnation,
source versions, phase and fresh challenge. Verify identities from independent
current authority; never trust a provider-supplied `detached` boolean or observer
fixture as evidence.

| Transition | Authority predicate and durable effect |
| --- | --- |
| Import original state | Reviewed old routes and writers fenced; exact complete storage/root set authenticated; immutable imported bytes and original-owner mapping retained |
| Stage | Current canonical version/high-water and exclusive transfer ownership; one attempt consumes the original owner; crash retains occupancy rather than restaging/replaying |
| Handoff | Transfer no longer writes; exactly admitted provider incarnation owns only its attempt bytes; later attach gets no launch/replacement/stdin-writer permission |
| Restore | Independently verified stable retirement plus physical exclusion for every old attempt writer before reading returned state; workspace/session/credential results and divergence quarantine stay independent |
| Canonical activation | CAS the full affected alias/projection group against original source versions; retain newer credentials; atomically record immutable new heads and operation/history binding |
| Native release | Existing native transaction combines verified retirement, every restoration result and independently current exact storage-release evidence; command success alone cannot release |
| Recovery/adoption | Inspect immutable original owner/history only; no fresh empty pool, new family, provider body replay or adoption by epoch change. Uncertain physical state remains occupied |

A content hash proves byte identity, not current storage exclusion. Repeated
empty listings, a quiet interval, Kubernetes object absence and successful
original-sandbox stop do not create physical retirement authority.

## History and rollback independence

The durable canonical high-water must be retained in a separately protected
restore domain. Record an independent intent/pin for the exact prospective
canonical transition **before** its local commit, or use an equivalently proved
durable intent/commit protocol. Otherwise local commit followed by failed
external pin can forget a transition when the old canonical snapshot is restored.
An external-ahead/local-old result must hold; never reset the pin to recover
availability. Native/authority receipt pins and consumption/retirement tombstones
must obey the same current-history rule.

No Paperclip image/PVC rollback may restore this external history alongside the
canonical snapshot. A separately scoped store in existing infrastructure is only
a candidate until backup/restore ownership, current-history survival, independent
identity pins and failure domains are demonstrated. Restoring both matching old
snapshots is not evidence that no later execution or credential update occurred.
Loss, rollback, unknown authority incarnation or conflicting history holds every
affected original family pending separate reviewed physical recovery.

## Exact unresolved proof obligations

| Obligation | Evidence required | Status |
| --- | --- | --- |
| Complete physical ownership | Current PVC/PV/backend volume IDs, attachments/mount holders, node/runtime incarnations and all writer paths mapped to original families | Saved mapping only; fresh authoritative inventory absent |
| Exclusive detach/barrier | Documented backend acknowledgement covers stale nodes, open file handles, partitions and replacement mounts; negative stale-writer tests | No production backend selected |
| Canonical CAS/aliases | Full root/projection group transaction, source-version mismatch quarantine, symlink/alias activation exclusion and crash durability | Candidate content/CAS fixtures; physical activation backend absent |
| Current high-water | Prospective-transition pin survives controller, canonical and runtime rollback; ahead/conflict/loss holds | Candidate durable ledger protocol; operational independent restore domain absent |
| Runtime retirement | Every future same-UID sandbox/container start excluded, all pre-barrier executions accounted for, exact history pinned | No approved runtime authority; fail-closed hooks only |
| Refresh/version safety | All copied/cached credential writers, provider grant relation and external writer coordination; newer versions cannot be overwritten | Laptop active; grant/writer relation unresolved |
| Owner preservation | Old/new physical migration record keeps original families and both A/shared holds, with no replacement/B exemption | Required by held policy and native contracts; real migration not performed |
| Operational recovery | Coordinated real backup/restore, separately current fence history and measured one-hour/four-hour target | Synthetic clone success cannot satisfy this; operational gate open |

## Information needed for the next design review

Obtain operator-approved, read-only facts in a separate authorized inventory:
exact CSI/storage backend and versions; StorageClass/provisioner parameters and
access modes; backend volume and attachment identities; mount/reattach and
force-detach semantics; where old node I/O is rejected; writer enumeration and
UID ownership; snapshot/clone/flush/fsync/crash guarantees; and which APIs produce
independently authenticated fresh evidence rather than cached desired state.
Document credential scope/RBAC for each proposed control API without granting it
to provider or supervisor Pods.

Identify the operator for the independent current-history store, its identity/
key protection, restore-exclusion boundary, current backup/recovery policy and
how native pins survive its loss or rollback. Enumerate controller, runner,
cache/staged and external auth writers without collecting secret values. Provide
canonical realpath/mode/root/projection/config mappings and which old/new physical
volumes each operation touches. Review expected failure behavior before choosing
an online model. No live migration, claim deletion, forced detach or provider
experiment is requested by this document.

## Concrete transaction follow-up, 2026-10-20

The bounded next decision is to **commission comparison/rehearsal**, not select
or install a storage service: test a sole protected canonical owner with detached
attempt copies against a documented backend-enforced stale-I/O reservation. Keep
the held/offline model if neither can prove exclusion under the non-root rules.
No claim, attachment, PV or scope-family change is authorized by this proposal.

The [production transport/storage follow-up](../production-transport-storage-2026-10-20.md)
now gives the exact prospective pin/CAS/activation sequence and proposed native
consume/open/close contracts. Its new mTLS control client does not implement
physical authority, streaming execution or a server. The complete original alias
and root group is one CAS unit. A parent replacement cannot bypass a child's
credential generation; cross-PVC operations require a protected atomic-head
protocol or remain held. Partial restoration results stay independent, and newer
credential refresh versions must survive workspace/session failure.

Prospective transition pins live in a protected restore domain outside the
Paperclip database/canonical-file rollback set. Existing external PostgreSQL may
host a separately operated domain, but schema separation alone is insufficient:
its restore permissions, rollback exclusion, independently pinned service identity
and recovery operator must be explicit. Do not assume another cluster or new
scope families. External-ahead/local-old and commit-with-lost-completion are held
states resolved by immutable-intent/head inspection, never by lowering history.

Retirement requires completed barrier **B**, not deny-intent **T**. Starts forwarded
before T can still create a sandbox after T; all such effects must be settled,
attributed and stopped before B. Native and storage must independently consume
the full current B receipt bound to the original owner, journal, roots, all
runtime/node/boot aliases, T/B sequences, stop evidence and challenge. Merely
observing a runtime tombstone, one stopped sandbox or a quiet volume is insufficient.
Missing either completed runtime authority or physical exclusion retains writer,
storage and native occupancy; stream cleanup must close only.

The 15 new lightweight control-client cases validate bindings, ordering, protocol
refusals, uncertain response behavior and redacted errors with synthetic/mocked
endpoints. They do not provide current physical inventory, native server
consumption, an independent high-water domain, detached-I/O acceptance or a
production authority. Prior hosted physical ACK/storage were synthetic; those
passing fixtures are preserved and are not blindly repeated or upgraded into
operational evidence. All unresolved obligations above remain open.

## Ordered byte effect and root-group interface follow-up

The source-only `production/write_authority.py` adds mandatory backend contracts
for exact byte commit, ordered revoke, original-operation inspection, prospective
root-group pin and full-group CAS activation. The write intent binds operation,
complete owner/command/physical binding hash, root group, sequence, byte hash and
exact native/runtime/storage/accepted-decision revisions. `OrderedWriteAuthority`
consumes a local attempt before invoking the backend and rejects partial, late
or uncertain replies. Its local lock prevents accidental local replay only.
The backend must retain durable attempt ownership across worker restart and must
serialize every current predicate with the actual effect. Proof/check followed by
an unguarded write does not implement this contract.

`RootGroupIntent` carries original family, physical exclusion and completed
retirement record hashes plus sorted complete expected/proposed heads. Strict
successor generations and unchanged root membership prevent an omitted child in
a submitted group. The actual backend must independently require the complete
authoritative group: matching caller lists cannot prove completeness. The pin
must live outside canonical/controller rollback and precede the atomic head
switch. Inspection after loss observes original immutable intent/heads without
retry, adoption or release. Physical exclusion/retirement hashes name evidence;
they do not themselves authenticate it or prove its freshness.

Fourteen synthetic contracts cover exact bytes, revision rejection, revoke order,
uncertain reply inspection, replay refusal, invalid deadlines, missing backend,
prospective pin order, complete group shape, generation rollback and CAS conflict.
Root-coordinated bounded verification must record the actual result separately.
These tests use in-memory reference backends, which cannot prove distributed
atomicity, crash durability, independent key custody, physical stale-I/O exclusion
or real high-water survival. No physical adapter, runtime broker, independent
history deployment or native all-command integration is installed. Selecting and
verifying a backend capable of the required effect boundary remains blocked;
activation and every original/shared-family hold remain unchanged.
