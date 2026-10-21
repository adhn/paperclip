# Persistent canonical owner candidate

`protected-execution/canonical_owner.py` adds actual local effect ownership:
a persistent sequential Unix socket process holds a lifetime exclusive flock over
its private canonical directory and alone creates canonical versions and replaces
HEAD. The provider-facing API accepts exact immutable bytes for all three synthetic
roots (`workspace`, `session`, `config`), never caller filesystem paths. The owner
copies the supplied mapping before hashing/writing. These are bounded opaque root
blobs, not an implementation of arbitrary directory/Git/ACL/xattr transfer.

A durable immutable exact operation intent precedes version preparation. Each new
version contains independent inodes for the complete group; files and directory
are fsynced. One atomic HEAD replacement selects every root and retains the exact
receipt ledger; canonical parent fsync precedes successful response. Expected
predecessor generation is compared while the owner mutex is held. Conflicting
operation IDs, stale generations, partial groups, booleans as generations, excess
bytes and retained-ledger capacity exhaustion refuse before publication. Receipts
are never evicted to permit replay. Integrity verification covers the current
selected complete group on inspection/publication. Multiple threads serialize;
a second process owner refuses the lifetime lock.

A failure during preparation/publication poisons the live owner. Restart inspection
returns `absent`, `uncertain` (durable intent without selected receipt), or
`published` with the exact receipt. An uncertain intent refuses automatic replay.
Exact already-published retry returns its existing receipt without another effect.
Orphan versions/pending HEAD files cannot become committed merely by existing.
The service retains intents/versions; orphan reclamation is deliberately absent.
Bounded receipt capacity eventually refuses new work rather than forgetting history.

`serve()` keeps this owner alive across requests. Each accepted Unix stream is
bounded to one request and two-second socket timeout; SO_PEERCRED must match an
explicit allowed UID. The endpoint mode allows a distinct caller UID to reach it;
peer authentication, rather than Unix mode0600, decides authorization. Provision
its endpoint parent and canonical directory separately: provider must never own
canonical paths, descriptors, mount aliases or owner credentials. Same-UID callers
are indistinguishable, and same-UID access to canonical files invalidates isolation.
The supervisor must provide descriptor-safe launch and endpoint lifecycle (the
server refuses to replace an existing endpoint). This source does not install a
supervisor, Kubernetes identity/mount policy, mandatory native/all-command caller,
physical retirement authority, or independently protected witness.

## Verification and scope

Agent command from `protected-execution`:
`python3 -B -m unittest test_canonical_owner -v`.
Initial eight tests PASS in0.049s; expanded ten tests PASS in0.170s. The expanded run
uses temporary local files, one four-thread bounded CAS test, four serial forked
crash children (`os._exit(27)` after group fsync, pending HEAD fsync, HEAD rename,
and parent fsync) and one persistent owner child serving publish then inspect.
Every child was joined with bounded deadlines; persistent server exits cleanly.
No container, network access, live resource, provider, image pull/build, Git/index
operation, overlay reset or reapplication occurred. An initial command used the
wrong relative working directory and failed before edits/tests; corrected command
produced these passes. Root subsequently clarified that root schedules process
fixtures; agent stopped further process execution. Root owns final bounded
container execution and final verification after edits.

Two small changes after that run copy the input dict and change socket mode to
0666 (explicit peer-UID authentication remains mandatory). They require final
root verification; the prior ten-case pass does not attest those changed inputs.
The previous descriptor-safe kernel fixture is unchanged and its retained pass
applies only to its unchanged code. The new tests do not duplicate kernel isolation
claims: they test a local owner's persistent effects, crashes, current group
integrity, intent inspection, stale/concurrent refusal and authenticated socket API.

Crash-at-rename evidence is a process-crash test on the local filesystem, not a
power-loss/storage-controller durability proof. Surviving HEAD after restart is a
local publication observation; it cannot prove independent high-water or reject
an administratively rolled-back whole canonical tree. Strict capture of adversarial
mutable directory trees is not claimed: exact request bytes must come from a
separately coherent snapshot/quiescence boundary. Detached canonical inodes never
retire any existing writer of original roots. Full original shared-family writer/
mount/descriptor/account inventory, verified legacy retirement, independent current
history/high-water, complete real root handling, protected owner deployment and
cross-authority deny/settlement remain blockers. No receipt emitted here may be
used as evidence that those blockers are resolved. Operational acceptance is false.

Original A/shared-family holds, B paused, timers off, capacity unchanged, draftPR5,
human merges, Gemini deferral and backup/S3/monitoring deferral remain. Reviewed
rollout and complete real hold reconciliation precede serial existing-B Codex and
subsequent Claude acceptance.

Root review corrections pending final root verification: intent creation/fsync/
parent fsync now share the poison-on-failure block; every unpublished retained
intent blocks all new operation IDs after restart. Inspection fsyncs the canonical
parent before reporting a selected published receipt, refusing/poisoning on error.
This completes local recovery durability work without claiming power-loss or
independent high-water evidence. Crash test timeout now kills/joins its exact
child before failing. Socket framing now has one absolute monotonic two-second
deadline, with remaining timeout refreshed rather than renewable per-read limits;
a mocked-clock regression covers slow fragments. None of these revisions has been
reexecuted by the storage agent; root owns final serialized fixture scheduling.

The owner also implements `deny(expected_generation)` under the publication mutex.
It retains/fsyncs a deny marker before atomic replacement and parent fsync. Both
pending and completed deny markers refuse future publications after restart;
inspection stays available. Any deny write/commit uncertainty poisons the current
owner. Deny is irreversible in this candidate (no unreviewed reactivation API).
Socket requests support the same exact-generation deny. Tests cover stale deny,
persistent deny with continued inspection and injected deny-fsync uncertainty.
Root verification is pending for these new cases. A local storage deny is neither
runtime T nor complete cross-owner settlement and cannot retire legacy writers.

Final root review correction: the already-published exact retry branch also fsyncs
the canonical parent before returning its retained receipt, poisoning on failure,
matching inspection recovery after HEAD rename. Root-scheduled final verification
is pending; storage agent ran no further tests. Files are frozen for integration.

## Final root verification

The pending-verification statements above are historical. Root's final contained
run passed all **13 storage cases**, included in the combined **34 PASS in0.268s**.
Exact final `canonical_owner.py` and `test_canonical_owner.py` SHA256 values match
`fixture-inputs.json` in canonical
`.handoff-state/2026-10-21/sole-owner-continuation/`. The root-owned command, output,
containment inspection and cleanup are retained there as `fixture-command.json`,
`fixture.log`, `fixture-inspect.json` and `fixture-cleanup.log`.
The cached exact-image fixture ran UID1000, network-none, read-only root,64MiB
disposable tmpfs,256MiB RAM/512MiB swap-inclusive,1CPU,64PIDs, capabilities dropped,
without host mounts/ports; its exact container was removed. Storage source/tests
remain frozen at those verified hashes. This supersedes the earlier local pass and
covers all final corrections, while leaving operational acceptance false and the
production/retirement/history/capture blockers above unchanged.

