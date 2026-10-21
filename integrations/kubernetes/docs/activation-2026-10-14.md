# Disposable evaluation activation — 2026-10-14

Merging PR #1 now activates this package through the existing main-following Flux root. It adds `infrastructure/paperclip-evaluation` at the root and includes `private-ingress` in the package. No Flux bootstrap files or existing application/database/tunnel manifests change.

## Concrete deployment

28 resources across paperclip-eval and paperclip-ingress: one authenticated private controller, three separate persistent SSH runners, four Longhorn PVCs (10 GiB controller, 20 GiB per runner), internal Services, restricted policies, and a separate LAN-only Caddy LoadBalancer with local CA/leaf issuance. All five images use published manifest digests. Existing manual bootstrap Secrets supply only controller/database identity, public CA, runner authorized public keys and registry pulls; no provider/Git login is provisioned. Timers and built-in local database backup are disabled. This is disposable evaluation, with no operational recovery claim.

## Validation before merge

- Static restricted workload/configuration checks, local health/guard fixtures and diff checks pass.
- Combined evaluation render and server-side dry-run accept all 28 resources.
- Full-root semantic comparison against main eeb2f51 confirms all 110 existing resources are identical; only the 28 dedicated evaluation resources are added.
- Longhorn nodes/disks report Ready and Schedulable with approximately 718–721 GiB available per default disk. Scheduling and volume attachment remain actual deployment checks.
- Bootstrap Secret names are present, images previously passed two complete CI verification/publishing runs and actual pull-only digest/identity verification.

## After reviewed merge

Observe Flux reconciliation and all five pods. Verify fresh PVC ownership, controller database TLS/readiness, actual Kubernetes image pulls, certificate issuance and dedicated address. Obtain public SSH host keys through trusted kubectl; prove SSH/SFTP and persistent markers/identities after replacement. Verify real LAN HTTPS and shared-tunnel/outside-LAN denial before provider login. Device CA trust installation remains separately approved. Bootstrap operator access securely without recording invite URLs; configure explicit SSH CLI environments and perform the implementation plan's serial provider gates.

Human-reviewed merge remains required. No workload was applied by preparation or dry-runs. Do not introduce valuable tasks until provider/cancellation/containment and accepted backup/restore gates pass.
