# Sole canonical owner and detached attempts — design and filesystem prototype

Proposed for review, not an approved topology or installed storage authority.
`detached_group_fixture.py` actually copies synthetic files, retains independent
inodes, fsyncs version content and atomically replaces one local full-group HEAD.
It is a disposable local prototype, never a production backend or receipt issuer.

## Concrete ownership choice proposed

Give one protected canonical owner the only canonical filesystem mounts. Provider
workloads receive independent copied attempt volumes, never canonical mounts,
subpaths, bind aliases, hardlinks, symlink paths, inherited file descriptors or
storage credentials. A protected transfer component reads detached attempt bytes
and creates a new immutable version under the canonical owner. Provider retirement
is still necessary for runtime/account safety, but isolation means a retained
attempt descriptor does not grant a descriptor to the newly published canonical
inode. Application lock files, Pod labels and Longhorn attachment metadata do not
provide this separation. No provider can directly operate the owner service.

The complete root group includes workspace/Git state, session state and every
effective credential/config/cache root including controller staging/copy-back.
Actual paths/aliases must come from a reviewed complete inventory, not the three
synthetic root labels in this fixture. One generation and one head name the entire
group; do not publish independent per-root pointers. Account/provider grants can
outlive copied files, so their external renewal/revocation authority remains a
separate obligation. Provider output always enters detached staging first.

Suggested real operation sequence:

1. Authority-owned transaction records prospective original operation, complete
   root set, expected generation/head/storage incarnation, account/credential
   family, original holds and immutable attempt identity before exposing a writer.
   Independent current high-water/history must agree at every effect, not merely
   at bootstrap. Preserve uncertain operations and occupancy if agreement fails.
2. Export exact canonical version into independent attempt storage. Review transfer
   treatment for file modes, executable bits, sparse data, directories, Git locks,
   symlinks and references. A provider cannot address canonical roots by alternate
   path or credential. Workload mounting/admission and owner API authentication
   must enforce that property outside provider permissions.
3. On completion/cancel/disconnect establish exact original attempt outcome before
   capturing. Either quiesce writers independently or capture an actual immutable
   snapshot; before/after byte comparison alone is not a coherent snapshot under
   adversarial writes. Validate complete group, content/metadata and no external
   references. Credential/session outcome must be consistent with real renewal.
4. Persist bytes and manifest in a fresh version, fsync required storage boundaries,
   then commit the independent authority/native/root-head common decision. Expose
   the new head only with exact predecessor, incarnation and generation CAS. The
   production cross-domain atomic protocol remains unresolved; a local rename
   cannot stand in for it. Do not issue a permit for a later caller-owned write.
5. Lost replies are inspected by original intent, exact bytes and current independent
   history. A completed newer head makes an older version historical, not reusable.
   Restore of owner/database/history snapshots holds until a separately current
   authority rules out rollback/replay. No head rewind or retry by fresh identity.

## Actual executable fixture

From the evaluation package:

```sh
python3 -B -m unittest discover -s protected-execution -p test_detached_group_fixture.py -v
```

All data lives under `tempfile.TemporaryDirectory`. Eight stdlib unit methods PASS
in0.065s. No process, network, database, container, provider or canonical source is
used. Tests exercise:

- Retain an **open writable attempt descriptor** through prepare/publication, then
  write/fsync through it. The current canonical bytes remain unchanged and inode
  identity differs. This is real local filesystem behavior, not a mocked fence.
- Build successive whole-group versions. Readers select exactly one HEAD version;
  all three roots change together and previous version bytes remain independent.
- Inject exceptions after durable version preparation/before HEAD replacement and
  after durable replacement/before reply. Exact inspect identifies current versus
  not-current; repeated activation of committed intent fails predecessor CAS.
- Reject missing roots, stale predecessor/contenders, symlinks and hardlinks;
  detect deliberately mutated version bytes before activation; refuse implicit
  reprovision and version-path traversal.

`prepare` uses independent file creation/copy, not links. It records directory and
file byte inventories, including empty directories; file sizes and SHA256 bind
content. `activate` serializes local processes through flock, checks exact original
predecessor and publishes one JSON head with atomic same-filesystem rename and
parent fsync. Content modes are made read-only as an immutability **model**.
`inspect` checks exact stored inventory and reports only `current`/`not-current`
and `operational_authority:false`. Not-current never means never-committed: a
version can have been superseded. Inspection creates no release or stop receipt.
Prepared/orphan pending files remain for inspection; this fixture performs no
unsafe automatic garbage collection.

## Exact proof limits and next isolated implementation

Same-UID chmod can bypass fixture read-only modes; a test demonstrates this and
subsequent content detection. The fixture assumes a trusted local parent and sole
cooperating single UID owner. `O_NOFOLLOW` protects only the final source component;
hostile ancestor TOCTOU is unprotected. It does not secure hostile directory replacement or a concurrent
provider namespace, and does not preserve executable metadata, ownership, ACLs,
xattrs or production Git symlink semantics. Source double-inventory checks only
sample consistency. Exceptions simulate control-flow interruption, not power-loss,
filesystem-failure or remount acceptance. No current independent authority exists
here; a rolled-back HEAD could defeat local CAS. No historical commit audit is
implemented, so inspect does not infer previous commitment from not-current.

A supported production owner must cover mount aliases, other administrative
writers, old inherited descriptors, root copies and external credential writers.
The transition from **existing shared legacy canonical writers** to sole ownership
is still blocked: copying a version does not revoke any original mount, grant,
controller route or provider family. Review exact migration/retirement/fencing
before routing a real workload to the proposed owner. No transition receipt exists.
Cross-PVC full-group atomic publication, remote storage crash durability, all-route
native installation, generation/restore independence and authority/effect common
linearization remain unresolved dependencies, not claims from these tests.

Next suitable fixture is a root-coordinated bounded isolated multi-UID/mount attempt
with canonical inaccessible to provider and deliberate old-open-file/mount attacks,
then independent authority crash/high-water inspection. Root schedules any heavier
fixture within laptop limits; it has not yet been scheduled or performed here. Installation
would require reviewed immutable image/policy/RBAC/network/workload/manual-migration
diff and separate rollout authorization. No live mounts, deployment or migrations.

All historical A/original shared-family holds remain, B paused, timers disabled,
Gemini deferred, capacity unchanged, PR5 draft and merges human-reviewed. Backup,
S3 and monitoring remain postponed. Synthetic local behavior does not authorize
provider dispatch or establish operational acceptance.
