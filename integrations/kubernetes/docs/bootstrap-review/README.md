# Mandatory held bootstrap: first review package, 2026-10-19

This is the first implementation slice of production bootstrap, starting with
legacy occupancy. PR #5 stays draft. It is **not a rollout or execution package**:
protected runner fencing/ACK, executable state contracts, external refresh grants,
legacy reconciliation execution, registry publication and an exact activation
workload diff remain required. Production preparation and active workload pins
are unchanged. No live state was reverified or mutated.

## Source review

[changes.patch](changes.patch) shows the bootstrap change against the previous
inactive candidate without the full generated snapshot. [changes.json](changes.json)
records its base, patch hash and before/after source hashes. The exact native
manifest and generated migration/snapshot remain the reconstruction authority.
This patch is for review; do not apply it to the already dirty source checkout.

## Implemented boundary

The candidate's actual production entry point now requires an external database,
`PAPERCLIP_MIGRATION_AUTO_APPLY=false` and an absolute host policy file. It loads
that policy before opening database connections. Missing, malformed, writable or
untrusted policy refuses startup. The file's opened inode and every resolved
parent must be root owned and not group/other writable; projected ConfigMap
symlinks work. An agent workspace or writable `/tmp` policy cannot activate it.

Startup's migration check reads the journal only. It cannot repair journal drift,
automatically initialize an empty database, prompt, or fall through to legacy
non-interactive migration approval. Bootstrap finishes before service factories,
routes and the HTTP listener. Once this database handle requires admission,
missing installation throws instead of silently selecting the legacy path.

Only `mode: held` exists. No execution allowlist or drain-release setting is
accepted. A successful bootstrap installs an empty trusted executable policy
and an immutable process-local start hold, in addition to a database drain.
Changing a scheduler or scope drain alone does not give this controller command,
lease-launch, probe, verification, or native-run authority. It creates **no remote
fence or epoch acknowledgement**. Do not deploy this image expecting B to run.

Migration 0344 adds bootstrap ownership history and separate legacy holds. A
transaction takes an advisory lock plus the scheduler lock, inventories existing
native rows, records holds and a fresh non-reusable epoch, and carries occupied
admission attempts forward as uncertain under their old immutable ownership.
An unknown previous scheduler owner or an undrained scheduler refuses bootstrap.
Restarts through this held bootstrap preserve holds byte-for-byte. A different
instance identity, resource remapping or changed historical evidence refuses
startup and rolls back the whole transaction, including a proposed new epoch.
This does not establish remote old-owner fencing or active-owner adoption.

Every retained lease lacking an exact native admission journal is held, even if
released, expired, succeeded, or carrying an unvalidated historical receipt.
Independent state restoration is not inferred from those fields. Mapped leases
hold runner/account/workspace/session/credential families. Unknown or conflicting
ownership and lease-less native history hold the instance. Existing journalled
work remains represented by its native admission attempt. Retained workspace
`active` status is not execution occupancy and is not changed. Bootstrap does
not modify native leases, run status, manual holds, lifecycle state or receipts.

The native grant transaction checks these legacy holds independently of ordinary
scope drains. It persists `legacy_occupancy_unreconciled` rather than claiming B
on A's shared scopes. No hold expiry, deletion, release or reconciliation endpoint
is implemented in this slice. Holds have no cascading deletion.

`held-policy.json` carries saved physical resource families for all five
Codex/Claude identities, preserving their shared account/state keys. It is a
review input, not a new live attestation. Gemini has no executable binding.
Unmapped environment-only historical leases deliberately get an instance hold;
do not invent an agent owner from request metadata to avoid it.

## Explicit historical reconciliation design

A's two missing historical outcomes must become present-day reconciliation
decisions. Historical run/lease facts and both manual holds remain intact until
the supported lifecycle coordinator independently observes an accepted decision.

1. Freeze dispatch globally; stop the old controller under reviewed GitOps
   maintenance. Reverify current native work, runner incarnations, descendants and
   every shared state writer. Capture a coordinated Paperclip-only recovery point
   or obtain the separately reviewed evaluation exemption.
2. Inventory **all** legacy sources, including the other missing outcomes and
   environment-only records. Bind each decision to company, agent (or an explicit
   reviewed auxiliary owner), run, exact lease, original evidence hash, all affected
   resource families, controller/runner incarnation and the protected fencing epoch.
   A's exact old run/lease IDs remain those in the trusted-attestation report.
3. Collect a new, time-bounded observation that no old provider/descendant can
   continue, under an independently protected fence. A process listing alone is
   insufficient against old-owner relaunch. Record the evidence as present-day
   containment, never as a receipt pretending to come from the historical run.
4. Reconcile workspace, session and credential outcomes independently. Preserve
   divergent uncommitted files and old transcripts for review; establish the
   canonical source and copy-back target. Old OAuth bytes must not overwrite a
   newer refresh state. Unknown refresh writers or recovery outcomes retain the
   shared hold. Present-day stop does not prove any of these three outcomes.
5. A future host-only command must append an immutable decision ledger with
   operator approval artifact/hash, evidence hashes, observation/expiry times and
   exact original hold hashes. Use scheduler/hold locks and compare-and-set to
   reject stale evidence and concurrent starts. The ledger must distinguish
   `held` from `present_day_reconciled`; retain both the original hold and every
   superseding/revoked decision. There must be no generic API accepting a boolean
   `stopped` or an agent-supplied receipt.