## Real bounded tree continuation (owner-tree increment, uncommitted)

This increment supersedes only the opaque-root implementation limitation above.
`canonical_tree.py` implements deterministic immutable tree envelopes and actual
fd-relative materialization into independent inodes. A root can be a regular file
(Claude-style config) or a directory. Directories, binary files, executable intent,
internal directory-style `.git` contents and a conservative confined symlink subset
are supported. Entry count4096, depth32 and encoded complete group1MiB bounds are
intentional fail-closed limits; large real projects refuse rather than truncate.
Owner-private0600/0700 normalization is explicit. UID/GID, timestamps and group/
other permission bits are outside the format; this is not a lossless POSIX archive.

Hardlinks (including hardlinked symlinks), special inodes, privileged permission
bits, extended metadata/ACLs, absolute/parent-traversing/dangling/chained symlinks,
non-directory `.git` indirection and different-device nested mounts refuse. Same-
device bind mounts cannot be detected from st_dev; the trusted boundary must prove
an alias-free allowed mount topology. A standalone Git checkout is copied; linked
worktrees/submodules using `.git` indirection require a separately reviewed complete
root contract and currently refuse. External Git alternates/config includes and
provider credential references are not interpreted or given access by this code;
complete application root resolution and their exclusion remain integration gates.

`CanonicalOwner.publish_trees(id, expected_generation, roots)` validates the entire
immutable group before any intent. Tree format is bound into the exact intent
hash, preventing a blob request from replaying a tree effect. Existing byte-mode
request identity stays compatible. Preparation persists both exact payloads and
materialized canonical trees, fsyncs files/directories, then selects all roots by
the existing one-HEAD CAS. Recovery rehashes both encoded roots and recaptured
physical trees before reporting the current group. Durable intent, unresolved-
intent global hold, persistent local deny, exact inspection, poison-on-uncertainty,
receipt retention and expected-generation refusal remain in the actual owner.
`publish_trees` is available through the same bounded peer-authenticated socket;
there is no caller-path capture endpoint.

`capture_group(trusted_snapshot_boundary)` explicitly requires an owner-installed
context manager whose scope holds one immutable snapshot or verified exclusion
over every root across the entire capture. The component supplies no implementation
of that authority. The Python context-manager shape authenticates nothing; accepting
a provider-controlled context manager, read-only fd, repeated scan, same-UID flock
or a detached copy as this dependency violates the contract. fd-relative reads and
metadata refusal do not prove coherence against hostile existing writers. Synthetic
fixture boundaries have no hostile writer and are not production freeze evidence.

`export_trees(expected_generation, destination)` rechecks the complete current
group under the publication mutex and creates a detached whole group in a fresh
owner-private directory. It refuses local deny/unresolved intents, stale generations,
nonempty destinations, and canonical-directory descendants by walking descriptor
ancestors before mutation. The destination parent and mount topology must already
be trusted; it does not certify absence of hidden bind aliases. Export failure can
leave a partial detached tree that must remain unselected. No canonical descriptor
is returned. Export is preparation, not an invocation/launch authorization or a
journaled launch transaction; a successful return cannot authorize provider use
later after deny. The root-owned integrated dispatcher must order launch and deny.

### Descriptor boundary and concrete physical placement review

The existing `descriptor_safe_storage_fixture.py` remains fixture code and was not
imported into the owner. The concrete launch sequence is owner-only materialization,
then trusted transfer of detached attempt ownership, then a child-only close of all
unapproved descriptors (including above the current soft limit), group/UID drop and
isolated exec. Existing fixture closes FD200 and denies parent-proc reacquisition.
This source does not wire a production launcher or certify every recovery route.
Owner must never export canonical fd/mount credentials to controller/provider code;
all setup, Git/tar, probes, transfer, cancellation, adoption and recovery routes need
the same trusted launch boundary. Unsupported old routes must refuse before prep.

Proposed physical placement is a dedicated non-root storage authority identity/PVC,
private canonical parent and socket directory, with provider workloads receiving
only separate detached attempt storage. Native controller/provider identities must
have neither canonical mount nor authority credentials. A local flock is merely
single-process coordination. Before placement can be reviewed for activation, exact
old PVC mounts, processes, open descriptors/mmap handles, sidecars, stale sessions,
node/kubelet restart routes, backups/restore clones, other clients and account refresh
writers must be independently inventoried and fenced for every original shared
family. Moving/copying trees does not revoke those handles. No command to remount,
delete, mutate, scale, migrate or retire a real writer was executed or authorized.
Physical storage-side stale-writer rejection and authenticated current independent
high-water are absent. Administrative rollback can replay this owner's local state;
local durable intent and tree integrity do not solve it. Runtime retirement and
cross-owner native/pipe/storage deny+settlement must precede rollout.

### Verification requested from root

No tests or subprocess/container fixtures were executed by the storage agent in
this increment. Root must execute `test_canonical_tree` and `test_canonical_owner`
in its bounded cached-image fixture and record final hashes/results. Added tree
cases cover binary/executable/Git/symlink roundtrip, file-root configs, explicit
whole-group boundary lifetime, partial boundary refusal, traversal/duplicates/
missing parents, original symlink traversal before normalization, dir-mode stability,
special/hardlink/.git refusal, xattr refusal and existing target refusal. Owner tree
cases cover actual materialized version+restart/CAS/detached mutation, physical
corruption, exact format conflict, pre-intent refusal, deny/export ordering, retained
uncertainty and export-inside-canonical refusal. No kernel UID/mount fixture was
changed; its prior pass applies only to its unchanged inputs. Operational acceptance
remains false. All original A/shared holds, paused B, disabled timers/current capacity,
draft PR5/human merges, Gemini and backup/S3/monitoring deferrals remain unchanged.

## Effect-custody continuation: descriptor capture race refusal

`capture_root` now compares lstat identity/metadata with the opened descriptor,
checks that the directory name still names that identity after recursive capture,
and compares each descriptor's device/inode/mode/link count/UID/GID/size/mtime/ctime
before and after reading. Symlink readlink has the same before/after identity check;
regular/directory xattrs are checked again after capture. Observable replacement,
content/metadata mutation and newly added unsupported metadata refuse rather than
silently selecting a mixed capture. File reads use `pread`, so capture neither
changes nor relies on a caller's shared open-file-description seek offset.

These checks deliberately do not claim snapshot coherence. Hostile writes between
checks, mutable mmap, mount replacement/aliases and application transactions spanning
multiple files still require an independently trusted immutable snapshot or verified
whole-group writer exclusion. There is no portable scan-based proof that a hostile
writer did not run. The trusted group context remains an unmet authority dependency,
not a caller assertion newly accepted by these changes. Production launcher and
physical ownership integration remain absent; no local tree/export receipt can
release any original shared-family hold.

