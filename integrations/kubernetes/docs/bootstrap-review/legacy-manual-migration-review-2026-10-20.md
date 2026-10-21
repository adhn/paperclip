# Manual migration and coordinated rollback review

Inactive manual procedure; no live migration executor or activation is enabled.
The actual controller-image/PVC harness is disposable kind infrastructure. Its
synthetic checkpoint cannot serve as a live backup or establish homelab storage,
provider retirement, credential refresh or operational restore acceptance.

The exact reviewed old registry digest is
`sha256:8bd2d8ccef956c777ea6eefa2004152632e0781706031e8cd42ef89bdd7c50ca`.
The candidate must be bound to final hosted source and a separately reviewed
published immutable digest before rollout; an unpublished Docker image ID is
not a registry pin. No placeholder digest authorizes a rollout.

## Concrete migration boundary

Candidate controller startup and candidate manual migration require the external
Paperclip-only DATABASE_URL and immutable root-owned admission policy, with
`PAPERCLIP_MIGRATION_AUTO_APPLY=false`. The candidate fixture wrapper invokes
`loadProductionAdmissionPolicy({databaseUrl,autoApply,policyPath})` from its packaged
server module before importing/calling the DB migration API. Missing policy and
protected-but-invalid policy are separate exact-error negative controls; migration
ledger and absence of the admission schema must remain unchanged. Their actual
image execution passes in hosted run 39466029222, including unchanged ledger
checks; this is synthetic clone acceptance only.

The exact old image lacks this policy loader. Its original-source initialization
uses only an empty synthetic DB under externally enforced fixture containment;
it is not evidence of a protected old-image operational executor. Both paths call
the exact image's
packaged `applyPendingMigrations(url)` and require `inspectMigrations(url).status`
to be `upToDate`; return-void is not itself a migration success result. The
candidate first must refuse the original schema with exactly
`admission_bootstrap_schema_not_current`, rather than accepting any startup error
as a successful refusal. Held bootstrap occurs before listeners/work services.
Restart must produce a new held epoch and preserve original native rows/holds.

Before migration, review the generated migration journal, immutable decision
triggers and complete source reconstruction. Capture a coordinated external DB,
controller files, runner workspaces/sessions/credentials, protected configuration
and history inventory under independently enforced dispatch/old-route exclusion.
Protect the currently authoritative launch-consumption, retirement and storage
history outside the controller rollback. Matching restored hashes are insufficient
if every authority also rolled back and forgot a consumed invocation.

The operational executor must use dedicated least-privilege credentials and
explicit namespace/DB/PVC targets from the reviewed diff; mount neither provider
credentials nor generic node/runtime authority. Record exact image identity,
policy, migration head, checkpoint hashes, lease/scope inventory and outcome.
This package deliberately supplies no ambient-kubeconfig or live SQL command.

## Rollback boundary

Stop and independently exclude every candidate execution before restoring.
Never run the old image over an upgraded database, erase admission rows to claim
a drain, revert only credentials over newer refresh state, restore the shared
PostgreSQL cluster, delete PVCs or reset external fence/high-water history.
Restore the Paperclip-only DB and files/config from one coordinated checkpoint
into separately reviewed targets. Unknown active writers or uncertain retirement
keep starts held throughout rollback. Inspect unchanged original company, agent,
run, lease, hold and receipt facts, restored files/hashes and absence of later
synthetic/divergent state. The exact old image may boot only under external
execution exclusion because it lacks the mandatory admission guard.

The disposable harness uses real source/restored-state/checkpoint/database PVCs,
old/new application images and full custom PostgreSQL dumps; checks held restart,
new epoch, exact stale-schema refusal and old-image restored-clone health; and
records distinct claim/PV UIDs plus host→CRI→container image identity. It uses
provider-free synthetic markers and local-path provisioner semantics. Hosted
execution results must be read before marking this rehearsal verified. Source
unit cases and the PostgreSQL socket regression alone are not image/PVC success.

Operational recovery additionally needs actual backup coverage, provider/state
refresh safety, independent fence restore/rollback survival, homelab storage
reattachment/exclusion and measured RPO/RTO. These remain separate acceptance
gates even after the disposable rehearsal passes.

## Remaining executable-command boundaries

The candidate wrapper is a fixture command, not an operational arbitrary-URL
migration tool. It validates the policy before migrations and verifies the
packaged migration head afterwards. It does not independently establish a
maintenance window, controller/old-route exclusion, a database identity beyond
the fixture's explicit URL, a real coordinated backup, stable retirement or
homelab storage ownership. Those exact operator/authority inputs must precede
any future reviewed operational executor. No live command is supplied here.

The candidate fixture policy is an immutable ConfigMap single-file read-only
subPath mount at `/etc/clone-policy.json`, including the invalid-policy control.
A real candidate Node preflight records and checks actual file and `/etc`/`/`
parent UID/mode/type, then requires the existing policy loader to accept it,
before controller startup or migration. This avoids depending on projected
ConfigMap directory permissions; pinned v1.34.0 source predicts that directory
metadata retains writable bits even with a read-only mount. Earlier import
failure supplied no actual policy-mount metadata. Neither non-root constraints
nor the strict root-owned/nonwritable policy loader are relaxed. Actual synthetic acceptance
passes in 39466029222; see IMAGE-PVC-REHEARSAL and
../integrated-review/HOSTED-VERIFICATION.md for source/evidence and limits.

