# Handoff execution, 2026-10-13

This record supersedes the earlier access blockers only. Evaluation acceptance remains open.

## Verified workstation and cluster facts

- Docker daemon access and kubectl snap startup work with approved execution outside the sandbox. Docker server: 29.8.1. Current kube context: `microk8s`.
- kubectl 1.35.9 is outside the supported minor-version skew against Kubernetes 1.32.13. Read-only queries below succeeded; use a compatible client for deployment verification.
- Three Ready amd64 nodes, each with 4 allocatable CPUs and approximately 15.4 GiB allocatable memory. Observed usage: 9–17% CPU and 26–40% memory. Usage is not a scheduling headroom guarantee.
- Calico IPv4 pool: `10.1.0.0/16`, VXLAN Always, outgoing NAT enabled. CoreDNS pods have `k8s-app=kube-dns`. Nodes: `192.168.1.11` through `.13`. No Calico HostEndpoints or Calico network/global network policies were returned. Node-path containment remains untested.
- CNPG operator image: `ghcr.io/cloudnative-pg/cloudnative-pg:1.30.1`. Three CNPG clusters still specify PostgreSQL 18.0 images. No configured backups/plugins, CronJobs, ScheduledBackups or Backups were returned; Barman ObjectStore CRD is absent. External backup coverage is not established.
- SQL on shared primary `postgres/postgresql-2` reports PostgreSQL 18.0. Existing non-template databases are `postgres` and `app`, each approximately 7.6 MiB. No evaluation database was provisioned.
- PostgreSQL SSL is enabled. An OpenSSL PostgreSQL handshake to `postgresql-rw.postgres.svc.cluster.local:5432` negotiated TLS 1.3 and verified the hostname against `/controller/certificates/client-ca.crt`. TCP SQL requires password authentication; no credential values were retrieved. This does not prove the application's Node driver CA configuration.
- Shared ingress Service uses `192.168.1.100`; no dedicated private ingress Service was found. Do not publish Paperclip through the shared tunnel route.
- Longhorn 1.10.0 CSI declares `fsGroupPolicy: ReadWriteOnceWithFSType`. Default `longhorn` has Delete reclaim policy and three replicas; `longhorn-postgres` has Retain and one replica. Fresh/restored runner ownership and fencing are untested.
- Legacy `planka/data-planka-postgresql-0` has no ownerReference and has Helm PostgreSQL labels. No current Planka pod mounts it. Contents and recovery value remain unclassified; retain it.

Private raw metadata inventory: `/tmp/paperclip-inventory-20261013.txt` (operator-only permissions; temporary evidence, not recovery storage).

## Registry discovery

Existing application manifests reference `ghcr.io/adhn/primdal-php` and `ghcr.io/adhn/primdal-nginx`, with `primdal-byg/ghcr-credentials` for pulls. GHCR under `adhn` is the existing registry convention. Workstation Docker configuration names only `testaviva.azurecr.io`; it has no GHCR login entry. Approved GitHub authentication succeeds as `adhn`, but its reported scopes omit package write. Do not repurpose another application's pull credential for publishing.

## Work in progress and gates

Pinned controller source was fetched into `/tmp/paperclip-build-20261013`. All three runner images built locally and passed extended SSH fixtures. The corrected controller image also built successfully. No image was pushed, Flux reference added, Paperclip workload deployed, secret created, provider authenticated or backup configured by these steps. A temporary credential-free network fixture was deployed and removed.

Registry publishing credentials/workflow, private ingress/TLS, application database TLS configuration, topology containment, all provider runtime tests and operational recovery remain required.

Operator decision during this handoff: postpone object-storage provisioning and the outside-cluster heartbeat; no independently hosted monitoring machine is currently available. Continue disposable evaluation. This defers recovery implementation, without waiving backup/restore acceptance for everyday use or establishing protection for existing workloads.

## Runner image and transport checks

All runners report Node 24.15.0, Python 3.13.5 and TypeScript 5.9.3. Provider versions: Codex 0.162.1, Claude Code 2.1.296 and Gemini 0.63.0.

All three passed UID-1000 key-only SSH login, CLI discovery through default SSH PATH, SFTP upload/download, a real loopback reverse-forwarded HTTP callback, read-only rootfs with all capabilities dropped, uncommitted marker preservation and stable SSH host identity after container replacement. No provider login/model call occurred. This does not prove Kubernetes volume ownership/fencing or Paperclip adapter authentication/cancellation.