Three root-scheduled regressions were added: preserving an existing seek offset,
actual file replacement during a patched read, and actual directory-entry replacement
between lstat and open. No tests or fixtures were executed by the storage agent.
Root must record the exact current-input contained run before claiming a pass.
`canonical_owner.py` and its existing tests are unchanged in this increment, so
intent durability, exact operation identity, whole-group CAS, global unresolved
intent hold, persistent deny and exact inspection mechanisms are preserved.

Complete application-root handling remains a concrete integration gate: resolve
workspace Git common-dir/worktree/submodule/alternate/include paths; provider session
and credential/config/refresh paths; HOME/XDG and configured external paths; and
all writers of those exact paths, into one trusted owner-selected closure before
capture. Do not follow links into unenumerated state or treat these three symbolic
root names as that closure. Current bounded format refuses unsupported relationships
and cannot represent every real project. Review exact provider configuration and
actual retained root inventory without exposing credential bytes when separately
authorized. Installation must place canonical state on a dedicated authority-only
mount/identity, deny controller/provider and legacy mount/descriptor/recovery access,
and independently reject restored stale ownership before an executable rollout.
No inventory, migration, fencing, live inspection or launch was performed here.

## Root-boundary continuation: conservative Git metadata refusal

The supported Git subset is now deliberately narrower. **Ordinary repositories
with remote/branch/custom config can refuse. Complete application-root handling is
still incomplete.** This increment does not resolve Git paths or fetch anything.
Every `.git` directory present in a tree envelope is checked during
`validate_application_subset`, which runs after new capture and before new owner
publication/export; low-level materialization stays structural-only. Structural tree-v1 `validate` remains unchanged
so previously accepted exact state stays inspectable. Git
metadata symlinks refuse even if lexically confined. `commondir`, `gitdir`,
`worktrees`, `modules`, `config.worktree`, and `objects/info/alternates` or
`http-alternates` refuse regardless of contents. Active hooks refuse; only regular
immediate `hooks/*.sample` files are accepted as Git-ignored examples.

`.git/config` must be a regular ASCII file in an intentionally small grammar:
blank/full-line comment lines, `[core]`, and unquoted single-line `key = value`.
Accepted keys are repositoryformatversion=0, bare=false, and the booleans filemode,
logallrefupdates, ignorecase and precomposeunicode. Unknown sections/keys/values,
subsections, include/includeIf, core.worktree/hooksPath, duplicate keys, quoting,
escapes/continuation, inline comments and unsupported syntax refuse. This is an
allowlist for a standalone non-bare checkout subset, not an imitation of the full
Git parser. Remote URLs can name local paths and are therefore not accepted here.
The encoded schema/exact bytes are unchanged; validation is more conservative.
Existing retained trees outside this subset remain exactly inspectable and exact
accepted retries retain their prior receipt. New publication/export refuses these
trees; no migration, automatic rewrite or retroactive invalidation exists.

Five regression methods exercise retained structural inspection versus refused new
use, safe standalone config/sample-hook roundtrip,
external-reference path refusal in both direct immutable envelopes and actual
capture, config syntax/escape refusal in both paths, and confined Git-internal
symlink refusal. Agent executed no tests/fixtures; root must verify final inputs.
The owner implementation/tests, durable intent, whole-group CAS, uncertainty hold,
persistent deny and exact-inspection mechanisms were not edited.

This code cannot certify ambient system/global Git config, HOME/XDG, GIT_DIR,
GIT_WORK_TREE, GIT_COMMON_DIR, alternate-object environment, command-line `-c`,
credential helpers, other provider state, bare-repository roots passed without a
`.git` component, or executable application behavior. Trusted root resolution and
a reviewed environment/config/command boundary must account for those separately.
Detached byte copies, this validator and local flock remain preparation only;
coherent capture authority, descriptor-safe production launch, physical old-writer
exclusion and independent current high-water are still missing. No live action,
provider call, Git/index operation, migration or hold release occurred. All original
A/shared-family holds, paused B, disabled timers/current capacity, draftPR5/human
merges and Gemini/backup/S3/monitoring deferrals remain unchanged.

Independent source review of root's `production/detached_exec.py` and seven test
methods found no blocking issue under its dedicated fresh single-thread non-root,
trusted immutable interpreter/code and externally isolated identity/mount contract.
Actual descriptor enumeration closes unknown inherited FDs above2 even beyond a
lowered soft limit; pipe/null-only inheritable stdio refuses regular capabilities.
Silent status125 failure avoids writing refusal diagnostics through rejected stderr.
Cwd placement/aliases, same-UID proc access, mappings and physical writer exclusion
remain external obligations. No test was run by the storage reviewer. Native agent
independently reviewed the Git subset and found no blocker within its documented
narrow grammar and trusted ambient-config exclusion precondition. Files are frozen
for root verification; review is source evidence only.

Root integration review identified and corrected a retained-state compatibility
issue before acceptance: stricter application policy must not redefine an existing
accepted tree-v1 receipt. `validate` now retains structural tree-v1 semantics;
`validate_application_subset` is separate. Default `capture_root` stays strict for
new captures, while `application_subset=False` is solely for integrity recapture
of existing accepted canonical state. Low-level materialization stays structural;
it supplies physical format transfer, never application use permission. Root
owns owner changes to apply strict checks to the complete group before new intent
or export mutation, preserving exact inspection/retry. The new retained-state test
checks legacy-config structural validation and exact physical recapture while new
capture/application-subset validation refuse. Structural materialization reconstructs
the same retained fixture without inventing permission for application use. No test was run by the storage agent.

## Group-launch continuation: narrow ordinary-clone config support

The application-policy gate now accepts a limited explicit network remote/branch
configuration. Earlier statements that all remote/branch config refuses are
historical; unknown syntax and options still refuse. This changes neither encoded
tree-v1 bytes nor structural validation/materialization, retained exact inspection,
accepted retries, durable intents, whole-group CAS, uncertainty hold or deny.

In addition to the previous core allowlist, exact `[remote "name"]` sections may
have one `url` and one optional `fetch`. URL must have an explicit lowercase http,
https or ssh scheme, DNS-style ASCII hostname (numeric labels allowed), optional
port1–65535 and canonical slash-separated nonempty path. Only ssh may have a simple
username. No local/scp shorthand, file/ext/remote-helper schemes, passwords, quoting,
backslash/percent escapes, query/fragment, empty or dot/parent path components,
option-like hostnames or unsupported characters are accepted. Fetch must be exactly
`+refs/heads/*:refs/remotes/<same-name>/*`. This is syntax restriction, not network
permission or a claim the destination is public/trusted/reachable; isolation and
network authorization remain external.

