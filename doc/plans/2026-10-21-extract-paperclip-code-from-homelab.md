# Move Paperclip application ownership out of homelab

Date: 2026-10-21

Branch: `migration/extract-homelab-paperclip-runtime-and-tests`

## Why

The homelab repository is a FluxCD source of truth. It should describe Kubernetes deployment, networking, storage, configuration and immutable image references. Paperclip application source, patches, SDK modifications, runtime helpers, application tests and image-build workflows had accumulated there while implementing SSH runners and then a broader admission/readiness program. That crossed the repository boundary and made the GitOps repository responsible for maintaining a third-party application fork.

This branch transfers that work to `adhn/paperclip`. It preserves the existing work for review; it does not endorse the expanded scope or establish deployment readiness. The original goal remains isolated Codex and Claude runners in Kubernetes.

## Base and preservation

The branch starts at `252d9b5077f4eee98ec48225641ef1a02d824158`, the upstream revision against which the existing application changes were developed. The fork's pre-existing `master` at `a1e2173ceb2ff58eef324e906c2060488688a9b8` is unchanged. Starting from that newer master would combine relocation with an upstream upgrade and risk silently replacing intervening application/API/schema changes.

The canonical intentionally dirty development checkout was read, not reset, cleaned, reconstructed or modified. All 200 native working-tree deltas were transferred: 195 files with exact byte matches and five intentional migration-snapshot deletions (0335–0339). This includes earlier runner/admission work as well as the latest readiness fixes; the previously reported 120-file count covered only the latest work package, not all existing changes.

Historical snapshots are preserved as they existed. The five absent intermediate snapshots are an inherited state, not a new schema simplification made by this migration. Migration history and compatibility require review before any execution. No schema generation, database operation or migration was run.

## Where the work now lives

| Former ownership/location | New ownership/location |
| --- | --- |
| Modified native Paperclip application files | Normal `server/`, `packages/`, `patches/` and root package configuration in this fork |
| Homelab evaluation `images/` | `integrations/kubernetes/images/` — runner/proxy/controller recipes, dependency locks and historical source overlays |
| Homelab evaluation `scripts/` | `integrations/kubernetes/scripts/` — application patch/build/verification tooling |
| Homelab evaluation `protected-execution/` | `integrations/kubernetes/protected-execution/` — runtime/authority implementations and tests |
| Homelab evaluation `fixture/` and `fixtures/` | Corresponding directories under `integrations/kubernetes/` |
| Homelab evaluation engineering reports | `integrations/kubernetes/docs/` |
| Six homelab Paperclip build/test workflows | `integrations/kubernetes/legacy-workflows/`, outside GitHub Actions discovery |

367 files were copied and hash-verified before their homelab originals were removed. This includes 43 generated Python cache files, which are excluded from Git by the integration `.gitignore`; 324 relocated non-cache files are retained for version control. Generated cache bytes are not source or validation inputs. No credential provisioning or credential-file copying was performed.

The portable [file manifest](../migrations/2026-10-21-homelab-extraction-manifest.json) records every native delta and relocated path/hash. Existing inherited patches and all new tests are preserved, rather than selectively dropping work during relocation.

The 64-file historical admission source snapshot matches the corresponding native files. It is not the authoritative complete fork implementation: another 131 transferred files are outside that older snapshot. Edit application code at normal native paths; do not continue treating an overlay copy as a second source of truth.

See [integration ownership](../../integrations/kubernetes/README.md) and [historical workflows](../../integrations/kubernetes/legacy-workflows/README.md).

## What homelab retains

The evaluation package retains Kubernetes workloads, Services, PVCs, namespace/RBAC/security/network configuration, private-ingress configuration, operator configuration examples and deployment-only documentation. Application source, dependency patches, helper programs, application/transport/authority tests, image build definitions and application CI workflows are removed from the active homelab working tree.

Workload image pins, Flux resources, other applications and live state are unchanged. Homelab's README and repository-boundary document point to this fork. Future application builds belong here; homelab receives a separately reviewed immutable-image update only after a suitable build exists.

Removal concerns the current worktree/diff. Git history and historical branches still contain their old committed contents; no history rewrite or force push was performed.

## Important build and activation limits

This is a preservation/ownership migration, not a behavior rewrite or upgrade. Historical scripts still contain original repository paths and may fetch the old upstream revision. The old production image preparation does not include all transferred native changes, and the admission overlay was intentionally test-only. Replaying those recipes would not establish a complete build of this branch.

The six relocated workflows are inactive. None has been added to this fork's `.github/workflows/`, enabled, dispatched or published. Porting a workflow requires explicit adaptation to this repository, a reviewed build source and intentional activation. Historical reports retain original paths/commands as historical evidence; relocation does not make every old relative link a current executable instruction.

The transferred native package configuration/SDK patches also require complete frozen-lock/build validation. No dependency installation or lock regeneration was performed. Do not deploy this branch, run its migrations, or infer production compatibility from byte-preservation checks.

## Verification

- Every native transfer matches the original dirty source: 195 exact file hashes; all five intentional deletions match.
- Every relocated homelab file was hash-checked at the destination before deleting its original. The 64-file historical native overlay independently matches native source.
- The relocated Python suite ran in a disposable cached container: **180 tests passed in 21.539s**. All 92 captured inputs match the previous verification inputs. Exit0, no OOM; cleanup and independent exact-container absence were checked.
- Containment: cached image `sha256:1eee6fcc4d866c86dd8e32a4a1a583767ddac0d640b0fe571b2c22d233b60eee`, UID1000, network-none, read-only root, no host mounts, dropped capabilities, no-new-privileges, 256MiB RAM/512MiB swap-inclusive/1CPU/64PIDs. No live authority or provider was contacted.
- A repository-boundary scan checks that homelab has no remaining Paperclip program/test/patch/build/workflow files. A resource-reference check ensures retained Kustomization resource paths still exist. Retained workload pins and configuration are compared for unchanged bytes.
- Earlier native/TypeScript isolated results are historical exact-input evidence, not a new full build of this branch. No full TypeScript build, typegraph, dependency installation or provider acceptance was run during extraction. The authorized local resource cap precludes full graphs; hosted capacity is needed.

Exact commands, input hashes, logs, inspection/OOM/cleanup/absence evidence and the cross-repository audit are retained outside the repositories in the project's `.handoff-state/2026-10-21/fork-extraction/`. This branch's portable manifest and this document remain usable without that local evidence directory.

## Git and operational state

The extraction was initially prepared locally, uncommitted and unstaged, under the prior no-commit/no-push instruction. The user subsequently explicitly authorized committing and pushing the fork migration branch and homelab cleanup. That authorization covers Git publication of these changes, not image publication, merge, cluster access, deployment, provider tasks or live migrations. The former instruction treating this fork path as retired is superseded by the user's explicit direction to use it for this extraction.

All original A/shared-family holds, paused B, disabled timers and existing capacity remain. Gemini authentication and backup/S3/monitoring deferrals remain; backup prerequisites are not waived.

## Next review

Review the application changes here, decide which are necessary for the isolated-runner deliverable, and plan a separately bounded upstream update if desired. Configure a reviewed fork-native build without replaying the historical overlays. Run hosted build/type checks before any immutable image is proposed for homelab. Historical admission/physical-owner guarantees remain unaccepted where previously unresolved; moving their code does not resolve them or install a partial transaction-owner port.