6. A separate, tested grant predicate may exclude only precisely reconciled
   occupancy while all evidence remains valid. A's lifecycle coordinator can then
   re-evaluate the exact leases using this explicitly distinct evidence type.
   Do not write lifecycle columns directly or backfill termination receipts.
   Both A sources and every other shared uncertain outcome must reconcile before
   B. Rehearse wrong-company/run/lease/hash, partial restoration, stale decision,
   crash-before/after-commit, revocation and sibling safety first.

This slice intentionally does not implement step 5/6: there is no accepted
protected present-day proof mechanism yet, and adding a release flag now would
provide an unsupported bypass. The next implementation must supply that mechanism
before enabling a reconciliation command or B execution.

## State and external-writer contracts still required

Codex's contract must cover the controller source `/paperclip/.codex/auth.json`,
company symlink, auth cache, runner default auth copy, and **each actual staged**
`.../.paperclip-runtime/codex/home/{auth.json,sessions}`. Bind controller canonical
workspace/copy-back destinations to exact remote realizations and resume targets.
Claude's contract covers both `/home/node/.claude` and `/home/node/.claude.json`,
including encoded-cwd transcripts. A single credentialRoot string is insufficient
to attest these independent restoration destinations. Canonical realpaths, storage
IDs, allowed composed configuration fingerprints, modes and drift checks must be
verified before an executable contract is accepted.

The operator says other clients/phone are idle and this laptop remains active.
Saved setup history records supported runner logins and Codex runner-to-controller
seeding. The operator confirms no later laptop/cluster credential copies. This establishes
no known copied cross-device chain; it does not prove provider-side grant independence.
No external credential files were read here. Treat the account as one quota
family, keep the cluster credential scope exclusive and record unknown external
refresh relationships. Local admission cannot lock the active laptop.

`account-window.json` records the user's ten-task minimum as ten serial tasks per
provider, proposed ten-minute task/two-hour stage bounds and no automatic body
retry or paid fallback. This is a finite test envelope, not measured provider
quota headroom, an approved token allowance, or permission to dispatch now. Freeze
external usage/observed available allowance and stop conditions before a stage.

## Protected runner and rollout package still required

The current SSH daemon and provider code share UID 1000. A directory writable by
that UID cannot protect an epoch from provider code. Root ownership checks for
**controller policy** do not repair the **runner** trust boundary.

The next fencing change needs a reviewed process/UID or container boundary,
operator-controlled persistent fence/ledger storage inaccessible to provider code,
a control endpoint/key that cannot become arbitrary unsupervised SSH, and verified
compare-and-set acknowledgement tied to physical runner/incarnation, root and
controller epoch. Readback must be independently authenticated before recording
an ACK. Test old-owner launch, lost/ambiguous ACK, symlink/root substitution,
restart, restore/epoch reuse and descendant stop. A same-UID `chmod` or an ACK row
inserted without remote proof is unacceptable. Any sidecar/privilege/topology
change must be explicit in the future workload diff.

The operator chose to retain the non-root rules and requested a stronger execution
design for review. [The concrete proposal](non-root-execution-design.md) separates
a trusted non-root supervisor and state-transfer Module from disposable provider
Pods. It covers launch/stop authority, independent termination evidence, protected
epoch storage, admission enforcement, canonical state and migration. This is a
proposed topology change, not an implemented or approved rollout. A protected
ledger alone does not establish independent execution authority.

After all source/rehearsal gates pass, produce the registry digest, exact source
hashes, immutable mounted policy/identity, manual migration executor and exact
workload diff for human review. No fabricated image digest or placeholder image
is included here. Disable automatic migration in that diff. Keep the old
controller stopped until guarded startup and protected epoch handoff pass.

SQL migration rollback rehearsal demonstrates atomic failure recovery and native
row preservation; it does **not** qualify application downgrade after admitted
work. The older controller cannot run while outstanding admission work exists.
After migration, require a verified drain and schema compatibility on a disposable
clone or a coordinated Paperclip-only database/files/config restore with external
dispatch blocked. Never delete admission rows/drop tables to create a false drain,
restore the whole shared PostgreSQL cluster, or delete PVCs as rollback.

Serial Codex on existing B follows reviewed rollout and complete shared legacy
resolution. Serial Claude lifecycle/session/refresh follows separately. Overlap,
Gemini authentication, timers and everyday-use/recovery acceptance remain held.

## Candidate source verification

[CI 39301024631](https://github.com/adhn/homelab/actions/runs/39301024631) PASS on
`0880eee`: full server/adapter/DB/focused typechecks, 400 native and 329 transport
cases, original 18 DB/24 subprocess contracts, all three synthetic actual-SSH
fixtures, complete production image build, three CLI guards and built-image
missing-policy refusal before database access. Documentation-only `4f929fa`
changes no tested source. The unpublished Docker image ID is
`sha256:e8f5f207a6b967218505f633dcd6c1b51cdcad711f4ff584a7801c42650147bd`;
this is not a registry digest or rollout pin. Full server typecheck reached the
6 GiB cap with zero OOM kills; keep that check on hosted capacity.

This passes the inactive held-bootstrap source gate only. The stronger non-root
execution topology, protected ACK, executable root contracts, reconciliation
release, restored-clone application rollback and activation diff remain open.