Exact `[branch "name"]` sections require `remote` naming a declared network remote
and `merge = refs/heads/<canonical-name>`. Names use a conservative ASCII ref subset;
empty/dot/parent components, double dots and `.lock` suffixes refuse. Unknown keys
(including pushurl/uploadpack/rebase), alternate refspecs, undeclared/local remotes,
incomplete branch records, quoting and config continuation refuse. No Git command,
network request or provider call is used to validate these immutable bytes.

Three added test methods cover actual safe network-config capture/materialization/
recapture with http(s)/ssh URLs, unsafe URL/helper/credential/escaping forms, and
branch/remote cross-reference and option refusal. Storage agent ran no tests;
root must execute exact final `test_canonical_tree` and `test_canonical_owner` inputs
in the bounded fixture. Application-root authority remains incomplete. In particular,
setting grouped HOME=session and XDG_CONFIG_HOME=config does not suppress their
`.gitconfig`/`git/config` files or system Git config. Trusted initial execution should
explicitly exclude ambient system/global Git config and inherited override/helper
variables; this was sent to root for its child-boundary integration. Such exclusions
do not constrain arbitrary provider commands after exec and do not confer physical
ownership, snapshot coherence, legacy-writer retirement or current high-water.
All original holds/prohibitions remain unchanged. Files frozen for root integration.

## Owner-port continuation: group descriptor shape and final recheck

`capture_group` now preflights all three trusted-boundary descriptors before
reading payload bytes. Reused descriptors and independently opened descriptors
naming the same device/inode refuse. Workspace and session require directories;
config retains the structural supported directory-or-regular-file choice. This
capture behavior does not add single-file config support to generic grouped exec,
which still refuses that profile. Every root's descriptor metadata is rechecked
after all three captures, so an observable change in an earlier root during a
later scan refuses the complete group. No partial group is returned.

Three regression methods cover same-descriptor/separate-open alias refusal,
workspace/session shape refusal with retained single-file config capture, and an
actual metadata change to workspace after its scan while config is captured.
Storage agent ran no tests or fixtures. Root must run exact final
`test_canonical_tree` and `test_canonical_owner` under its bounded fixture and
record inputs/results before reporting a pass.

The trusted immutable snapshot or complete writer exclusion remains a required,
uninstalled dependency. Distinct inode identity does not detect nested same-device
bind aliases, overlapping subtrees, inherited descriptors, writable mappings,
proc-based access or old writers. A metadata recheck cannot prove descendant
coherence, no intervening write, application transaction coherence or independent
high-water. Neither this scanner nor the detached child wrapper owns the physical
storage effect. Production placement still requires authority-only canonical
mount/identity, explicit exclusion of every controller/provider/legacy/recovery
writer and an independent mechanism rejecting restored old authority. No provider
application profile was invented from symbolic workspace/session/config labels.
Trusted provider-specific HOME/config/session/refresh closure remains incomplete.

Structural tree-v1 encoding/validation/materialization, retained exact inspection/
retry and accepted-retirement semantics are unchanged. `canonical_owner.py` and
its durable intents, whole-group CAS, global uncertainty hold and persistent deny
were not edited. No Git/index, native checkout, live inspection/mutation, network,
provider, migration, installation or hold release occurred. All original A/shared
holds, paused B, disabled timers/current capacity, draft PR5/human merges and the
Gemini/backup/S3/monitoring deferrals remain; backup release prerequisite is not
waived. These local source checks are preparation, not operational acceptance.

## Writer-profile continuation: retained actual Codex/Claude profile closure

This increment inspected the intentionally dirty retained native checkout read-only.
Source locations below are under `.work/paperclip-admission/packages/adapters/`;
they describe adapter behavior, not authenticated provider-binary behavior or live
state. No provider command, credential file, network, native mutation or fixture
was used. Generic grouped HOME=session/XDG_CONFIG_HOME=config is insufficient for
both actual adapters. No `application_profiles.py` or test module was created:
no complete bounded profile is supported by the retained source closure, and an
environment/schema helper would wrongly substitute preparation for effect ownership.
Root was notified before this documentation edit; no root imports are needed.

| Actual source location | Concrete state/effect and required ownership closure |
| --- | --- |
| `codex-local/src/server/codex-home.ts:9–27,118–147` | Shared root resolves explicit CODEX_HOME or `~/.codex`; managed root resolves company `codex-home`. Staging allowlist is config.json, config.toml, instructions.md, auth.json and skills. Source explicitly excludes runtime sqlite/WAL, plugins, cache, sessions and shell_snapshots. This is provisioning, not a complete session-transfer profile. |
| `codex-local/src/server/execute.ts:738–815,830–869,973` | Provider config/MCP rewriting and skill injection precede staging; actual execution explicitly sets CODEX_HOME to remote asset or effective home. Auth staging follows links to bytes. Recovery/copy-back targets shared host auth source or managed connection home, plus a per-account cache resolver. Merely setting HOME cannot select this actual root. |
| `codex-local/src/server/codex-home.ts:326–348,451–491,610–765` | Managed config.toml is written; seeding can link auth.json from shared custody; skill staging intentionally encounters shared external skill stores. A conservative three-root capture cannot follow these external identities without a trusted complete source closure. Existing narrow tree policy remains refusal, not silent dereference. |
| `codex-local/src/server/codex-auth-copyback.ts:80–158,160–191` | Actual copy-back stages/fsyncs a temp beside hostAuthPath and atomically renames/fsyncs its directory under mutation/merge locks. Then a separately locked, independently failing per-account cache write runs after host outcome is established. Both are real writer families; a canonical group receipt does not own either or atomically reconcile both. Local merge locks are not physical old-writer fencing or independent high-water. |
| `claude-local/src/server/claude-config.ts:22,45–78,122–183,219–235` | Shared config resolves explicit CLAUDE_CONFIG_DIR or `~/.claude`. Sanitized seed copies settings.json and CLAUDE.md, removes selected hooks/MCP/permission keys, and preserves other settings. Runtime has a separate company/agent `claude-runtime/runs/<run>/mcp/mcp-config.json`. Remote materialization may read credentials.json or .credentials.json from ambient HOME/.claude. A sanitized seed does not prove closure over all settings/external paths. |
| `claude-local/src/server/execute.ts:565–600` | The actual local sandbox grants rw to sharedClaudeConfigDir **and sibling** `dirname(sharedClaudeConfigDir)/.claude.json`; prompt bundle and separate run MCP directory are additional ro assets. Its HOME is dirname(sharedClaudeConfigDir). Mapping CLAUDE_CONFIG_DIR directly to group/config would place the sibling at group/.claude.json, outside the exact three-member group. No such reinterpretation is accepted here. |
| `claude-local/src/server/execute.ts:608–710,789–798,851–879` | Remote stages skills, mcp-config and optional config-seed, materializes runtime/config and explicitly sets CLAUDE_CONFIG_DIR. Every CLI invocation, including resume, loads current --mcp-config with --strict-mcp-config; resume also depends on stored cwd/target/prompt identity. HOME/XDG alone supplies neither these paths nor resume semantics. |
| `claude-local/src/server/execute.ts:1367–1384,1393–1407` | Poisoned local sessions cause actual deletion of `CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session>.jsonl` before fresh retry; finally collects provider stop then restores workspace. Session-repair deletion and workspace restore are writers requiring the same ownership/recovery closure, not passive profile reads. |
| `claude-local/src/server/acp.ts:195–320` | ACP has distinct remote preparation: explicit workspace-contained config is remapped; host-only override logs substitution and falls through to managed seed. It stages config seed/skills, reads ambient HOME credentials and sets CLAUDE_CONFIG_DIR. Source states no credential copy-back and workspace-only teardown with logged restore failure. A new profile must not silently inherit this override fallback or promise credential/session persistence absent from that lane. |

