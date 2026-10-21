# Independent authority implementation delta — 2026-10-20

Current source continuation: [owned authority services and retained-intent
implementation](OWNED-AUTHORITY-SERVICES.md). Actual runtime/storage/custody/native
effect integration remains blocked/open; the historical interfaces below are not
operational authorization.

Functional continuation `862d648` passes hosted39493128372 (133 cases plus seven guards); native d489129/all64 and six production inputs unchanged.

Current continuation: [ordered authority integration and precise remaining native/all-command boundaries](ORDERED-AUTHORITY-INTEGRATION.md). Earlier implementation counts below retain their historical scope.

Functional source `2a72f9e` continues `258496d`. Hosted [39491421658](https://github.com/adhn/homelab/actions/runs/39491421658) passes all 89 component cases and seven reconstruction-guard methods. It changes inactive Python components
and bounded component CI only. Native functional source remains `d489129` with
64 exact overlay files; the deliberate source checkout is preserved. Production
image inputs, preparation, held policy, RBAC, network and workload stay unchanged.
No runtime or storage authority is installed by this delta.

| Package | Implemented source/review | Still required before activation |
| --- | --- | --- |
| Runtime retirement | [Exact-build decision and bounded rehearsal](../runtime-authority-decision-2026-10-20.md): owner intent/effect/T/B, every route and no recovery allow window | Named compatible unavoidable runtime effect/recovery mechanism, every endpoint/handler/shim proof, separate installation authorization |
| Operation ownership | `production/operation_worker.py`; persistent spawned adapter owner with bounded framed IPC, deadline/cancellation and permanent uncertainty hold | Protected factory placement, bounded listener/handshake/admission, real adapter independent intent/effect inspection; killing a local worker never proves remote cancellation |
| Every-command byte forwarding | `production/gateway.py` Attachment.write and `production/stream_server.py` exact bounded bytes, sequence/hash, fresh runtime/storage observations and no replay | Real existing-stream backend must order native cancellation/runtime/storage revocation against each actual write; every setup/probe/transfer/lifecycle command path must enter this protocol; neither backend nor all-path integration is installed |
| Legacy current history | `production/decision_history.py`: protected public-verification identity interface, complete original closure and comparison against independent current accepted/revoked history | Real issuer/channel/custody, independent retained append-intent history, mandatory native admission/lifecycle integration and ordered use/revoke guard |
| Canonical storage | [Physical proof boundary](STORAGE-PROOF-BOUNDARY.md) and [storage decision](../bootstrap-review/physical-storage-authority-decision-2026-10-20.md) | Actual stale-writer exclusion, original multi-root CAS/activation, independent high-water and uncertain intent resolution |
| Reconciliation/manual migration | [Full evidence sequence](../bootstrap-review/evidence-activation-sequence-2026-10-20.md) and [manual migration review](../bootstrap-review/legacy-manual-migration-review-2026-10-20.md) | Real complete inventory/issuers/operator consent/signer, supported present-day A review, real coordinated recovery point and exact executor targets |

## Review diff by activation surface

The review diff adds no Kubernetes object or production image recipe. It cannot
serve as an executable activation diff. These exact dependencies determine which
future surface can change:

- **Image:** publish nothing. Preserve the verified native/image scope until an
  actual recipe change needs its own full hosted verification and separately
  authorized immutable registry identity. Python modules are not integrated into
  the controller by their presence in this review tree.
- **Policy/admission:** preserve the held policy and original instance/account/
  scope identities. An observation from the new history verifier is explicitly
  not a reusable permit. Native `legacyHoldIsReconciled` and its callers remain
  unmodified; accepted-decision resurrection under native rollback is still an
  activation blocker until mandatory ordered use-side integration exists.
- **RBAC/network/workload:** no new verbs, sockets, mounts, Service, listener or
  Pod is installed. The eventual factory, issuer, gateway and verifier identities
  must determine exact least-privilege paths. No generic exec/attach authority,
  fixture broker, observer or CNI installer enters the deployment.
- **Storage:** control-worker termination, close-only cleanup and authenticated
  observations do not detach a mount, revoke stale I/O, activate roots or release
  capacity. Unknown outcomes retain original ownership and independent history.
- **Manual migration:** no live command or migration is added. Exact target,
  exclusion, checkpoint, independent history, executor and rollback manifests
  remain prerequisites; synthetic restored-clone success is separate from real
  backup/RPO/RTO acceptance.

The current [verification ledger](HOSTED-VERIFICATION.md) records exact test
scopes. The earlier native/image hosted passes are reused only because their
source and recipes are unchanged. Changed Python components need current bounded
checks; those cannot prove physical retirement, key custody or recovery.

Both historical A holds and original shared Codex families remain. B stays
paused per saved evidence, Gemini deferred, timers off and PR #5 draft. Reviewed
rollout and complete shared-hold resolution precede ten bounded serial Codex B
tasks, then Claude lifecycle/session/refresh. No live action, provider dispatch,
publication, migration, capacity increase or merge is authorized here.