## Verified rehearsal and exact operational review inputs — 2026-10-20

Hosted [39466029222](https://github.com/adhn/homelab/actions/runs/39466029222)
PASS on functional candidate `3dcaad6` verifies 28 harness cases and actual
old/new image manual migration, exact policy/stale-schema controls, distinct
Pod/held-epoch restart, coordinated DB/files rollback before old boot, unchanged
source, four distinct PVC/PVs and cleanup. Native source `3dc1426` is unchanged.
No repeat of that completed rehearsal is needed for documentation-only changes.
This accepts the synthetic disposable procedure; no homelab backup, real
credential/session restoration, physical exclusion or one-hour/four-hour target
was exercised. Application boots used 1536 MiB with old-space 768 MiB; these
configuration values are not production headroom or an approved workload change.

The next executable review package needs all rows below before it can contain a
real migration command. Missing rows leave the package inactive.

| Required immutable artifact | Exact review requirement | Present disposition |
| --- | --- | --- |
| Release manifest | Source/reconstruction hashes, published candidate registry digest, old digest, policy hash, migration head and architecture | Source verified; publication separately unauthorized, candidate registry pin absent |
| Target identity | Dedicated Paperclip DB/user/TLS endpoint and namespace UID; controller/runner PVC/PV/backend identities; original family/root mapping | Saved context only; fresh complete physical contract absent |
| Exclusion authorization | Reviewed maintenance window plus independently enforced old/new launch-route and physical writer exclusion; exact issuer/current-history pins | No approved production retirement/storage authority |
| Coordinated recovery manifest | Paperclip-only DB dump/recovery identity, files/config/keys/workspace/session/credential checkpoint hashes and current refresh lineage; safe retained copies | Synthetic clone PASS; real point and verified coverage absent |
| Independent history manifest | Current launch-consumption, runtime tombstone, writer/storage and credential high-water authorities with restore-exclusion ownership and expected pins | Production independent restore domain absent |
| Executor spec | Exact image command/arguments, dedicated credentials, protected policy mount metadata, DB identity guard, dispatch exclusion, deadline and no provider/host/runtime access | Fixture wrapper exists; operational executor not installed |
| Hold manifest | Complete clone bootstrap inventory, exact original lease/run/scopes and append history; no lifecycle/receipt changes; supported unresolved-source dispositions | Saved anchors/matrix prepared; authoritative current inventory absent |
| Outcome/rollback manifest | Pre/post migration heads, held epochs, exact native rows/file hashes, failure logs and candidate exclusion before coordinated restore/old boot | Synthetic results saved; real inspection/rollback path absent |

The executor must check its own actual target identity and immutable policy,
refuse auto-apply, inspect the original migration head, invoke the exact packaged
migration API, inspect the final head and retain its bounded result before any
controller boot is considered. A failed/lost migration response requires reviewed
ledger inspection under continued exclusion; it is not permission to boot,
blindly retry a migration command or restore independent authority backwards.
Interrupted recovery retains all starts held until exact old/new state and
current independent history are reconciled. Old-image rollback requires external
exclusion for its entire lifetime because the old controller lacks the new gate.

[The operational evidence matrix](operational-evidence-matrix-2026-10-20.md)
identifies ten historical lease anchors and all issuer/verifier gaps. Capture
those originals and every newly discovered source in the clone review. Passing
migration cannot clear A or any shared hold; complete supported reconciliation
and later reviewed rollout precede any serial B task. Real recovery acceptance
still requires separately measured RPO/RTO, off-cluster retained backups and
actual restored-clone verification with current fence/high-water authority.

## Accepted/revoked history retained across manual recovery

The independent-history manifest must additionally name legacy decision authority,
original full source/hold/scope closure, each latest accepted/revoked sequence and
decision hash, prospective append intents and uncertain/completed outcomes. Pin
its current authority/history incarnation and protected public-verification key
identity before inspecting a restored clone. Do not place this authoritative
high-water inside the coordinated Paperclip rollback set or reset it to agree
with a restored local chain. Loss, rollback or identity change holds all affected
original families pending separate supported recovery; a matching restored DB/
files pair cannot establish absence of later revokes/effects.

`production/decision_history.py` now specifies and tests read-only exact-current
history comparisons, including local reconcile1 versus external revoke2 without
append. It is not wired into native accepted-decision use and supplies no actual
issuer, retained authority, signing keys, ordered use guard or migration command.
The manual executor review must require those native admission/lifecycle gates
before considering restored decisions applicable. Merely loading the module,
validating a fresh response or booting the clone held is insufficient.

A future migration rehearsal must retain an independent external history while
restoring only the candidate native DB/files, then require direct admission and
lifecycle checks to remain held against retained revoke2 and uncertain append
intents. Preserve all original rows/receipts and shared Codex families. Existing
synthetic image/PVC migration success remains valid in its recorded scope; it
was not rerun here and does not prove this additional decision-use recovery or
real backup/RPO/RTO acceptance. No A reconciliation, manual live migration or
hold release is authorized by this source work.