A concrete installable profile must therefore bind actual adapter lane and exact
provider build; select a trusted inventory including effective cwd/target identity,
provider home, config, session sqlite/WAL/transcripts, sibling config, prompt/MCP/
skills assets, credential sources and refresh/cache destinations; account for the
writers above and every provisioning/probe/login/recovery route; then capture under
one genuine coherent boundary. Unsupported config/external references must refuse
without provider execution. Rewriting arbitrary TOML/JSON, following shared auth or
skill symlinks, splitting CODEX_HOME's config/session files between symbolic roots,
or replacing a requested external config with a managed seed is not authorized by
this source review. Full provider parsing/effect ownership is absent; no accepted
complete profile, new launch permit or full application compatibility is claimed.

A possible later physical layout can nest the required Claude config and sibling
inside one owner-selected HOME tree, but that is a reviewed profile change requiring
actual invocation, transfer, refresh and recovery integration. It is not implemented
or accepted by this report. Structural tree-v1, historical exact inspection/retry,
durable intents, whole-group CAS, global uncertainty hold, persistent deny and
accepted-retirement semantics remain unchanged. Root owns shared integration and
all verification. No new storage tests were necessary for this report-only scope;
previous exact-input evidence is reusable only for unchanged files. All existing
holds and prohibitions persist; operational acceptance remains false.

## Control-closure continuation: nested Git metadata policy bypass refusal

Source review found a concrete new-use application-policy gap: `_git_subset`
interpreted a path relative to its first `.git` component only. An inner repository
at `.git/nested/.git/config` could therefore contain unsupported `include` or
`core.worktree` settings without reaching the config check for that inner root.
A later command using `.git/nested` as cwd could select that inner repository.
No provider command or Git invocation was performed to claim operational impact.

The new-use gate now conservatively refuses paths with repeated `.git` components:
repositories stored inside another repository's metadata are an unsupported profile.
It does not silently parse/rewrite their settings or resolve external state. Ordinary
workspace nested repositories such as `nested/.git/config` retain the existing
per-repository policy checks. Structural tree-v1 `validate`, materialization and
`capture_root(application_subset=False)` remain unchanged, so retained exact bytes
can still be reconstructed/inspected without granting new application use. Existing
accepted operation retries remain the canonical owner's unchanged exact-history
behavior; this increment does not reinterpret their receipts.

Three new methods exercise direct new-use refusal for malicious and benign inner
configs, actual filesystem capture refusal, ordinary nested workspace repository
acceptance plus its own unsafe-config refusal, and retained structural physical
reconstruction/exact integrity recapture while new-use capture refuses. Root must
run final `test_canonical_tree` (29 methods) and existing canonical-owner tests in
the bounded fixture. Storage agent ran no tests, fixtures, Git/index, network or
provider commands and changed no native file.

This closes one bounded policy hole, not complete provider parsing or application
profile closure. Bare repositories without `.git` path components, arbitrary
provider commands/config semantics, skills and credential external references,
coherent snapshot capture, physical old-writer/mount/descriptor exclusion and
independent high-water remain unresolved as recorded above. No profile helper,
launch authority, retirement proof or installation was manufactured. Durable
intents, whole-group CAS, global uncertainty hold, persistent deny, protected exact
old-owner stop/inspection and accepted-retirement semantics are unchanged. All
original A/shared-family holds, paused B, timers/current capacity, draft PR5/human
merges, deferrals and the backup release prerequisite persist. Operational
acceptance remains false.


## Effect-owner continuation: pre-run and probe credential publication closure

Read-only retained-source review extends the concrete writer inventory beyond
post-run auth copy-back. Locations below are under `.work/paperclip-admission/`;
no credential bytes, provider execution, live inspection or native edits occurred.

| Actual source | Distinct effect and integration consequence |
| --- | --- |
| `packages/adapters/codex-local/src/server/codex-auth-cache.ts:500–570` | `selectVendCredential` reads host identity, resolves that account's cache slot, stages bytes beside host auth, invokes the merge predicate, then renames over host auth under the host-directory merge lock. It is a real host credential publisher before provisioning, not a profile read. Unlike `codex-auth-copyback.ts:110–126`, this function closes its staged file without `sync()` and does not sync the host directory after rename. A returned `vended` is therefore neither the canonical owner's durable publication receipt nor independently protected retirement evidence. |
| `packages/adapters/codex-local/src/server/execute.ts:681–699` | Actual execution calls that vend before managed-home seeding and catches its errors to continue from shared credentials. New owner integration must own this publication before any launch; an error after rename cannot be reclassified as an absent effect merely because this caller logs a skipped vend. |
| `packages/adapters/codex-local/src/server/test.ts:111–136` | The actual remote subscription probe also vends into shared host auth and catches errors before staging credentials. This `test.ts` is adapter probe implementation, not an isolated unit test. Routing only ordinary task execution would leave a real alternate publisher outside ownership. |
| `packages/adapters/codex-local/src/server/codex-auth-cache.ts:232–256,301–361` | Cache-root create/reuse, whole device-login promotion and secret-mutation ownership use different lock domains. The secret mutation lock permits only an active inherited AsyncLocalStorage owner and expires it on return. Preserve that distinction when integrating database and filesystem effects; a single local lock token is not a physical writer fence. |
| `packages/adapters/codex-local/src/server/codex-auth-cache.ts:577–612` | Entry deletion and whole company-cache deletion are separate exported implementations. Entry deletion acquires an entry-directory merge lock; whole-cache deletion directly removes the resolved root. Scoped non-test search found no callers in server source or the Codex adapter source, so this report records implementations requiring reachability/export closure, not a proven current production route. Neither can silently count as cleanup of a selected canonical generation. |
| `server/src/routes/agents.ts:890–925,1063–1072,1080 onward` | Actual login promotion spans credential publication, account-home creation/reuse, secret binding, potential unclaimed-home recursive cleanup and a later separately locked terminal authenticated commit. Cleanup errors are swallowed at the removal call. The subsequent terminal commit revalidates under secret-mutation ownership; it is distinct from the earlier credential/filesystem publication. These boundaries require distinct retained effects and inspection outcomes. |