The upstream optional OpenCode/ACPX provider-pack stage performs an additional production dependency resolution. The corrected preparation script omits that unused pack for the selected SSH CLI scope, retaining the empty directory expected by the upstream production COPY. Pack-dependent engines are unavailable; all three selected adapters explicitly use CLI. The controller build must use this corrected recipe before publishing.

## Credential-free live network checks

Copied candidate policies into temporary namespace `paperclip-netcheck`; used digest-pinned Node probe pods, no Secrets/volumes/tokens. Repeated with all pods on think2, then Codex on think1, Claude on think2 and Gemini on think3. Final fixture pods reported zero restarts. Removed the namespace after saving evidence.

PASS for the tested flows on both topologies:

- Controller reaches each runner over Service/direct Pod IP on port 2222 and the existing PostgreSQL writable Service/primary Pod on 5432.
- Each runner reaches controller port 3100 over Service/direct Pod IP, resolves public DNS and connects to `registry.npmjs.org:443`.
- Each runner times out against unrelated fixture Service/Pod IP, PostgreSQL Service/primary Pod, Kubernetes API Service, all three node API endpoints on 16443 and shared LAN ingress on 443. These targets are reachable from the unrestricted control fixture.
- Each runner is blocked from the other runners over Service/direct Pod IP; the controller reaches those same listeners. Unrelated control cannot reach protected runner/controller listeners.

The first fixture listener crashed on unhandled ECONNRESET; corrected the listener and discarded those failed runs. Increasing the initial memory limit was not the actual fix. Do not interpret those failures as CNI failures.

Limits: representative IPv4 TCP paths only, no exhaustive port/LAN/global-address/IPv6 coverage, no provider-specific login/refresh traffic, scoped API authorization, private HTTPS/tunnel test or actual Paperclip adapter invocation. The live probes establish useful pre-credential containment evidence, not completion of the provider isolation gate. Raw results are temporary files under `/tmp/paperclip-network-probe-*`.

## Local image identities

These are local image configuration IDs, not registry manifest digests:

| Image | Local ID |
| --- | --- |
| Controller | `sha256:c9c5ba0ab0a23c06cae9dd21ae2024372b6b4e06bf7f55532d4d85f963c7aab3` |
| Codex | `sha256:b224dcbd015e8df7691ad00a1fb776be38f74d0a6019cd3a4bb553dfc6f1974c` |
| Claude | `sha256:27eed89d1693ab06555b6d59a87c26ff3c6a68d07f493616a1bd031b5b588056` |
| Gemini | `sha256:4c291f4ae329bf00a17cd514539c177029b9660456e2184fb65cdc5538024daf` |

Operator approved preparing a dedicated LAN ingress and local CA. Device CA trust installation remains subject to separate approval. A review branch stages the inactive package and an isolated GHCR publishing workflow; activation remains gated.

## Evaluation database bootstrap

Provisioned only new role/database `paperclip_eval`, namespace `paperclip-eval` with restricted admission, manual `paperclip-controller` Secret and public-CA-only `paperclip-postgres-ca` Secret. Existing databases/roles were not overwritten. Generated controller credentials are retained privately in `/home/andam/.local/share/paperclip-evaluation/` with directory mode 0700 and secret file mode 0600; never commit this bundle. No provider credentials or Paperclip workloads are present.

PASS: actual built controller PostgreSQL driver with `sslmode=verify-full` and `NODE_EXTRA_CA_CERTS` connects under the evaluation identity, verifies the Service hostname and negotiates TLS 1.3. Temporary create/insert/drop fixture succeeds and is removed. Role has no superuser/create-db/create-role/replication/bypass-RLS privileges, a 16-connection limit, and no CREATE permission on existing `app` database. PUBLIC permissions were revoked on the new evaluation database. Existing databases retain their original ACLs; absence of CREATE does not establish denial of all connections or every pre-existing public function.

The controller manifest now requires the verified public CA Secret. A temporary loopback database tunnel and local controller-driver fixture were used; Kubernetes controller startup and full application migrations remain untested.

Dedicated LAN proxy image also built locally, after removing the stock binary's unneeded file capability. PASS: UID 1000, read-only rootfs, all capabilities dropped, TLS hostname verification against an ephemeral fixture certificate and 403 rejection despite forged forwarding headers. The fixture CA was not installed. Real LAN/tunnel routing, deployed certificate issuance and device trust remain untested.

Draft PR: https://github.com/adhn/homelab/pull/1 . Hosted build/publish run: https://github.com/adhn/homelab/actions/runs/38454145048 . Registry digests remain pending until that run succeeds.

## Further database and transport results