The required integrated transaction graph must retain separate exact operation IDs,
original owner/family, predecessor and selected target identity for pre-run/probe
vend, host copy-back, additive cache update, account-home creation/promotion,
secret binding, cleanup and terminal login state. A durable intent must precede
each independently committing effect. Any error or reply loss after possible
rename/delete/database commit retains uncertainty and inspection of that exact
operation; it must not trigger a fresh write or suppress already committed siblings.
Later deny must order with every one of these publishers, preserve exact old-owner
inspection and stop, and hold dependent new work until all charged effects settle.
No generic HOME mapping or canonical three-root receipt supplies that ownership.

No tree code or tests were changed: no additional provider profile can safely be
installed from this source closure, and native vend durability repair belongs with
the complete native owner port after strict physical-COMMIT validity is resolved.
The retained 29 tree cases and structural tree-v1/historical inspection/exact retry
remain unchanged; root must compare exact input hashes before reusing evidence.
All prior physical placement, coherent capture, legacy-writer exclusion and
independent high-water blockers persist. No operational acceptance or hold release
is claimed; all original shared-family holds, paused B, disabled timers, current
capacity, draft PR5, human merges and deferred backup release prerequisite remain.


## Provider-cut continuation: Claude provisioning, repair and recovery effects

This increment uses the effect-owner checkpoint (137 exact cases PASS in5.094s)
as retained evidence, not a new test run. Read-only native source review follows
additional actual Claude effect paths. All source paths below are relative to
`.work/paperclip-admission/`; native bytes remain untouched.

| Actual source | Physical effect and separate ownership boundary |
| --- | --- |
| `packages/adapters/claude-local/src/server/claude-config.ts:66–116` | Seed collection reads settings and CLAUDE.md independently, sanitizes selected settings, truncates a SHA256 cache key to16 hex digits, and materializes a persistent seed through mkdir/mkdtemp/write/rename. Existing target existence is trusted; there is no fsync or existing-target byte verification in this helper. Its cache key is not a coherent snapshot, complete config parser, canonical receipt or independent high-water. Seed creation and abandoned temporary removal are actual host writers. |
| `claude-config.ts:221–255` (same directory) | Remote materialization executes mkdir/cp of the seed and conditionally copies both credential filename variants from the remote process's ambient HOME/.claude. Each copy is an independent filesystem effect and may leave partial state on shell failure. The command neither installs owner durability nor excludes stale runner writers. Trusted capture must inventory the runner's credential source as well as the selected managed config destination; host HOME mapping does not describe this read. |
| `claude-config.ts:293–374` | Both ordinary CLI and ACP probes use a helper that may install a missing CLI, create a host temporary workspace, stage config with symlink following, materialize remote auth/config, then restore workspace in finally and remove the temp. Restore/cleanup errors are caught. A probe result is therefore not proof that its preparation/restore left no effects, and probe routes need full provisioning/transfer/cleanup ownership before new use. |
| `packages/adapters/claude-local/src/server/acp.ts:247–263` | Workspace-contained explicit CLAUDE_CONFIG_DIR takes a distinct stage([])/remap branch and installs ordinary workspace sync-back. Thus the source statement “no credential copy-back” means no dedicated auth restore seam: it does **not** exclude config/credential bytes stored under that workspace from ordinary restore. Those bytes remain in the workspace effect family and need exact predecessor/inspection. |
| `acp.ts:265–316` (same directory) | Host-only explicit config falls back to managed seed; the other branch stages seed with followSymlinks=true, selected skills with false, materializes remote config and sets CLAUDE_CONFIG_DIR. This fallback is retained source behavior, not acceptance of replacing an operator-selected root. Unsupported external profiles must refuse before prep in the owner integration. |
| `packages/adapters/claude-local/src/server/execute.ts:1367–1407` | Ordinary local poisoned-session recovery unlinks the exact encoded-cwd/session transcript and retries fresh; any unlink error is ignored and server-side session clearing can still follow. Finally collects provider stop, stops the bridge and restores workspace. Transcript deletion, session-state clearing, fresh invocation and workspace restore are distinct effects; a fresh retry cannot infer the deletion outcome from the prior error. This local-only unlink path must not be projected onto remote ACP. |
| `packages/adapter-utils/src/acpx-engine/execute.ts:1966–1967,4356–4368` and `ephemeral-session-environment.ts:8–38` | ACP selects a separate configured/default stateDir and creates a runtime persistence store. The wrapper removes environment from saved conversation options and injects the current environment on load; it still delegates all conversation saves. Environment stripping does not eliminate session persistence, prove transcript ownership or make this stateDir part of any synthetic three-root group. The imported acpx store's physical implementation requires its own closure. |
| `packages/adapter-utils/src/acpx-engine/execute.ts:2803–2824,5530–5549` and `packages/adapter-utils/src/workspace-restore-teardown.ts:35–55` | ACP tracks restore outcome separately from the turn result and can retain a successful turn with failed restore. The stopped predicate gates instruction collection, while workspace sync-back runs in finally even when that predicate is false. This source ordering is not proof that mutable provider files were frozen. Runtime-owned stop/exclusion must independently precede trusted capture and any selectable restoration. |

The required effect graph distinguishes immutable seed preparation, CLI install,
remote credential/config materialization, provider invocation/refresh, transcript
repair, ACP conversation persistence, workspace restoration and cleanup. Each
physical publisher needs the exact original family and target, predecessor state,
retained prospective intent and exact result/uncertainty inspection. A broad run
success, swallowed cleanup error, cleared session, logged restore failure or local
stop submission cannot settle another effect. Deny must order with preparation and
new invocation while preserving protected exact original-owner stop/inspection;
pre-deny effects remain charged until independently settled or safely stopped.

This does not invent logout or account-delete calls for Claude: the scoped adapter
and login-route searches did not establish those provider-specific paths. Deleting
a local credential/config tree would not prove remote account/token revocation.
Complete provider binary/config/session behavior, imported ACP store effects,
actual recovery and deletion reachability, sibling .claude.json, MCP/prompt/skills,
all source/destination aliases and every old descriptor/mmap/mount/client still
require trusted closure. Same-UID checks, local locks, detached copies and cache
hashes do not prove coherent capture, physical retirement or independent high-water.

Only this report changed; no tests, fixtures, Git/index, network, provider or live
actions ran. Structural tree-v1 and historical exact inspection/retry remain
unchanged. No complete profile, physical exclusion, strict physical-COMMIT port,
rollout or acceptance is claimed. Preserve all original shared-family holds, paused
B, disabled timers/current capacity, draft PR5/human merges and all deferrals,
including the backup release prerequisite.

## Provider-owner follow-up: startup publishers and non-atomic restore closure

Newest completed checkpoint by retained checkpoint timestamps is provider-cut,
whose exact fixture log records 140 PASS in4.177s. The fixture command, summary
and cleanup confirmation were read; no fixture was rerun by this agent. This
increment changes only this report under the pre-recorded provider-owner-followup
ownership. Source locations below remain relative to `.work/paperclip-admission/`.

| Actual source | Additional physical writer or outcome boundary |
| --- | --- |
| `server/src/index.ts:1084–1087`; `server/src/services/codex-auth-reconciliation.ts:88–145` | Startup schedules managed-home reconciliation through `trackIdleWork`, independently of task execution, provider probes and device login. It selects Codex agent configuration, skips aiConnection-bound rows, and calls the real home seeder. Per-row exceptions increment a failure count and allow subsequent rows to continue. Activation must own or exclude this restart-time publisher before exposing the canonical mount; a held task queue alone does not cover it. |
| `packages/adapters/codex-local/src/server/codex-home.ts:822–871` | Reconciliation checks a configured managed path, preserves usable secret-bound auth and matching API-key auth, then invokes `seedManagedCodexHome`. A later `source_auth_missing` or `already_seeded` classification is an auth-read result, not an exact inventory proving that no config/skill/seed preparation occurred. Preserve the actual selected credential identity; do not replace a secret-bound key with subscription credentials during owner migration. |
| `packages/adapters/codex-local/src/server/codex-auth-seed-write.ts:60–81` | The shared seed writer syncs its staged credential, renames, syncs the destination directory, then awaits the caller's log sink before returning `written`. Log rejection therefore can follow durable credential publication; cleanup of the now-absent temporary path cannot roll that publication back. Exact inspection must distinguish post-publication reporting failure from absent effect. The helper's comment about always removing a partial temporary file cannot be used to settle the selected destination outcome. |
| `packages/adapter-utils/src/execution-state-journal.ts:14–33` | Restoration and mutation helpers call the body directly when no AsyncLocalStorage journal is installed. A present journal without mutation support refuses, but the absent-journal route remains unowned. These wrappers cannot establish mandatory startup, provider or recovery effect ownership; the actual launch/control boundary must exclude every route lacking the installed owner. |
| `packages/adapter-utils/src/workspace-restore-merge.ts:552–588,691–734` | Restore deletes entries, removes directories, creates symlinks, and stages/syncs/renames regular files individually. Conflict preflight runs under a local merge lock; the whole tree is not selected by a single atomic group commit. Later entry or afterApply failure may follow already-selected earlier entries. These effects need retained exact operation inspection and partial-outcome accounting, rather than treating a rejected Promise as no restore. No filesystem-directory fsync or independent high-water guarantee is supplied by this per-entry routine. |
| `workspace-restore-merge.ts:591–619,621–643,36–42` (same directory) | Baseline/subset capture can create disk-backed manifest trees and dispose them by recursive removal. A scan of live roots plus a local target lock does not freeze the source tree or other provider writers. Capture, manifest disposal and target publication are distinct effect families; temporary storage also needs bounded ownership and recovery accounting. |

This extends the concrete cut to automatic restart work and the actual restore
implementation used below ACP teardown. In particular, a workspace-contained
Claude config can carry credentials through ordinary restore even when dedicated
credential copy-back is absent, and restore still lies outside the instruction-
collection stopped predicate. Stop-pipe submission, terminal turn status and a
successful conflict preflight supply no trusted whole-group capture boundary.

The complete provider profile remains unavailable: Codex staging explicitly omits
runtime sessions/sqlite/WAL and does not own host-auth/cache/provisioning/startup
writers; Claude needs sibling .claude.json, MCP/prompt/skills, probes/transcript
repair and imported ACP session persistence in the same actual lane inventory.
No profile parser, generic HOME rewrite, new wrapper or partial native port was
installed. Canonical authority-only physical mount/identity placement must also
exclude startup reconcilers, old processes/sessions/descriptors/mmap/bind aliases,
backup/restore clients and maintenance routes. No retained source scan proves
that exclusion, coherent capture or independently current history.

Structural tree-v1, exact historical inspection/retry, repeated-.git new-use
refusal and ordinary nested-repository support are unchanged. Strict physical-
COMMIT validity remains unresolved and monotonic fenced facts remain an UNACCEPTED
proposal. No tests, fixtures, Git/index, native edits, network/provider or live
actions ran. Root alone integrates and verifies changed executable inputs. All
original shared-family holds, paused B, timers/current capacity, draft PR5/human
merges and deferrals persist; backup release prerequisite is not waived and
operational acceptance remains false.

## Recovery-owner continuation: actual ACP session and cleanup authority

Provider-owner-followup is the latest completed checkpoint; its retained exact
fixture log ends 143 PASS in4.679s and cleanup confirmation records absence. The
recovery-owner-continuation ownership was read before this report-only edit.
No dependency, network, provider, test, fixture, native or Git/index action ran.

The local ACP dependency remains an explicit closure gap. Neither the native
root nor adapter-utils `node_modules/acpx` path exists in this retained checkout.
The adapter-utils lock entry pins `acpx`0.13.1 with local patch, but that is not
the complete imported physical store source. Scoped reading of the retained
`patches/acpx@0.13.1.patch:1086–1181` shows runtime reopen and configuration paths
calling `sessionStore.save` independently of the final turn. It does not expose
the complete createRuntimeStore filesystem implementation, atomicity, file layout,
deletion behavior or recovery rules. No package acquisition or broad unchanged
cache search was attempted; no unobserved store implementation is invented.

| Actual retained source, relative to `.work/paperclip-admission/` | Recovery effect and consequence |
| --- | --- |
| `packages/adapter-utils/src/acpx-engine/execute.ts:4330–4344,4356–4385` | Compatible session metadata can select a live cached runtime. Tool refresh, MCP fingerprint change or any current MCP server causes discard before a replacement. New cold runtime receives the newly wrapped persistent store and environment, while a cached runtime reuses its already-created object. A compatibility label or fresh wrapper construction does not itself replace the cached runtime's credentials/store options or prove physical session ownership. Current source's credential gate constrains host reuse; it must remain intact. |
| `session-reuse-store.ts:108–116,149–162` (same directory) and `execute.ts:3990–4004` | Generic eviction removes the exact map entry before awaiting its resource release. The actual host idle-close callback catches close errors. Map absence therefore does not certify provider exit, persistent-state deletion or release. An integrated owner must retain the exact original runtime/attempt and uncertain close outside the evicted cache; an idempotent cache removal is not independently committed runtime settlement. |
| `execute.ts:4454–4477,4515–4566` (same directory) | A failed resume can set clearSession and invoke ensureSession again without the old resume ID. An abandoned handshake may resolve later and trigger a fire-and-forget close with persistent state retained; late-close failure is logged with a fixed code. Old resume, new session creation and late cleanup are separate effects. Clearing server session metadata cannot delete or settle the original physical conversation, and a late handle must retain its original owner identity for inspection/stop. |
| `execute.ts:4940–4968,5450–5508` (same directory) | Channel loss requests cancel and starts a local deadline; known loss can skip remote close entirely and drop matching warm bookkeeping. Operator-stop escalation may separately call close with discardPersistentState=true, whereas ordinary/late cleanup can retain persistent state. None of these return paths proves remote credential revocation or backend persistent-state deletion. Each real close/discard/cancel and skipped-unknown outcome needs separate prospective intent and exact inspection. |
| `settlement-sequence.ts:135–205` (same directory) | Settlement catches step errors, records them, continues subsequent steps, then labels every unsaved ledger resource finalized based on the reuse decision. This is a resource disposition report, not an effect-completion receipt: close or restoration can have failed. Keep independent original intent/outcome/uncertainty records and do not reinterpret finalized as confirmed runtime termination, coherent restore or authority release. |