PASS: the same Node driver rejects both the untrusted CA (`SELF_SIGNED_CERT_IN_CHAIN`) and wrong hostname (`ERR_TLS_CERT_ALTNAME_INVALID`). Full pinned migration bootstrap succeeds under the scoped evaluation role: 338 journal entries, 281 tables, status `upToDate`. Loader execution requires the writable `/tmp` already specified in the controller manifest. Loopback tunnel was closed after the test.

Generated three distinct Ed25519 SSH client identities in the private operator directory and created `runner-codex-ssh`, `runner-claude-ssh` and `runner-gemini-ssh` Secrets containing only their public authorized keys. These are transport keys, not provider login state. Persistent runner host keys and known_hosts lines cannot be verified until the actual Kubernetes runners start.

## Mounted PVC usage snapshot

Read kubelet statistics without inspecting application files: 19 mounted PVCs reported usage. Per-instance Memos/Planka data is approximately 0.66–0.74 GiB; MariaDB approximately 0.71 GiB per instance; shared PostgreSQL data approximately 59 MiB and WAL approximately 0.59–0.66 GiB per instance; Redis approximately 32 KiB per instance; Portainer approximately 1.4 MiB. This is a point-in-time filesystem snapshot, not change-rate sizing or backup-consistency evidence. The unmounted legacy Planka claim cannot be classified from mounted-volume statistics and remains retained. Raw metadata: `/tmp/paperclip-pvc-usage-20261013.json`.

## Topology and activation state

Trusted existing operator SSH on think1 confirms the router/default gateway is `192.168.1.1`, matching the proxy exclusion. Node has a globally routed IPv6 address; its exact address is intentionally kept out of the public review evidence. Runner public egress rules allow IPv4 only; IPv6 route/containment tests remain unperformed. The LAN Service explicitly selects IPv4 SingleStack and has no NodePorts. Do not introduce AAAA records or dual-stack workload egress without testing the complete policy.

Flux still follows `main` at `eeb2f51c9eba3c937de3de8a1e0d7a3bb9092064`. No Deployment/Pod exists in `paperclip-eval`; only the five intended manual bootstrap Secrets are present. No provider API keys or login state have been provisioned.

## Registry pull and CA lifecycle preparation

Hosted run 38454145048 exceeded its one-hour limit without publishing. Logs were unavailable, so the stalled build substep remains unknown. Five local candidates were exported with checksums and provenance; the pending replacement workflow uses an unpublished private draft release as transport, verifies and tests these exact images, and publishes through CI. Publication and registry manifest digests remain unverified.

The LAN proxy requires a rollout after cert-manager leaf renewal: static certificate files and disabled Caddy admin do not provide verified automatic reload. Verify the renewed served certificate over LAN HTTPS after each rollout; renewal monitoring remains an everyday-use gate.

Existing homelab GHCR pull identity is reused only through dedicated image-pull Secrets; it is not used for publishing and is not mounted into application containers. Controller/runners and LAN proxy reference `paperclip-ghcr-pull` in their respective namespaces. Registry access verification remains pending publication. The separate ingress namespace is bootstrapped only with restricted admission and its pull Secret; proxy/Service/CA issuance remain inactive.

The copied PostgreSQL CA expires January 11, 2027. This is a snapshot of CNPG's public CA, not automatic cross-namespace certificate synchronization. Refresh the Secret and operator copy after CA renewal, drain/restart the controller so `NODE_EXTRA_CA_CERTS` reloads, and repeat trusted/untrusted/wrong-host checks before the old CA expires. Admission/failure behavior must remain fail-closed. Automating renewal monitoring is an operations input before everyday use.

## Publication and resumed checks, 2026-10-14

CI run https://github.com/adhn/homelab/actions/runs/38622073966 succeeded: exact candidate provenance/identity verification, all three runner fixtures, LAN proxy fixture, controller guards and GHCR publication passed. Downloaded sanitized evidence matches the committed candidate manifest. Five registry manifest digests match independent pull-only registry reads; actual digest pulls match all five candidate configuration IDs. See `../images/published.json`. Workload and proxy references now use those immutable digests. Kubernetes image pulls and application startup remain untested.

Base/addon rendering and installed-client server-side dry-runs passed without applying workloads. Reverified context microk8s, three Ready nodes, Flux still on main at eeb2f51c9eba3c937de3de8a1e0d7a3bb9092064, six evaluation bootstrap Secrets and one ingress pull Secret, and no Paperclip workloads. The transport release remains an unpublished draft. No merge, activation, provider authentication or recovery implementation occurred.