The environment-filter wrapper only strips `record.acpx.session_options.env` on
save and reinjects the current environment on load. It does not scrub arbitrary
conversation fields, authenticate persisted history, capture provider transcripts
or resolve the external store's cleanup semantics. Distinct persistent conversation
records, backend session state, staged workspace/config and credential sources
remain separate roots/effect families. A successful turn, local timeout, cache
eviction or resource disposition cannot collapse them into one group receipt.

ACP workspace restore still runs outside the instruction-collection stopped
predicate and may carry workspace-contained credentials. Complete profiles require
the actual imported persistence and provider binary internals in addition to the
already recorded Codex sessions/sqlite/WAL and Claude sibling/MCP/prompt/skills/
probe/transcript closure. Trusted coherent capture, physical legacy mount/handle/
session exclusion and independent current history remain absent. Structural
tree-v1/historical exact inspection/retry stay separate from new-use policy;
repeated .git paths refuse new use and ordinary nested repositories remain supported.
No new complete profile, launcher, wrapper or transaction port is installed.
Strict physical-COMMIT remains unresolved; monotonic fenced facts remain UNACCEPTED.
All original shared holds, paused B, timers/capacity/draftPR5/human merges and
deferrals persist, including backup prerequisite. Operational acceptance is false.

Independent follow-up read of root's final `production/owned_effect_dispatch.py`
found no blocking issue in the scoped marker/generation correction. Recovery
requires exact fields/types/route/operation, canonical base64 and byte-for-byte
canonical JSON frame equality, so malformed/duplicate/noncanonical frames cannot
manufacture marker-only operation inspection. Corrupt markers still hold new work.
Enqueue compares the caller with the immutable construction generation before SQL
or mutation and holds on a changed retained SQL generation. Exact deny retains its
barrier before the SQL check; stale refusal preserves original control. No test
was run by this reviewer. This local result installs no physical storage owner,
complete provider profile, coherent capture, runtime termination or release.


## Owner-custody follow-up: encrypted recovery root and credential aliases

Baseline recovery-owner-continuation exact fixture log records145 PASS in4.467s;
its cleanup confirmation records absence. New disjoint ownership was read before
this report-only edit. No tests, fixtures, unavailable dependency searches, Git/
index, network, provider, native edits or live actions ran.

Additional actual retained source closure, relative to `.work/paperclip-admission/`:

| Source | Separate root/effect requiring ownership |
| --- | --- |
| `server/src/services/idle-local-work.ts:12,36–55`; `quota-credential-recovery.ts:14–52` | The instance-root `quota-credential-recovery/<company>/<grant>.json` tree stores encrypted replacement credentials outside provider HOME. Preparation publishes and removes a probe; actual write encrypts, creates/syncs a0600 temp, renames and syncs the directory. Clear/probe removal uses rm without directory sync. File absence therefore is not durable retirement evidence. Idle scan treats every journal/probe/unexpected entry as occupied and never decrypts it; preserve this fail-closed accounting. |
| `server/src/services/ai-connections.ts:898–947,1023–1115` | Actual recovery binds company/grant/connection/secret/baseHash, rotates the secret inside SQL transaction, then clears the filesystem journal after commit. Mismatched journal cleanup is another filesystem effect. Single-use OAuth exchange precedes the replacement journal write; the preparation probe proves storage availability, not an exact prospective exchange intent. Reply/parse/journal failure may follow token consumption. Exchange, encrypted journal publication, secret rotation/SQL commit and deletion need independent exact outcomes, not one provider-home generation. |
| `server/src/secrets/local-encrypted-provider.ts:21–25,50–80` | Journal encryption uses the instance secret provider and therefore depends on the configured master-key environment or resolved master-key file, even if the target secret vault is remote. Key loading can enforce file permissions and missing-key creation is a separate writer. An encrypted journal cannot be restored independently of exact authorized key custody; merely moving CODEX_HOME cannot transfer or retire this recovery authority. |
| `packages/adapters/codex-local/src/server/codex-home.ts:197–248,352–361` | Managed auth alias migration unlinks a non-directory old target or wrong symlink before creating the selected new symlink. API-key auth separately removes target then writes JSON. A failure can therefore leave missing auth after a committed deletion; fresh retries cannot infer no effect. Target path and original shared source/alias must be bound before this preparation, and directory refusal must stay distinct from successful migration. These are different writers from the fsynced staged-rename seed helper. |
| `server/src/services/local-ai-credentials.ts:17–39`; `packages/adapters/claude-local/src/server/quota.ts:164–207` | The platform-specific Claude login lane reads two file names then, on macOS, the config-path-derived suffixed Keychain item through `/usr/bin/security`. Passive shared-account reads do not automatically access the unsuffixed item; explicit import can. This is retained platform branch source, not an assertion that the Linux runner uses Keychain. A supported macOS profile would need separate keychain custody; a directory copy cannot represent it. Preserve explicit-import and isolated-home separation. |

The additional encrypted spool/key and alias deletion families need trusted
source/destination inventories and original-family operation identities before
capture or launcher activation. A provider config/session tree alone omits them.
No broad home remapping, guessed complete profile or partial native repair was
installed. Source-level canonical owner review established no additional local
defect warranting a change within this report-only scope; trusted private path
custody remains a deployment dependency rather than a newly proven property.
Structural tree-v1 and exact historical inspection/retry remain separate from
new-use application checks: repeated .git metadata refuses new use, ordinary
nested repositories remain supported. Strict physical-COMMIT, full native and
provider ownership, coherent capture, physical legacy exclusion, independent
current history and authenticated runtime provenance remain blocked. Monotonic
fenced facts remain UNACCEPTED. All original shared holds, paused B, disabled
timers/current capacity, draft PR5/human merges and deferrals persist; backup
release prerequisite remains. Operational acceptance is false.
